/**
 * The rubric, written in the bible's own words.
 *
 * A generic "is this good art" question produces a generic answer. The criteria below
 * quote the style's actual medium, shading model, band count and silhouette rule back
 * at the scorer, so "style match" means match *this* style rather than match the
 * scorer's idea of nice.
 *
 * There is deliberately **no palette criterion**. Palette adherence is a distance
 * computation over pixels: exact, free, and identical between runs. Asking a model for
 * it would cost a call and return a number that moves. `score-style.ts` measures it.
 */

import type { StyleBible, VisualStyle } from '@rv/contracts';
import type { VisionRubricCriterion } from '@rv/providers';

import { MEDIUM_PHRASING } from '../prompts/medium';

/** Weights. Style match dominates because it is what the gate exists to protect. */
export const RUBRIC_WEIGHTS = {
  styleMatch: 3,
  silhouetteReadability: 2,
  alphaCleanliness: 2,
  identityMatch: 3,
} as const;

export const STYLE_MATCH_KEY = 'style-match';
export const SILHOUETTE_KEY = 'silhouette-readability';
export const ALPHA_KEY = 'alpha-cleanliness';
export const IDENTITY_KEY = 'identity-match';

function mediumSentence(visual: VisualStyle): string {
  const clause = MEDIUM_PHRASING[visual.medium].clause;
  return clause === '' ? (visual.mediumNote ?? visual.medium) : clause;
}

export interface BuildStyleRubricOptions {
  /** Adds the identity criterion. Only meaningful when anchors were actually sent. */
  readonly withIdentity?: boolean;
}

export function buildStyleRubric(
  bible: StyleBible,
  options: BuildStyleRubricOptions = {},
): readonly VisionRubricCriterion[] {
  const visual = bible.visual;
  const line = visual.line.present
    ? `outlines are present at roughly ${visual.line.weight <= 0.3 ? 'a fine' : visual.line.weight <= 0.6 ? 'a medium' : 'a heavy'} weight`
    : 'there are no outlines at all';

  const criteria: VisionRubricCriterion[] = [
    {
      key: STYLE_MATCH_KEY,
      weight: RUBRIC_WEIGHTS.styleMatch,
      question: [
        `Does this look like ${mediumSentence(visual)}?`,
        `It should use ${visual.shading.model} shading with about ${String(visual.shading.steps)} distinct tones, and ${line}.`,
        'Score 1 only if a viewer would file it with the reference style without hesitating.',
      ].join(' '),
    },
    {
      key: SILHOUETTE_KEY,
      weight: RUBRIC_WEIGHTS.silhouetteReadability,
      question: [
        'Imagine the subject filled in solid black at thumbnail size.',
        `Would it still be recognisable? The style's own rule is: ${visual.shape.silhouetteRule}`,
      ].join(' '),
    },
    {
      key: ALPHA_KEY,
      weight: RUBRIC_WEIGHTS.alphaCleanliness,
      question: [
        'Look at the outer edge of the subject.',
        'Is it free of halos, pale fringing, leftover background colour and semi-transparent smear?',
        'Score 1 for a clean cut, 0 for a visible matte line all the way round.',
      ].join(' '),
    },
  ];

  if (options.withIdentity === true) {
    criteria.push({
      key: IDENTITY_KEY,
      weight: RUBRIC_WEIGHTS.identityMatch,
      question:
        'Compared with the reference images, is this recognisably the same character or object - same proportions, same markings, same costume?',
    });
  }

  return criteria;
}
