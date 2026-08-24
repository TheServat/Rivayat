/**
 * Opening the asset library: SQLite for the index, the filesystem CAS for the bytes.
 *
 * One helper rather than three call sites, because the two halves have to agree - a
 * database that indexes blobs the store does not have is a library that resolves every
 * key and then fails at draw time - and because closing the handle is easy to forget.
 * `withRegistry` owns the lifetime; a command never sees the handle.
 *
 * The default location is `workspace/rivayat.db` plus `workspace/assets`, which is
 * docs/04 §7's layout. `rv assets produce` currently writes to `workspace/produce-demo.db`
 * instead, deliberately, so the demo cannot corrupt the index the API is serving - so
 * `--db` and `--store` exist to point these commands at it.
 */

import { join } from 'node:path';

import type { AssetRepository, BlobStore } from '@rv/asset-registry';
import { DrizzleAssetRepository, FsBlobStore, createDatabase } from '@rv/persistence';
import { type AppError, type Result, isErr } from '@rv/shared-kernel';

export interface RegistryLocation {
  readonly dbUrl: string;
  readonly storeRoot: string;
}

/** Where the library lives, given the workspace and whatever the user overrode. */
export function registryLocation(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  overrides: { readonly db?: string | undefined; readonly store?: string | undefined } = {},
): RegistryLocation {
  return {
    dbUrl: overrides.db ?? env.RV_DB_URL ?? `file:${join(workspaceRoot, 'rivayat.db')}`,
    storeRoot: overrides.store ?? env.RV_ASSET_STORE ?? join(workspaceRoot, 'assets'),
  };
}

export interface OpenRegistry {
  readonly repository: AssetRepository;
  readonly blobs: BlobStore;
}

/**
 * Runs `body` against an open library and closes the handle whatever happens.
 *
 * SQLite in WAL mode holds the file open for the life of the process, so a command that
 * leaks a handle makes the next command - and the API - fail to open the same file.
 */
export async function withRegistry<T>(
  location: RegistryLocation,
  body: (open: OpenRegistry) => Promise<Result<T, AppError>>,
): Promise<Result<T, AppError>> {
  const database = createDatabase(location.dbUrl);
  if (isErr(database)) return database;
  try {
    return await body({
      repository: new DrizzleAssetRepository(database.value),
      blobs: new FsBlobStore({ root: location.storeRoot }),
    });
  } finally {
    database.value.close();
  }
}
