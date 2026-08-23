import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { unwrap } from '@rv/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { indexedFrame } from '../__fixtures__/doubles';
import { workspaceScratch } from '../__fixtures__/workspace';
import {
  FileFrameStore,
  InMemoryFrameStore,
  decodeFrameFile,
  encodeFrameFile,
  frameFileName,
} from './frame-stores';

describe('frame file format', () => {
  it('round-trips a frame', () => {
    const frame = indexedFrame(3, 2, 9);
    const decoded = unwrap(decodeFrameFile(encodeFrameFile(frame)));
    expect(decoded).toEqual(frame);
  });

  it('rejects a file shorter than its header', () => {
    expect(decodeFrameFile(new Uint8Array(4)).ok).toBe(false);
  });

  it('rejects a file with the wrong magic number', () => {
    const bytes = encodeFrameFile(indexedFrame(2, 2, 0));
    bytes[0] = 0;
    expect(decodeFrameFile(bytes).ok).toBe(false);
  });

  it('rejects a truncated frame rather than encoding a hole', () => {
    // Exactly what a render killed mid-write leaves behind. Encoding it would shift
    // every subsequent frame.
    const bytes = encodeFrameFile(indexedFrame(4, 4, 0));
    const result = decodeFrameFile(bytes.slice(0, bytes.length - 8));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });

  it('names files so a listing sorts numerically', () => {
    expect([frameFileName(9), frameFileName(10), frameFileName(100)].sort()).toEqual([
      frameFileName(9),
      frameFileName(10),
      frameFileName(100),
    ]);
  });
});

describe('InMemoryFrameStore', () => {
  it('stores and returns a frame', async () => {
    const store = new InMemoryFrameStore();
    await store.put(3, indexedFrame(2, 2, 3));
    expect(unwrap(await store.get(3))).toEqual(indexedFrame(2, 2, 3));
  });

  it("copies rather than aliases the caller's buffer", async () => {
    // The renderer reuses one surface for every frame; a retained view would alias the
    // next frame and the store would hold N copies of the last one.
    const store = new InMemoryFrameStore();
    const frame = indexedFrame(2, 2, 1);
    await store.put(0, frame);
    frame.data[0] = 255;
    expect(unwrap(await store.get(0)).data[0]).not.toBe(255);
  });

  it('overwrites silently, because re-rendering a frame is idempotent', async () => {
    const store = new InMemoryFrameStore();
    await store.put(0, indexedFrame(2, 2, 0));
    expect((await store.put(0, indexedFrame(2, 2, 1))).ok).toBe(true);
  });

  it('reports what it holds, ascending', async () => {
    const store = new InMemoryFrameStore();
    await store.put(5, indexedFrame(1, 1, 5));
    await store.put(1, indexedFrame(1, 1, 1));
    expect(await store.list()).toEqual([1, 5]);
    expect(await store.has(5)).toBe(true);
    expect(await store.has(2)).toBe(false);
  });

  it('fails a read for a frame that is not there', async () => {
    expect((await new InMemoryFrameStore().get(0)).ok).toBe(false);
  });

  it('clears', async () => {
    const store = new InMemoryFrameStore();
    await store.put(0, indexedFrame(1, 1, 0));
    await store.clear();
    expect(await store.list()).toEqual([]);
  });
});

describe('FileFrameStore', () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(await workspaceScratch(), 'frames-'));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('round-trips a frame through the disk', async () => {
    const store = new FileFrameStore(join(directory, 'a'));
    await store.put(7, indexedFrame(4, 3, 7));
    expect(unwrap(await store.get(7))).toEqual(indexedFrame(4, 3, 7));
  });

  it('creates its directory on first write', async () => {
    const store = new FileFrameStore(join(directory, 'deep', 'nested'));
    expect((await store.put(0, indexedFrame(1, 1, 0))).ok).toBe(true);
  });

  it('lists only the frame files it recognises', async () => {
    const path = join(directory, 'mixed');
    const store = new FileFrameStore(path);
    await store.put(2, indexedFrame(1, 1, 2));
    await store.put(11, indexedFrame(1, 1, 11));
    await writeFile(join(path, 'notes.txt'), 'ignore me');
    expect(await store.list()).toEqual([2, 11]);
  });

  it('reports nothing for a directory that does not exist', async () => {
    expect(await new FileFrameStore(join(directory, 'absent')).list()).toEqual([]);
    expect(await new FileFrameStore(join(directory, 'absent')).has(0)).toBe(false);
  });

  it('fails a read for a missing frame', async () => {
    expect((await new FileFrameStore(join(directory, 'absent')).get(0)).ok).toBe(false);
  });

  it('clears the directory', async () => {
    const path = join(directory, 'clearable');
    const store = new FileFrameStore(path);
    await store.put(0, indexedFrame(1, 1, 0));
    expect((await store.clear()).ok).toBe(true);
    expect(await store.list()).toEqual([]);
  });
});
