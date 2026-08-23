/**
 * Scored, repaired a bounded number of times, and then handed to a human (RV-128).
 *
 * The failure this exists to prevent is not "a bad asset shipped" - it is "a bad asset
 * shipped **silently**". So the gate has exactly three outcomes and no fourth:
 *
 *  - `accepted` - every threshold met.
 *  - `repaired` - a retry met them, and the trail of attempts is on the result.
 *  - `needs-review` - the retries ran out. The verdict is `rejected`, the version is
 *    *not* registered, and the caller has the scores and the reason to put in front of
 *    someone. A test asserts the registry was never called on this path, because an
 *    "almost good enough" asset quietly entering the library is how a style drifts.
 *
 * Repair is a prompt clause, not a different model. The gate knows which criteria
 * failed and turns each into an instruction; the caller re-composes the request with it
 * (`ComposeRequestInput.repairClause`) and regenerates. Every retry is metered by
 * whatever ran the generation, which is why the gate does not do the generating itself.
 */

import { type AppError, type Result, isErr, ok } from '@rv/shared-kernel';
import type { AssetSpec, QualityScores, StyleBible } from '@rv/contracts';
import type { ImagePayload, VisionScore, VisionScoringPort } from '@rv/providers';

import {
  ALPHA_CLEANLINESS,
  IDENTITY_MATCH,
  type MeasuredScores,
  PART_COMPLETENESS,
  SILHOUETTE,
  STYLE_MATCH,
  buildRubric,
  mergeMeasuredScores,
} from './rubric';

export interface QualityThresholds {
  /** Weighted mean below which the take is rejected however good its parts. */
  readonly overall: number;
  /** Per-criterion floors. A criterion absent from the map has no floor of its own. */
  readonly perCriterion: Readonly<Record<string, number>>;
  /** Bounded repair attempts. RV-128's N, default 2. */
  readonly maxRepairs: number;
}

export const DEFAULT_THRESHOLDS: QualityThresholds = {
  overall: 0.7,
  perCriterion: {
    [STYLE_MATCH]: 0.6,
    [SILHOUETTE]: 0.5,
    [IDENTITY_MATCH]: 0.7,
    [ALPHA_CLEANLINESS]: 0.85,
    [PART_COMPLETENESS]: 0.999,
  },
  maxRepairs: 2,
};

export interface QualityGateDeps {
  readonly vision: VisionScoringPort;
  readonly thresholds?: QualityThresholds;
}

export interface ScoreAttempt {
  readonly image: ImagePayload;
  readonly measured: MeasuredScores;
}

export interface QualityGateInput {
  readonly spec: AssetSpec;
  readonly style: StyleBible;
  /** The take under test. */
  readonly attempt: ScoreAttempt;
  /** Style anchors and the identity turnaround, for the comparison criteria. */
  readonly references?: readonly ImagePayload[];
  /** How many repairs have already been spent on this asset. */
  readonly repairsSoFar?: number;
}

export type QualityVerdict = 'accepted' | 'needs-review';

export interface QualityGateOutput {
  readonly verdict: QualityVerdict;
  readonly scores: QualityScores;
  readonly detail: readonly VisionScore[];
  /** Criteria that came in under their floor, worst first. */
  readonly failures: readonly {
    readonly key: string;
    readonly score: number;
    readonly floor: number;
  }[];
  /**
   * The clause to append to the next prompt, when another attempt is allowed.
   *
   * `undefined` on acceptance, and also when the repair budget is spent - which is the
   * signal to stop rather than an invitation to try once more.
   */
  readonly repairClause: string | undefined;
  readonly repairsRemaining: number;
}

export class QualityGateUseCase {
  readonly #vision: VisionScoringPort;
  readonly #thresholds: QualityThresholds;

  constructor(deps: QualityGateDeps) {
    this.#vision = deps.vision;
    this.#thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS;
  }

  async execute(input: QualityGateInput): Promise<Result<QualityGateOutput, AppError>> {
    const rubric = buildRubric(input.style, input.spec);

    const scored = await this.#vision.score({
      image: input.attempt.image,
      rubric,
      ...(input.references === undefined ? {} : { references: input.references }),
    });
    if (isErr(scored)) return scored;

    const merged = mergeMeasuredScores(scored.value.scores, input.attempt.measured, rubric);
    const byKey = new Map(merged.scores.map((score) => [score.key, score.score]));

    const failures = Object.entries(this.#thresholds.perCriterion)
      .flatMap(([key, floor]) => {
        const score = byKey.get(key);
        // A criterion the rubric did not ask about - `identity-match` on a tree - has no
        // score and cannot fail. Treating an absent score as 0 would reject every prop.
        if (score === undefined || score >= floor) return [];
        return [{ key, score, floor }];
      })
      .sort((left, right) => left.score - right.score || left.key.localeCompare(right.key));

    if (merged.overall < this.#thresholds.overall) {
      failures.push({ key: 'overall', score: merged.overall, floor: this.#thresholds.overall });
    }

    const repairsRemaining = Math.max(0, this.#thresholds.maxRepairs - (input.repairsSoFar ?? 0));
    const passed = failures.length === 0;

    return ok({
      verdict: passed ? 'accepted' : 'needs-review',
      scores: toQualityScores(byKey, merged.overall),
      detail: merged.scores,
      failures,
      repairClause:
        passed || repairsRemaining === 0 ? undefined : repairClauseFor(failures, input.style),
      repairsRemaining,
    });
  }
}

/**
 * The rubric's five keys, in the shape the version record stores.
 *
 * `identityMatch` stays absent rather than defaulting: `QualityScores` marks it
 * "characters only", and a tree recorded with `identityMatch: 0` would drag every
 * aggregate report downward for a criterion that never applied to it.
 */
function toQualityScores(byKey: ReadonlyMap<string, number>, overall: number): QualityScores {
  const identity = byKey.get(IDENTITY_MATCH);
  return {
    styleMatch: byKey.get(STYLE_MATCH) ?? 0,
    alphaCleanliness: byKey.get(ALPHA_CLEANLINESS) ?? 0,
    silhouetteReadability: byKey.get(SILHOUETTE) ?? 0,
    ...(identity === undefined ? {} : { identityMatch: identity }),
    partCompleteness: byKey.get(PART_COMPLETENESS) ?? 0,
    overall,
  };
}

/**
 * One instruction per failed criterion, in the words that will change the picture.
 *
 * Deliberately specific to what failed. "Try harder" is the repair prompt that produces
 * the same image with a different seed; "thicken the outline and flatten the shading"
 * is one the model can act on.
 */
function repairClauseFor(
  failures: readonly { readonly key: string; readonly score: number }[],
  style: StyleBible,
): string {
  const instructions = failures.flatMap((failure) => {
    const build = REPAIRS[failure.key];
    return build === undefined ? [] : [build(style)];
  });
  if (instructions.length === 0) return 'Increase overall fidelity to the style anchors';
  return `Correct the previous attempt: ${instructions.join('; ')}`;
}

const REPAIRS: Readonly<Record<string, (style: StyleBible) => string>> = {
  [STYLE_MATCH]: (style) =>
    `match the ${style.visual.medium} medium and ${style.visual.shading.model} shading exactly, and remove anything resembling ${style.visual.negative.join(' or ') || 'other styles'}`,
  [SILHOUETTE]: (style) => `strengthen the silhouette so that ${style.visual.shape.silhouetteRule}`,
  [IDENTITY_MATCH]: () =>
    'keep the face, build, markings and wardrobe identical to the reference turnaround',
  [ALPHA_CLEANLINESS]: () =>
    'place every component on a flat, unshaded background field with no cast shadow, glow or gradient behind it',
  [PART_COMPLETENESS]: () =>
    'draw every listed component separately, fully visible, with clear empty space between them and no overlaps',
};
