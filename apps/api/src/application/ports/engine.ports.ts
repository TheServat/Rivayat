/**
 * The capabilities the delivery layer needs from the engines, declared here.
 *
 * A port belongs to the layer that *needs* it (architecture §1), and today most of the
 * layers that will implement these are one-line scaffolds. Declaring the ports anyway
 * is what makes the composition root complete: every controller talks to an interface,
 * every interface has a token, and the stub that satisfies it today is swapped for the
 * real engine tomorrow without a controller changing.
 *
 * They are deliberately narrow. `StoryEnginePort` is four methods and not one
 * `run(stage)`, because a stage that cannot say what it consumes and produces cannot
 * be typed, cached or selectively re-run - and selective re-run (RV-185) is the whole
 * point of stages being separable.
 */

import type {
  AnimationIR,
  AssetSpec,
  AssetVersion,
  Brief,
  ContinuityIssue,
  EpisodeId,
  FormatProfileId,
  MemoryRetrievalRequest,
  MemoryRetrievalResult,
  Scene,
  SeriesBible,
  SeriesId,
  Sha256Hex,
  Shot,
  Slug,
  StyleBible,
  StyleBibleId,
} from '@rv/contracts';
import type { Result } from '@rv/shared-kernel';

import type { StylePresetList, StyleProbeSheet } from '../../modules/style/style.contracts';

// ── S1 Style ────────────────────────────────────────────────────────────────

export interface DeriveStyleRequest {
  readonly brief: Brief;
  /** Content hashes of reference images already in the blob store. */
  readonly referenceHashes: readonly Sha256Hex[];
}

/**
 * Which style to probe, and on which lane.
 *
 * The bible arrives by id rather than by value because probing is the middle of a
 * three-request conversation - choose, probe, lock - and the document the second request
 * draws against has to be the one the third request freezes. A body carrying the whole
 * bible would let those two diverge silently.
 */
export interface ProbeStyleRequest {
  readonly styleBibleId: StyleBibleId;
  /** `free` is the local ComfyUI lane: four 512px tiles at $0.00. */
  readonly lane: 'free' | 'paid';
  readonly signal?: AbortSignal;
}

export interface StyleEnginePort {
  /**
   * The curated shelf, with enough of each preset to choose between them.
   *
   * Cards rather than slugs. A gallery of eleven names can show neither a palette nor a
   * motion profile, so a client given only names has to guess or materialise all eleven
   * to find out - and the second mints eleven style bibles to draw a grid.
   */
  listPresets(): Promise<Result<StylePresetList>>;
  fromPreset(preset: Slug): Promise<Result<StyleBible>>;
  derive(request: DeriveStyleRequest): Promise<Result<StyleBible>>;
  /**
   * Four tiles, generated **before** the lock rather than after it.
   *
   * `docs/06-screen-briefs.md` and RV-204 both order this choose → probe → lock, and
   * that is the order the Style Lab is built in: probing a style you have already
   * committed to is not a decision, it is a receipt. See `style/probe-seal.ts` for how
   * that is reconciled with the one guard in front of every image generation.
   */
  probe(request: ProbeStyleRequest): Promise<Result<StyleProbeSheet>>;
  /**
   * Freezes the checksum. Every asset dedup key depends on it, so this is the moment
   * the asset library forks.
   */
  lock(id: StyleBibleId): Promise<Result<StyleBible>>;
}

// ── S2/S3/S4/S7 Story ───────────────────────────────────────────────────────

export interface StoryEnginePort {
  /** S2: brief plus locked style to the series outline. */
  generateSeriesBible(brief: Brief, style: StyleBible): Promise<Result<SeriesBible>>;
  /** S4: the world an episode needs, as specs the registry can price. */
  generateWorld(bible: SeriesBible, episodeId: EpisodeId): Promise<Result<readonly AssetSpec[]>>;
  /** S7: scenes to shots. */
  generateShotList(scene: Scene, style: StyleBible): Promise<Result<readonly Shot[]>>;
}

// ── S6 Produce ──────────────────────────────────────────────────────────────

export interface AssetProductionRequest {
  readonly spec: AssetSpec;
  readonly style: StyleBible;
  /** Seeded from the run, so a replay produces the same pixels (#1). */
  readonly seed: number;
}

export interface AssetProductionPort {
  /** Generate, matte, split into parts, rig, clip, and register. One asset version. */
  produce(request: AssetProductionRequest): Promise<Result<AssetVersion>>;
}

// ── narrative memory ────────────────────────────────────────────────────────

export interface NarrativeMemoryPort {
  /** Fold a written scene into the bi-temporal graph. */
  ingestScene(seriesId: SeriesId, scene: Scene): Promise<Result<readonly ContinuityIssue[]>>;
  /** Budgeted retrieval, deterministic for a given graph state. */
  retrieve(request: MemoryRetrievalRequest): Promise<Result<MemoryRetrievalResult>>;
  /** Every unresolved contradiction in an episode's subtree. */
  checkContinuity(episodeId: EpisodeId): Promise<Result<readonly ContinuityIssue[]>>;
}

// ── S10/S11 Render and deliver ──────────────────────────────────────────────

export interface RenderRequest {
  readonly ir: AnimationIR;
  readonly formats: readonly FormatProfileId[];
  readonly outputDir: string;
}

export interface RenderOutput {
  /** Content hash of each produced file, one per requested format. */
  readonly artifacts: readonly { readonly format: FormatProfileId; readonly hash: Sha256Hex }[];
}

export interface RenderPort {
  render(request: RenderRequest): Promise<Result<RenderOutput>>;
}
