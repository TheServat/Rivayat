import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FixedClock, instant } from '@rv/shared-kernel';

import { DEFAULT_SEED, buildContext } from './context';
import { BufferIo } from './io';

describe('buildContext', () => {
  const io = new BufferIo();

  it('puts the workspace under the working directory by default', () => {
    const context = buildContext({ io, env: {}, cwd: '/repo' });
    expect(context.workspaceRoot).toBe(join('/repo', 'workspace'));
  });

  it('resolves $RV_WORKSPACE relative to the working directory', () => {
    const context = buildContext({ io, env: { RV_WORKSPACE: 'tmp/ws' }, cwd: '/repo' });
    expect(context.workspaceRoot).toBe(resolve('/repo', 'tmp/ws'));
  });

  /**
   * Non-negotiable #1. A seed derived from the clock would make "the second run costs
   * $0" false for reasons unrelated to caching, so the default is a constant.
   */
  it('uses a constant seed unless one is supplied', () => {
    expect(buildContext({ io, env: {} }).seed).toBe(DEFAULT_SEED);
  });

  it('takes $RV_SEED when it is a positive number, and ignores it otherwise', () => {
    expect(buildContext({ io, env: { RV_SEED: '99' } }).seed).toBe(99);
    expect(buildContext({ io, env: { RV_SEED: 'banana' } }).seed).toBe(DEFAULT_SEED);
    expect(buildContext({ io, env: { RV_SEED: '-1' } }).seed).toBe(DEFAULT_SEED);
  });

  it('mints ids from the injected clock, so a replay reproduces them', () => {
    const clock = new FixedClock(instant(1_700_000_000_000));
    const first = buildContext({ io, env: {}, clock }).ids.project();
    const second = buildContext({ io, env: {}, clock }).ids.project();
    // The 10-character time prefix is a pure function of the clock; only the random
    // half differs, which is what makes two contexts distinguishable at all.
    expect(first.slice(0, 14)).toBe(second.slice(0, 14));
  });

  it('accepts an explicit workspace root, which is how a test isolates itself', () => {
    expect(buildContext({ io, env: {}, workspaceRoot: '/tmp/ws' }).workspaceRoot).toBe('/tmp/ws');
  });
});
