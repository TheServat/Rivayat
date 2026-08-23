/**
 * One composition, seven deliverables - as a value.
 *
 * `ReframePlan`'s own docstring makes the claim this file has to honour: "a plan is a
 * value, not a side effect: it is computed, shown, editable, and only then rendered.
 * That is what makes 're-framing to another aspect ratio costs $0' true." So building a
 * plan touches no files, spawns no processes and generates nothing - it is arithmetic
 * over the shot list, and the seven plans for a 90-second episode take about a
 * millisecond between them.
 *
 * The plan is also where `needsReview` is set, and that is the single most important
 * line in the module. A silent bad crop ships a face behind the follow button; a
 * flagged one costs someone thirty seconds. The schema refuses a plan that carries a
 * violation without the flag, so the two cannot drift.
 */

import { ValidationError, err, ok, type AppError, type Result } from '@rv/shared-kernel';
import {
  FORMAT_PRESETS,
  type FormatProfile,
  type FormatProfileId,
  type ReframePlan,
  type ShotReframe,
  type Size,
} from '@rv/contracts';

import { solveShotCrop, type ShotFraming, type SolveOptions } from './solve-crop';

export interface ReframeInput {
  /** The format-agnostic authoring canvas - `AnimationIR.sceneSpace`. */
  readonly composition: Size;
  /** In timeline order. At least one; `ReframePlan.shots` has a `.min(1)`. */
  readonly shots: readonly ShotFraming[];
}

export interface BuildPlanOptions extends SolveOptions {
  /** Cap on the notes carried on the plan. `ReframePlan.notes` allows 32. */
  readonly maxNotes?: number;
}

const MAX_PLAN_NOTES = 32;

/**
 * Solve every shot for one delivery format.
 *
 * Returns a `Result` rather than throwing because an empty shot list is caller input,
 * not a bug here - the pipeline can legitimately reach delivery with an episode whose
 * choreography stage produced nothing, and that should surface as a typed failure.
 */
export function buildReframePlan(
  input: ReframeInput,
  profile: FormatProfile,
  options: BuildPlanOptions = {},
): Result<ReframePlan, AppError> {
  if (input.shots.length === 0) {
    return err(
      new ValidationError({
        message: 'cannot build a reframe plan for a composition with no shots',
        context: { format: profile.id },
      }),
    );
  }

  const shots: ShotReframe[] = [];
  const notes: string[] = [];

  for (const shot of input.shots) {
    const solved = solveShotCrop(shot, input.composition, profile.size, profile.safeArea, options);
    notes.push(...solved.notes);
    shots.push({
      shotId: shot.shotId,
      strategy: solved.strategy,
      sourceCrop: solved.sourceCrop,
      panTo: solved.panTo,
      focusPoint: solved.focusPoint,
      scale: solved.scale,
      safeAreaViolation: solved.safeAreaViolation,
      layoutOverrides: [],
    });
  }

  const needsReview = shots.some((shot) => shot.safeAreaViolation);

  return ok({
    format: profile.id,
    targetSize: profile.size,
    // Copied, not referenced: `ReframePlan.safeArea` exists so a stored plan stays
    // interpretable after the preset table changes underneath it.
    safeArea: profile.safeArea,
    shots,
    layoutOverrides: [],
    needsReview,
    notes: notes.slice(0, options.maxNotes ?? MAX_PLAN_NOTES),
  });
}

/**
 * A plan per requested format.
 *
 * All-or-nothing: a delivery that silently skipped the one format whose plan failed
 * would produce six files and a missing seventh that nobody notices until the schedule
 * slips.
 */
export function buildReframePlans(
  input: ReframeInput,
  formats: readonly FormatProfileId[],
  options: BuildPlanOptions = {},
): Result<ReadonlyMap<FormatProfileId, ReframePlan>, AppError> {
  const plans = new Map<FormatProfileId, ReframePlan>();
  for (const format of formats) {
    const plan = buildReframePlan(input, FORMAT_PRESETS[format], options);
    if (!plan.ok) return plan;
    plans.set(format, plan.value);
  }
  return ok(plans);
}
