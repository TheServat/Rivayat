/**
 * The bi-temporal narrative graph: entities, relations, the facts the series remembers,
 * and what each character believes.
 *
 * The shape of these three tables is dictated by one query the continuity engine has
 * to answer cheaply: *was this true, in the fiction, at story ordinal N, and did we
 * still believe it at authoring instant T?* That is why `StoryTime` is flattened into
 * integer `*_ordinal` columns rather than left inside its JSON document - an ordinal
 * comparison has to be an indexed range scan, not a scan plus a parse. The human-facing
 * `label` rides along in its own column because the contract says it is display-only
 * and is never compared.
 *
 * `entities.payload` is the one place a discriminated union is stored whole. `Entity`
 * is nine payload shapes under one `kind`; a table per kind would be nine tables and a
 * nine-way union in every read, and no query in the system filters on a field that
 * only three of the nine have.
 *
 * **`beliefs` and `facts` are two tables because they are two things.** The table now
 * called `beliefs` was called `facts` and always stored beliefs - what a character
 * holds - while `@rv/contracts` has since grown a real `Fact`: the retrievable unit of
 * narrative memory, of which a relation is one kind. Storing a belief in a table named
 * `facts` is not a naming quibble in this domain; it is the one distinction the whole
 * epistemic layer rests on (docs/02 3), and every query written against the old name
 * was answering "what is true" with "what somebody thinks".
 */

import type {
  AudienceVisibility,
  BeliefId,
  EntityAssetLink,
  EntityId,
  EntityKind,
  FactContent,
  FactId,
  Importance,
  IsoInstant,
  RelationId,
  RelationSource,
  RelationType,
  SeriesId,
} from '@rv/contracts';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { embeddingVector, jsonDoc } from './columns';

export const entities = sqliteTable(
  'entities',
  {
    id: text('id').primaryKey().$type<EntityId>(),
    seriesId: text('series_id').notNull().$type<SeriesId>(),
    kind: text('kind').notNull().$type<EntityKind>(),
    canonicalName: text('canonical_name').notNull(),
    /** Every other name this is called by. The mention resolver reads it as a set. */
    aliases: jsonDoc<string[]>()('aliases').notNull(),
    summary: text('summary').notNull(),
    firstAppearanceOrdinal: integer('first_appearance_ordinal').notNull(),
    firstAppearanceLabel: text('first_appearance_label'),
    importance: text('importance').notNull().$type<Importance>(),
    assetRefs: jsonDoc<EntityAssetLink[]>()('asset_refs').notNull(),
    /** The kind-specific sheet. See the file comment for why it is not nine tables. */
    payload: jsonDoc<Record<string, unknown>>()('payload').notNull(),
    embedding: embeddingVector()('embedding'),
    embeddingModel: text('embedding_model'),
  },
  (table) => [
    index('entities_series_idx').on(table.seriesId),
    index('entities_series_kind_idx').on(table.seriesId, table.kind),
    index('entities_canonical_name_idx').on(table.canonicalName),
  ],
);

export const relations = sqliteTable(
  'relations',
  {
    id: text('id').primaryKey().$type<RelationId>(),
    seriesId: text('series_id').notNull().$type<SeriesId>(),
    fromEntityId: text('from_entity_id')
      .notNull()
      .$type<EntityId>()
      .references(() => entities.id),
    toEntityId: text('to_entity_id')
      .notNull()
      .$type<EntityId>()
      .references(() => entities.id),
    type: text('type').notNull().$type<RelationType>(),
    /** The assertion in one sentence. Embedded for retrieval, quoted in findings. */
    fact: text('fact').notNull(),
    strength: real('strength').notNull(),

    // Story time: when it was true inside the fiction. `null` means unbounded.
    validFromOrdinal: integer('valid_from_ordinal'),
    validFromLabel: text('valid_from_label'),
    validUntilOrdinal: integer('valid_until_ordinal'),
    validUntilLabel: text('valid_until_label'),

    // Authoring time: when we decided it. Retraction un-says the sentence; it is not
    // the same axis as `valid_until`, which ends the fact inside the story.
    assertedAt: text('asserted_at').notNull().$type<IsoInstant>(),
    retractedAt: text('retracted_at').$type<IsoInstant>(),

    sourceRef: jsonDoc<RelationSource>()('source_ref').notNull(),
    confidence: real('confidence').notNull(),
    visibility: text('visibility').notNull().$type<AudienceVisibility>(),
  },
  (table) => [
    index('relations_series_from_idx').on(table.seriesId, table.fromEntityId),
    index('relations_series_to_idx').on(table.seriesId, table.toEntityId),
    index('relations_series_type_idx').on(table.seriesId, table.type),
    index('relations_valid_from_idx').on(table.seriesId, table.validFromOrdinal),
  ],
);

/**
 * What a character believes, as opposed to what is true.
 *
 * This is `KnownFact` from `EpistemicView` - a proposition held *by* someone *about* a
 * relation - with the holder promoted to a column so "what does Kael know" is an
 * indexed lookup rather than a scan of every character view.
 *
 * Its id is a `BeliefId`, not a `FactId`. The two used to share the `fct_` space, and a
 * `ContinuityIssue.conflictingFacts` entry resolved against that space could land in
 * either table - silently, and in the direction where a belief gets reported as canon.
 */
export const beliefs = sqliteTable(
  'beliefs',
  {
    id: text('id').primaryKey().$type<BeliefId>(),
    seriesId: text('series_id').notNull().$type<SeriesId>(),
    /** Whose head this belief is in. */
    holderId: text('holder_id')
      .notNull()
      .$type<EntityId>()
      .references(() => entities.id),
    relationId: text('relation_id')
      .notNull()
      .$type<RelationId>()
      .references(() => relations.id),
    /** The proposition as the holder would state it, not as the narrator would. */
    proposition: text('proposition').notNull(),
    /** The epistemic edge that put it in their head: knows, told, believes-falsely. */
    via: text('via').notNull(),
    learnedAtOrdinal: integer('learned_at_ordinal'),
    learnedAtLabel: text('learned_at_label'),
    learnedFromEntityId: text('learned_from_entity_id').$type<EntityId>(),
    /** How sure *they* are. Not how sure we are - that lives on the relation. */
    confidence: real('confidence').notNull(),
  },
  (table) => [
    index('beliefs_series_holder_idx').on(table.seriesId, table.holderId),
    index('beliefs_relation_idx').on(table.relationId),
    index('beliefs_learned_at_idx').on(table.seriesId, table.learnedAtOrdinal),
  ],
);

/**
 * One thing the series remembers, on two clocks. The `Fact` of `@rv/contracts`.
 *
 * A fact is the retrievable unit and a relation is one kind of fact, so `content` is a
 * discriminated union and it is **shredded**, not stored whole: `content_kind` and
 * `relation_id` are both queried. Resolving a continuity finding means turning a list
 * of `FactId`s back into graph edges, and that is a join on `relation_id`, which a JSON
 * document cannot serve.
 *
 * `covers` is the one part kept as a document. It is a list of ids read only when
 * retrieval decides it has the budget to expand a summary; a join table for it would be
 * a fourth table serving one query that is never a filter.
 *
 * The two clocks are flattened into `*_ordinal` columns for the same reason they are on
 * `relations`, and spelled with the same four names - `biTemporalShape` in the contract
 * exists precisely so "what was true during episode 2, as we believe it today" is one
 * query shape over both tables rather than two that have to be kept in step.
 */
export const facts = sqliteTable(
  'facts',
  {
    id: text('id').primaryKey().$type<FactId>(),
    seriesId: text('series_id').notNull().$type<SeriesId>(),

    contentKind: text('content_kind').notNull().$type<FactContent['kind']>(),
    /** Set for a relation-kinded fact, null otherwise. The join a finding is resolved by. */
    relationId: text('relation_id')
      .$type<RelationId>()
      .references(() => relations.id),
    /** The prose of a statement or a summary. Null for a relation, whose sentence lives on the edge. */
    text: text('text'),
    /** The facts a summary stands in for. Null for every other kind. */
    covers: jsonDoc<FactId[]>()('covers'),

    // Story time: when it was true inside the fiction. `null` means unbounded.
    validFromOrdinal: integer('valid_from_ordinal'),
    validFromLabel: text('valid_from_label'),
    validUntilOrdinal: integer('valid_until_ordinal'),
    validUntilLabel: text('valid_until_label'),

    // Authoring time: when we wrote it down, and when we stopped believing we had.
    assertedAt: text('asserted_at').notNull().$type<IsoInstant>(),
    retractedAt: text('retracted_at').$type<IsoInstant>(),

    sourceRef: jsonDoc<RelationSource>()('source_ref').notNull(),
    confidence: real('confidence').notNull(),
    visibility: text('visibility').notNull().$type<AudienceVisibility>(),
    /** Narrative weight. Retrieval ranks on it, so it is a column and not a computation. */
    importance: text('importance').notNull().$type<Importance>(),

    embedding: embeddingVector()('embedding'),
    embeddingModel: text('embedding_model'),
  },
  (table) => [
    index('facts_series_idx').on(table.seriesId),
    // The hot bi-temporal read, mirroring `relations_valid_from_idx` so the two tables
    // answer the same question the same way.
    index('facts_series_valid_from_idx').on(table.seriesId, table.validFromOrdinal),
    index('facts_relation_idx').on(table.relationId),
  ],
);

export type EntityRow = typeof entities.$inferSelect;
export type NewEntityRow = typeof entities.$inferInsert;
export type RelationRow = typeof relations.$inferSelect;
export type NewRelationRow = typeof relations.$inferInsert;
export type BeliefRow = typeof beliefs.$inferSelect;
export type NewBeliefRow = typeof beliefs.$inferInsert;
export type FactRow = typeof facts.$inferSelect;
export type NewFactRow = typeof facts.$inferInsert;
