/**
 * The documents the CLI keeps on disk, as schemas.
 *
 * **These belong in `@rv/contracts` and are here under protest.** Non-negotiable #5 puts
 * every shape in that package, and `docs/05-remaining-work.md` §W5 already records the
 * first of these as a gap: "No `Project` schema in `contracts` - the API's most-used
 * resource is the one resource with no shared type". `apps/api/src/application/
 * resources.ts` declares its own `Project`, `SeriesCard` and `RunSummary` for exactly
 * the same reason, so this is the *second* local copy, which is the drift W5 predicted.
 *
 * Two things keep the damage bounded until the schemas move:
 *
 *  - every field is built from a `@rv/contracts` primitive, so the branded id types,
 *    the nano-dollar integer rule and the ISO instant format are the shared ones;
 *  - {@link ProjectRecord} is deliberately field-for-field identical to the API's
 *    `Project`, so the move is a delete and an import rather than a migration.
 *
 * The story, world and run documents have no counterpart in the API at all. They are
 * the CLI's working state between commands - what `story new` writes and `cast states`
 * reads - and the API keeps the same information in SQLite.
 */

import {
  AssetArchetype,
  CanonPolicy,
  Entity,
  EntityId,
  EntityStatus,
  EpisodeId,
  Fact,
  OpenLoop,
  Relation,
  RelationId,
  RelationSource,
  SceneId,
  SemanticKey,
  Size,
  Slug,
  StoryTime,
  SubjectClass,
  IsoInstant,
  Label,
  Locale,
  NanoUsdAmount,
  NonEmptyString,
  NonNegativeInt,
  PipelineStage,
  ProjectId,
  Prose,
  RunId,
  SeriesId,
  Sha256Hex,
  StyleBibleId,
  UsageRecord,
} from '@rv/contracts';
import { z } from 'zod';

/** Bumped when a document's shape changes incompatibly. Read before anything else. */
export const DOCUMENT_VERSION = 1 as const;

const versioned = { version: z.literal(DOCUMENT_VERSION) };

// ── project ─────────────────────────────────────────────────────────────────

/**
 * A project on disk.
 *
 * Field-for-field the API's `Project`, plus `locale`: the CLI creates projects with
 * `--lang fa` and the API has no equivalent because its clients carry the locale in the
 * request. When the schema moves to `@rv/contracts`, `locale` moves with it - a
 * Persian-first product whose root aggregate cannot say which language it is in is a
 * product that will guess.
 */
export const ProjectRecord = z.strictObject({
  ...versioned,
  id: ProjectId,
  name: Label,
  description: Prose,
  locale: Locale.default('fa'),
  /** The locked style, once there is one. `null` before S1 finishes. */
  styleBibleId: StyleBibleId.nullable().default(null),
  /** Ceiling for the whole project, in nano-dollars. `null` inherits the machine layer. */
  budgetNanoUsd: NanoUsdAmount.nullable().default(null),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});
export type ProjectRecord = z.infer<typeof ProjectRecord>;

// ── settings overrides at project scope ─────────────────────────────────────

/**
 * The project layer of the settings stack.
 *
 * Raw values, not validated ones, exactly as `SettingsLayer` in `@rv/settings` defines
 * it: a value written by an older build must be skippable at resolution time rather
 * than make the file unreadable.
 */
export const SettingsDocument = z.strictObject({
  ...versioned,
  values: z.record(z.string(), z.unknown()).default({}),
  updatedAt: IsoInstant,
});
export type SettingsDocument = z.infer<typeof SettingsDocument>;

// ── story ───────────────────────────────────────────────────────────────────

/** One node of the outline tree, flattened for storage. */
export const OutlineEntry = z.strictObject({
  id: NonEmptyString.max(64),
  ordinal: z.number().int().positive(),
  /** The human handle - `E01` for episodes, `S01` for seasons. */
  code: NonEmptyString.max(16),
  title: Label,
  /** What its parent asked it to accomplish. The DOC binding. */
  plannedSummary: Prose,
  summary: Prose,
});
export type OutlineEntry = z.infer<typeof OutlineEntry>;

/** A character the story cannot be told without, as intake spotted it. */
export const CastEntry = z.strictObject({
  slug: NonEmptyString.max(64),
  name: Label,
  role: NonEmptyString.max(32),
  importance: NonEmptyString.max(32),
  premiseRole: Prose,
  distinguishingTrait: Prose,
});
export type CastEntry = z.infer<typeof CastEntry>;

export const StoryDocument = z.strictObject({
  ...versioned,
  projectId: ProjectId,
  seriesId: SeriesId,
  styleBibleId: StyleBibleId,
  title: Label,
  premise: Prose,
  themes: z.array(Label).default([]),
  tone: z.array(Label).default([]),
  genre: z.array(Label).default([]),
  canonPolicy: CanonPolicy,
  language: Locale,
  episodeDurationMs: z.number().int().positive(),
  seasons: z.array(OutlineEntry).default([]),
  episodes: z.array(OutlineEntry).default([]),
  cast: z.array(CastEntry).default([]),
  /** Which model answered, and what the repair loop cost. Provenance, not behaviour. */
  models: z.array(NonEmptyString.max(120)).default([]),
  createdAt: IsoInstant,
});
export type StoryDocument = z.infer<typeof StoryDocument>;

// ── cast states ─────────────────────────────────────────────────────────────

/** One expression, pose or wardrobe state, with the prompt that draws it. */
export const CharacterStateEntry = z.strictObject({
  slug: NonEmptyString.max(64),
  kind: z.enum(['expression', 'pose', 'wardrobe']),
  label: Label,
  description: Prose,
  /** The finished text an image model receives. Editable; regenerating is not required. */
  prompt: Prose,
});
export type CharacterStateEntry = z.infer<typeof CharacterStateEntry>;

export const CharacterStatesDocument = z.strictObject({
  ...versioned,
  projectId: ProjectId,
  characterSlug: NonEmptyString.max(64),
  name: Label,
  states: z.array(CharacterStateEntry).default([]),
  /** `(wardrobe x state)` pairs the asset pipeline must produce. */
  variants: z
    .array(
      z.strictObject({
        semanticKey: NonEmptyString.max(200),
        variantKey: NonEmptyString.max(120),
        label: Label,
        prompt: Prose,
      }),
    )
    .default([]),
  createdAt: IsoInstant,
});
export type CharacterStatesDocument = z.infer<typeof CharacterStatesDocument>;

// ── runs ────────────────────────────────────────────────────────────────────

export const RUN_STAGE_OUTCOMES = ['succeeded', 'skipped', 'failed'] as const;
export const RunStageOutcome = z.enum(RUN_STAGE_OUTCOMES);
export type RunStageOutcome = z.infer<typeof RunStageOutcome>;

export const RunStageRecord = z.strictObject({
  stage: PipelineStage,
  outcome: RunStageOutcome,
  durationMs: NonNegativeInt,
  costNanoUsd: NanoUsdAmount.default(0),
  /** `kind:ref` pointers, matching `ArtifactRef` flattened for the wire. */
  artifacts: z.array(NonEmptyString.max(300)).default([]),
  /** Why a stage was skipped, or how it failed. `null` when it simply worked. */
  detail: z.string().max(2000).nullable().default(null),
});
export type RunStageRecord = z.infer<typeof RunStageRecord>;

export const RunDocument = z.strictObject({
  ...versioned,
  id: RunId,
  projectId: ProjectId,
  status: z.enum(['running', 'succeeded', 'failed']),
  seed: NonNegativeInt,
  lane: z.enum(['free', 'paid']),
  stages: z.array(RunStageRecord).default([]),
  spentNanoUsd: NanoUsdAmount.default(0),
  startedAt: IsoInstant,
  finishedAt: IsoInstant.nullable().default(null),
});
export type RunDocument = z.infer<typeof RunDocument>;

/**
 * The cost ledger for one run.
 *
 * A file because `@rv/persistence` exports no usage repository: the `usage_records`
 * table exists in `packages/persistence/src/schema/ops.ts` and the only Drizzle
 * repository for it lives in `apps/api/src/infrastructure/persistence`, which the CLI
 * cannot import. Same records, same schema, different home until that repository moves.
 */
export const LedgerDocument = z.strictObject({
  ...versioned,
  runId: RunId,
  projectId: ProjectId,
  records: z.array(UsageRecord).default([]),
  updatedAt: IsoInstant,
});
export type LedgerDocument = z.infer<typeof LedgerDocument>;

// ── render ──────────────────────────────────────────────────────────────────

/** What `render` recorded so `render resume` can prove it produced the same bytes. */
export const RenderDocument = z.strictObject({
  ...versioned,
  runId: RunId,
  projectId: ProjectId,
  episodeId: NonEmptyString.max(64),
  animationId: NonEmptyString.max(64),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  framesTotal: NonNegativeInt,
  framesRendered: NonNegativeInt,
  /** Digest of the ordered frame hashes. Two runs of the same IR must match. */
  frameStreamHash: Sha256Hex,
  masterPath: z.string().nullable().default(null),
  complete: z.boolean(),
  updatedAt: IsoInstant,
});
export type RenderDocument = z.infer<typeof RenderDocument>;

// ── ids used as human handles ───────────────────────────────────────────────

/** `E01`-style handles are what a person types; the ULID is what the graph stores. */
export const EpisodeHandle = z.union([EpisodeId, NonEmptyString.max(16)]);
export type EpisodeHandle = z.infer<typeof EpisodeHandle>;

// ── the narrative world model ───────────────────────────────────────────────

/**
 * One scene as the continuity rule pass needs to see it.
 *
 * A mirror of `SceneUnderCheck` in `@rv/narrative-memory`, which is a TypeScript
 * interface rather than a schema - correctly, because the engine never parses one; it
 * receives it from the extraction pass in memory. The CLI *does* parse one, off disk,
 * so it needs the schema. If `SceneUnderCheck` ever gains a field, this drifts silently
 * and the fix is to move the schema into `@rv/contracts` and infer the interface from
 * it, exactly as non-negotiable #5 requires.
 */
export const SceneCheckEntry = z.strictObject({
  sceneId: SceneId,
  at: StoryTime,
  locationId: EntityId,
  presentEntityIds: z.array(EntityId).default([]),
  /** Who did or said something. A body in the room is not the same as a body acting. */
  actingEntityIds: z.array(EntityId).default([]),
  usesKnowledge: z
    .array(z.strictObject({ knowerId: EntityId, relationId: RelationId, note: Prose.optional() }))
    .default([]),
  wardrobe: z
    .array(z.strictObject({ entityId: EntityId, wardrobeSlug: NonEmptyString.max(64) }))
    .default([]),
  props: z.array(z.strictObject({ entityId: EntityId, propId: EntityId })).default([]),
  statedAges: z.array(z.strictObject({ entityId: EntityId, years: z.number() })).default([]),
  synopsis: Prose.optional(),
});
export type SceneCheckEntry = z.infer<typeof SceneCheckEntry>;

/** Mirror of `VitalityRecord`, for the same reason as {@link SceneCheckEntry}. */
export const VitalityEntry = z.strictObject({
  entityId: EntityId,
  status: EntityStatus,
  at: StoryTime,
  sourceRef: RelationSource,
});
export type VitalityEntry = z.infer<typeof VitalityEntry>;

/**
 * Everything `NarrativeGraph` is built from, plus the scenes the checker reads.
 *
 * The graph itself is not stored - it is derived on every read, which is cheap and
 * removes any chance of a persisted graph disagreeing with the deltas that made it.
 */
export const WorldDocument = z.strictObject({
  ...versioned,
  projectId: ProjectId,
  seriesId: SeriesId,
  entities: z.array(Entity).default([]),
  relations: z.array(Relation).default([]),
  facts: z.array(Fact).default([]),
  openLoops: z.array(OpenLoop).default([]),
  vitality: z.array(VitalityEntry).default([]),
  /** Broadcast order. A promise's age is measured in episodes, not in story ordinals. */
  episodeOrder: z.array(EpisodeId).default([]),
  /** Episodes whose canon is frozen (non-negotiable #7). */
  airedEpisodes: z.array(EpisodeId).default([]),
  /** Keyed by episode id. What `continuity check --episode` reads. */
  scenesByEpisode: z.record(z.string(), z.array(SceneCheckEntry)).default({}),
  updatedAt: IsoInstant,
});
export type WorldDocument = z.infer<typeof WorldDocument>;

// ── asset demand ────────────────────────────────────────────────────────────

/**
 * What an episode needs drawn, beyond its cast.
 *
 * A mirror of `SceneRequirement` in `@rv/asset-engine` - again an interface rather than
 * a schema, because the engine receives one from S4 in memory and the CLI reads one off
 * disk. Written by hand or by S4; consumed by `rv assets plan`.
 */
export const AssetRequirement = z.strictObject({
  semanticKey: SemanticKey,
  label: Label,
  description: Prose,
  archetype: AssetArchetype,
  subjectClass: SubjectClass,
  tags: z.array(Slug).max(32).default([]),
  canvas: Size.optional(),
});
export type AssetRequirement = z.infer<typeof AssetRequirement>;

export const AssetRequirementsDocument = z.strictObject({
  ...versioned,
  projectId: ProjectId,
  /** Keyed by episode code or id. `"*"` applies to every episode. */
  byEpisode: z.record(z.string(), z.array(AssetRequirement)).default({}),
  updatedAt: IsoInstant,
});
export type AssetRequirementsDocument = z.infer<typeof AssetRequirementsDocument>;
