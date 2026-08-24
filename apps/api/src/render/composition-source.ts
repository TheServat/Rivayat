/**
 * Which composition a stage is acting on, when the run did not spell it out.
 *
 * S8 produces an `AnimationIR` and S9, S10 and S11 all consume one, but a run carries
 * **one payload for every stage** - `PipelineRunner` hands each job `state.payload`
 * unchanged - so the run that starts at S8 cannot possibly name in its payload the
 * composition S8 has not made yet. Something has to carry the result forward.
 *
 * The run record already does. Each stage runs as its own job and re-reads the run, so
 * `context.run.stages` holds what the earlier stages produced, as the same `kind:ref`
 * strings the screen renders. S8 records `composition:<sha256>`, and that is the seam:
 * a later stage with nothing in its payload takes the composition its own run produced.
 *
 * It is deliberately a *fallback*, never an override. An explicit `ir` or
 * `compositionId` in the payload wins, because a run that names its input is making a
 * claim about what is being rendered and silently substituting something else - even
 * something the same run made - would break ADR-0001's "reproducible from its input
 * alone" in the direction nobody checks.
 */

import type { AnimationIR } from '@rv/contracts';
import { ValidationError, err, isErr, ok, type AppError, type Result } from '@rv/shared-kernel';

import type { CompositionStore } from '../modules/compositions/composition.store';
import type { RunSummary } from '../application/resources';
import type { StageContext } from '../pipeline/stage';
import { RenderStageRequest } from './render-stage.contracts';

/** What S8 records so the rest of the run can find what it made. */
export const COMPOSITION_ARTIFACT_PREFIX = 'composition:';

/**
 * The composition an earlier stage of this run stored, or `null`.
 *
 * The *last* one wins: a run that choreographed twice - S8 re-run after an edit - has
 * two, and the later one is the cut the rest of the pipeline is about.
 */
export function upstreamCompositionId(run: RunSummary): string | null {
  let found: string | null = null;
  for (const stage of run.stages) {
    if (stage.status !== 'succeeded') continue;
    for (const artifact of stage.artifacts) {
      if (artifact.startsWith(COMPOSITION_ARTIFACT_PREFIX)) {
        found = artifact.slice(COMPOSITION_ARTIFACT_PREFIX.length);
      }
    }
  }
  return found;
}

/** How a stage payload names its composition. Both absent means "ask the run". */
export interface CompositionRequest {
  readonly ir?: AnimationIR | undefined;
  readonly compositionId?: string | undefined;
}

/**
 * Where a stage looks for its composition, in order.
 *
 * Three places, and the order is the order of specificity:
 *
 *  1. **The stage's own payload.** An explicit claim about what this stage is acting on.
 *  2. **The render's payload.** One run carries one payload, and a run that says "render
 *     this" has said what the whole run is about - so previewing and delivering a
 *     *different* composition from the one being rendered would be surprising rather
 *     than flexible. This is what lets `['preview', 'render', 'deliver']` be started
 *     with the composition named once.
 *  3. **What this run produced.** The `composition:` artefact S8 recorded.
 *
 * Returns a reference rather than a composition, so the caller decides whether "no
 * composition anywhere" is a failure (S9 and S10 cannot proceed) or a fact to work
 * around (S11 can still deliver, it simply cannot follow a subject).
 */
export function compositionReference(
  context: StageContext,
  own: CompositionRequest,
): CompositionRequest {
  if (own.ir !== undefined) return { ir: own.ir };
  if (own.compositionId !== undefined) return { compositionId: own.compositionId };

  const render = RenderStageRequest.safeParse(context.job.payload.render);
  if (render.success && render.data.ir !== undefined) return { ir: render.data.ir };
  if (render.success && render.data.compositionId !== undefined) {
    return { compositionId: render.data.compositionId };
  }

  const upstream = upstreamCompositionId(context.run);
  return upstream === null ? {} : { compositionId: upstream };
}

/** The composition, and the address it came from when it came from the store. */
export interface ResolvedComposition {
  readonly ir: AnimationIR;
  /** `null` for an IR that travelled inline and was therefore never stored. */
  readonly compositionId: string | null;
}

/**
 * A payload reference, plus the run it was made in, to the composition itself.
 *
 * A reference that names nothing is a *validation* failure rather than a not-found:
 * from the stage's point of view the payload is wrong, and "your composition does not
 * exist" is easier to act on than a 404 for a resource nobody asked for by name.
 */
export class CompositionSource {
  readonly #store: CompositionStore;

  constructor(store: CompositionStore) {
    this.#store = store;
  }

  async resolve(
    request: CompositionRequest,
    run: RunSummary,
    field: string,
  ): Promise<Result<ResolvedComposition, AppError>> {
    if (request.ir !== undefined) return ok({ ir: request.ir, compositionId: null });

    const id = request.compositionId ?? upstreamCompositionId(run);
    if (id === null) {
      return err(
        new ValidationError({
          message:
            `${field} names no composition: supply \`ir\` or \`compositionId\`, ` +
            'or run the choreograph stage first so this run produces one',
          context: { field },
        }),
      );
    }

    const found = await this.#store.find(id);
    if (isErr(found)) return found;
    if (found.value === null) {
      return err(
        new ValidationError({
          message: `No composition is stored under ${id}; store it first with POST /api/compositions`,
          context: { field, compositionId: id },
        }),
      );
    }
    return ok({ ir: found.value.ir, compositionId: id });
  }
}
