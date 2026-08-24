/**
 * S8 Choreograph, wired: the shot list in the payload becomes a stored composition.
 *
 * The compile itself is `ChoreographShotsUseCase` and is pure. This is the joint, and
 * it makes two decisions the use case cannot.
 *
 * **Where the composition goes.** Into the same content-addressed store the studio's
 * `POST /api/compositions` writes to, under the hash of the document. So a
 * choreography that produced this exact cut before produces the same id, the render
 * that follows finds the same frames, and `compositions.contracts.ts`'s parenthetical -
 * "a composition store is what S8 will write into" - is now true rather than planned.
 *
 * **How the rest of the run finds it.** As a `composition:<sha256>` artefact on the
 * stage result. A run carries one payload for every stage, so a run that starts at S8
 * cannot name in its payload the composition S8 has not made yet; the run record is the
 * only channel that runs the right way. `composition-source.ts` is the other end of it,
 * and S9, S10 and S11 all read through that one function.
 *
 * Retargeted clip fragments are stored the same way and for the same reason: a fragment
 * is an `AnimationIR`, `AnimationClip.irHash` addresses one by content, and a walk
 * cycle rescaled onto this rig is a document somebody has to be able to fetch. There is
 * no clip *library* store in this build to promote them into - the payload carries the
 * library - so what this stage can do honestly is store what it derived and record the
 * binding.
 *
 * Nothing here spends money. S8 is arithmetic over the shot list: no provider, no
 * encoder, no generation, and therefore a stage a user can re-run while editing.
 */

import type { PipelineStageKey } from '@rv/contracts';
import {
  KeyframeMotionProvider,
  MotionProviderRegistry,
  ProceduralMotionProvider,
} from '@rv/anim-engine';
import {
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
import type { CompositionStore } from '../modules/compositions/composition.store';
import type { StageContext, StageHandler, StageOutput } from '../pipeline/stage';
import { ChoreographStageRequest } from './choreograph-stage.contracts';
import { ChoreographShotsUseCase, type ChoreographOutput } from './choreograph.use-case';
import { COMPOSITION_ARTIFACT_PREFIX } from './composition-source';
import type { Choreography } from './choreography.contracts';
import type { ChoreographyStore } from './choreography.store';

/** Frame rate for a cut whose style bible said nothing. The animation default. */
const DEFAULT_FPS = 24;

export interface ChoreographStageHandlerDeps {
  readonly compositions: CompositionStore;
  readonly choreography: ChoreographyStore;
  /**
   * The motion providers this build can author with.
   *
   * Injected rather than constructed here because the registry is the seam ADR-0008
   * exists to create: a physics or mocap provider arrives as a registration in the
   * composition root, and this stage does not change.
   */
  readonly motion: MotionProviderRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** The two providers this build ships. Registration order is selection order. */
export function defaultMotionProviders(): MotionProviderRegistry {
  const registry = new MotionProviderRegistry();
  registry.registerAll([new KeyframeMotionProvider(), new ProceduralMotionProvider()]);
  return registry;
}

export class ChoreographStageHandler implements StageHandler {
  readonly stage: PipelineStageKey = 'choreograph';
  readonly implemented = true;
  readonly #deps: ChoreographStageHandlerDeps;

  constructor(deps: ChoreographStageHandlerDeps) {
    this.#deps = deps;
  }

  async execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    const parsed = ChoreographStageRequest.safeParse(context.job.payload.choreograph);
    if (!parsed.success) {
      return err(toValidationError(parsed.error, 'run.payload.choreograph'));
    }
    const request = parsed.data;

    context.reportProgress({
      progress: 0.1,
      detail: `choreographing ${String(request.shots.length)} shots`,
      item: { kind: 'shot', key: 'compile', index: 0, total: request.shots.length },
    });

    const useCase = new ChoreographShotsUseCase(this.#deps.motion);
    const compiled = await useCase.execute({
      shots: request.shots,
      fps: request.fps ?? request.motion?.fps ?? DEFAULT_FPS,
      // The run's seed, never the payload's: a run that could name a second seed would
      // make two replays of one payload diverge.
      seed: context.run.seed,
      name: request.name ?? defaultName(request.shots.length),
      motion: request.motion,
      ambient: request.ambient,
      speakers: request.speakers,
      rigs: request.rigs,
      library: request.library,
      variants: request.variants,
    });
    if (isErr(compiled)) return compiled;

    context.reportProgress({ progress: 0.7, detail: 'storing the composition' });

    const stored = await this.#deps.compositions.store(compiled.value.ir, request.name);
    if (isErr(stored)) return stored;

    const fragments = await this.#storeFragments(compiled.value);
    if (isErr(fragments)) return fragments;

    const record: Choreography = {
      compositionId: stored.value.id,
      animationId: compiled.value.ir.id,
      sceneSpace: compiled.value.ir.sceneSpace,
      fps: compiled.value.ir.fps,
      durationMs: compiled.value.ir.durationMs,
      shots: [...compiled.value.shots],
      clips: [...compiled.value.bindings],
      createdAt: toIso(this.#deps.clock.now()),
    };
    const saved = await this.#deps.choreography.save(record);
    if (isErr(saved)) return saved;

    this.#deps.logger.info('choreographed', {
      compositionId: stored.value.id,
      shots: compiled.value.shots.length,
      nodes: compiled.value.ir.nodes.length,
      durationMs: compiled.value.ir.durationMs,
    });

    context.reportProgress({
      progress: 1,
      detail:
        `${String(compiled.value.ir.nodes.length)} nodes, ` +
        `${String(compiled.value.ir.tracks.length)} tracks, ` +
        `${String(compiled.value.ir.behaviours.length)} behaviours`,
    });

    return ok({
      artifacts: [
        `${COMPOSITION_ARTIFACT_PREFIX}${stored.value.id}`,
        `animation:${compiled.value.ir.id}`,
        `shots:${String(compiled.value.shots.length)}`,
        ...fragments.value,
      ],
    });
  }

  /**
   * Every retargeted fragment, stored by content.
   *
   * A failure here fails the stage rather than being logged: the binding on the record
   * says a fragment exists at that hash, and a record that points at a document nobody
   * stored is worse than no record.
   */
  async #storeFragments(output: ChoreographOutput): Promise<Result<string[], AppError>> {
    const artifacts: string[] = [];
    for (const fragment of output.fragments) {
      // No label: the fragment carries its own name, and a synthesised one would have
      // to be length-checked against `Label` for no gain.
      const stored = await this.#deps.compositions.store(fragment.ir);
      if (isErr(stored)) return stored;
      artifacts.push(`clip:${fragment.instance}:${fragment.clip}:${stored.value.id}`);
    }
    return ok(artifacts);
  }
}

function defaultName(shots: number): string {
  return `untitled cut, ${String(shots)} shots`;
}
