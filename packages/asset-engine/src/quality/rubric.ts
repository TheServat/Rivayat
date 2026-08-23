/**
 * The rubric, derived from the style bible rather than written beside it.
 *
 * Architecture §5 names the five criteria - style match, alpha cleanliness, silhouette
 * readability, character-identity match against the anchors, part completeness - and
 * the point of deriving the *questions* from the bible is that "on style" means
 * something different per project. A paper-cutout series and a watercolour series both
 * score `style-match`, and the sentence the vision model is asked to answer is not the
 * same sentence.
 *
 * Two of the five are **measured, not asked**. `alpha-cleanliness` and
 * `part-completeness` are arithmetic the pipeline already did - the stray-pixel
 * fraction from `raster/alpha` and the filled-plan ratio from the splitter - and asking
 * a vision model to guess at numbers we hold exactly would be strictly worse. They are
 * still in the rubric so the score sheet has all five, but they are folded in by
 * {@link mergeMeasuredScores} after the model has answered.
 */

import type { AssetSpec, StyleBible } from '@rv/contracts';
import type { VisionRubricCriterion, VisionScore } from '@rv/providers';

export const STYLE_MATCH = 'style-match';
export const SILHOUETTE = 'silhouette-readability';
export const IDENTITY_MATCH = 'identity-match';
export const ALPHA_CLEANLINESS = 'alpha-cleanliness';
export const PART_COMPLETENESS = 'part-completeness';

/** The criteria a vision model is actually asked about. */
export function buildRubric(style: StyleBible, spec: AssetSpec): VisionRubricCriterion[] {
  const medium =
    style.visual.medium === 'custom'
      ? (style.visual.mediumNote ?? 'the declared medium')
      : style.visual.medium;
  const palette = style.visual.palette.colors
    .map((colour) => `${colour.name} ${colour.hex}`)
    .join(', ');

  const criteria: VisionRubricCriterion[] = [
    {
      key: STYLE_MATCH,
      weight: 2,
      question: [
        `Does this read as ${medium} with ${style.visual.shading.model} shading,`,
        `${style.visual.line.present ? `a ${describeWeight(style.visual.line.weight)} outline` : 'no outline'},`,
        `and the palette (${palette})?`,
        `It must not contain: ${style.visual.negative.join(', ') || 'nothing in particular'}.`,
        '1 means indistinguishable from the style anchors, 0 means a different art style entirely.',
      ].join(' '),
    },
    {
      key: SILHOUETTE,
      weight: 1.5,
      question: [
        `Judged as a solid black shape, is the subject readable? The style rule is: ${style.visual.shape.silhouetteRule}.`,
        '1 means instantly identifiable in silhouette, 0 means an unreadable blob.',
      ].join(' '),
    },
  ];

  if (spec.subjectClass === 'character' || spec.subjectClass === 'creature') {
    criteria.push({
      key: IDENTITY_MATCH,
      weight: 2,
      question: [
        'Compared with the reference images, is this the same individual - same face, build, markings and wardrobe?',
        '1 means unmistakably the same character, 0 means a different character.',
      ].join(' '),
    });
  }

  return criteria;
}

/** Scores the pipeline computed itself, which the model is never asked to guess. */
export interface MeasuredScores {
  readonly alphaCleanliness: number;
  readonly partCompleteness: number;
}

/**
 * Folds the measured scores in beside the model's, and re-weights the overall.
 *
 * Re-weighting rather than averaging the two overalls: a rubric that gains a criterion
 * must not move the threshold, which is why every score is 0..1 and the overall is a
 * weighted mean rather than a sum.
 */
export function mergeMeasuredScores(
  modelScores: readonly VisionScore[],
  measured: MeasuredScores,
  rubric: readonly VisionRubricCriterion[],
): { scores: readonly VisionScore[]; overall: number } {
  const scores: VisionScore[] = [
    ...modelScores,
    {
      key: ALPHA_CLEANLINESS,
      score: clamp01(measured.alphaCleanliness),
      reason: 'Measured: fraction of semi-transparent pixels outside the 2px edge band.',
    },
    {
      key: PART_COMPLETENESS,
      score: clamp01(measured.partCompleteness),
      reason: 'Measured: fraction of required planned parts that came back usable.',
    },
  ];

  const weights = new Map(rubric.map((criterion) => [criterion.key, criterion.weight ?? 1]));
  weights.set(ALPHA_CLEANLINESS, 1);
  weights.set(PART_COMPLETENESS, 1.5);

  let weighted = 0;
  let total = 0;
  for (const score of scores) {
    const weight = weights.get(score.key) ?? 1;
    weighted += score.score * weight;
    total += weight;
  }

  return { scores, overall: total === 0 ? 0 : weighted / total };
}

function describeWeight(weight: number): string {
  return weight < 0.25 ? 'hairline' : weight < 0.6 ? 'medium' : 'heavy';
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
