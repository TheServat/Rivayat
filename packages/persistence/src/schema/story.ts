/**
 * Episodes, scenes and shots.
 *
 * `SeriesBible` is one deeply nested document - series → season → episode → act →
 * sequence → scene → beat → shot - and storing it that way would make "which shots
 * does this scene owe?" a full-document read and every write a full-document rewrite.
 * So the three levels that are independently queried, edited and rendered get rows,
 * and the two purely structural levels in between (`Act`, `Sequence`) stay inside
 * `episodes.structure` as an outline that names scene ids in playing order.
 *
 * `beats` stay inside their scene: a beat is only ever read with its scene, and a
 * `Shot.beatRef` resolves against the scene the shot already belongs to.
 */

import type {
  Act,
  Beat,
  SceneId as SceneRef,
  Sequence,
  DialogueLine,
  EmotionalValueShift,
  EntityId,
  EpisodeId,
  EpisodeStatus,
  FocusTarget,
  IsoInstant,
  NormRect,
  OpenLoopId,
  SceneId,
  SceneSpace,
  SeasonId,
  SeriesId,
  ShotAction,
  ShotAudio,
  ShotCamera,
  ShotId,
  ShotLayer,
  BeatId,
} from '@rv/contracts';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { jsonDoc } from './columns';

/**
 * A sequence with its scenes reduced to references.
 *
 * Derived from the contract type rather than written out, so a field added to
 * `Sequence` lands here automatically. `@rv/contracts` has no schema for an outline
 * that *points at* scenes - `Sequence.scenes` embeds whole `Scene` documents - and
 * storing it that way would duplicate every scene body inside its episode row and make
 * a one-scene rewrite a whole-episode write.
 */
export type SequenceOutline = Omit<Sequence, 'scenes'> & { readonly sceneIds: readonly SceneRef[] };

/** An act with its sequences outlined the same way. */
export type ActOutline = Omit<Act, 'sequences'> & {
  readonly sequences: readonly SequenceOutline[];
};

export const episodes = sqliteTable(
  'episodes',
  {
    id: text('id').primaryKey().$type<EpisodeId>(),
    seriesId: text('series_id').notNull().$type<SeriesId>(),
    /** `null` for a standalone short, which is one episode with no season around it. */
    seasonId: text('season_id').$type<SeasonId>(),
    /** Position among siblings, 1-based and contiguous. */
    ordinal: integer('ordinal').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    /** The instruction the parent level gave, verbatim. The critique pass diffs it. */
    plannedSummary: text('planned_summary'),
    /**
     * The gate everything hangs off: below `aired` the subtree is re-plannable, at
     * `aired` the facts it asserted are frozen (non-negotiable #7).
     */
    status: text('status').notNull().$type<EpisodeStatus>(),
    logline: text('logline').notNull(),
    coldOpen: text('cold_open'),
    cliffhanger: text('cliffhanger'),
    opensLoops: jsonDoc<OpenLoopId[]>()('opens_loops').notNull(),
    closesLoops: jsonDoc<OpenLoopId[]>()('closes_loops').notNull(),
    airedAt: text('aired_at').$type<IsoInstant>(),
    /**
     * Acts and sequences, whole, with their scenes reduced to ids in playing order.
     *
     * Purely structural levels: nothing queries an act, and a re-outline rewrites all
     * of them at once. The scenes themselves are rows so a scene can be rewritten
     * without touching its siblings.
     */
    structure: jsonDoc<ActOutline[]>()('structure').notNull(),
  },
  (table) => [
    uniqueIndex('episodes_series_ordinal_uq').on(table.seriesId, table.ordinal),
    index('episodes_series_status_idx').on(table.seriesId, table.status),
  ],
);

export const scenes = sqliteTable(
  'scenes',
  {
    id: text('id').primaryKey().$type<SceneId>(),
    episodeId: text('episode_id')
      .notNull()
      .$type<EpisodeId>()
      .references(() => episodes.id),
    ordinal: integer('ordinal').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    plannedSummary: text('planned_summary'),

    locationRef: text('location_ref').notNull().$type<EntityId>(),
    /** `null` for a scene narrated from outside anyone, which forfeits the irony guard. */
    povEntityRef: text('pov_entity_ref').$type<EntityId>(),
    presentEntityRefs: jsonDoc<EntityId[]>()('present_entity_refs').notNull(),

    goal: text('goal').notNull(),
    conflict: text('conflict').notNull(),
    outcome: text('outcome').notNull(),

    // Flattened for the same reason as `relations`: "which scenes cover ordinal N" has
    // to be a range scan. See the narrative schema's file comment.
    fromOrdinal: integer('from_ordinal'),
    fromLabel: text('from_label'),
    untilOrdinal: integer('until_ordinal'),
    untilLabel: text('until_label'),

    valueShift: jsonDoc<EmotionalValueShift>()('value_shift').notNull(),
    beats: jsonDoc<Beat[]>()('beats').notNull(),
  },
  (table) => [
    uniqueIndex('scenes_episode_ordinal_uq').on(table.episodeId, table.ordinal),
    index('scenes_location_idx').on(table.locationRef),
    index('scenes_from_ordinal_idx').on(table.fromOrdinal),
  ],
);

export const shots = sqliteTable(
  'shots',
  {
    id: text('id').primaryKey().$type<ShotId>(),
    sceneId: text('scene_id')
      .notNull()
      .$type<SceneId>()
      .references(() => scenes.id),
    /** Position in the scene shot list, 0-based and contiguous. */
    index: integer('index').notNull(),
    durationMs: integer('duration_ms').notNull(),
    beatRef: text('beat_ref').notNull().$type<BeatId>(),

    // Every block below is a whole sub-document that the composer reads as a unit and
    // the planner rewrites as a unit. Shredding `layout` in particular would be a row
    // per placed asset per shot for a list that is only ever read in z-order.
    sceneSpace: jsonDoc<SceneSpace>()('scene_space').notNull(),
    camera: jsonDoc<ShotCamera>()('camera').notNull(),
    layout: jsonDoc<ShotLayer[]>()('layout').notNull(),
    blocking: jsonDoc<ShotAction[]>()('blocking').notNull(),
    dialogue: jsonDoc<DialogueLine[]>()('dialogue').notNull(),
    audio: jsonDoc<ShotAudio>()('audio').notNull(),
    safeArea: jsonDoc<NormRect>()('safe_area').notNull(),
    focusTarget: jsonDoc<FocusTarget>()('focus_target').notNull(),
  },
  (table) => [
    uniqueIndex('shots_scene_index_uq').on(table.sceneId, table.index),
    index('shots_beat_idx').on(table.beatRef),
  ],
);

export type EpisodeRow = typeof episodes.$inferSelect;
export type NewEpisodeRow = typeof episodes.$inferInsert;
export type SceneRow = typeof scenes.$inferSelect;
export type NewSceneRow = typeof scenes.$inferInsert;
export type ShotRow = typeof shots.$inferSelect;
export type NewShotRow = typeof shots.$inferInsert;
