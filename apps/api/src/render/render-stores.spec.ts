/**
 * The two stores that make a resume survive a kill, tested against the kill.
 *
 * Both exist because of a failure the `resume.e2e-spec.ts` child process produced by
 * dying at an unhelpful moment, and both are easy to write in a way that looks right and
 * is not. So the assertions here are about the *torn* states specifically: a frame file
 * that is the right name and the wrong length, and a checkpoint that is half a JSON
 * document.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Size } from '@rv/contracts';
import { frameFileName, type FrameBuffer } from '@rv/render-engine';
import { MemoryLogger, isErr } from '@rv/shared-kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PinnedCheckpointStore, VerifiedFileFrameStore, expectedFrameBytes } from './render-stores';

const SIZE: Size = { width: 8, height: 4 };
const KEY = 'a'.repeat(64);

function frame(index: number): FrameBuffer {
  const data = new Uint8Array(SIZE.width * SIZE.height * 4);
  data.fill(index % 256);
  return { width: SIZE.width, height: SIZE.height, data };
}

describe('VerifiedFileFrameStore', () => {
  let directory = '';
  let store: VerifiedFileFrameStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'rivayat-frames-'));
    store = new VerifiedFileFrameStore(directory, SIZE);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('round-trips a frame and reports it as present', async () => {
    expect(isErr(await store.put(3, frame(3)))).toBe(false);
    expect(await store.has(3)).toBe(true);

    const read = await store.get(3);
    if (isErr(read)) throw read.error;
    expect(read.value.width).toBe(SIZE.width);
    expect(read.value.data).toEqual(frame(3).data);
    expect(await store.list()).toEqual([3]);
  });

  it('does not list a frame whose file is short, which is what a kill mid-write leaves', async () => {
    await store.put(0, frame(0));
    await store.put(1, frame(1));

    // A file with a perfectly good name and half the bytes. `FileFrameStore.list` reports
    // it; trusting it makes the resume skip a frame that was never drawn, and the encode
    // then fails on the length check after every other frame has been rendered.
    await writeFile(join(directory, frameFileName(2)), new Uint8Array(20));

    expect(await readdir(directory)).toHaveLength(3);
    expect(await store.list()).toEqual([0, 1]);
  });

  it('drops a frame that vanishes between the listing and the check', async () => {
    await store.put(0, frame(0));
    const removed = await store.clear();
    expect(isErr(removed)).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await store.has(0)).toBe(false);
  });

  it('computes the exact length a whole frame has', () => {
    // 12-byte header plus RGBA. Wrong by one and every frame looks torn.
    expect(expectedFrameBytes(SIZE)).toBe(12 + 8 * 4 * 4);
  });

  it('reports a read of a frame that is not there rather than inventing one', async () => {
    const missing = await store.get(9);
    expect(isErr(missing)).toBe(true);
  });
});

describe('PinnedCheckpointStore', () => {
  let directory = '';
  let store: PinnedCheckpointStore;

  const record = {
    jobId: 'job_01J0000000000000000000000A',
    completedRanges: [{ from: 0, to: 10 }],
    irHash: 'b'.repeat(64),
    lastFrameHash: 'c'.repeat(64),
    updatedAtIso: '2026-08-24T00:00:00.000Z',
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'rivayat-ckpt-'));
    store = new PinnedCheckpointStore(directory, KEY, new MemoryLogger());
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('answers null for a render that has not started, rather than failing', async () => {
    const loaded = await store.load('job_01J0000000000000000000000A');
    if (isErr(loaded)) throw loaded.error;
    expect(loaded.value).toBeNull();
  });

  it('ignores the job id, so a different process resumes the same render', async () => {
    expect(isErr(await store.save('job_01J0000000000000000000000A', record))).toBe(false);

    // The whole reason this class exists: a resumed render is a *different job*, and a
    // checkpoint filed under the old job id is a checkpoint the new one never finds.
    const other = new PinnedCheckpointStore(directory, KEY, new MemoryLogger());
    const loaded = await other.load('job_01J0000000000000000000000Z');
    if (isErr(loaded)) throw loaded.error;
    expect(loaded.value?.completedRanges).toEqual([{ from: 0, to: 10 }]);
    expect(loaded.value?.irHash).toBe(record.irHash);
  });

  it('leaves no partial document behind, because the write is a rename', async () => {
    await store.save('job_01J0000000000000000000000A', record);

    // Nothing but the committed file: a `.tmp` left in place would be read by nothing,
    // but a *live* file half-written would be read by the resume.
    const entries = await readdir(directory);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(entries).toHaveLength(1);

    const raw = await readFile(join(directory, entries[0] ?? ''), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ irHash: record.irHash });
  });

  it('degrades an unreadable checkpoint to "no checkpoint" rather than failing the render', async () => {
    await store.save('job_01J0000000000000000000000A', record);
    const entries = await readdir(directory);
    // Truncated JSON, which is what a non-atomic writer leaves when it is killed. The
    // render should redraw every frame - slow and correct - not refuse to run.
    await writeFile(join(directory, entries[0] ?? ''), '{"irHash": "b', 'utf8');

    const loaded = await store.load('job_01J0000000000000000000000A');
    if (isErr(loaded)) throw loaded.error;
    expect(loaded.value).toBeNull();
  });

  it('reports a write it could not make', async () => {
    // A directory path that cannot be created, because a file already sits where the
    // directory would go.
    const blocker = join(directory, 'blocked');
    await writeFile(blocker, 'not a directory', 'utf8');

    const blocked = new PinnedCheckpointStore(blocker, KEY);
    const saved = await blocked.save('job_01J0000000000000000000000A', record);
    expect(isErr(saved)).toBe(true);
    if (!isErr(saved)) return;
    expect(saved.error.kind).toBe('validation');
  });
});
