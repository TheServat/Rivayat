/**
 * S0 Intake, as the studio sends and receives it.
 *
 * `Brief` is imported from the contracts rather than restated: it is a discriminated
 * union of five source kinds, the server picks an intake front door by `kind`, and a
 * hand-written copy here would drift the moment a sixth is added. The studio offers the
 * `idea` door - a sentence the author types - and the union is what keeps the other four
 * reachable without a second schema.
 */

import { Brief, CastCandidate, SeriesId } from '@rv/contracts';
import { z } from 'zod';

export const StoryBrief = Brief;
export type StoryBrief = z.infer<typeof StoryBrief>;

/**
 * What S0 leaves behind.
 *
 * The shortlist is named rather than folded into a success flag, because it is the thing
 * that was missing: a screen that could only report "intake ran" would give no way to
 * see that it produced nothing.
 */
export const IntakeReport = z.strictObject({
  seriesId: SeriesId,
  workingTitle: z.string().min(1),
  premise: z.string().min(1),
  castCandidates: z.array(CastCandidate),
});
export type IntakeReport = z.infer<typeof IntakeReport>;
