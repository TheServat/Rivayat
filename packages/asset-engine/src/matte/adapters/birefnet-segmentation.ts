/**
 * BiRefNet through `@huggingface/transformers` - research §4's learned matting engine.
 *
 * It is the escalation tier, not the primary: a flat field is better keyed than
 * segmented (see {@link ThresholdMatting}), and a segmentation model asked to cut a
 * flat field will happily eat a pale wing. What it exists for is the case the key
 * cannot serve at all - a graded or vignetted backdrop, where flood-filling from the
 * border stalls after a few pixels and the matte "removes nothing".
 *
 * Three deliberate shapes:
 *
 * - **The module is loaded lazily and injectably.** `@huggingface/transformers` drags
 *   in `onnxruntime-node`, and paying that import cost on every process that touches an
 *   `AssetSpec` would make the CLI slow for no reason. The injection point is also what
 *   makes the adapter testable at all - CLAUDE.md §3 forbids a live model download in
 *   CI, so the tests substitute the loader and the *arithmetic* is what gets covered.
 * - **It returns a mask, not a matte.** Everything about how the mask becomes alpha
 *   lives in {@link ModelMatting}, where it is plain testable code.
 * - **The weight cache is a parameter.** transformers.js defaults `env.cacheDir` to a
 *   `.cache` folder *inside its own package directory*, so a 224 MB download would live
 *   in `node_modules` and be destroyed by the next `pnpm install`. Callers point it at
 *   the workspace instead.
 *
 * ## Measured, 2026-08-23, on this machine
 *
 * `onnx-community/BiRefNet_lite-ONNX` at `dtype: 'fp32'`, CPU (onnxruntime-node) with
 * ComfyUI holding 3.4 GB of the 6 GB card: **224 MB download**, ~11 s to build the
 * session, **12-15 s per 768x512 image**, byte-identical alpha across runs. On the
 * `prop/lamp-cart/laden` take that both threshold tiers refused with
 * "removed nothing: coverage 0.99", it returned coverage **0.189** with four
 * transparent corners and clean cuts between the wheel spokes.
 */

import { type AppError, type Result, ProviderError, ok } from '@rv/shared-kernel';

import type { MattingEngineId, SegmentationModel } from '../../ports/matting-port';
import type { RgbaImage } from '../../ports/raster-port';

/** The subset of `@huggingface/transformers` this adapter uses. */
export interface TransformersLike {
  pipeline(
    task: 'background-removal',
    model?: string,
    options?: Record<string, unknown>,
  ): Promise<BackgroundRemover>;
  RawImage: new (
    data: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    channels: 1 | 2 | 3 | 4,
  ) => RawImageLike;
  /**
   * Mutable global config. Absent on a test double, which is why it is optional.
   *
   * transformers.js has no per-pipeline cache directory; `env.cacheDir` is the only
   * lever, and it has to be set before the first `pipeline()` call.
   */
  env?: { cacheDir?: string | null };
}

export interface RawImageLike {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: number;
}

export type BackgroundRemover = (image: RawImageLike) => Promise<RawImageLike | RawImageLike[]>;

export interface BiRefNetOptions {
  /**
   * Model id on the hub. Defaults to {@link DEFAULT_BIREFNET_MODEL}.
   *
   * A parameter rather than a constant because the checkpoint is the thing most likely
   * to be tuned per project, and because `image.lane`-style settings are declared, not
   * hard-coded (architecture §7b).
   */
  readonly model?: string;
  /** Runtime options handed straight to the pipeline. Defaults to `{ dtype: 'fp32' }`. */
  readonly pipelineOptions?: Record<string, unknown>;
  /**
   * Where the ONNX weights are cached.
   *
   * Left unset, transformers.js caches inside its own `node_modules` directory, so the
   * 224 MB download is re-fetched after every install. Apps point this at the
   * workspace.
   */
  readonly cacheDir?: string;
  /** Overridden in tests. Defaults to a dynamic import of the real package. */
  readonly load?: () => Promise<TransformersLike>;
}

export const BIREFNET_ENGINE = 'birefnet';

/**
 * The transformers.js-format BiRefNet lite checkpoint.
 *
 * **Note the `-ONNX` suffix.** `onnx-community/BiRefNet_lite` - the id this constant
 * held until it was first actually downloaded - does not exist on the hub; the ONNX
 * conversion of `ZhengPeng7/BiRefNet_lite` is published as `BiRefNet_lite-ONNX`, with
 * `onnx/model.onnx` (224 MB, fp32) and `onnx/model_fp16.onnx` (114 MB). Verified live
 * against `huggingface.co/api/models` on 2026-08-23.
 *
 * Research §4 also names a 2026-07 illustration fine-tune, "Lucida". It exists
 * (`egeorcun/lucida`, 885 MB safetensors + custom modelling code; `tomohisa/lucida-web`,
 * 473 MB bare ONNX) but **neither ships a transformers.js `config.json`**, so neither
 * loads through the `background-removal` pipeline. Adopting it needs a second
 * `SegmentationModel` implementation driving `onnxruntime-node` directly, which is a
 * separate piece of work; this constant is the one that runs today.
 */
export const DEFAULT_BIREFNET_MODEL = 'onnx-community/BiRefNet_lite-ONNX';

/** fp32, not fp16: onnxruntime-node's CPU provider has no fp16 kernels for this graph. */
const DEFAULT_PIPELINE_OPTIONS: Readonly<Record<string, unknown>> = { dtype: 'fp32' };

export class BiRefNetSegmentation implements SegmentationModel {
  readonly id: MattingEngineId = BIREFNET_ENGINE;
  readonly #model: string;
  readonly #pipelineOptions: Record<string, unknown>;
  readonly #cacheDir: string | undefined;
  readonly #load: () => Promise<TransformersLike>;
  #remover: Promise<BackgroundRemover> | undefined;

  constructor(options: BiRefNetOptions = {}) {
    this.#model = options.model ?? DEFAULT_BIREFNET_MODEL;
    this.#pipelineOptions = options.pipelineOptions ?? { ...DEFAULT_PIPELINE_OPTIONS };
    this.#cacheDir = options.cacheDir;
    this.#load = options.load ?? loadTransformers;
  }

  async segment(image: RgbaImage): Promise<Result<Uint8Array, AppError>> {
    let cut: RawImageLike | RawImageLike[];
    let module: TransformersLike;
    try {
      module = await this.#load();
      if (this.#cacheDir !== undefined && module.env !== undefined) {
        module.env.cacheDir = this.#cacheDir;
      }
      this.#remover ??= module.pipeline('background-removal', this.#model, this.#pipelineOptions);
      const remover = await this.#remover;
      cut = await remover(new module.RawImage(image.data, image.width, image.height, 4));
    } catch (caught: unknown) {
      // The adapter boundary is where an exception becomes a `Result`, exactly once.
      // A model that will not load is a provider failure, not a programmer error - the
      // chain is supposed to fall through to the next engine.
      this.#remover = undefined;
      return err(caught, this.#model);
    }

    const first = Array.isArray(cut) ? cut[0] : cut;
    if (first === undefined) {
      return err(new Error('background-removal returned no image'), this.#model);
    }
    // The pipeline composites its mask back onto the *original* raster, so a size
    // change means a preprocessor we do not understand - and reading it row-major
    // anyway would produce a diagonally sheared matte that still passes every
    // downstream length check.
    if (first.width !== image.width || first.height !== image.height) {
      return err(
        new Error(
          `background-removal returned ${String(first.width)}x${String(first.height)} for a ${String(image.width)}x${String(image.height)} input`,
        ),
        this.#model,
      );
    }

    return ok(alphaChannel(first, image.width * image.height));
  }
}

/**
 * The alpha plane of the cut image, as one byte per pixel.
 *
 * The pipeline returns RGBA with the background already zeroed, so alpha *is* the
 * confidence mask. Reading it rather than re-deriving one from the colour keeps this
 * adapter from having an opinion about what the matte should look like.
 */
function alphaChannel(image: RawImageLike, expectedPixels: number): Uint8Array {
  const mask = new Uint8Array(expectedPixels);
  const channels = image.channels;
  for (let i = 0; i < expectedPixels; i += 1) {
    // A model that returned fewer channels than four has no alpha to read; treat every
    // returned pixel as foreground rather than inventing a gradient.
    mask[i] = channels >= 4 ? (image.data[i * channels + 3] ?? 0) : 255;
  }
  return mask;
}

function err(caught: unknown, model: string): Result<Uint8Array, AppError> {
  return {
    ok: false,
    error: new ProviderError({
      message: caught instanceof Error ? caught.message : 'BiRefNet segmentation failed',
      provider: `huggingface:${model}`,
      cause: caught,
      retryable: false,
    }),
  };
}

/* c8 ignore start -- loads a 100 MB ONNX runtime; CI runs the injected loader instead. */
async function loadTransformers(): Promise<TransformersLike> {
  const module: unknown = await import('@huggingface/transformers');
  return module as TransformersLike;
}
/* c8 ignore stop */
