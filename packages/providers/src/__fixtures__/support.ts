/**
 * Deterministic scaffolding shared by the specs.
 *
 * Every id, timestamp and random draw in a test comes from here, so a failure is
 * reproducible and a diff of two runs is empty. That is the same discipline the
 * pipeline itself is held to (CLAUDE.md #1) - a test suite that is not deterministic
 * cannot be evidence that the code is.
 */

import { Ids, type ProjectId, type RunId } from '@rv/contracts';
import {
  FixedClock,
  IdGenerator,
  type Instant,
  type Rng,
  createRng,
  instant,
} from '@rv/shared-kernel';

export const TEST_EPOCH: Instant = instant(Date.parse('2026-08-23T12:00:00.000Z'));

export function fixedClock(start: Instant = TEST_EPOCH): FixedClock {
  return new FixedClock(start);
}

/** Ids that are the same on every run - the random half is a fixed byte pattern. */
export function deterministicIds(clock = fixedClock()): Ids {
  return new Ids(new IdGenerator(clock, (size) => new Uint8Array(size).fill(7)));
}

export function testProjectId(ids = deterministicIds()): ProjectId {
  return ids.project();
}

export function testRunId(ids = deterministicIds()): RunId {
  return ids.run();
}

/** Seeded, so retry jitter is reproducible. */
export function testRng(seed = 'rivayat-test'): Rng {
  return createRng(seed);
}

/** A sleep that records what it was asked to wait rather than actually waiting. */
export function recordingSleep(): {
  sleep: (ms: number) => Promise<void>;
  waits: number[];
} {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}
