/**
 * The registry's storage port.
 *
 * Declared here, in the application layer, and implemented in `@rv/persistence` -
 * that direction is the entire reason ADR-0006's Postgres swap is a DI binding change
 * instead of a rewrite. Nothing below this interface knows that SQLite exists.
 *
 * Two methods carry invariants the interface cannot express in types and every
 * implementation must therefore honour:
 *
 * 1. {@link AssetRepository.appendVersion} assigns the next ordinal **atomically**.
 *    Read-then-write in the caller would let two concurrent takes collide on the same
 *    ordinal, and the ordinal is how "version N is still readable" is addressed.
 * 2. No method ever replaces or removes an `AssetVersion`. A second take appends.
 */

import type { Result, Unit } from '@rv/shared-kernel';
import type {
  Asset,
  AssetArchetype,
  AssetId,
  AssetKey,
  AssetKeyParts,
  AssetVersion,
  AssetVersionId,
  IsoInstant,
  Label,
  Prose,
  SemanticKey,
} from '@rv/contracts';

/**
 * A version on its way into the store, before the store has decided where it sits.
 *
 * `ordinal` is deliberately absent: it is the repository's to assign, inside the same
 * transaction as the insert.
 */
export type AssetVersionDraft = Omit<AssetVersion, 'ordinal'>;

/**
 * A version produced by a generator, which does not yet know which asset it belongs to.
 *
 * The use-case fills `assetId` once it has resolved the dedup key to an existing asset
 * or minted a new one.
 */
export type NewAssetVersion = Omit<AssetVersion, 'assetId' | 'ordinal'>;

/** The identity half of an `Asset`, as supplied at first registration. */
export interface AssetIdentityDraft {
  readonly id: AssetId;
  readonly key: AssetKey;
  /**
   * The four key components, stored alongside the key.
   *
   * Redundant with `key` by construction, and worth the columns: when a cache miss
   * happens that should not have, this is what you diff to find which component moved.
   */
  readonly keyParts: AssetKeyParts;
  readonly semanticKey: SemanticKey;
  readonly archetype: AssetArchetype;
  readonly label: Label;
  readonly description: Prose;
  readonly tags: readonly string[];
}

export interface AppendVersionOptions {
  /** Whether the new version becomes the one served when nothing is pinned. */
  readonly makeCurrent: boolean;
}

export interface StoredAssetVersion {
  readonly asset: Asset;
  readonly version: AssetVersion;
}

/**
 * One row of the semantic index.
 *
 * Flat and embedding-bearing so a similarity sweep is a single read; the full `Asset`
 * tree would be several hundred times the bytes for the same ranking.
 */
export interface AssetSearchRecord {
  readonly assetId: AssetId;
  readonly key: AssetKey;
  readonly semanticKey: SemanticKey;
  readonly label: Label;
  readonly description: Prose;
  readonly tags: readonly string[];
  /** `null` until the asset has been indexed. Unindexed assets are never ranked. */
  readonly embedding: readonly number[] | null;
  /** Which model produced `embedding`. Vectors from different models are incomparable. */
  readonly embeddingModel: string | null;
}

export interface AssetRepository {
  /** The hot path of every generation request. Must be an indexed lookup. */
  findByKey(key: AssetKey): Promise<Result<Asset | null>>;

  /**
   * Bulk form of {@link AssetRepository.findByKey}.
   *
   * A 40-spec episode plan must not be 40 round trips; the plan is shown to a human
   * who is waiting for it.
   */
  findManyByKeys(keys: readonly AssetKey[]): Promise<Result<ReadonlyMap<AssetKey, Asset>>>;

  findById(id: AssetId): Promise<Result<Asset | null>>;

  /** Creates the asset and its first version in one transaction. Fails if the key exists. */
  create(
    identity: AssetIdentityDraft,
    firstVersion: NewAssetVersion,
    now: IsoInstant,
  ): Promise<Result<StoredAssetVersion>>;

  /** Appends a take. Assigns the next ordinal atomically. Never overwrites. */
  appendVersion(
    draft: AssetVersionDraft,
    options: AppendVersionOptions,
    now: IsoInstant,
  ): Promise<Result<StoredAssetVersion>>;

  /** Rollback: makes an older version current again without disturbing any other. */
  setCurrentVersion(
    assetId: AssetId,
    versionId: AssetVersionId,
    now: IsoInstant,
  ): Promise<Result<Unit>>;

  /** The semantic index, for reuse-before-generate. */
  listSearchRecords(): Promise<Result<readonly AssetSearchRecord[]>>;

  saveEmbedding(
    assetId: AssetId,
    embedding: readonly number[],
    model: string,
  ): Promise<Result<Unit>>;
}
