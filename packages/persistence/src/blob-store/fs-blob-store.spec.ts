import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256 } from '@rv/shared-kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type TempBlobStore, openTempBlobStore } from '../__fixtures__/workspace';
import { FsBlobStore as FsBlobStoreClass, type FsBlobStore } from './fs-blob-store';

const OAK = new TextEncoder().encode('oak-tree-layer-bytes');
const OAK_HASH = sha256(OAK) as string;

let temp: TempBlobStore;
let store: FsBlobStore;

beforeEach(async () => {
  temp = await openTempBlobStore();
  store = temp.store;
});

afterEach(async () => {
  await temp.cleanup();
});

describe('FsBlobStore.path', () => {
  it('shards on the first two hex characters', () => {
    expect(store.path(OAK_HASH)).toBe(join(temp.root, OAK_HASH.slice(0, 2), OAK_HASH));
  });

  it('exposes its root, so an operator can point a tool at the store', () => {
    expect(store.root).toBe(temp.root);
  });
});

describe('when the filesystem itself is the problem', () => {
  it('reports a failure rather than throwing when the root is not a directory', async () => {
    const file = join(temp.root, 'not-a-directory');
    await writeFile(file, 'x');
    const broken = new FsBlobStoreClass({ root: file });

    expect(await broken.put(OAK)).toMatchObject({ ok: false });
    // The sweep has to survive it too, or a bad configuration takes out maintenance.
    expect(await broken.verify()).toMatchObject({ ok: false });
    expect(await broken.gc([])).toMatchObject({ ok: false });
  });

  it('does not mistake an unreadable blob for a missing one', async () => {
    // A directory sitting where a blob should be: present, but not readable as bytes.
    await mkdir(store.path(OAK_HASH), { recursive: true });

    const loaded = await store.get(OAK_HASH);
    const verified = await store.verify(OAK_HASH);
    const linked = await store.link(OAK_HASH, 'trunk.png');

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.kind).not.toBe('not-found');
    expect(verified).toMatchObject({ ok: false });
    expect(linked).toMatchObject({ ok: false });
  });
});

describe('FsBlobStore.put', () => {
  it('stores bytes under their own hash', async () => {
    const result = await store.put(OAK);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ hash: OAK_HASH, byteSize: OAK.byteLength, created: true });
    expect(new Uint8Array(await readFile(store.path(OAK_HASH)))).toEqual(OAK);
  });

  it('touches the disk once when the same bytes are stored twice', async () => {
    const first = await store.put(OAK);
    const before = await stat(store.path(OAK_HASH));

    const second = await store.put(OAK);
    const after = await stat(store.path(OAK_HASH));

    expect(first.ok && first.value.created).toBe(true);
    expect(second.ok && second.value.created).toBe(false);
    expect(second.ok && second.value.hash).toBe(OAK_HASH);
    // Same inode, same birth time, same size: the second put proved we had it and
    // wrote nothing. This is the dedup guarantee at the byte level.
    expect(after.ino).toBe(before.ino);
    expect(after.birthtimeMs).toBe(before.birthtimeMs);
    expect(after.size).toBe(before.size);
  });

  it('leaves no temp files behind', async () => {
    await store.put(OAK);
    await store.put(OAK);

    const leftovers = await readdir(join(temp.root, '.tmp')).catch(() => [] as string[]);

    expect(leftovers.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not race when the same bytes are put concurrently', async () => {
    const results = await Promise.all([
      store.put(OAK),
      store.put(OAK),
      store.put(OAK),
      store.put(OAK),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    const hashes = new Set(results.map((result) => (result.ok ? result.value.hash : 'error')));
    expect(hashes).toEqual(new Set([OAK_HASH]));
    // Exactly one writer may claim the creation; the rest must report a no-op rather
    // than an error, or a parallel produce stage would fail for no reason.
    expect(results.filter((result) => result.ok && result.value.created)).toHaveLength(1);
    expect(new Uint8Array(await readFile(store.path(OAK_HASH)))).toEqual(OAK);
  });

  it('stores distinct bytes under distinct addresses', async () => {
    const other = new TextEncoder().encode('birch-tree-layer-bytes');

    const a = await store.put(OAK);
    const b = await store.put(other);

    expect(a.ok && b.ok && a.value.hash).not.toBe(b.ok ? b.value.hash : '');
  });
});

describe('FsBlobStore.get / has', () => {
  it('round-trips bytes exactly', async () => {
    await store.put(OAK);

    const loaded = await store.get(OAK_HASH);

    expect(loaded.ok && loaded.value).toEqual(OAK);
  });

  it('reports a missing blob as not-found, not as an internal failure', async () => {
    const loaded = await store.get('f'.repeat(64));

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.kind).toBe('not-found');
  });

  it('answers has() without reading the bytes', async () => {
    expect((await store.has(OAK_HASH)).ok && (await store.has(OAK_HASH))).toMatchObject({
      value: false,
    });
    await store.put(OAK);
    expect(await store.has(OAK_HASH)).toMatchObject({ value: true });
  });

  it.each(['not-a-hash', 'A'.repeat(64), 'abc'])('rejects %s as an address', async (bad) => {
    const hash = bad;
    expect(await store.has(hash)).toMatchObject({ ok: false });
    expect(await store.get(hash)).toMatchObject({ ok: false });
    expect(await store.link(hash, 'x.png')).toMatchObject({ ok: false });
  });
});

describe('FsBlobStore.link', () => {
  it('exposes a blob under a readable filename', async () => {
    await store.put(OAK);

    const linked = await store.link(OAK_HASH, 'trunk.png');

    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.value.endsWith('trunk.png')).toBe(true);
    expect(new Uint8Array(await readFile(linked.value))).toEqual(OAK);
  });

  it('refuses a name that could escape the store', async () => {
    await store.put(OAK);

    expect(await store.link(OAK_HASH, '../escape.png')).toMatchObject({ ok: false });
    expect(await store.link(OAK_HASH, 'nested/escape.png')).toMatchObject({ ok: false });
  });

  it('refuses to link a blob that is not there', async () => {
    const linked = await store.link(OAK_HASH, 'trunk.png');

    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.error.kind).toBe('not-found');
  });
});

describe('FsBlobStore.verify', () => {
  it('passes a healthy store', async () => {
    await store.put(OAK);
    await store.put(new TextEncoder().encode('another'));

    const report = await store.verify();

    expect(report.ok && report.value).toMatchObject({ checked: 2, ok: 2, corrupt: [] });
  });

  it('detects a file whose bytes no longer match its name', async () => {
    await store.put(OAK);
    // Simulates bit rot or a half-written file that somehow reached its final name.
    await writeFile(store.path(OAK_HASH), 'tampered');

    const report = await store.verify();

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.ok).toBe(0);
    expect(report.value.corrupt).toHaveLength(1);
    expect(report.value.corrupt[0]?.expected).toBe(OAK_HASH);
    expect(report.value.corrupt[0]?.actual).not.toBe(OAK_HASH);
  });

  it('verifies a single address when given one', async () => {
    await store.put(OAK);

    expect(await store.verify(OAK_HASH)).toMatchObject({ value: { checked: 1, ok: 1 } });
  });

  it('reports not-found when asked to verify an address that is not stored', async () => {
    const report = await store.verify('c'.repeat(64));

    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.error.kind).toBe('not-found');
  });

  it('reports an empty store rather than failing on a missing root', async () => {
    const missing = new FsBlobStoreClass({ root: join(temp.root, 'does-not-exist') });

    expect(await missing.verify()).toMatchObject({ value: { checked: 0, corrupt: [] } });
  });
});

describe('FsBlobStore.gc', () => {
  it('reports what nothing references without deleting it', async () => {
    await store.put(OAK);
    const orphan = await store.put(new TextEncoder().encode('orphaned-layer'));
    if (!orphan.ok) throw new Error('setup failed');

    const report = await store.gc([OAK_HASH]);

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.scanned).toBe(2);
    expect(report.value.reachable).toBe(1);
    expect(report.value.unreferenced).toEqual([orphan.value.hash]);
    expect(report.value.reclaimableBytes).toBeGreaterThan(0);
    expect(report.value.deleted).toEqual([]);
    // ADR-0006: reclamation is a separate, deliberate act. The default must not unlink.
    expect(await store.has(orphan.value.hash)).toMatchObject({ value: true });
  });

  it('deletes only when asked, and only what is unreferenced', async () => {
    await store.put(OAK);
    const orphan = await store.put(new TextEncoder().encode('orphaned-layer'));
    if (!orphan.ok) throw new Error('setup failed');

    const report = await store.gc([OAK_HASH], { delete: true });

    expect(report.ok && report.value.deleted).toEqual([orphan.value.hash]);
    expect(await store.has(orphan.value.hash)).toMatchObject({ value: false });
    expect(await store.has(OAK_HASH)).toMatchObject({ value: true });
  });

  it('ignores the temp directory and anything that is not a content address', async () => {
    await store.put(OAK);
    await writeFile(join(temp.root, 'README.txt'), 'not a blob');

    const report = await store.gc([OAK_HASH]);

    expect(report.ok && report.value).toMatchObject({ scanned: 1, unreferenced: [] });
  });
});
