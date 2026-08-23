/**
 * Test scaffolding for the two things this package owns: a real database and a real
 * store on a real filesystem.
 *
 * Both are genuine. The database is `:memory:` with the committed migrations applied,
 * so a unique index can actually fire; the blob store is a temp directory, so an
 * `fsync`, a rename and a corrupted file are all real events. Neither is a mock,
 * because the guarantees under test are properties of SQLite and of the filesystem,
 * not of this code's intentions.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unwrap } from '@rv/shared-kernel';

import { FsBlobStore } from '../blob-store/fs-blob-store';
import { type DatabaseHandle, createDatabase } from '../database/database';

/** A migrated in-memory database. The caller closes it. */
export function openTestDatabase(): DatabaseHandle {
  return unwrap(createDatabase(':memory:'));
}

export interface TempBlobStore {
  readonly store: FsBlobStore;
  readonly root: string;
  cleanup(): Promise<void>;
}

export async function openTempBlobStore(): Promise<TempBlobStore> {
  const root = await mkdtemp(join(tmpdir(), 'rv-cas-'));
  return {
    store: new FsBlobStore({ root }),
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}
