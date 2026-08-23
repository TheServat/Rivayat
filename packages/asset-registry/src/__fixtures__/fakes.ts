/**
 * Hand-written doubles for the two ports whose real implementations live elsewhere.
 *
 * These exist for unit-level questions - "does the use-case propagate a repository
 * failure", "does the floor actually filter" - and for nothing else. Every claim about
 * the *storage* guarantees (no double write, ordinals, forking on a style change) is
 * asserted in `@rv/persistence` against a real in-memory SQLite with the real
 * migrations applied, because a fake cannot fail a unique index and the unique index is
 * where those guarantees actually live.
 *
 * {@link FakeAssetRepository} records every method it is asked for, so a test can
 * assert that a read-only use-case really was read-only.
 */

import { type AppError, type Result, UNIT, type Unit, err, ok } from '@rv/shared-kernel';
import type { Asset, AssetId, AssetKey, AssetVersionId, IsoInstant } from '@rv/contracts';

import type {
  AppendVersionOptions,
  AssetIdentityDraft,
  AssetRepository,
  AssetSearchRecord,
  AssetVersionDraft,
  EmbeddingPort,
  NewAssetVersion,
  StoredAssetVersion,
} from '../ports/index';

/** Method names that change stored state. Used to prove a plan wrote nothing. */
export const WRITE_METHODS = [
  'create',
  'appendVersion',
  'setCurrentVersion',
  'saveEmbedding',
] as const;

export class FakeAssetRepository implements AssetRepository {
  readonly calls: string[] = [];
  readonly #byKey = new Map<AssetKey, Asset>();
  readonly #byId = new Map<AssetId, Asset>();
  #records: readonly AssetSearchRecord[] = [];
  #failure: AppError | null = null;

  /** Every subsequent call fails with this error, so failure paths are reachable. */
  failWith(error: AppError): void {
    this.#failure = error;
  }

  seed(asset: Asset): void {
    this.#byKey.set(asset.key, asset);
    this.#byId.set(asset.id, asset);
  }

  seedRecords(records: readonly AssetSearchRecord[]): void {
    this.#records = records;
  }

  get wrote(): boolean {
    return this.calls.some((call) => (WRITE_METHODS as readonly string[]).includes(call));
  }

  findByKey(key: AssetKey): Promise<Result<Asset | null>> {
    return this.#answer('findByKey', () => this.#byKey.get(key) ?? null);
  }

  findManyByKeys(keys: readonly AssetKey[]): Promise<Result<ReadonlyMap<AssetKey, Asset>>> {
    return this.#answer('findManyByKeys', () => {
      const found = new Map<AssetKey, Asset>();
      for (const key of keys) {
        const asset = this.#byKey.get(key);
        if (asset !== undefined) found.set(key, asset);
      }
      return found;
    });
  }

  findById(id: AssetId): Promise<Result<Asset | null>> {
    return this.#answer('findById', () => this.#byId.get(id) ?? null);
  }

  create(
    _identity: AssetIdentityDraft,
    _firstVersion: NewAssetVersion,
    _now: IsoInstant,
  ): Promise<Result<StoredAssetVersion>> {
    return this.#answer('create', () => {
      throw new Error('FakeAssetRepository.create is only here to be counted, never to succeed');
    });
  }

  appendVersion(
    _draft: AssetVersionDraft,
    _options: AppendVersionOptions,
    _now: IsoInstant,
  ): Promise<Result<StoredAssetVersion>> {
    return this.#answer('appendVersion', () => {
      throw new Error('FakeAssetRepository.appendVersion is only here to be counted');
    });
  }

  setCurrentVersion(
    _assetId: AssetId,
    _versionId: AssetVersionId,
    _now: IsoInstant,
  ): Promise<Result<Unit>> {
    return this.#answer('setCurrentVersion', () => UNIT);
  }

  listSearchRecords(): Promise<Result<readonly AssetSearchRecord[]>> {
    return this.#answer('listSearchRecords', () => this.#records);
  }

  saveEmbedding(
    _assetId: AssetId,
    _embedding: readonly number[],
    _model: string,
  ): Promise<Result<Unit>> {
    return this.#answer('saveEmbedding', () => UNIT);
  }

  #answer<T>(call: string, produce: () => T): Promise<Result<T>> {
    this.calls.push(call);
    if (this.#failure !== null) return Promise.resolve(err(this.#failure));
    return Promise.resolve(ok(produce()));
  }
}

/**
 * A deterministic embedder over a fixed vocabulary.
 *
 * Presence-of-term vectors: crude, but it makes similarity a hand-checkable number, so
 * a test can assert an actual ranking rather than "the stub returned what I told it
 * to". A stub that answers with canned vectors would prove nothing about the ranking.
 */
export const TEST_VOCABULARY = [
  'tree',
  'oak',
  'flora',
  'gnarled',
  'old',
  'mature',
  'forest',
  'boulder',
  'moss',
  'stone',
  'mineral',
] as const;

export class KeywordEmbeddingPort implements EmbeddingPort {
  readonly model = 'test-keyword-v1';
  readonly dimensions = TEST_VOCABULARY.length;
  #failure: AppError | null = null;

  failWith(error: AppError): void {
    this.#failure = error;
  }

  embed(texts: readonly string[]): Promise<Result<readonly (readonly number[])[]>> {
    if (this.#failure !== null) return Promise.resolve(err(this.#failure));
    const vectors = texts.map((text) => {
      const lowered = text.toLowerCase();
      return TEST_VOCABULARY.map((term) => (lowered.includes(term) ? 1 : 0));
    });
    return Promise.resolve(ok(vectors));
  }
}

/** An embedder that returns nothing, to reach the "provider gave no vector" branch. */
export class EmptyEmbeddingPort implements EmbeddingPort {
  readonly model = 'test-empty';
  readonly dimensions = 0;

  embed(): Promise<Result<readonly (readonly number[])[]>> {
    return Promise.resolve(ok([]));
  }
}
