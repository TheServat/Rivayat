/**
 * Everything a command is allowed to depend on, handed to it explicitly.
 *
 * Non-negotiable #1 says no wall-clock read and no `Math.random()` outside an adapter.
 * A CLI is the easiest place in the system to break that rule by accident - "it is just
 * a timestamp in the output" - so the clock, the id generator and the seed arrive here
 * and there is no other source. A test constructs one of these with a `FixedClock` and
 * a counting byte source and gets byte-identical output on every run, which is what
 * makes the golden assertions in the specs meaningful.
 */

import { join, resolve } from 'node:path';

import { Ids } from '@rv/contracts';
import { IdGenerator, SystemClock, type Clock } from '@rv/shared-kernel';

import type { CliIo } from './io';

export interface CliContext {
  readonly io: CliIo;
  readonly env: NodeJS.ProcessEnv;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly cwd: string;
  /**
   * Where runtime data lives, per docs/04 §7.
   *
   * Resolved once, here, so no command has to decide - and so a test points the whole
   * CLI at a temporary directory by constructing a context rather than by chdir'ing a
   * shared process.
   */
  readonly workspaceRoot: string;
  /** Root seed for anything that needs an RNG. Deterministic, and printable. */
  readonly seed: number;
}

export interface BuildContextOptions {
  readonly io: CliIo;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly clock?: Clock;
  readonly ids?: Ids;
  readonly workspaceRoot?: string;
  readonly seed?: number;
}

/**
 * The default seed.
 *
 * A constant rather than a time-derived value: two invocations of `rv run` with the
 * same inputs must produce the same artefacts, and a seed that changed per process
 * would make "the second run costs $0" false for reasons unrelated to caching.
 */
export const DEFAULT_SEED = 20_260_823;

export function buildContext(options: BuildContextOptions): CliContext {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const clock = options.clock ?? new SystemClock();
  const seedFromEnv = Number(env.RV_SEED ?? '');
  return {
    io: options.io,
    env,
    cwd,
    clock,
    ids: options.ids ?? new Ids(new IdGenerator(clock)),
    workspaceRoot:
      options.workspaceRoot ??
      (env.RV_WORKSPACE === undefined ? join(cwd, 'workspace') : resolve(cwd, env.RV_WORKSPACE)),
    seed:
      options.seed ??
      (Number.isFinite(seedFromEnv) && seedFromEnv > 0 ? seedFromEnv : DEFAULT_SEED),
  };
}
