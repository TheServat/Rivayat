import type { EpistemicStanding } from '../api/epistemic';

/**
 * The stroke pattern each epistemic standing is drawn with.
 *
 * One table, read by the legend chip and by the diagram that draws the edges, so the
 * two cannot disagree. It exists because colour may not be the only signal separating
 * *knows* from *believes falsely*: the pattern is the channel that survives a
 * monochrome print, a colour-blind reader and a low-contrast display, and the legend is
 * only worth having if it shows the same pattern the graph uses.
 */
export const STANDING_DASH: Readonly<Record<EpistemicStanding, string>> = {
  knows: '0',
  witnessed: '0',
  told: '6 3',
  'believes-falsely': '5 2 1 2',
  suspects: '1 3',
  blind: '1 4',
};

/** Stroke width, so a held fact reads heavier than one the viewer only might hold. */
export const STANDING_WIDTH: Readonly<Record<EpistemicStanding, number>> = {
  knows: 1.6,
  witnessed: 2.2,
  told: 1.6,
  'believes-falsely': 2,
  suspects: 1.4,
  blind: 1.2,
};

/**
 * The catalogue key for each standing.
 *
 * The domain spells `believes-falsely` in kebab case and a message catalogue cannot,
 * so the translation between the two lives here once instead of in every component
 * that needs to name a standing out loud.
 */
export const STANDING_MESSAGE_KEY: Readonly<Record<EpistemicStanding, string>> = {
  knows: 'knows',
  witnessed: 'witnessed',
  told: 'told',
  'believes-falsely': 'believesFalsely',
  suspects: 'suspects',
  blind: 'blind',
};
