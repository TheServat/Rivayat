/**
 * Identifier schemas.
 *
 * Every id is a prefixed ULID (see `@rv/shared-kernel/id`) and is *branded* at the
 * type level, so an `AssetId` cannot be passed where a `SceneId` is expected. The
 * prefix does double duty: it makes an id self-describing in a log or an LLM prompt,
 * and it gives the schema something cheap and exact to validate.
 */

import { IdGenerator } from '@rv/shared-kernel';
import { z } from 'zod';

/**
 * The prefix registry. Short enough to stay readable, long enough to be unambiguous.
 * Adding an entity type means adding a prefix here first.
 */
export const ID_PREFIXES = {
  project: 'prj',
  series: 'ser',
  season: 'sea',
  episode: 'ep',
  act: 'act',
  sequence: 'seq',
  scene: 'scn',
  shot: 'sht',
  beat: 'bet',

  entity: 'ent',
  relation: 'rel',
  fact: 'fct',
  belief: 'bel',
  openLoop: 'lop',
  community: 'cmt',

  styleBible: 'sty',

  asset: 'ast',
  assetVersion: 'asv',
  part: 'prt',
  variant: 'vnt',
  clip: 'clp',
  rig: 'rig',
  bone: 'bon',
  sheet: 'atl',

  animation: 'anm',
  node: 'nod',
  track: 'trk',
  behaviour: 'bhv',
  marker: 'mrk',

  audioCue: 'auc',

  run: 'run',
  job: 'job',
  usage: 'usg',
  issue: 'iss',
} as const satisfies Record<string, string>;

export type IdKind = keyof typeof ID_PREFIXES;

/** The random half of a ULID in Crockford base32 - 26 chars, no I/L/O/U. */
const ULID_BODY = '[0-9A-HJKMNP-TV-Z]{26}';

function idSchema<TBrand extends string>(kind: IdKind, brand: TBrand) {
  const prefix = ID_PREFIXES[kind];
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${ULID_BODY}$`), `expected a ${brand} (\`${prefix}_<ULID>\`)`)
    .brand<TBrand>()
    .describe(brand);
}

// ── work hierarchy ──────────────────────────────────────────────────────────
export const ProjectId = idSchema('project', 'ProjectId');
export type ProjectId = z.infer<typeof ProjectId>;

export const SeriesId = idSchema('series', 'SeriesId');
export type SeriesId = z.infer<typeof SeriesId>;

export const SeasonId = idSchema('season', 'SeasonId');
export type SeasonId = z.infer<typeof SeasonId>;

export const EpisodeId = idSchema('episode', 'EpisodeId');
export type EpisodeId = z.infer<typeof EpisodeId>;

export const ActId = idSchema('act', 'ActId');
export type ActId = z.infer<typeof ActId>;

export const SequenceId = idSchema('sequence', 'SequenceId');
export type SequenceId = z.infer<typeof SequenceId>;

export const SceneId = idSchema('scene', 'SceneId');
export type SceneId = z.infer<typeof SceneId>;

export const ShotId = idSchema('shot', 'ShotId');
export type ShotId = z.infer<typeof ShotId>;

export const BeatId = idSchema('beat', 'BeatId');
export type BeatId = z.infer<typeof BeatId>;

// ── narrative graph ─────────────────────────────────────────────────────────
export const EntityId = idSchema('entity', 'EntityId');
export type EntityId = z.infer<typeof EntityId>;

export const RelationId = idSchema('relation', 'RelationId');
export type RelationId = z.infer<typeof RelationId>;

export const FactId = idSchema('fact', 'FactId');
export type FactId = z.infer<typeof FactId>;

/**
 * A belief, which is not a fact.
 *
 * A fact is what is true; a belief is what a character holds, and the whole epistemic
 * layer turns on the difference (docs/02 3). They are stored in two tables and they
 * need two id spaces: `ContinuityIssue.conflictingFacts` is a list of `FactId`s that
 * has to resolve to edges the UI can highlight, and if a belief could carry a `fct_`
 * id then resolving one would silently land in the wrong table.
 */
export const BeliefId = idSchema('belief', 'BeliefId');
export type BeliefId = z.infer<typeof BeliefId>;

export const OpenLoopId = idSchema('openLoop', 'OpenLoopId');
export type OpenLoopId = z.infer<typeof OpenLoopId>;

export const CommunityId = idSchema('community', 'CommunityId');
export type CommunityId = z.infer<typeof CommunityId>;

// ── style ───────────────────────────────────────────────────────────────────
export const StyleBibleId = idSchema('styleBible', 'StyleBibleId');
export type StyleBibleId = z.infer<typeof StyleBibleId>;

// ── assets ──────────────────────────────────────────────────────────────────
export const AssetId = idSchema('asset', 'AssetId');
export type AssetId = z.infer<typeof AssetId>;

export const AssetVersionId = idSchema('assetVersion', 'AssetVersionId');
export type AssetVersionId = z.infer<typeof AssetVersionId>;

export const PartId = idSchema('part', 'PartId');
export type PartId = z.infer<typeof PartId>;

export const VariantId = idSchema('variant', 'VariantId');
export type VariantId = z.infer<typeof VariantId>;

export const ClipId = idSchema('clip', 'ClipId');
export type ClipId = z.infer<typeof ClipId>;

export const RigId = idSchema('rig', 'RigId');
export type RigId = z.infer<typeof RigId>;

export const BoneId = idSchema('bone', 'BoneId');
export type BoneId = z.infer<typeof BoneId>;

export const SheetId = idSchema('sheet', 'SheetId');
export type SheetId = z.infer<typeof SheetId>;

// ── animation ───────────────────────────────────────────────────────────────
export const AnimationId = idSchema('animation', 'AnimationId');
export type AnimationId = z.infer<typeof AnimationId>;

export const NodeId = idSchema('node', 'NodeId');
export type NodeId = z.infer<typeof NodeId>;

export const TrackId = idSchema('track', 'TrackId');
export type TrackId = z.infer<typeof TrackId>;

export const BehaviourId = idSchema('behaviour', 'BehaviourId');
export type BehaviourId = z.infer<typeof BehaviourId>;

export const MarkerId = idSchema('marker', 'MarkerId');
export type MarkerId = z.infer<typeof MarkerId>;

/**
 * One entry on the audio timeline.
 *
 * Its own kind rather than a reuse of `MarkerId` because the two are different things
 * that happen to coincide in time: a marker is a cue *point* in the animation document,
 * an audio cue is a piece of sound with a duration and a provenance. `AudioCue.markerRef`
 * is how they are tied together - see `audio/timeline.ts` for why that is a reference
 * and not an identity.
 */
export const AudioCueId = idSchema('audioCue', 'AudioCueId');
export type AudioCueId = z.infer<typeof AudioCueId>;

// ── operations ──────────────────────────────────────────────────────────────
export const RunId = idSchema('run', 'RunId');
export type RunId = z.infer<typeof RunId>;

export const JobId = idSchema('job', 'JobId');
export type JobId = z.infer<typeof JobId>;

export const UsageId = idSchema('usage', 'UsageId');
export type UsageId = z.infer<typeof UsageId>;

export const IssueId = idSchema('issue', 'IssueId');
export type IssueId = z.infer<typeof IssueId>;

/**
 * Mints branded ids.
 *
 * The one place where an untyped generated string is widened into a branded type.
 * It takes an `IdGenerator` rather than reaching for a singleton so that a replayed
 * pipeline run - which needs a fixed clock - produces the same ids it did the first
 * time.
 */
export class Ids {
  readonly #generator: IdGenerator;

  constructor(generator: IdGenerator = new IdGenerator()) {
    this.#generator = generator;
  }

  /** Mints an id for `kind`, branded as `T`. The kind and brand must agree. */
  mint<T extends string>(kind: IdKind): T {
    return this.#generator.next(ID_PREFIXES[kind]) as unknown as T;
  }

  project(): ProjectId {
    return this.mint('project');
  }
  series(): SeriesId {
    return this.mint('series');
  }
  season(): SeasonId {
    return this.mint('season');
  }
  episode(): EpisodeId {
    return this.mint('episode');
  }
  act(): ActId {
    return this.mint('act');
  }
  sequence(): SequenceId {
    return this.mint('sequence');
  }
  scene(): SceneId {
    return this.mint('scene');
  }
  shot(): ShotId {
    return this.mint('shot');
  }
  beat(): BeatId {
    return this.mint('beat');
  }
  entity(): EntityId {
    return this.mint('entity');
  }
  relation(): RelationId {
    return this.mint('relation');
  }
  fact(): FactId {
    return this.mint('fact');
  }
  belief(): BeliefId {
    return this.mint('belief');
  }
  openLoop(): OpenLoopId {
    return this.mint('openLoop');
  }
  community(): CommunityId {
    return this.mint('community');
  }
  styleBible(): StyleBibleId {
    return this.mint('styleBible');
  }
  asset(): AssetId {
    return this.mint('asset');
  }
  assetVersion(): AssetVersionId {
    return this.mint('assetVersion');
  }
  part(): PartId {
    return this.mint('part');
  }
  variant(): VariantId {
    return this.mint('variant');
  }
  clip(): ClipId {
    return this.mint('clip');
  }
  rig(): RigId {
    return this.mint('rig');
  }
  bone(): BoneId {
    return this.mint('bone');
  }
  sheet(): SheetId {
    return this.mint('sheet');
  }
  animation(): AnimationId {
    return this.mint('animation');
  }
  node(): NodeId {
    return this.mint('node');
  }
  track(): TrackId {
    return this.mint('track');
  }
  behaviour(): BehaviourId {
    return this.mint('behaviour');
  }
  marker(): MarkerId {
    return this.mint('marker');
  }
  audioCue(): AudioCueId {
    return this.mint('audioCue');
  }
  run(): RunId {
    return this.mint('run');
  }
  job(): JobId {
    return this.mint('job');
  }
  usage(): UsageId {
    return this.mint('usage');
  }
  issue(): IssueId {
    return this.mint('issue');
  }
}
