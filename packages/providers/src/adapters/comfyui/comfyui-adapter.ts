/**
 * The free local image lane: ComfyUI on the 6 GB Quadro.
 *
 * Everything measured about this machine lives in `tools/comfy-workflows/README.md`
 * and the numbers below come from there, not from received wisdom:
 *
 *  - **Port 8288, not 8188.** 8188 sits inside a Windows reserved TCP exclusion range
 *    (8163-8262, held by WinNAT) and binding it fails with `PermissionError`.
 *  - **768px is the practical ceiling and 1024px is the hard one.** 1024² runs at 95 %
 *    of the card with ~300 MiB spare; 1280² completes but thrashes DynamicVRAM at 2.1×
 *    the time for 1.6× the pixels. Above 1024 this adapter declines rather than OOMs
 *    the GPU, because an OOM takes the whole server down and a refusal does not.
 *  - **ComfyUI caches node outputs.** An identical graph comes back in ~10 ms without
 *    running the sampler. That is free dedup in production and a lie in a benchmark;
 *    it is why `ResponseCache` and the smoke harness both exist and why this adapter
 *    does not try to defeat it.
 *
 * The flow is the one `tools/scripts/comfy-smoke.mjs` proves works:
 * `POST /prompt` → poll `GET /history/{id}` → `GET /view`.
 */

import type { Capability, ProviderKind, Size } from '@rv/contracts';
import { modelRef } from '@rv/contracts';
import {
  type AppError,
  type Clock,
  ProviderError,
  type Result,
  SystemClock,
  TimeoutError,
  UnsupportedCapabilityError,
  err,
  isErr,
  ok,
} from '@rv/shared-kernel';

import { type FetchLike, JsonHttpClient } from '../../http/json-http';
import { type ImageArtifact, toImageArtifact } from '../../ports/common';
import type { ImageEditPort, ImageEditRequest } from '../../ports/image-edit';
import type {
  ImageGenerationPort,
  ImageGenerationRequest,
  ImageResult,
} from '../../ports/image-generation';
import type { ProviderAdapter } from '../../ports/provider-adapter';
import { elapsedSince } from '../shared';
import { type PlaceholderValues, buildGraph } from './workflow';
import { ComfyHistory, ComfyPromptResponse, type ComfyImageRef } from './wire';

/**
 * Not 8188.
 *
 * See the file header: 8188 is unbindable on this machine. Changing it here changes it
 * everywhere, which is the point of it being a constant rather than a literal.
 */
export const COMFYUI_DEFAULT_BASE_URL = 'http://127.0.0.1:8288';

export const COMFYUI_CAPABILITIES: readonly Capability[] = ['image-generation', 'image-edit'];

/** Hard ceiling per axis. 1024² already sits at 95 % of a 6 GB card (README §2). */
export const COMFYUI_MAX_DIMENSION = 1024;

/** The ceiling worth staying under. 3.25 s/image at 768² with 1.3 GB headroom. */
export const COMFYUI_RECOMMENDED_DIMENSION = 768;

/** The two graphs in `tools/comfy-workflows/`, already parsed. */
export interface ComfyWorkflowSet {
  /** `txt2img-lcm-draft.json` */
  readonly txt2img: unknown;
  /** `img2img-lcm-variant.json` */
  readonly img2img: unknown;
}

/**
 * Defaults from README §3, measured on this GPU.
 *
 * `sampler`/`scheduler` are the LCM pairing; `karras`/`normal` degrade badly at 4
 * steps. `cfg` above ~2 burns an LCM image out. `lora_strength` below ~0.8 makes the
 * 4-step schedule fall apart. None of these are style preferences.
 */
export const COMFYUI_DEFAULTS: PlaceholderValues = {
  checkpoint: 'dreamshaper_8.safetensors',
  lora: 'lcm-lora-sdv1-5.safetensors',
  lora_strength: 1.0,
  sampler: 'lcm',
  scheduler: 'sgm_uniform',
  steps: 6,
  cfg: 1.5,
  batch_size: 1,
  denoise: 0.4,
  width: 512,
  height: 512,
  seed: 0,
  negative:
    'blurry, low quality, jpeg artifacts, watermark, signature, text, deformed, extra limbs, oversaturated',
  filename_prefix: 'rivayat',
};

export interface ComfyUiAdapterOptions {
  readonly workflows: ComfyWorkflowSet;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  /** Overrides any of `COMFYUI_DEFAULTS` - a different checkpoint, more steps. */
  readonly defaults?: PlaceholderValues;
  readonly capabilities?: readonly Capability[];
  /** How long to wait for a queued prompt. 512² takes ~1.4 s; a cold checkpoint adds ~10 s. */
  readonly generationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Injected so tests do not spend real seconds polling. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Identifies this client to ComfyUI's queue. */
  readonly clientId?: string;
}

const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export class ComfyUiAdapter implements ProviderAdapter, ImageGenerationPort, ImageEditPort {
  readonly kind: ProviderKind = 'comfyui';
  readonly modelRef: string;
  readonly capabilities: readonly Capability[];

  readonly #http: JsonHttpClient;
  readonly #clock: Clock;
  readonly #workflows: ComfyWorkflowSet;
  readonly #defaults: PlaceholderValues;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #clientId: string;

  constructor(options: ComfyUiAdapterOptions) {
    // The "model" is the checkpoint the graph loads: it is what the output depends on
    // and therefore what the ledger and the dedup key must name.
    const checkpoint = String(options.defaults?.checkpoint ?? COMFYUI_DEFAULTS.checkpoint);
    this.modelRef = modelRef('comfyui', checkpoint);
    this.capabilities = options.capabilities ?? COMFYUI_CAPABILITIES;
    this.#workflows = options.workflows;
    this.#defaults = { ...COMFYUI_DEFAULTS, ...options.defaults };
    this.#clock = options.clock ?? new SystemClock();
    this.#timeoutMs = options.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#clientId = options.clientId ?? 'rivayat';
    this.#http = new JsonHttpClient({
      baseUrl: options.baseUrl ?? COMFYUI_DEFAULT_BASE_URL,
      provider: 'comfyui',
      clock: this.#clock,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  async generateImage(request: ImageGenerationRequest): Promise<Result<ImageResult, AppError>> {
    const size = request.size ?? {
      width: Number(this.#defaults.width),
      height: Number(this.#defaults.height),
    };
    const ceiling = this.#checkCeiling(size);
    if (ceiling !== undefined) return err(ceiling);

    // References are silently useless here: the txt2img graph has no IP-Adapter node,
    // and `--disable-all-custom-nodes` is on for reproducibility (README §7).
    if ((request.references?.length ?? 0) > 0) {
      return err(
        new UnsupportedCapabilityError(
          'comfyui',
          'reference-image conditioning - the local graphs run with --disable-all-custom-nodes, so no IP-Adapter node is available; route reference-conditioned work to the cloud lane',
        ),
      );
    }

    return this.#run(
      this.#workflows.txt2img,
      {
        prompt: request.prompt,
        ...(request.negativePrompt === undefined ? {} : { negative: request.negativePrompt }),
        width: size.width,
        height: size.height,
        seed: request.seed ?? Number(this.#defaults.seed),
        batch_size: request.count ?? Number(this.#defaults.batch_size),
      },
      size,
      request.seed ?? Number(this.#defaults.seed),
      request.signal,
    );
  }

  async editImage(request: ImageEditRequest): Promise<Result<ImageResult, AppError>> {
    const size = request.size ?? {
      width: Number(this.#defaults.width),
      height: Number(this.#defaults.height),
    };
    const ceiling = this.#checkCeiling(size);
    if (ceiling !== undefined) return err(ceiling);

    if (request.mask !== undefined) {
      return err(
        new UnsupportedCapabilityError(
          'comfyui',
          'masked inpainting - img2img-lcm-variant.json has no mask input; add an inpainting workflow before routing masked edits here',
        ),
      );
    }

    const uploaded = await this.#upload(request.base.data, request.base.mimeType, request.signal);
    if (isErr(uploaded)) return uploaded;

    return this.#run(
      this.#workflows.img2img,
      {
        prompt: request.instruction,
        // The graph's positive node is `"{{prompt}}, {{variant}}"`, so both must be
        // supplied even when the caller has only one instruction to give.
        variant: request.instruction,
        image: uploaded.value,
        width: size.width,
        height: size.height,
        seed: request.seed ?? Number(this.#defaults.seed),
        denoise: request.strength ?? Number(this.#defaults.denoise),
      },
      size,
      request.seed ?? Number(this.#defaults.seed),
      request.signal,
    );
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Refuses rather than OOMs.
   *
   * An out-of-memory kill takes the whole ComfyUI process with it, so every queued job
   * dies with the oversized one. A typed refusal costs the router one failover.
   */
  #checkCeiling(size: Size): AppError | undefined {
    const largest = Math.max(size.width, size.height);
    if (largest <= COMFYUI_MAX_DIMENSION) return undefined;
    return new UnsupportedCapabilityError(
      'comfyui',
      `image generation at ${String(size.width)}x${String(size.height)} - the local 6 GB card tops out at ${String(COMFYUI_MAX_DIMENSION)}px per axis (${String(COMFYUI_RECOMMENDED_DIMENSION)}px recommended); route larger work to the cloud lane`,
    );
  }

  async #run(
    workflow: unknown,
    values: PlaceholderValues,
    size: Size,
    seed: number,
    signal: AbortSignal | undefined,
  ): Promise<Result<ImageResult, AppError>> {
    const startedAt = this.#clock.now();

    const graph = buildGraph(workflow, { ...this.#defaults, ...values });
    if (isErr(graph)) return graph;

    const queued = await this.#http.postJson(
      '/prompt',
      { prompt: graph.value.prompt, client_id: this.#clientId },
      { ...(signal === undefined ? {} : { signal }) },
    );
    if (isErr(queued)) return queued;

    const accepted = ComfyPromptResponse.safeParse(queued.value);
    if (!accepted.success) {
      return err(
        new ProviderError({
          message: 'ComfyUI /prompt returned no prompt_id',
          provider: 'comfyui',
          retryable: true,
        }),
      );
    }
    if (Object.keys(accepted.data.node_errors ?? {}).length > 0) {
      return err(
        new ProviderError({
          message: 'ComfyUI rejected the graph',
          provider: 'comfyui',
          // The same graph will be rejected again; this is a workflow bug, not a blip.
          retryable: false,
          context: { nodeErrors: accepted.data.node_errors },
        }),
      );
    }

    const outputs = await this.#awaitHistory(accepted.data.prompt_id, signal);
    if (isErr(outputs)) return outputs;

    const images: ImageArtifact[] = [];
    for (const reference of outputs.value) {
      const bytes = await this.#download(reference, signal);
      if (isErr(bytes)) return bytes;
      images.push(
        toImageArtifact(
          { mimeType: bytes.value.contentType, data: bytes.value.bytes },
          { size, seed },
        ),
      );
    }

    if (images.length === 0) {
      return err(
        new ProviderError({
          message: 'ComfyUI completed the prompt but produced no image',
          provider: 'comfyui',
          retryable: false,
          context: { promptId: accepted.data.prompt_id },
        }),
      );
    }

    return ok({
      images,
      modelRef: this.modelRef,
      usage: {
        // Local inference: no tokens, and the ledger row will price to exactly zero.
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: images.length, resolution: size },
        latencyMs: elapsedSince(this.#clock, startedAt),
      },
    });
  }

  async #awaitHistory(
    promptId: string,
    signal: AbortSignal | undefined,
  ): Promise<Result<readonly ComfyImageRef[], AppError>> {
    const deadline = this.#clock.now() + this.#timeoutMs;

    for (;;) {
      const response = await this.#http.getJson(`/history/${promptId}`, {
        ...(signal === undefined ? {} : { signal }),
      });
      if (isErr(response)) return response;

      const parsed = ComfyHistory.safeParse(response.value);
      if (!parsed.success) {
        return err(
          new ProviderError({
            message: 'ComfyUI /history returned an unexpected body',
            provider: 'comfyui',
            retryable: true,
            context: { promptId },
          }),
        );
      }

      const entry = parsed.data[promptId];
      if (entry !== undefined) {
        const status = entry.status;
        if (status?.status_str === 'error') {
          return err(
            new ProviderError({
              message: 'ComfyUI reported an execution error',
              provider: 'comfyui',
              // Node-level failures repeat: a missing checkpoint stays missing.
              retryable: false,
              context: { promptId, messages: status.messages },
            }),
          );
        }
        if (status?.completed === true || entry.outputs !== undefined) {
          const images: ComfyImageRef[] = [];
          for (const output of Object.values(entry.outputs ?? {})) {
            for (const image of output.images ?? []) images.push(image);
          }
          return ok(images);
        }
      }

      if (this.#clock.now() >= deadline) {
        return err(new TimeoutError(`comfyui prompt ${promptId}`, this.#timeoutMs));
      }
      await this.#sleep(this.#pollIntervalMs);
    }
  }

  async #download(
    reference: ComfyImageRef,
    signal: AbortSignal | undefined,
  ): Promise<Result<{ bytes: Uint8Array; contentType: string }, AppError>> {
    const query = new URLSearchParams({
      filename: reference.filename,
      subfolder: reference.subfolder ?? '',
      type: reference.type ?? 'output',
    });
    return this.#http.getBytes(`/view?${query.toString()}`, {
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Puts the base image where `LoadImage` can find it.
   *
   * `POST /upload/image` is multipart, which is the one request in this package that
   * is not JSON - hence the hand-built `FormData` rather than the shared client.
   */
  async #upload(
    bytes: Uint8Array,
    mimeType: string,
    signal: AbortSignal | undefined,
  ): Promise<Result<string, AppError>> {
    const form = new FormData();
    const name = `rivayat-base.${mimeType.split('/')[1] ?? 'png'}`;
    form.append('image', new Blob([bytes], { type: mimeType }), name);
    form.append('overwrite', 'true');

    const response = await this.#http.postForm('/upload/image', form, {
      ...(signal === undefined ? {} : { signal }),
    });
    if (isErr(response)) return response;

    const uploaded = response.value;
    if (uploaded === null || typeof uploaded !== 'object') {
      return err(
        new ProviderError({
          message: 'ComfyUI /upload/image returned an unexpected body',
          provider: 'comfyui',
          retryable: true,
        }),
      );
    }
    const filename: unknown = (uploaded as Record<string, unknown>).name;
    if (typeof filename !== 'string') {
      return err(
        new ProviderError({
          message: 'ComfyUI /upload/image did not name the stored file',
          provider: 'comfyui',
          retryable: true,
        }),
      );
    }
    const subfolder: unknown = (uploaded as Record<string, unknown>).subfolder;
    return ok(
      typeof subfolder === 'string' && subfolder !== '' ? `${subfolder}/${filename}` : filename,
    );
  }
}
