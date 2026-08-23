/**
 * The bi-temporal narrative graph: entities, relations, and what each character
 * believes.
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
 */

import type {
  AudienceVisibility,
  EntityAssetLink,
  EntityId,
  EntityKind,
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
 * `@rv/contracts` registers a `FactId` prefix but has no top-level `Fact` schema to go
 * with it; the closest shape it does have is `KnownFact` inside `EpistemicView`, which
 * is a belief held *by* someone *about* a relation. That is what this table persists,
 * with the holder promoted to a column so "what does Kael know" is an indexed lookup
 * rather than a scan of every character's view.
 */
export const facts = sqliteTable(
  'facts',
  {
    id: text('id').primaryKey().$type<FactId>(),
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
    fact: text('fact').notNull(),
    /** The epistemic edge that put it in their head: `knows`, `told`, `believes-falsely`… */
    via: text('via').notNull(),
    learnedAtOrdinal: integer('learned_at_ordinal'),
    learnedAtLabel: text('learned_at_label'),
    learnedFromEntityId: text('learned_from_entity_id').$type<EntityId>(),
    /** How sure *they* are. Not how sure we are - that lives on the relation. */
    confidence: real('confidence').notNull(),
  },
  (table) => [
    index('facts_series_holder_idx').on(table.seriesId, table.holderId),
    index('facts_relation_idx').on(table.relationId),
    index('facts_learned_at_idx').on(table.seriesId, table.learnedAtOrdinal),
  ],
);

export type EntityRow = typeof entities.$inferSelect;
export type NewEntityRow = typeof entities.$inferInsert;
export type RelationRow = typeof relations.$inferSelect;
export type NewRelationRow = typeof relations.$inferInsert;
export type FactRow = typeof facts.$inferSelect;
export type NewFactRow = typeof facts.$inferInsert;
