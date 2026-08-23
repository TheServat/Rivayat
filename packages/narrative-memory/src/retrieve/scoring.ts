/**
 * The scoring function from docs/02 §4, and nothing else.
 *
 * ```
 * score(fact) = w1·graphProximity  + w2·semanticSimilarity + w3·storyRecency
 *             + w4·importance      + w5·isOpenLoop
 * ```
 *
 * Pure, so it can be checked term by term. Every component returns `[0,1]` and the total
 * is divided by the sum of the weights - not because docs/02 asks for it, but because
 * `RetrievedFact.score` is a `Unit01` and a caller who sets all five weights to 1 would
 * otherwise produce a 5 and fail validation at the boundary. Normalising also makes two
 * runs with differently-scaled weights comparable, which is what a weight-tuning
 * diagnostic needs.
 *
 * Determinism is a property of every term here: no clock, no randomness, no map
 * iteration, and every input is either the graph or the request.
 */

import type {
  Importance,
  RetrievalScoreBreakdown,
  RetrievalWeights,
  StoryTime,
} from '@rv/contracts';

/**
 * Narrative weight as a number.
 *
 * `mentioned` is 0 rather than a small positive value: a name dropped once should never
 * outrank anything on importance alone, and the other four terms still let it in when
 * it is genuinely relevant.
 */
export const IMPORTANCE_SCORE: Readonly<Record<Importance, number>> = {
  lead: 1,
  supporting: 0.75,
  recurring: 0.5,
  background: 0.25,
  mentioned: 0,
};

/**
 * Hop distance to a score.
 *
 * `1/(1+d)`: a seed entity scores 1, one hop 0.5, two hops 0.33. Harmonic rather than
 * linear because the interesting cliff is between "in this scene" and "not in this
 * scene"; past two hops the graph has stopped discriminating anyway, which is why
 * `maxHops` is capped at 4 in the request schema.
 */
export function proximityScore(distance: number | undefined): number {
  if (distance === undefined) return 0;
  return 1 / (1 + Math.max(0, distance));
}

/**
 * Cosine similarity, floored at 0.
 *
 * Negative cosine means "points the other way", which for prose embeddings is noise
 * rather than anti-relevance. Mapping `[-1,1]` onto `[0,1]` instead would hand every
 * unrelated fact a free 0.5 and flatten the term into a constant.
 */
export function similarityScore(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return Math.min(1, Math.max(0, dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))));
}

/**
 * How recent, in story time, relative to the oldest fact in play.
 *
 * Normalised against the actual span rather than against an absolute scale, because
 * story ordinals are arbitrary - a series may number its beats 0-100 or 1204-1209, and a
 * fixed decay constant would make the term a no-op in one and a step function in the
 * other.
 *
 * A fact that begins after the scene it is being retrieved for scores 0: it has not
 * happened yet, and only a retro-fit puts one in the candidate set at all.
 */
export function recencyScore(
  validFrom: StoryTime | null,
  at: StoryTime,
  oldestOrdinal: number,
): number {
  const from = validFrom?.ordinal ?? oldestOrdinal;
  if (from > at.ordinal) return 0;
  const span = at.ordinal - oldestOrdinal;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - (at.ordinal - from) / span));
}

export function importanceScore(importance: Importance): number {
  return IMPORTANCE_SCORE[importance];
}

/**
 * The weighted total.
 *
 * Divided by the weight sum so the result is always a `Unit01`. A caller who zeroes
 * every weight gets 0 rather than `NaN` - a degenerate request should return an
 * unranked list, not poison the sort.
 */
export function weightedTotal(
  breakdown: RetrievalScoreBreakdown,
  weights: RetrievalWeights,
): number {
  const sum =
    weights.graphProximity +
    weights.semanticSimilarity +
    weights.storyRecency +
    weights.importance +
    weights.isOpenLoop;
  if (sum <= 0) return 0;
  const total =
    weights.graphProximity * breakdown.graphProximity +
    weights.semanticSimilarity * breakdown.semanticSimilarity +
    weights.storyRecency * breakdown.storyRecency +
    weights.importance * breakdown.importance +
    weights.isOpenLoop * breakdown.isOpenLoop;
  return Math.min(1, Math.max(0, total / sum));
}

/** All five terms zeroed. The shape an always-included candidate reports. */
export const ZERO_BREAKDOWN: RetrievalScoreBreakdown = Object.freeze({
  graphProximity: 0,
  semanticSimilarity: 0,
  storyRecency: 0,
  importance: 0,
  isOpenLoop: 0,
});
