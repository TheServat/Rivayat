/**
 * The style bible, reduced to what a writing stage can use.
 *
 * The story stages are not allowed to depend on the whole `StyleBible`: they would then
 * break whenever a render-only field moved, and a test would have to build a complete
 * locked bible - checksum, seed, easings and all - to write a line of dialogue.
 *
 * What they actually need is three things. The **compiled prompt fragments**, because a
 * character-state description is only a usable image prompt if the style clause is
 * already in it. The **silhouette rule and shape language**, because that is what makes a
 * derived visual descriptor answerable to the art direction rather than to taste. And the
 * **palette names**, so a character's colours can be chosen from the series' own set
 * instead of invented beside it.
 */

import type { StyleBible, StyleBibleId } from '@rv/contracts';

export interface StyleBrief {
  readonly styleBibleId?: StyleBibleId;
  readonly name: string;
  readonly medium: string;
  /** Prepended to every generation. Frozen with the checksum; never edited downstream. */
  readonly positiveFragment: string;
  readonly negativeFragment: string;
  /** The extra clause for character subjects, when the bible declares one. */
  readonly characterFragment?: string;
  readonly paletteNames: readonly string[];
  /** "recognisable as a black shape at 64px" - the readability contract for every design. */
  readonly silhouetteRule: string;
  readonly shapeNote: string;
}

/** Reads a brief off a bible, so the two cannot drift. */
export function styleBriefFrom(bible: StyleBible): StyleBrief {
  const { shape } = bible.visual;
  return {
    styleBibleId: bible.id,
    name: bible.name,
    medium: bible.visual.medium,
    positiveFragment: bible.prompts.positive,
    negativeFragment: bible.prompts.negative,
    ...(bible.prompts.bySubject.character === undefined
      ? {}
      : { characterFragment: bible.prompts.bySubject.character }),
    paletteNames: bible.visual.palette.colors.map((color) =>
      color.role === undefined ? color.name : `${color.name} (${color.role})`,
    ),
    silhouetteRule: shape.silhouetteRule,
    shapeNote:
      `roundness ${shape.roundness.toFixed(2)}, exaggeration ${shape.exaggeration.toFixed(2)}, ` +
      `${shape.headToBodyRatio.toFixed(1)} heads tall, detail density ${shape.detailDensity.toFixed(2)}`,
  };
}
