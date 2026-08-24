/**
 * S9 Preview, wired: a cheap look at the real thing.
 *
 * Every decision about *what* a preview is lives in `preview-stage.contracts.ts`. What
 * this file adds is the one that makes those decisions safe: **the preview is the same
 * job**. It builds a `RenderStagePayload`, files it under the same content address with
 * the same `renderKey`, and hands it to `RunRenderJobUseCase` with the same renderers,
 * the same frame store, the same checkpoint store and the same encoder S10 uses. The
 * only difference between a preview and a render is the two numbers in the payload.
 *
 * That has a consequence worth stating, because it is the acceptance criterion: a
 * preview requested at the composition's own size and rate produces the *same render
 * key* as the render, and therefore reuses its frames rather than drawing a second set.
 * A preview that could diverge from the render would have to diverge somewhere, and
 * there is nowhere left for it to.
 *
 * It does not report `deliveredMs`. A preview is finished video and it is not a
 * deliverable; counting its milliseconds would put them in the denominator of cost per
 * delivered minute, which is a number about the product rather than about the looking.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { relative } from 'node:path';

import type { PipelineStageKey, RenderProgress } from '@rv/contracts';
import {
  FfmpegEncoder,
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
  type AppError,
  type Clock,
  type Logger,
  type Result,
} from '@rv/shared-kernel';

import { toValidationError } from '../common/zod-validation.pipe';
import type { CompositionStore } from '../modules/compositions/composition.store';
import type { StageContext, StageHandler, StageOutput } from '../pipeline/stage';
import { CompositionSource, compositionReference } from './composition-source';
import { PreviewStageRequest, previewFps, previewSize } from './preview-stage.contracts';
import { RenderStagePayload, renderKey } from './render-stage.contracts';
import { renderLayout } from './render-stage.handler';
import { PinnedCheckpointStore, VerifiedFileFrameStore } from './render-stores';

export interface PreviewStageHandlerDeps {
  readonly renderers: ReadonlyMap<FrameBackendId, FrameRenderer>;
  readonly encoder: FfmpegEncoder;
  readonly compositions: CompositionStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly workspaceDir: string;
}

export class PreviewStageHandler implements StageHandler {
  readonly stage: PipelineStageKey = 'preview';
  readonly implemented = true;
  readonly #deps: PreviewStageHandlerDeps;
  readonly #compositions: CompositionSource;

  constructor(deps: PreviewStageHandlerDeps) {
    this.#deps = deps;
    this.#compositions = new CompositionSource(deps.compositions);
  }

  async execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    const parsed = PreviewStageRequest.safeParse(context.job.payload.preview ?? {});
    if (!parsed.success) return err(toValidationError(parsed.error, 'run.payload.preview'));
    const request = parsed.data;

    // The composition this run is about: named on the preview, named on the render, or
    // produced by this run's own choreograph stage. A preview of a *different*
    // composition from the one being rendered would be a preview of nothing useful.
    const source = await this.#compositions.resolve(
      compositionReference(context, { ir: request.ir, compositionId: request.compositionId }),
      context.run,
      'run.payload.preview',
    );
    if (isErr(source)) return source;

    const fps = previewFps(source.value.ir.fps, request.fps);
    const size = previewSize(source.value.ir.sceneSpace, request.maxWidth);

    // The composition with one field changed. A different `fps` is a different
    // document and therefore a different content address, which is exactly right: the
    // preview's frames are not the render's frames unless the two agree on everything.
    const payload = RenderStagePayload.safeParse({
      ir: { ...source.value.ir, fps },
      size,
      backend: request.backend,
      frames: request.frames,
      codec: 'h264',
      keepFrames: request.keepFrames,
    });
    if (!payload.success) return err(toValidationError(payload.error, 'run.payload.preview'));

    const key = renderKey(payload.data);
    const layout = renderLayout(this.#deps.workspaceDir, key, 'h264');

    const prepared = await this.#prepare(layout.root);
    if (isErr(prepared)) return prepared;

    const useCase = new RunRenderJobUseCase({
      renderers: this.#deps.renderers,
      frames: new VerifiedFileFrameStore(layout.frames, size),
      checkpoints: new PinnedCheckpointStore(layout.checkpoints, key, this.#deps.logger),
      encoder: this.#deps.encoder,
      clock: this.#deps.clock,
      progress: {
        emit: (tick: RenderProgress) => {
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
        },
      },
    });

    const outcome = await useCase.execute({
      jobId: context.job.id,
      ir: payload.data.ir,
      size,
      backend: payload.data.backend,
      frames: payload.data.frames,
      master: { outputPath: layout.master, settings: masterSettings({ fps, codec: 'h264' }) },
      keepFrames: payload.data.keepFrames,
      signal: context.signal,
      // Same granularity as S10: a preview is short, and a resumed preview that redrew
      // frames it already had would be a second preview rather than a resumed one.
      checkpointEvery: 1,
    });
    if (isErr(outcome)) return outcome;

    const bytes = await this.#read(layout.master);
    if (isErr(bytes)) return bytes;
    const digest = sha256(bytes.value);

    this.#deps.logger.info('preview complete', {
      previewKey: key,
      fps,
      size,
      framesTotal: outcome.value.framesTotal,
      sha256: digest,
    });

    context.reportProgress({
      progress: 1,
      detail:
        `${String(outcome.value.framesTotal)} frames at ${String(size.width)}x` +
        `${String(size.height)}, ${String(fps)} fps`,
    });

    return ok({
      artifacts: [
        `preview-master:${digest}`,
        `preview-key:${key}`,
        `preview-path:${relative(this.#deps.workspaceDir, layout.master).replaceAll('\\', '/')}`,
        `preview-cadence:${String(size.width)}x${String(size.height)}@${String(fps)}`,
      ],
    });
  }

  async #prepare(root: string): Promise<Result<void, AppError>> {
    try {
      await mkdir(root, { recursive: true });
      return ok(undefined);
    } catch (caught: unknown) {
      return err(
        new ValidationError({
          message: `Could not create the preview directory ${root}`,
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
