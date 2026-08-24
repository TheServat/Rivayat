/**
 * S10 Render, wired for real, and the one stage where "resumable" has to be literal.
 *
 * `RunRenderJobUseCase` in `@rv/render-engine` already owns the loop, the checkpoint
 * and the encode. This is the joint: it turns a job payload into that use-case's input,
 * puts the frames and the checkpoint at a **content address** rather than under the run
 * id, and turns the engine's progress ticks into run events.
 *
 * **Checkpoint granularity is one frame, and that is a decision rather than a default.**
 * The alternatives are a stage-level checkpoint - which throws away the whole render on
 * a kill, so the resume is a re-render and the byte-identity claim is a restatement of
 * `evaluate`'s purity rather than a test of anything - and a batched one, which throws
 * away work in proportion to the batch. A frame is the smallest unit whose output is a
 * pure function of `(ir, index)`, so it is the smallest unit that can be trusted after
 * a crash. The cost of taking it every frame is one ~200-byte JSON write against a
 * frame that took milliseconds to draw and eight megabytes to store at 1080p; the cost
 * of *not* taking it is the frame. Per-frame also makes the engine's reconcile step
 * exact rather than conservative.
 *
 * **The signal is checked between frames, by the engine, not here.** That is the
 * difference between cancellation and delay: a stage that only looked at the signal on
 * entry would finish its 1,800-frame render before noticing.
 *
 * Nothing in this file reads a wall clock. The injected `Clock` reaches the engine only
 * for the ETA and the checkpoint timestamp, both of which are reporting - the frames
 * are identical whatever it says.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { PipelineStageKey, RenderProgress, Size } from '@rv/contracts';
import {
  FfmpegEncoder,
  FfprobeReader,
  RunRenderJobUseCase,
  masterSettings,
  type FrameBackendId,
  type FrameRenderer,
} from '@rv/render-engine';
import {
  ValidationError,
  err,
  isErr,
  ok,
  sha256,
  toIso,
  type AppError,
  type Clock,
  type Logger,
  type Result,
} from '@rv/shared-kernel';

import { DELIVERY_MANIFEST_FILE, RunDelivery, type DeliveredFile } from './delivery.contracts';

import { toValidationError } from '../common/zod-validation.pipe';
import type { CompositionStore } from '../modules/compositions/composition.store';
import type { StageContext, StageHandler, StageOutput } from '../pipeline/stage';
import {
  RenderStagePayload,
  RenderStageRequest,
  renderKey,
  renderSize,
} from './render-stage.contracts';
import { PinnedCheckpointStore, VerifiedFileFrameStore } from './render-stores';

/** Container per codec, so the master's extension is data rather than a `switch`. */
const MASTER_EXTENSION: Readonly<Record<string, string>> = {
  prores: 'mov',
  h264: 'mp4',
  h265: 'mp4',
  vp9: 'webm',
  av1: 'mp4',
};

export interface RenderStageHandlerDeps {
  /** Backends by id, injected so a test can install one that draws nothing expensive. */
  readonly renderers: ReadonlyMap<FrameBackendId, FrameRenderer>;
  readonly encoder: FfmpegEncoder;
  /**
   * Reads back what was actually encoded.
   *
   * The stage knows what it *asked* for; only the prober knows what came out, and
   * "is this file deliverable" is a question about the file. One `ffprobe` per render,
   * at the end, against a file that is already on disk.
   */
  readonly prober: FfprobeReader;
  /**
   * Resolves a `compositionId` into the composition it names.
   *
   * Here rather than in the controller because the resolution has to happen on the
   * *worker*: a run is resumed by a different process from the one that started it, and
   * a payload that had been expanded at request time would carry megabytes of IR through
   * the queue and the payload store for no gain.
   */
  readonly compositions: CompositionStore;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Renders live under `<workspaceDir>/renders/<renderKey>/`. */
  readonly workspaceDir: string;
}

/** Where every artefact of one render lives. Derived, never stored. */
export interface RenderLayout {
  readonly root: string;
  readonly frames: string;
  readonly checkpoints: string;
  readonly master: string;
  /** What was produced, measured. Read by `GET /api/runs/:id/delivery`. */
  readonly manifest: string;
}

export function renderLayout(workspaceDir: string, key: string, codec: string): RenderLayout {
  const root = join(workspaceDir, 'renders', key);
  return {
    root,
    frames: join(root, 'frames'),
    checkpoints: join(root, 'checkpoint'),
    master: join(root, `master.${MASTER_EXTENSION[codec] ?? 'mp4'}`),
    manifest: join(root, DELIVERY_MANIFEST_FILE),
  };
}

export class RenderStageHandler implements StageHandler {
  readonly stage: PipelineStageKey = 'render';
  readonly implemented = true;
  readonly #deps: RenderStageHandlerDeps;

  constructor(deps: RenderStageHandlerDeps) {
    this.#deps = deps;
  }

  async execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    const request = RenderStageRequest.safeParse(context.job.payload.render);
    if (!request.success) return err(toValidationError(request.error, 'run.payload.render'));

    const resolved = await this.#resolve(request.data);
    if (isErr(resolved)) return resolved;

    // Re-parsed through the *payload* schema, so everything downstream - and the render
    // key in particular - sees one shape whichever way the composition arrived.
    const parsed = RenderStagePayload.safeParse(resolved.value);
    if (!parsed.success) return err(toValidationError(parsed.error, 'run.payload.render'));
    const payload = parsed.data;

    const size = renderSize(payload);
    const key = renderKey(payload);
    const layout = renderLayout(this.#deps.workspaceDir, key, payload.codec);

    // FFmpeg does not create directories, and it discovers that after the whole filter
    // graph is built - which is a confusing failure at the end of a long render.
    const prepared = await this.#prepare(layout.root);
    if (isErr(prepared)) return prepared;

    const settings = masterSettings({ fps: payload.ir.fps, codec: payload.codec });

    const useCase = new RunRenderJobUseCase({
      renderers: this.#deps.renderers,
      frames: new VerifiedFileFrameStore(layout.frames, size),
      checkpoints: new PinnedCheckpointStore(layout.checkpoints, key, this.#deps.logger),
      encoder: this.#deps.encoder,
      clock: this.#deps.clock,
      progress: {
        emit: (tick) => {
          report(context, tick);
        },
      },
    });

    const outcome = await useCase.execute({
      jobId: context.job.id,
      ir: payload.ir,
      size,
      backend: payload.backend,
      frames: payload.frames,
      master: { outputPath: layout.master, settings },
      keepFrames: payload.keepFrames,
      signal: context.signal,
      // One frame. See the file header for why this is not tunable from the payload.
      checkpointEvery: 1,
    });
    if (isErr(outcome)) return outcome;

    const bytes = await this.#read(layout.master);
    if (isErr(bytes)) return bytes;

    const digest = sha256(bytes.value);

    // Measured before the stage reports success, so a run that says it delivered
    // something can always say *what*. A probe failure is logged rather than fatal: the
    // file exists and is hashed, and refusing the whole render because we could not
    // describe it would throw away the render.
    await this.#writeManifest(layout, key, size, digest, bytes.value.byteLength);

    this.#deps.logger.info('render complete', {
      renderKey: key,
      framesRendered: outcome.value.framesRendered,
      framesTotal: outcome.value.framesTotal,
      sha256: digest,
    });

    return ok({
      artifacts: [
        `render-master:${digest}`,
        `render-frame-stream:${outcome.value.frameStreamHash}`,
        `render-key:${key}`,
      ],
      // Frames actually encoded, not the IR's declared duration: a shard renders a
      // slice, and the cost-per-minute denominator has to be what shipped.
      deliveredMs: Math.round((outcome.value.framesTotal / payload.ir.fps) * 1000),
    });
  }

  /**
   * A request with a composition reference becomes a request with a composition.
   *
   * A reference that names nothing is a validation failure rather than a not-found: from
   * the stage's point of view the *payload* is wrong, and a run that fails with "your
   * composition does not exist" is easier to act on than one that fails with a 404 for a
   * resource nobody asked for by name.
   */
  async #resolve(request: RenderStageRequest): Promise<Result<Record<string, unknown>, AppError>> {
    const common = {
      size: request.size,
      backend: request.backend,
      frames: request.frames,
      codec: request.codec,
      keepFrames: request.keepFrames,
    };

    if (request.ir !== undefined) return ok({ ...common, ir: request.ir });

    const id = request.compositionId ?? '';
    const found = await this.#deps.compositions.find(id);
    if (isErr(found)) return found;
    if (found.value === null) {
      return err(
        new ValidationError({
          message: `No composition is stored under ${id}; store it first with POST /api/compositions`,
          context: { compositionId: id },
        }),
      );
    }
    return ok({ ...common, ir: found.value.ir });
  }

  /**
   * Probes the master and records it as the run's one delivered file.
   *
   * A manifest on disk next to the artefact rather than a row: `render_artifacts`
   * requires a `jobs` row this app does not write, and the manifest has to survive the
   * process that made it - which is the same requirement the frames and the checkpoint
   * have, answered the same way and in the same directory.
   *
   * `inSpec` stays `null`. A master is not a platform deliverable - no `FormatProfile`
   * describes it - and the seven that are come from S11, which is still a stub. Claiming
   * a verdict here would be the one thing worse than having none.
   */
  async #writeManifest(
    layout: RenderLayout,
    key: string,
    size: Size,
    digest: string,
    bytes: number,
  ): Promise<void> {
    const probed = await this.#deps.prober.probe(layout.master);
    if (isErr(probed)) {
      this.#deps.logger.warn('render produced a file the prober could not read', {
        renderKey: key,
        path: layout.master,
        code: probed.error.code,
      });
      return;
    }

    const file: DeliveredFile = {
      kind: 'master',
      path: relative(this.#deps.workspaceDir, layout.master).replaceAll('\\', '/'),
      format: null,
      sha256: digest,
      bytes,
      durationMs: Math.round(probed.value.durationMs),
      size: { width: probed.value.width, height: probed.value.height },
      codecName: probed.value.codecName,
      pixelFormat: probed.value.pixelFormat,
      fps: probed.value.fps,
      bitrateBps: probed.value.bitrateBps,
      frameCount: probed.value.frameCount,
      hasAudio: probed.value.hasAudio,
      issues: [],
      inSpec: null,
    };

    const manifest: RunDelivery = {
      renderKey: key,
      composition: size,
      files: [file],
      needsAttention: false,
      createdAt: toIso(this.#deps.clock.now()),
    };

    try {
      await writeFile(layout.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    } catch (caught: unknown) {
      this.#deps.logger.warn('could not write the delivery manifest', {
        renderKey: key,
        cause: String(caught),
      });
    }
  }

  async #prepare(root: string): Promise<Result<void, AppError>> {
    try {
      await mkdir(root, { recursive: true });
      return ok(undefined);
    } catch (caught: unknown) {
      return err(
        new ValidationError({
          message: `Could not create the render directory ${root}`,
          cause: caught,
          context: { root },
        }),
      );
    }
  }

  async #read(path: string): Promise<Result<Uint8Array, AppError>> {
    try {
      return ok(Uint8Array.from(await readFile(path)));
    } catch (caught: unknown) {
      return err(
        new ValidationError({
          message: `The encoder reported success but ${path} is not readable`,
          cause: caught,
          context: { path },
        }),
      );
    }
  }
}

/**
 * One engine tick to one run event.
 *
 * `item` carries the frame rather than only the fraction, because "frame 412 of 1,800"
 * is what a progress list renders and a fraction is what a bar renders, and a UI shows
 * both. `phase` goes in `detail` because it is prose for a human - the client branches
 * on the structured fields.
 */
function report(context: StageContext, tick: RenderProgress): void {
  context.reportProgress({
    progress: tick.fraction,
    detail: tick.message ?? tick.phase,
    item: {
      kind: 'frame',
      key: String(tick.framesDone),
      index: tick.framesDone,
      total: tick.framesTotal,
    },
  });
}
