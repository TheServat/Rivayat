/**
 * The content-addressed store. The path *is* the identity.
 *
 * `<root>/<sha[0:2]>/<sha256>` — the two-character shard exists so no directory holds
 * hundreds of thousands of entries, which is where NTFS and ext4 both start to hurt.
 *
 * Four properties, and each one is a decision rather than an accident:
 *
 * **Deduplicated.** `put` hashes first and returns early if the file is already there.
 * Two projects that need the same oak tree in the same style share one file, which is
 * the mechanism behind "episode N+1 is nearly free" (ADR-0002) rather than a nice
 * side effect of it.
 *
 * **Atomic.** Bytes go to a temp file and are published by linking that file at its
 * content address. A crash or a killed render can therefore leave a `.tmp` behind but
 * can never leave a truncated file at a content address — which would be a file that
 * lies about its own name and would be served forever after.
 *
 * **Race-safe, and honest about who won.** Two writers of the same bytes both try to
 * publish. `link` fails when the target exists, on every platform, which is what lets
 * exactly one of them report `created: true`; rename would silently replace and let
 * both claim it. That matters because "did I create this blob?" is how the caller
 * decides whether anything was actually spent. See {@link commit}.
 *
 * **Verifiable and sweepable.** `verify()` re-hashes and reports what does not match
 * its own name. `gc()` reports what nothing references and deletes only when asked —
 * ADR-0006 is explicit that reclamation is a separate, deliberate act, because a hash
 * may be referenced by a project we are not currently looking at.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  copyFile,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  NotFoundError,
  type Result,
  type Sha256,
  ValidationError,
  err,
  isErr,
  ok,
  shardPath,
  toAppError,
} from '@rv/shared-kernel';
import type { BlobPutResult, BlobStore } from '@rv/asset-registry';
import type { Sha256Hex } from '@rv/contracts';

/** Where in-flight writes land before they are renamed to their content address. */
const TEMP_DIR = '.tmp';
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface FsBlobStoreOptions {
  /** Root of the store. `workspace/assets` in a normal checkout. */
  readonly root: string;
}

export interface BlobVerifyReport {
  readonly checked: number;
  readonly ok: number;
  /** Files whose contents no longer hash to the name they are filed under. */
  readonly corrupt: readonly CorruptBlob[];
}

export interface CorruptBlob {
  readonly expected: Sha256Hex;
  readonly actual: Sha256Hex;
  readonly path: string;
}

export interface BlobGcReport {
  readonly scanned: number;
  readonly reachable: number;
  readonly unreferenced: readonly Sha256Hex[];
  readonly reclaimableBytes: number;
  /** Empty unless `gc` was called with `delete: true`. */
  readonly deleted: readonly Sha256Hex[];
}

export interface BlobGcOptions {
  /**
   * Actually unlink. Default `false`.
   *
   * Off by default because the sweep runs against *one* caller's idea of what is
   * reachable, and the store is shared across every project on the machine.
   */
  readonly delete?: boolean;
}

export class FsBlobStore implements BlobStore {
  readonly #root: string;
  /**
   * Makes concurrent temp names unique inside this process; the pid separates
   * processes. Not `Math.random()` — non-negotiable #1 holds here too, and a counter
   * is both deterministic and sufficient.
   */
  #sequence = 0;

  constructor(options: FsBlobStoreOptions) {
    this.#root = options.root;
  }

  get root(): string {
    return this.#root;
  }

  /** `<root>/<hash[0:2]>/<hash>`. Pure: it does not check that anything is there. */
  path(hash: Sha256Hex): string {
    return join(this.#root, shardPath(hash as Sha256));
  }

  async has(hash: Sha256Hex): Promise<Result<boolean>> {
    const invalid = rejectMalformed(hash);
    if (invalid !== null) return invalid;
    return ok(await exists(this.path(hash)));
  }

  /**
   * Stores bytes under their own hash.
   *
   * Idempotent: identical bytes put twice yield the same hash, write once, and report
   * `created: false` the second time. The caller uses that flag to tell "we spent
   * something" apart from "we proved we already had it".
   */
  async put(bytes: Uint8Array): Promise<Result<BlobPutResult>> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const target = this.path(hash);

    if (await exists(target)) {
      return ok({ hash, byteSize: bytes.byteLength, created: false });
    }

    try {
      await mkdir(dirname(target), { recursive: true });
      const temp = await this.#writeTemp(hash, bytes);
      try {
        return ok({ hash, byteSize: bytes.byteLength, created: await commit(temp, target) });
      } finally {
        await rm(temp, { force: true });
      }
    } catch (caught) {
      return err(toAppError(caught, `Could not store blob ${hash}`));
    }
  }

  async get(hash: Sha256Hex): Promise<Result<Uint8Array>> {
    const invalid = rejectMalformed(hash);
    if (invalid !== null) return invalid;

    try {
      return ok(new Uint8Array(await readFile(this.path(hash))));
    } catch (caught) {
      if (isMissing(caught)) return err(new NotFoundError('Blob', hash));
      return err(toAppError(caught, `Could not read blob ${hash}`));
    }
  }

  /**
   * Exposes a blob under a readable filename.
   *
   * A copy rather than a symlink or a hard link: symlinks need elevation on Windows,
   * and a hard link would let an external tool that opens the file for writing corrupt
   * the canonical copy — at which point the store's name no longer matches its bytes.
   */
  async link(hash: Sha256Hex, name: string): Promise<Result<string>> {
    const invalid = rejectMalformed(hash);
    if (invalid !== null) return invalid;
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      return err(
        new ValidationError({
          message: 'Link name must be a bare filename.',
          context: { name },
        }),
      );
    }

    const source = this.path(hash);
    if (!(await exists(source))) return err(new NotFoundError('Blob', hash));

    const destination = join(this.#root, TEMP_DIR, 'links', `${hash.slice(0, 12)}-${name}`);
    try {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      return ok(destination);
    } catch (caught) {
      return err(toAppError(caught, `Could not expose blob ${hash} as ${name}`));
    }
  }

  /**
   * Re-hashes stored files and reports the ones that no longer match their name.
   *
   * Content addressing is only a guarantee if something occasionally checks it. Pass a
   * hash to verify one file, omit it to sweep the store.
   */
  async verify(hash?: Sha256Hex): Promise<Result<BlobVerifyReport>> {
    let targets: readonly Sha256Hex[];
    if (hash === undefined) {
      const stored = await this.#listStored();
      if (isErr(stored)) return stored;
      targets = stored.value;
    } else {
      const invalid = rejectMalformed(hash);
      if (invalid !== null) return invalid;
      targets = [hash];
    }

    const corrupt: CorruptBlob[] = [];
    let checked = 0;

    for (const candidate of targets) {
      const path = this.path(candidate);
      try {
        const bytes = await readFile(path);
        checked += 1;
        const actual = createHash('sha256').update(bytes).digest('hex');
        if (actual !== candidate) corrupt.push({ expected: candidate, actual, path });
      } catch (caught) {
        if (isMissing(caught)) return err(new NotFoundError('Blob', candidate));
        return err(toAppError(caught, `Could not verify blob ${candidate}`));
      }
    }

    return ok({ checked, ok: checked - corrupt.length, corrupt });
  }

  /**
   * Mark-and-sweep against a caller-supplied reachable set.
   *
   * Reports by default and deletes only on request. The store grows monotonically
   * until this runs, which ADR-0006 accepts as work we own rather than pretending a
   * row deletion can be trusted to imply a file deletion.
   */
  async gc(
    reachable: Iterable<Sha256Hex>,
    options: BlobGcOptions = {},
  ): Promise<Result<BlobGcReport>> {
    const listed = await this.#listStored();
    if (isErr(listed)) return listed;
    const stored = listed.value;

    const live = new Set(reachable);
    const unreferenced = stored.filter((hash) => !live.has(hash)).sort();

    let reclaimableBytes = 0;
    const deleted: Sha256Hex[] = [];

    for (const hash of unreferenced) {
      const path = this.path(hash);
      try {
        reclaimableBytes += (await stat(path)).size;
        if (options.delete === true) {
          await rm(path, { force: true });
          deleted.push(hash);
        }
      } catch (caught) {
        if (!isMissing(caught)) return err(toAppError(caught, `Could not sweep blob ${hash}`));
      }
    }

    return ok({
      scanned: stored.length,
      reachable: stored.length - unreferenced.length,
      unreferenced,
      reclaimableBytes,
      deleted,
    });
  }

  async #writeTemp(hash: Sha256Hex, bytes: Uint8Array): Promise<string> {
    // Read the counter into a local *before* the first await. Leaving it on `this`
    // across the `mkdir` lets four concurrent puts all observe the final value and
    // collide on one temp name, which is exactly the race this name exists to avoid.
    this.#sequence += 1;
    const ticket = this.#sequence;

    const directory = join(this.#root, TEMP_DIR);
    await mkdir(directory, { recursive: true });
    const temp = join(directory, `${hash}.${String(process.pid)}.${String(ticket)}.tmp`);
    await writeFile(temp, bytes, { flag: 'wx' });
    return temp;
  }

  /** Every hash actually on disk. Names that are not hashes are ignored, not repaired. */
  async #listStored(): Promise<Result<Sha256Hex[]>> {
    const found: Sha256Hex[] = [];
    let shards: string[];
    try {
      shards = await readdir(this.#root);
    } catch (caught) {
      if (isMissing(caught)) return ok(found);
      return err(toAppError(caught, `Could not list the blob store at ${this.#root}`));
    }

    for (const shard of shards) {
      if (shard === TEMP_DIR || shard.length !== 2) continue;
      const entries = await readdir(join(this.#root, shard)).catch(() => [] as string[]);
      for (const entry of entries) {
        if (HASH_PATTERN.test(entry) && entry.startsWith(shard)) found.push(entry);
      }
    }

    return ok(found);
  }
}

/**
 * Publishes a fully written temp file at its content address.
 *
 * A hard link rather than a rename, because `link` is the only filesystem operation
 * that both publishes atomically *and* fails when the target already exists. Rename
 * silently replaces on POSIX and on Windows, so with rename every racing writer would
 * report itself as the creator - and "did I create this blob?" is the question the
 * cost ledger answers "did we spend money?" with.
 *
 * Returns `true` if this call created the file, `false` if another writer got there
 * first with the same bytes. Falls back to `rename` where hard links are unavailable
 * (FAT, some network mounts): still atomic, just unable to attribute the creation.
 */
async function commit(temp: string, target: string): Promise<boolean> {
  try {
    await link(temp, target);
    return true;
  } catch {
    if (await exists(target)) return false;
    await rename(temp, target);
    return true;
  }
}

function rejectMalformed(hash: string): Result<never> | null {
  if (HASH_PATTERN.test(hash)) return null;
  return err(
    new ValidationError({
      message: 'Not a lowercase sha256 hex digest.',
      context: { hash },
    }),
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isMissing(caught: unknown): boolean {
  return caught instanceof Error && 'code' in caught && caught.code === 'ENOENT';
}
