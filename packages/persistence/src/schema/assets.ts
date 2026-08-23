/**
 * The asset tree: identity → versions → parts, variants, clips, baked sheets.
 *
 * Three schema decisions carry the product rules:
 *
 * 1. **The dedup key is a unique index, not an application check.** `assets_dedup_uq`
 *    covers all four components, so a duplicate insert fails at the database level
 *    even if a use-case forgets to look first (RV-100). The composite `key` gets its
 *    own unique index because that is the column the hot path actually queries.
 * 2. **No cascade anywhere.** Every foreign key is `no action` on delete. RV-106 wants
 *    a deleted project to leave its assets resolvable for everyone else, and ADR-0006
 *    wants deleting a row to be incapable of deleting bytes. A cascade would defeat
 *    both quietly.
 * 3. **`(asset_id, ordinal)` is unique.** Version N+1 never replaces version N, and the
 *    ordinal is how "is version 1 still readable?" is asked. Two concurrent takes that
 *    both computed ordinal 2 must collide here rather than both succeed.
 */

import type {
  AssetArchetype,
  AssetId,
  AssetKey,
  AssetVersionId,
  AssetVersionStatus,
  ClipId,
  ClipSource,
  IsoInstant,
  LoopMode,
  PartId,
  Provenance,
  QualityScores,
  QualityTarget,
  Rect,
  Rig,
  SemanticKey,
  Sha256Hex,
  SheetId,
  Slug,
  StoryInterval,
  StyleBibleId,
  VariantId,
  Vec2,
} from '@rv/contracts';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { embeddingVector, jsonDoc } from './columns';

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey().$type<AssetId>(),
    /** `compositeHash(semanticKey, styleChecksum, variantKey, specHash)`. */
    key: text('key').notNull().$type<AssetKey>(),

    // The four components, stored alongside the key they produce. Redundant by
    // construction and worth the columns: when a miss happens that should not have,
    // this is the only thing you can diff to find which component moved.
    semanticKey: text('semantic_key').notNull().$type<SemanticKey>(),
    styleChecksum: text('style_checksum').notNull().$type<Sha256Hex>(),
    variantKey: text('variant_key').notNull().$type<Slug>(),
    specHash: text('spec_hash').notNull().$type<Sha256Hex>(),

    archetype: text('archetype').notNull().$type<AssetArchetype>(),
    label: text('label').notNull(),
    description: text('description').notNull(),
    tags: jsonDoc<string[]>()('tags').notNull(),

    /**
     * Not a foreign key.
     *
     * The asset row must exist before its first version row can reference it, so a
     * real constraint here would need SQLite's deferred foreign keys, which are off by
     * default and would trade a genuine guarantee for a fragile one. The repository
     * writes both rows in one transaction instead.
     */
    currentVersionId: text('current_version_id').notNull().$type<AssetVersionId>(),

    /**
     * Semantic index. `null` until the asset has been embedded.
     *
     * `AssetSpec` and `Asset` have no embedding field in `@rv/contracts` - unlike
     * `EntityEnvelope`, which does - so this pair of columns is storage's own, and the
     * text they were derived from is `assetEmbeddingText()` in `@rv/asset-registry`.
     */
    embedding: embeddingVector()('embedding'),
    embeddingModel: text('embedding_model'),

    createdAt: text('created_at').notNull().$type<IsoInstant>(),
    updatedAt: text('updated_at').notNull().$type<IsoInstant>(),
  },
  (table) => [
    uniqueIndex('assets_key_uq').on(table.key),
    uniqueIndex('assets_dedup_uq').on(
      table.semanticKey,
      table.styleChecksum,
      table.variantKey,
      table.specHash,
    ),
    index('assets_semantic_key_idx').on(table.semanticKey),
    index('assets_style_checksum_idx').on(table.styleChecksum),
  ],
);

export const assetVersions = sqliteTable(
  'asset_versions',
  {
    id: text('id').primaryKey().$type<AssetVersionId>(),
    assetId: text('asset_id')
      .notNull()
      .$type<AssetId>()
      .references(() => assets.id),
    /** 1-based, monotonic within the asset. Assigned inside the insert transaction. */
    ordinal: integer('ordinal').notNull(),
    status: text('status').notNull().$type<AssetVersionStatus>(),

    styleBibleId: text('style_bible_id').notNull().$type<StyleBibleId>(),
    styleChecksum: text('style_checksum').notNull().$type<Sha256Hex>(),

    /**
     * The fitted rig, whole. `null` while the version is still being rigged.
     *
     * Bones, meshes, IK chains and anchors are always loaded together and evaluated as
     * a unit; four more tables would buy four joins and no query anyone wants.
     */
    rig: jsonDoc<Rig>()('rig'),

    canvasWidth: integer('canvas_width').notNull(),
    canvasHeight: integer('canvas_height').notNull(),
    nominalHeight: integer('nominal_height').notNull(),
    previewImageHash: text('preview_image_hash').$type<Sha256Hex>(),

    quality: text('quality').notNull().$type<QualityTarget>(),
    /** Vision-gate scores, whole. Recorded even for a rejected take, for tuning. */
    scores: jsonDoc<QualityScores>()('scores'),
    rejectionReason: text('rejection_reason'),

    provenance: jsonDoc<Provenance>()('provenance').notNull(),
    createdAt: text('created_at').notNull().$type<IsoInstant>(),
  },
  (table) => [
    uniqueIndex('asset_versions_asset_ordinal_uq').on(table.assetId, table.ordinal),
    index('asset_versions_asset_idx').on(table.assetId),
  ],
);

export const parts = sqliteTable(
  'parts',
  {
    id: text('id').primaryKey().$type<PartId>(),
    versionId: text('version_id')
      .notNull()
      .$type<AssetVersionId>()
      .references(() => assetVersions.id),
    name: text('name').notNull().$type<Slug>(),
    role: text('role').notNull().$type<Slug>(),
    /** Address in the CAS. Indexed, not foreign-keyed - see `blobs`. */
    imageHash: text('image_hash').notNull().$type<Sha256Hex>(),

    // Geometry is flat because the compositor reads it per part per frame and a JSON
    // parse in that loop is measurable.
    boundsX: real('bounds_x').notNull(),
    boundsY: real('bounds_y').notNull(),
    boundsWidth: real('bounds_width').notNull(),
    boundsHeight: real('bounds_height').notNull(),
    sizeWidth: integer('size_width').notNull(),
    sizeHeight: integer('size_height').notNull(),
    pivotX: real('pivot_x').notNull(),
    pivotY: real('pivot_y').notNull(),

    zOrder: integer('z_order').notNull(),
    deformable: integer('deformable', { mode: 'boolean' }).notNull(),
    alphaCoverage: real('alpha_coverage').notNull(),
  },
  (table) => [
    uniqueIndex('parts_version_name_uq').on(table.versionId, table.name),
    index('parts_image_hash_idx').on(table.imageHash),
  ],
);

export const variants = sqliteTable(
  'variants',
  {
    id: text('id').primaryKey().$type<VariantId>(),
    versionId: text('version_id')
      .notNull()
      .$type<AssetVersionId>()
      .references(() => assetVersions.id),
    key: text('key').notNull().$type<Slug>(),
    label: text('label').notNull(),
    /** Part name → replacement image hash. Everything else is reused byte-for-byte. */
    replacedParts: jsonDoc<Record<string, Sha256Hex>>()('replaced_parts').notNull(),

    /**
     * The interval, whole. `null` means the variant has no story-time constraint.
     *
     * Kept as a document *and* denormalised into the two ordinal columns below: the
     * document round-trips the contract exactly (absent is not the same as
     * `{from:null,until:null}` at the type level), while the ordinals are what an
     * indexed "which variant applies at ordinal N" query can actually use.
     */
    validity: jsonDoc<StoryInterval>()('validity'),
    validFromOrdinal: integer('valid_from_ordinal'),
    validUntilOrdinal: integer('valid_until_ordinal'),

    provenance: jsonDoc<Provenance>()('provenance').notNull(),
  },
  (table) => [
    // Deliberately not unique: a thing that changes twice is two variants sharing a
    // key with disjoint validity, which is exactly how "Kael loses an eye in E06" is
    // modelled.
    index('variants_version_key_idx').on(table.versionId, table.key),
    index('variants_valid_from_idx').on(table.validFromOrdinal),
  ],
);

export const clips = sqliteTable(
  'clips',
  {
    id: text('id').primaryKey().$type<ClipId>(),
    versionId: text('version_id')
      .notNull()
      .$type<AssetVersionId>()
      .references(() => assetVersions.id),
    name: text('name').notNull().$type<Slug>(),
    label: text('label'),
    source: text('source').notNull().$type<ClipSource>(),
    durationMs: integer('duration_ms').notNull(),
    fps: integer('fps').notNull(),
    loop: text('loop').notNull().$type<LoopMode>(),
    /** Content hash of the `AnimationIR` fragment. Two assets sharing an idle share it. */
    irHash: text('ir_hash').notNull().$type<Sha256Hex>(),
    bakedSheetId: text('baked_sheet_id').$type<SheetId>(),
    tags: jsonDoc<string[]>()('tags').notNull(),
    provenance: jsonDoc<Provenance>()('provenance').notNull(),
  },
  (table) => [
    uniqueIndex('clips_version_name_uq').on(table.versionId, table.name),
    index('clips_ir_hash_idx').on(table.irHash),
  ],
);

export const spriteSheets = sqliteTable(
  'sprite_sheets',
  {
    id: text('id').primaryKey().$type<SheetId>(),
    clipId: text('clip_id')
      .notNull()
      .$type<ClipId>()
      .references(() => clips.id),
    atlasImageHash: text('atlas_image_hash').notNull().$type<Sha256Hex>(),
    atlasJsonHash: text('atlas_json_hash').notNull().$type<Sha256Hex>(),
    frameCount: integer('frame_count').notNull(),
    fps: integer('fps').notNull(),
    frameWidth: integer('frame_width').notNull(),
    frameHeight: integer('frame_height').notNull(),
    atlasWidth: integer('atlas_width').notNull(),
    atlasHeight: integer('atlas_height').notNull(),
    /**
     * Per-frame source rects, whole.
     *
     * A row per frame would be tens of thousands of rows that are only ever read as
     * one array by the atlas loader, and never queried individually.
     */
    frames: jsonDoc<{ rect: Rect; trimOffset: Vec2 }[]>()('frames').notNull(),
    trimmed: integer('trimmed', { mode: 'boolean' }).notNull(),
    padding: integer('padding').notNull(),
    createdAt: text('created_at').notNull().$type<IsoInstant>(),
  },
  (table) => [index('sprite_sheets_clip_idx').on(table.clipId)],
);

export type AssetRow = typeof assets.$inferSelect;
export type NewAssetRow = typeof assets.$inferInsert;
export type AssetVersionRow = typeof assetVersions.$inferSelect;
export type NewAssetVersionRow = typeof assetVersions.$inferInsert;
export type PartRow = typeof parts.$inferSelect;
export type NewPartRow = typeof parts.$inferInsert;
export type VariantRow = typeof variants.$inferSelect;
export type NewVariantRow = typeof variants.$inferInsert;
export type ClipRow = typeof clips.$inferSelect;
export type NewClipRow = typeof clips.$inferInsert;
export type SpriteSheetRow = typeof spriteSheets.$inferSelect;
export type NewSpriteSheetRow = typeof spriteSheets.$inferInsert;
