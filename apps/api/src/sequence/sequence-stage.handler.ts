/**
 * S7 Sequence, wired for real over `BuildShotListUseCase`.
 *
 * The division of labour is the engine's and is not re-litigated here: the model decides
 * what a director decides - where to cut, how close, who is in frame, what the frame is
 * *about* - and the code decides everything that is arithmetic or belongs to the style
 * bible. This stage's job is to supply the second half honestly.
 *
 * **The camera grammar and the frame rate come from the locked style, not the payload.**
 * `MotionStyle.camera.cutRhythm` decides how long a shot is and `MotionStyle.fps` decides
 * what a duration rounds to. Taking them from the run payload would let two runs under
 * the same style cut differently, which is precisely the drift the style bible exists to
 * prevent.
 *
 * **The safe area is solved, never supplied.** `solveSafeArea` is pinned at both ends of
 * a seam - `story-engine/src/shots/safe-area-contract.spec.ts` records the rectangles and
 * `render-engine/src/reframe/shot-list-seam.spec.ts` asserts the same figures crop
 * cleanly for every delivery format. This stage passes the canvas and the deliverables
 * and nothing else, so the seam that is tested is the seam that runs.
 *
 * One model call, guarded and metered through `meteredStageWork` - the same path the
 * three LLM story stages take, for the same reason: a stage whose work is a model call
 * has to be behind the budget guard before the call, and `StructuredTrace` is what says
 * afterwards what it actually consumed.
 */

import type { CameraGrammar, PipelineStageKey, Shot, StyleBible } from '@rv/contracts';
import type { ModelRouter } from '@rv/providers';
import {
  BuildShotListUseCase,
  type PlaceableAsset,
  type ShotListResult,
  type StoryEngineDeps,
} from '@rv/story-engine';
import {
  ValidationError,
  err,
  isErr,
  ok,
  toIso,
  type AppError,
  type Clock,
  type Logger,
  type Result,
} from '@rv/shared-kernel';

import { toValidationError } from '../common/zod-validation.pipe';
import type { MeteredCallRunner } from '../cost/metered-call';
import type { StageContext, StageHandler, StageOutput } from '../pipeline/stage';
import { meteredStageWork } from '../story/stage-spend';
import { upstreamStyleBibleId } from '../style/style-artifacts';
import type { StyleBibleRepository } from '../style/style-bible.repository';
import { SequenceStageRequest, type ScenePlaceable } from './sequence-stage.contracts';
import { SHOT_LIST_VERSION, ShotListStore } from './shot-list.store';

export interface SequenceStageHandlerDeps {
  readonly styles: StyleBibleRepository;
  readonly shotLists: ShotListStore;
  /**
   * The engine's two ports, assembled per run.
   *
   * A factory rather than a bundle so `StructuredCall`'s output can be scoped to the
   * stage that is running - which is what makes "which model needed three repair turns
   * on this schema" answerable per run instead of per process.
   */
  readonly engine: (logger: Logger) => StoryEngineDeps;
  /** Consulted to name the model on the ledger row before the call is made. */
  readonly router: ModelRouter;
  readonly meter: MeteredCallRunner;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class SequenceStageHandler implements StageHandler {
  readonly stage: PipelineStageKey = 'sequence';
  readonly implemented = true;
  readonly #deps: SequenceStageHandlerDeps;

  constructor(deps: SequenceStageHandlerDeps) {
    this.#deps = deps;
  }

  async execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    const request = SequenceStageRequest.safeParse(context.job.payload.sequence);
    if (!request.success) return err(toValidationError(request.error, 'run.payload.sequence'));
    const payload = request.data;

    const style = await this.#style(context, payload.styleBibleId);
    if (isErr(style)) return style;

    context.reportProgress({
      progress: 0.1,
      detail: `sequencing "${payload.scene.title}" for ${payload.deliverables.join(', ')}`,
    });

    const useCase = new BuildShotListUseCase(
      this.#deps.engine(this.#deps.logger.child({ stage: 'sequence' })),
    );

    const camera: CameraGrammar = style.value.motion.camera;

    const built = await meteredStageWork<ShotListResult>(
      { meter: this.#deps.meter, router: this.#deps.router },
      // `scene-write` at `final`, matching `DIRECTOR` in `@rv/story-engine` exactly: the
      // guard has to price the model the role will actually be routed to, and the role is
      // where that decision lives.
      { context, stage: 'sequence', task: 'scene-write', tier: 'final', calls: 1 },
      async (signal) => {
        const outcome = await useCase.execute({
          scene: payload.scene,
          sceneDurationMs: payload.sceneDurationMs,
          camera,
          fps: style.value.motion.fps,
          masterAspect: payload.masterAspect,
          deliverables: payload.deliverables,
          canvas: payload.canvas,
          placeables: payload.placeables.map(toPlaceable),
          dialogue: payload.dialogue,
          // No `safeArea`. See the file header: the solved rectangle is the one the
          // reframer's seam test is written against.
          ...(signal === undefined ? {} : { signal }),
        });
        if (isErr(outcome)) return outcome;
        return ok({ value: outcome.value, traces: [outcome.value.trace] });
      },
    );
    if (isErr(built)) return built;

    context.reportProgress({
      progress: 0.9,
      detail: `${String(built.value.shots.length)} shots; ${built.value.pacingNote}`,
      item: {
        kind: 'shot',
        key: payload.scene.id,
        index: built.value.shots.length,
        total: built.value.shots.length,
      },
    });

    const stored = await this.#deps.shotLists.save({
      version: SHOT_LIST_VERSION,
      sceneId: payload.scene.id,
      shots: [...built.value.shots],
      safeArea: built.value.safeArea,
      pacingNote: built.value.pacingNote,
      createdAt: toIso(this.#deps.clock.now()),
    });
    if (isErr(stored)) return stored;

    this.#deps.logger.info('shot list built', {
      sceneId: payload.scene.id,
      shots: built.value.shots.length,
      safeArea: built.value.safeArea,
      masterAspect: payload.masterAspect,
    });

    context.reportProgress({
      progress: 1,
      detail: `${String(built.value.shots.length)} shots stored for ${payload.scene.id}`,
    });

    return ok({
      artifacts: [
        `shot-list:${payload.scene.id}`,
        ...built.value.shots.map((shot: Shot) => `shot:${shot.id}`),
      ],
    });
  }

  /**
   * The style this scene is cut under.
   *
   * The payload wins, then the bible S1 established earlier in this run. A run with
   * neither is refused rather than defaulted: `CameraGrammar` has defaults for every
   * field, so a stage that invented one would silently cut every series at the same
   * three-second rhythm and nothing downstream would notice.
   */
  async #style(
    context: StageContext,
    declared: StyleBible['id'] | undefined,
  ): Promise<Result<StyleBible, AppError>> {
    const id = declared ?? upstreamStyleBibleId(context.run);
    if (id === null) {
      return err(
        new ValidationError({
          message:
            'S7 has no style to cut under: the payload names no `styleBibleId` and no earlier ' +
            'stage of this run established one. The camera grammar and the frame rate are the ' +
            "style's, not the run's.",
          context: { stages: context.run.stages.map((stage) => stage.stage) },
        }),
      );
    }

    const found = await this.#deps.styles.find(id);
    if (isErr(found)) return found;
    if (found.value === null) {
      return err(
        new ValidationError({
          message: `No style bible is stored under ${id}.`,
          context: { styleBibleId: id },
        }),
      );
    }
    return ok(found.value);
  }
}

/**
 * The wire shape to the engine's own.
 *
 * Built conditionally rather than spread: `exactOptionalPropertyTypes` is on, and
 * `{ variantId: undefined }` is a different type from `{}` - only one of which the
 * engine's `PlaceableAsset` accepts.
 */
function toPlaceable(placeable: ScenePlaceable): PlaceableAsset {
  return {
    instance: placeable.instance,
    label: placeable.label,
    assetId: placeable.assetId,
    assetVersionId: placeable.assetVersionId,
    band: placeable.band,
    clipVocabulary: placeable.clipVocabulary,
    ...(placeable.variantId === undefined ? {} : { variantId: placeable.variantId }),
    ...(placeable.entityRef === undefined ? {} : { entityRef: placeable.entityRef }),
  };
}
