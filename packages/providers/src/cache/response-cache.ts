/**
 * Never pay twice for a byte-identical request.
 *
 * The key is `compositeHash(model, params, prompt, refHashes)` from
 * `@rv/shared-kernel` - length-prefixed, so the classic concatenation collision where
 * `["ab","c"]` and `["a","bc"]` hash alike cannot happen. Params go through
 * `stableStringify` first, because `JSON.stringify` orders keys by insertion and two
 * logically identical requests would otherwise miss.
 *
 * The port is here; only the in-memory implementation is. A disk-backed one belongs in
 * `@rv/persistence` alongside the rest of the content-addressed store - putting it here
 * would give this package a filesystem dependency for the sake of one class.
 */

import {
  type AppError,
  type Clock,
  type Result,
  type Sha256,
  UNIT,
  type Unit,
  compositeHash,
  contentHash,
  ok,
} from '@rv/shared-kernel';

/** Everything that can change the bytes a provider returns. */
export interface CacheKeyInput {
  /** `provider:model`. Two providers serving the same slug bill and behave differently. */
  readonly modelRef: string;
  /** Temperature, seed, size - anything the call sends that is not the prompt. */
  readonly params: unknown;
  readonly prompt: string;
  /** Content hashes of reference images, in the order they are sent. Order matters. */
  readonly refHashes?: readonly string[];
}

/**
 * Builds the cache key.
 *
 * Reference hashes are folded into a single component rather than spread across the
 * composite, so a request with two references cannot collide with one whose prompt
 * happens to equal the first reference's hash.
 */
export function cacheKey(input: CacheKeyInput): Sha256 {
  return compositeHash(
    input.modelRef,
    contentHash(input.params),
    input.prompt,
    contentHash([...(input.refHashes ?? [])]),
  );
}

export interface CacheEntry<T> {
  readonly value: T;
  /** Epoch millis the entry was written, from an injected clock. */
  readonly storedAt: number;
  /** `provider:model` that produced it, for the ledger's `cacheHit` row. */
  readonly modelRef: string;
}

export interface ResponseCache {
  get<T>(key: Sha256): Promise<Result<CacheEntry<T> | null, AppError>>;
  set<T>(key: Sha256, entry: Omit<CacheEntry<T>, 'storedAt'>): Promise<Result<Unit, AppError>>;
  delete(key: Sha256): Promise<Result<Unit, AppError>>;
  clear(): Promise<Result<Unit, AppError>>;
  size(): number;
}

export interface InMemoryResponseCacheOptions {
  readonly clock: Clock;
  /**
   * Entries to keep. Least-recently-*written* is evicted first.
   *
   * A bound rather than none because a long run generates thousands of image buffers
   * and an unbounded map is a memory leak with extra steps.
   */
  readonly maxEntries?: number;
  /** Turns the cache into a no-op. This is what `--no-cache` sets. */
  readonly disabled?: boolean;
}

const DEFAULT_MAX_ENTRIES = 512;

export class InMemoryResponseCache implements ResponseCache {
  readonly #clock: Clock;
  readonly #maxEntries: number;
  readonly #disabled: boolean;
  // Insertion-ordered, which is what makes the eviction below O(1) without a list.
  readonly #entries = new Map<string, CacheEntry<unknown>>();

  constructor(options: InMemoryResponseCacheOptions) {
    this.#clock = options.clock;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#disabled = options.disabled ?? false;
  }

  // The port is async because a disk-backed implementation must be; this one is not,
  // so the promises are resolved rather than the methods being pointlessly `async`.
  get<T>(key: Sha256): Promise<Result<CacheEntry<T> | null, AppError>> {
    if (this.#disabled) return Promise.resolve(ok(null));
    const entry = this.#entries.get(key);
    return Promise.resolve(ok(entry === undefined ? null : (entry as CacheEntry<T>)));
  }

  set<T>(key: Sha256, entry: Omit<CacheEntry<T>, 'storedAt'>): Promise<Result<Unit, AppError>> {
    if (this.#disabled) return Promise.resolve(ok(UNIT));

    // Delete first so a rewrite moves to the back of the insertion order rather than
    // keeping its original eviction position.
    this.#entries.delete(key);
    this.#entries.set(key, { ...entry, storedAt: this.#clock.now() });

    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
    return Promise.resolve(ok(UNIT));
  }

  delete(key: Sha256): Promise<Result<Unit, AppError>> {
    this.#entries.delete(key);
    return Promise.resolve(ok(UNIT));
  }

  clear(): Promise<Result<Unit, AppError>> {
    this.#entries.clear();
    return Promise.resolve(ok(UNIT));
  }

  size(): number {
    return this.#entries.size;
  }
}
