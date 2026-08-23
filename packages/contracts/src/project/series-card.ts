/**
 * `SeriesCard` - a series before it has a bible.
 *
 * `SeriesBible` (`story/story-bible.ts`) is the planned series: it requires at least one
 * season holding at least one episode, and every one of those requirements is correct
 * for a series that has been through S2. None of them is true of a series that was
 * created ten seconds ago and has a title and a sentence, which is the state a series
 * spends its whole first session in.
 *
 * Widening `SeriesBible` to allow an empty season list would make "a series has
 * episodes" unenforceable for the case that matters. So there are two shapes, and the
 * boundary between them is `hasBible`: the card is the row, the bible is the plan, and
 * the card records only whether the plan exists.
 *
 * It lived in `apps/api/src/application/resources.ts` for the same reason `Project` did
 * - nothing upstream described it - and its header there names this file as the fix.
 */

import { z } from 'zod';

import { IsoInstant, Label, Prose } from '../primitives/common';
import { ProjectId, SeriesId } from '../primitives/ids';

/**
 * The series row, as it exists from creation onward.
 *
 * `hasBible` is a flag rather than a nullable `SeriesBible` because the bible is large,
 * separately stored and separately versioned: a list of series has to answer "which of
 * these have been planned" without loading a dozen act trees to find out.
 */
export const SeriesCard = z.strictObject({
  id: SeriesId,
  projectId: ProjectId,
  title: Label,
  premise: Prose.describe('What the series is about, in the author’s words. One paragraph.'),
  hasBible: z
    .boolean()
    .default(false)
    .describe('Set once S2 has produced a `SeriesBible` for it. Never inferred from the title.'),
  createdAt: IsoInstant,
});
export type SeriesCard = z.infer<typeof SeriesCard>;
