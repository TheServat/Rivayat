/**
 * The produce checkpoint store, against a real database and a real blob store.
 *
 * Resume correctness is the thing under test, not the SQL. Two rules decide whether a
 * step is skipped, and both are cheap to write and easy to get backwards:
 *
 *  1. a checkpoint whose `inputHash` no longer matches what the step would consume is
 *     ignored rather than trusted, and
 *  2. a checkpoint whose record has vanished from the blob store re-runs the step
 *     rather than half-resuming it.
 *
 * Neither is implemented in this class - `ProduceAssetsUseCase` makes both calls - so
 * the tests below reproduce the decision with the engine's own helpers
 * (`stepInputHash`, `writeRecord`, `readRecord`) over this store's real rows and real
 * bytes. A mocked store would let both rules pass while being false in the running
 * system, which is exactly how a resume that regenerates everything, or worse resumes
 * onto stale inputs, ships green.
 */

import {
  type ProduceCheckpointKey,
  readRecord,
  stepInputHash,
  writeRecord,
} from '@rv/asset-engine';
import type { AssetKey, RunId, StageCheckpoint } from '@rv/contracts';
import { isErr, unwrap } from '@rv/shared-kernel';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../database/database';
import { produceCheckpoints } from '../schema/index';
import { type TempBlobStore, openTempBlobStore, openTestDatabase } from '../__fixtures__/workspace';
import { DrizzleProduceCheckpointRepository } from './drizzle-produce-checkpoint.repository';

const RUN_ID = `run_${'01J9ZQ3K5M7N9P1R3T5V7XA001'}` as RunId;
const ASSET_KEY = 'a'.repeat(64) as AssetKey;
const OTHER_ASSET_KEY = 'b'.repeat(64) as AssetKey;
const AT = '2026-08-23T00:00:00.000Z';

const GenerateLike = z.object({ imageHash: z.string(), seed: z.number().int() });

let handle: DatabaseHandle;
let blobs: TempBlobStore;
let store: DrizzleProduceCheckpointRepository;

function key(overrides: Partial<ProduceCheckpointKey> = {}): ProduceCheckpointKey {
  return { runId: RUN_ID, assetKey: ASSET_KEY, step: 'generate', attempt: 0, ...overrides };
}

function checkpoint(overrides: Partial<StageCheckpoint> = {}): StageCheckpoint {
  return {
    stage: 'produce',
    inputHash: 'c'.repeat(64),
    outputs: [],
    jobIds: [],
    costNanoUsd: 4_000_000,
    completedAt: AT,
    ...overrides,
  };
}

beforeEach(async () => {
  handle = openTestDatabase();
  blobs = await openTempBlobStore();
  store = new DrizzleProduceCheckpointRepository(handle);
});

afterEach(async () => {
  handle.close();
  await blobs.cleanup();
});

describe('reading back what was written', () => {
  it('returns the checkpoint unchanged, including what it cost', async () => {
    const written = checkpoint({
      outputs: [{ kind: 'produce-generate', ref: 'd'.repeat(64), contentHash: 'd'.repeat(64) }],
    });
    expect(isErr(await store.write(key(), written))).toBe(false);

    expect(unwrap(await store.read(key()))).toEqual(written);
  });

  it('answers absence with null rather than with a failure', async () => {
    expect(unwrap(await store.read(key()))).toBeNull();
  });

  it('keeps the four parts of the key apart', async () => {
    await store.write(key(), checkpoint({ inputHash: '1'.repeat(64) }));

    // Every component is load-bearing. `attempt` in particular: the quality gate's
    // repair loop regenerates with a different prompt, and a store that collapsed
    // attempts would let a repaired take overwrite the record of the take it repaired.
    for (const other of [
      key({ runId: `run_${'01J9ZQ3K5M7N9P1R3T5V7XA009'}` as RunId }),
      key({ assetKey: OTHER_ASSET_KEY }),
      key({ step: 'matte' }),
      key({ attempt: 1 }),
    ]) {
      expect(unwrap(await store.read(other)), JSON.stringify(other)).toBeNull();
    }
  });

  it('replaces a checkpoint written under the same key rather than refusing it', async () => {
    // A step re-runs whenever its inputs changed, and it writes the same key again. An
    // insert that conflicted would fail the write, which the engine treats as "costs a
    // re-run next time" - so the next resume would be wrong too, permanently.
    await store.write(key(), checkpoint({ inputHash: '1'.repeat(64), costNanoUsd: 1 }));
    await store.write(key(), checkpoint({ inputHash: '2'.repeat(64), costNanoUsd: 2 }));

    const read = unwrap(await store.read(key()));

    expect(read?.inputHash).toBe('2'.repeat(64));
    expect(read?.costNanoUsd).toBe(2);
    expect(handle.db.select().from(produceCheckpoints).all()).toHaveLength(1);
  });

  it('reads a row an older build wrote in a shape the contract no longer accepts as absent', async () => {
    // Written straight to the table, bypassing this class, exactly as a previous
    // version of it would have. `null` costs a re-run; handing the caller a shape the
    // schema rejects would defer the failure to whichever step trusted it.
    handle.db
      .insert(produceCheckpoints)
      .values({
        runId: RUN_ID,
        assetKey: ASSET_KEY,
        step: 'generate',
        attempt: 0,
        stage: 'produce',
        inputHash: 'not-a-sha256',
        outputs: [],
        jobIds: [],
        costNanoUsd: 0,
        completedAt: AT,
      })
      .run();

    expect(unwrap(await store.read(key()))).toBeNull();
  });

  it('reports a database that has gone away instead of pretending the step never ran', async () => {
    handle.close();

    // The difference matters: `null` means "run it again", and an unreachable database
    // would then silently regenerate a whole episode at full cost.
    expect(isErr(await store.read(key()))).toBe(true);
    expect(isErr(await store.write(key(), checkpoint()))).toBe(true);
    handle = openTestDatabase();
  });
});

describe('the two rules a resume actually turns on', () => {
  it('does not match a checkpoint whose inputs have since changed', async () => {
    const inputs = { prompt: 'a cast-iron street lamp', seed: 7 };
    const stored = stepInputHash('generate', ASSET_KEY, 0, inputs);
    await store.write(key(), checkpoint({ inputHash: stored }));

    const unchanged = unwrap(await store.read(key()));
    const edited = stepInputHash('generate', ASSET_KEY, 0, { ...inputs, seed: 8 });

    // The comparison the use-case makes. Same step, same asset, same attempt, one
    // edited input: "already ran" must not stand in for "already ran on this".
    expect(unchanged?.inputHash).toBe(stored);
    expect(unchanged?.inputHash).not.toBe(edited);
  });

  it('folds the step and the attempt into the hash, so two steps cannot collide', () => {
    const inputs = { prompt: 'a cast-iron street lamp' };

    expect(stepInputHash('generate', ASSET_KEY, 0, inputs)).not.toBe(
      stepInputHash('matte', ASSET_KEY, 0, inputs),
    );
    expect(stepInputHash('generate', ASSET_KEY, 0, inputs)).not.toBe(
      stepInputHash('generate', ASSET_KEY, 1, inputs),
    );
  });

  it('resumes a step whose record is still in the store', async () => {
    const record = { imageHash: 'e'.repeat(64), seed: 7 };
    const reference = unwrap(await writeRecord(blobs.store, 'generate', record));
    await store.write(key(), checkpoint({ outputs: [reference] }));

    const resumed = unwrap(await store.read(key()));
    const loaded = await readRecord(blobs.store, 'generate', resumed?.outputs ?? [], GenerateLike);

    expect(loaded).toEqual(record);
  });

  it('re-runs a step whose record has been collected out of the blob store', async () => {
    const reference = unwrap(
      await writeRecord(blobs.store, 'generate', { imageHash: 'e'.repeat(64), seed: 7 }),
    );
    await store.write(key(), checkpoint({ outputs: [reference] }));

    // A real reclamation, through the store's own `gc`, not an `rm` behind its back:
    // nothing references this blob, so a workspace clean-up is entitled to take it.
    unwrap(await blobs.store.gc([], { delete: true }));

    const resumed = unwrap(await store.read(key()));
    const loaded = await readRecord(blobs.store, 'generate', resumed?.outputs ?? [], GenerateLike);

    // The checkpoint survives - that is the point. It is the *record* that is gone, and
    // the only correct answer is to run the step again rather than resume half of it.
    expect(resumed).not.toBeNull();
    expect(loaded).toBeNull();
  });

  it('re-runs a step whose record no longer parses', async () => {
    const stored = unwrap(await blobs.store.put(new TextEncoder().encode('{"imageHash":42}')));
    await store.write(
      key(),
      checkpoint({
        outputs: [{ kind: 'produce-generate', ref: stored.hash, contentHash: stored.hash }],
      }),
    );

    const resumed = unwrap(await store.read(key()));

    // Same answer as a missing blob, for the same reason: trusting a document written
    // by an older build is how a resumed run produces a different asset and reports
    // success.
    expect(
      await readRecord(blobs.store, 'generate', resumed?.outputs ?? [], GenerateLike),
    ).toBeNull();
  });
});
