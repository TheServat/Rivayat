import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { unwrap } from '@rv/shared-kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scratchDir } from '../__fixtures__/workspace';
import type { CheckpointRecord } from '../ports/storage';
import { FileCheckpointStore, InMemoryCheckpointStore, parseRecord } from './checkpoint-stores';

const RECORD: CheckpointRecord = {
  jobId: 'job_0000000000000000000000000A',
  completedRanges: [{ from: 0, to: 30 }],
  irHash: 'abc123',
  lastFrameHash: 'def456',
  updatedAtIso: '2026-08-23T10:00:00.000Z',
};

describe('InMemoryCheckpointStore', () => {
  it('returns null before anything is saved', async () => {
    expect(unwrap(await new InMemoryCheckpointStore().load('job_x'))).toBeNull();
  });

  it('round-trips and keeps the history a test can assert on', async () => {
    const store = new InMemoryCheckpointStore();
    await store.save(RECORD.jobId, RECORD);
    await store.save(RECORD.jobId, { ...RECORD, completedRanges: [{ from: 0, to: 60 }] });
    expect(unwrap(await store.load(RECORD.jobId))).toMatchObject({
      completedRanges: [{ from: 0, to: 60 }],
    });
    expect(store.history).toHaveLength(2);
  });
});

describe('FileCheckpointStore', () => {
  let directory: string;

  beforeAll(async () => {
    directory = await scratchDir('checkpoints');
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('round-trips through the disk', async () => {
    const store = new FileCheckpointStore(join(directory, 'ok'));
    await store.save(RECORD.jobId, RECORD);
    expect(unwrap(await store.load(RECORD.jobId))).toEqual(RECORD);
  });

  it('treats a missing checkpoint as "this job has not started"', async () => {
    const store = new FileCheckpointStore(join(directory, 'empty'));
    expect(unwrap(await store.load('job_missing'))).toBeNull();
  });

  it('refuses a corrupt checkpoint rather than silently reporting no progress', async () => {
    // Reporting "nothing completed" is the benign failure; a garbled range would skip
    // frames that were never drawn and encode a hole.
    const path = join(directory, 'corrupt');
    const store = new FileCheckpointStore(path);
    await store.save('job_bad', RECORD);
    await writeFile(join(path, 'job_bad.checkpoint.json'), '{"completedRanges": "nope"}');
    const result = await store.load('job_bad');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });

  it('creates its directory on first save', async () => {
    const store = new FileCheckpointStore(join(directory, 'deep', 'nested'));
    expect((await store.save('job_1', RECORD)).ok).toBe(true);
  });
});

describe('parseRecord', () => {
  it('accepts a well-formed record', () => {
    expect(parseRecord(RECORD, RECORD.jobId)).toEqual(RECORD);
  });

  it('defaults the optional fields rather than failing on them', () => {
    const parsed = parseRecord({ irHash: 'x', completedRanges: [] }, 'job_1');
    expect(parsed).toEqual({
      jobId: 'job_1',
      completedRanges: [],
      irHash: 'x',
      lastFrameHash: null,
      updatedAtIso: '',
    });
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['no irHash', { completedRanges: [] }],
    ['no ranges', { irHash: 'x' }],
    ['a malformed range', { irHash: 'x', completedRanges: ['nope'] }],
    ['inverted bounds', { irHash: 'x', completedRanges: [{ from: 10, to: 5 }] }],
  ])('refuses %s', (_name, value) => {
    expect(() => parseRecord(value, 'job_1')).toThrow();
  });
});
