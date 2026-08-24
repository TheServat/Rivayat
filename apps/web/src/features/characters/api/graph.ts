/**
 * What the Characters screen reads, composed from `@rv/contracts`.
 *
 * The two shapes that matter — `Entity` and `Relation`, both bi-temporal — are imported
 * verbatim, not restated. `EpistemicView` is imported too, even though nothing serves
 * it yet, because it is the shape the missing endpoint must answer with and naming it
 * here is what will make that swap a deletion rather than a rewrite.
 *
 * What is added is the *envelope* and two things a graph screen needs that the domain
 * has no reason to carry:
 *
 *  - **`storyMarks`** — the points on the story clock worth standing on. The bi-temporal
 *    standpoint is the feature of this screen, and a slider needs stops: the ordinals
 *    the series actually uses, not a free integer range. The API derives them from the
 *    episode list; the client must not invent them.
 *  - **`revisions`** — the labelled points on the *authoring* clock, which is the half
 *    of the model that has no other way to be reached. Without a list of instants worth
 *    standing at, "replay the graph as it stood before the retro-fit" is a date picker
 *    and nobody will ever use it.
 *
 * **Report — routes this screen needs and the API does not have:**
 *
 * | route                                                         | answers with       | story  |
 * | ------------------------------------------------------------- | ------------------ | ------ |
 * | `GET /api/series/:seriesId/graph`                              | `NarrativeSnapshot`| RV-207 |
 * | `GET /api/series/:seriesId/entities/:entityId/view`            | `EpistemicView`    | RV-063 |
 * | `GET /api/series/:seriesId/entities/:entityId/states`          | `CharacterStates`  | RV-206 |
 * | `PATCH /api/series/:seriesId/entities/:entityId/states/:key`   | `CharacterStateCell` | RV-083 |
 * | `POST /api/series/:seriesId/entities/:entityId/states/:key/generate` | `CharacterStateCell` | RV-206 |
 *
 * `POST /api/assets/resolve` already exists and is the right place for the *estimate*
 * behind a generate; it is not wired here because it needs an `AssetSpec` the studio
 * cannot assemble without the state grid it is trying to price.
 */

import {
  Entity,
  EpistemicView,
  IsoInstant,
  Label,
  NanoUsdAmount,
  Prose,
  Relation,
  SemanticKey,
  SeriesId,
  Slug,
  StoryTime,
  Unit01,
} from '@rv/contracts';
import { z } from 'zod';

export { Entity, EpistemicView, Relation };

// ── the two clocks, as points a person can choose between ───────────────────

/**
 * A point on the story clock worth standing on.
 *
 * `ordinal` is the value everything is compared against and is a Latin-digit number
 * wherever it travels. `label` is **optional and only for a moment the fiction has a
 * name for** - "Year 1204, first thaw". A plain episode number is not one: it is a
 * number, and a number is rendered in the reader's own numerals by the interface. A
 * label carrying "Episode 5" would ship Latin digits into a Persian page and could not
 * be re-formatted, because parsing a localised string back into a number is the one
 * thing the studio never does.
 */
export const StoryMark = z.strictObject({
  at: StoryTime,
  label: Label.optional(),
});
export type StoryMark = z.infer<typeof StoryMark>;

/** A named point on the authoring clock: a moment the graph is worth replaying at. */
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

// ── the state grid ──────────────────────────────────────────────────────────

/**
 * Where one cell of the grid stands.
 *
 * `stale` is the state RV-206 turns on: an edited prompt makes exactly that cell a
 * cache miss, and the grid has to say so *before* anything is regenerated. `rejected`
 * is not a missing image — it is an image that reached the quality gate and failed it,
 * which is a diagnosis the user can act on.
 */
export const STATE_CELL_STATUSES = ['ready', 'missing', 'generating', 'stale', 'rejected'] as const;
export const StateCellStatus = z.enum(STATE_CELL_STATUSES);
export type StateCellStatus = z.infer<typeof StateCellStatus>;

export const STATE_KINDS = ['expression', 'pose', 'wardrobe'] as const;
export const StateKind = z.enum(STATE_KINDS);
export type StateKind = z.infer<typeof StateKind>;

/**
 * One `(outfit x state)` the pipeline must produce, with the prompt behind it.
 *
 * `variantKey` and `semanticKey` together are half of the dedup key, so they are shown
 * rather than hidden: "why did this regenerate" is a question with a precise answer and
 * the answer is these two strings plus the prompt hash.
 */
export const CharacterStateCell = z.strictObject({
  semanticKey: SemanticKey,
  variantKey: Slug,
  wardrobeSlug: Slug,
  stateSlug: Slug,
  stateKind: StateKind,
  label: Label,
  /** The exact text an image model receives. Editable in place. */
  prompt: Prose,
  intensity: Unit01.default(0.7),
  status: StateCellStatus.default('missing'),
  /** Content hash of the rendered image, when one exists. */
  imageHash: z.string().min(1).max(128).optional(),
  /** Against the identity anchors. Characters only, and absent until it is scored. */
  identityMatch: Unit01.optional(),
  estimateNanoUsd: NanoUsdAmount.default(0),
});
export type CharacterStateCell = z.infer<typeof CharacterStateCell>;

export const CharacterStates = z.strictObject({
  /** The score below which a cell is flagged rather than trusted. From the settings. */
  identityFloor: Unit01.default(0.82),
  /** The model a generate on this screen would run on, for the estimate line. */
  imageModel: Label.nullable().default(null),
  cells: z.array(CharacterStateCell).max(512).default([]),
});
export type CharacterStates = z.infer<typeof CharacterStates>;

export const CharacterStateEdit = z.strictObject({
  prompt: Prose,
});
export type CharacterStateEdit = z.infer<typeof CharacterStateEdit>;
