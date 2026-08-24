/**
 * One deterministic CLI, per test.
 *
 * Everything the specs need in order to assert on behaviour instead of on a process:
 * a fixed clock, an id generator seeded from a counter rather than from `crypto`, a
 * temporary workspace, and a buffered writer. Nothing here reads the wall clock, draws
 * a random number, or opens a socket - which is the same bar the rest of the repo holds
 * its fixtures to (docs/04 §8: "Deterministic data only - fixed seeds, `FixedClock`, no
 * `Date.now()`").
 *
 * The id generator is the part worth explaining. `IdGenerator` takes its randomness as
 * a function so that a replayed pipeline run mints the same ids; here that same seam
 * makes `prj_…` stable across runs, which is what lets a spec assert on a whole JSON
 * document rather than on the two fields that happen not to be ids.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ids } from '@rv/contracts';
import { FixedClock, IdGenerator, createRng, instant } from '@rv/shared-kernel';

import { buildContext, type CliContext } from '../cli/context';
import { BufferIo } from '../cli/io';

/** 2026-08-23T18:00:00Z, the day the CLI work was done. Any fixed instant would do. */
export const FIXED_NOW = instant(Date.UTC(2026, 7, 23, 18, 0, 0));

/**
 * Byte source for `IdGenerator`, drawn from a seeded PRNG.
 *
 * `createRng` is the repo's own deterministic generator, so the ids a spec sees are a
 * function of the seed and of nothing else.
 */
export function seededBytes(seed: number): (size: number) => Uint8Array {
  const rng = createRng(seed);
  return (size) => Uint8Array.from({ length: size }, () => Math.floor(rng.next() * 256));
}

export interface Harness {
  readonly context: CliContext;
  readonly io: BufferIo;
  readonly clock: FixedClock;
  readonly workspaceRoot: string;
  /** Removes the temporary workspace. Call it in `afterEach`. */
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly seed?: number;
  readonly cwd?: string;
}

/** Builds a CLI context over a fresh temporary workspace. */
export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rv-cli-'));
  const io = new BufferIo();
  const clock = new FixedClock(FIXED_NOW);
  const ids = new Ids(new IdGenerator(clock, seededBytes(options.seed ?? 7)));

  const context = buildContext({
    io,
    clock,
    ids,
    workspaceRoot,
    // A deliberately empty environment: a spec must not pass or fail because the
    // developer running it has `GEMINI_API_KEY` set.
    env: options.env ?? {},
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

  return {
    context,
    io,
    clock,
    workspaceRoot,
    // `maxRetries` is not paranoia: a command that opened SQLite leaves the `-wal` and
    // `-shm` files being released asynchronously by Windows, and an immediate `rmdir`
    // loses the race with ENOTEMPTY.
    dispose: () =>
      rm(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

/** Parses the `--json` envelope a command wrote to stdout. */
export function jsonOut(io: BufferIo): { ok: boolean; code: string | null; data?: unknown } {
  return JSON.parse(io.outText) as { ok: boolean; code: string | null; data?: unknown };
}
