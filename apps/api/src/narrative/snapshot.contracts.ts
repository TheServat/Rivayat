/**
 * The graph as one screen reads it: both clocks, and the points worth standing on.
 *
 * Same standing as `story/story.contracts.ts` - the studio declared these first, in
 * `apps/web/src/features/characters/api/graph.ts`, and they belong in `@rv/contracts`.
 * The two shapes that carry the actual data, `Entity` and `Relation`, are imported
 * verbatim from there and not restated; what is added is the envelope and the two things
 * a graph *screen* needs that the domain has no reason to carry.
 *
 * **`storyMarks`** are the stops on the story-time slider. A bi-temporal standpoint is
 * the feature of that screen, and a slider needs stops: the ordinals the series actually
 * uses, not a free integer range. Derived here, because a client that invented them
 * would let a user stand at a moment no fact was ever asserted about and conclude the
 * graph is empty.
 *
 * **`revisions`** are the stops on the *authoring* slider, which is the half of the
 * model with no other way to be reached. Without a list of instants worth standing at,
 * "replay the graph as it stood before the retro-fit" is a date picker, and nobody will
 * ever use a date picker for that.
 */

import { Entity, IsoInstant, Label, Prose, Relation, SeriesId, StoryTime } from '@rv/contracts';
import { z } from 'zod';

/**
 * A point on the story clock worth standing on.
 *
 * `ordinal` is the value everything is compared against. `label` is **optional and only
 * for a moment the fiction has a name for** - it is carried through from the author's own
 * `validFrom.label`, never composed here. A plain episode number is not a label: it is a
 * number, and the interface renders numbers in the reader's own numerals. Composing
 * "Episode 5" on this side would ship Latin digits into a Persian page that cannot
 * re-format them, because parsing a localised string back into a number is the one thing
 * the studio never does.
 */
export const StoryMark = z.strictObject({
  at: StoryTime,
  label: Label.optional(),
});
export type StoryMark = z.infer<typeof StoryMark>;

/**
 * A named point on the authoring clock: a moment the graph is worth replaying at.
 *
 * `label` says **where the assertions made at that instant came from** - `author`,
 * `episode`, `inferred` - and not how many there were. A count would be a number in the
 * label, which has the same problem `StoryMark.label` has, and the count is derivable
 * from the relation list the client already holds.
 */
export const GraphRevision = z.strictObject({
  at: IsoInstant,
  label: Label,
  note: Prose.optional(),
});
export type GraphRevision = z.infer<typeof GraphRevision>;

export const NarrativeSnapshot = z.strictObject({
  seriesId: SeriesId,
  entities: z.array(Entity).max(2048).default([]),
  relations: z.array(Relation).max(8192).default([]),
  storyMarks: z.array(StoryMark).max(512).default([]),
  revisions: z.array(GraphRevision).max(256).default([]),
});
export type NarrativeSnapshot = z.infer<typeof NarrativeSnapshot>;

/**
 * The query behind `GET /api/series/:id/entities/:entityId/view`.
 *
 * Both clocks, both optional, and they mean different things when omitted. `at` absent
 * is "the latest moment the series uses"; `asOf` absent is "as we believe it **now**",
 * which is not the same query as any past instant - it keeps assertions that have never
 * been retracted, rather than assertions that had not *yet* been retracted at some
 * moment. Getting that distinction wrong is how a reveal retroacts into an earlier
 * scene's view.
 */
export const EpistemicViewQuery = z.strictObject({
  at: z.coerce.number().int().optional(),
  asOf: IsoInstant.optional(),
});
export type EpistemicViewQuery = z.infer<typeof EpistemicViewQuery>;
