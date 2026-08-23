import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isErr, isOk } from '@rv/shared-kernel';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { assets, blobs } from '../schema/index';
import { createDatabase, migrationsFolder } from './database';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rv-db-'));
  cleanups.push(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

describe('createDatabase', () => {
  it('applies the committed migrations to an in-memory database', () => {
    const handle = createDatabase(':memory:');
    expect(isOk(handle)).toBe(true);
    if (!isOk(handle)) return;

    // Querying a table proves the migration ran; an unmigrated SQLite would throw.
    expect(handle.value.db.select().from(assets).all()).toEqual([]);
    expect(handle.value.db.select().from(blobs).all()).toEqual([]);
    handle.value.close();
  });

  it('enforces foreign keys, which SQLite leaves off by default', () => {
    const handle = createDatabase(':memory:');
    if (!isOk(handle)) throw new Error('expected an open database');

    const [row] = handle.value.sqlite.pragma('foreign_keys') as { foreign_keys: number }[];

    expect(row?.foreign_keys).toBe(1);
    handle.value.close();
  });

  it('creates the parent directory for a file: URL and survives a reopen', async () => {
    const directory = await tempDir();
    const url = `file:${join(directory, 'nested', 'rivayat.db')}`;

    const first = createDatabase(url);
    if (!isOk(first)) throw new Error('expected an open database');
    first.value.db
      .insert(blobs)
      .values({
        hash: 'a'.repeat(64),
        byteSize: 3,
        mediaType: null,
        createdAt: '2026-08-23T00:00:00.000Z',
      })
      .run();
    first.value.close();

    const second = createDatabase(url);
    if (!isOk(second)) throw new Error('expected to reopen the database');
    expect(second.value.db.select().from(blobs).all()).toHaveLength(1);
    second.value.close();
  });

  it('uses WAL on disk so readers do not block the single writer', async () => {
    const directory = await tempDir();
    const handle = createDatabase(`file:${join(directory, 'wal.db')}`);
    if (!isOk(handle)) throw new Error('expected an open database');

    const [row] = handle.value.sqlite.pragma('journal_mode') as { journal_mode: string }[];

    expect(row?.journal_mode).toBe('wal');
    handle.value.close();
  });

  it('accepts a bare path as well as a file: URL', async () => {
    const directory = await tempDir();
    // On Windows a bare path starts `C:\`, which a naive scheme check reads as a URL.
    const handle = createDatabase(join(directory, 'bare.db'));
    expect(isOk(handle)).toBe(true);
    if (isOk(handle)) handle.value.close();
  });

  it('accepts a fully-qualified file:// URL', async () => {
    const directory = await tempDir();
    const handle = createDatabase(pathToFileURL(join(directory, 'url.db')).href);
    expect(isOk(handle)).toBe(true);
    if (isOk(handle)) handle.value.close();
  });

  it('names the Postgres swap instead of silently falling back to a local file', () => {
    const handle = createDatabase('postgres://localhost:5432/rivayat');

    expect(isErr(handle)).toBe(true);
    if (!isErr(handle)) return;
    expect(handle.error.kind).toBe('unsupported');
  });

  it.each([
    ['an empty URL', '   '],
    ['an unknown scheme', 'mysql://localhost/rivayat'],
  ])('rejects %s', (_case, url) => {
    const handle = createDatabase(url);

    expect(isErr(handle)).toBe(true);
    if (!isErr(handle)) return;
    expect(handle.error.kind).toBe('validation');
  });

  it('can skip migrations, for a caller that owns the schema itself', () => {
    const handle = createDatabase(':memory:', { applyMigrations: false });
    if (!isOk(handle)) throw new Error('expected an open database');

    const tables = handle.value.sqlite
      .prepare(`select name from sqlite_master where type = 'table'`)
      .all();

    expect(tables).toEqual([]);
    handle.value.close();
  });

  it('reports a failure rather than throwing when the location cannot be opened', async () => {
    const directory = await tempDir();
    // A directory is not a database file, and better-sqlite3 says so.
    const handle = createDatabase(directory);

    expect(isErr(handle)).toBe(true);
  });

  it('resolves the committed migrations directory', () => {
    expect(migrationsFolder()).not.toBe('');
  });

  it('honours the busy timeout it was given', () => {
    const handle = createDatabase(':memory:', { busyTimeoutMs: 1234 });
    if (!isOk(handle)) throw new Error('expected an open database');

    const [row] = handle.value.sqlite.pragma('busy_timeout') as { timeout: number }[];

    expect(row?.timeout).toBe(1234);
    handle.value.close();
  });

  it('creates the dedup unique index the registry relies on', () => {
    const handle = createDatabase(':memory:');
    if (!isOk(handle)) throw new Error('expected an open database');

    const indexes = handle.value.db.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'index' and tbl_name = 'assets'`,
    );

    // RV-100: a duplicate insert must fail at the database level, not only in
    // application code.
    expect(indexes.map((row) => row.name)).toContain('assets_dedup_uq');
    handle.value.close();
  });
});
