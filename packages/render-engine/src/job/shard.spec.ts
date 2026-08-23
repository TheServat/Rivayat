import { unwrap } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { shardAll, shardRange } from './shard';

describe('shardRange', () => {
  it('splits evenly when it divides', () => {
    const ranges = [0, 1, 2, 3].map((index) =>
      unwrap(shardRange({ from: 0, to: 100 }, { index, count: 4 })),
    );
    expect(ranges).toEqual([
      { from: 0, to: 25 },
      { from: 25, to: 50 },
      { from: 50, to: 75 },
      { from: 75, to: 100 },
    ]);
  });

  it('gives the remainder to the earliest shards one frame at a time', () => {
    const ranges = [0, 1, 2, 3].map((index) =>
      unwrap(shardRange({ from: 0, to: 101 }, { index, count: 4 })),
    );
    expect(ranges.map((range) => range.to - range.from)).toEqual([26, 25, 25, 25]);
  });

  it('shards a sub-range, not just the whole timeline', () => {
    expect(unwrap(shardRange({ from: 40, to: 60 }, { index: 1, count: 2 }))).toEqual({
      from: 50,
      to: 60,
    });
  });

  it('tiles the range with no gap and no overlap', () => {
    // The property that makes concatenation correct: shard N ends exactly where shard
    // N+1 begins.
    const total = { from: 7, to: 103 };
    const ranges = shardAll(total, 5);
    expect(ranges[0]?.from).toBe(total.from);
    expect(ranges.at(-1)?.to).toBe(total.to);
    for (let index = 1; index < ranges.length; index += 1) {
      expect(ranges[index]?.from).toBe(ranges[index - 1]?.to);
    }
  });

  it('refuses a shard index outside the count', () => {
    const result = shardRange({ from: 0, to: 10 }, { index: 4, count: 4 });
    expect(result.ok).toBe(false);
  });

  it('refuses to invent an empty shard when there are more workers than frames', () => {
    // A zero-length `FrameRange` does not satisfy the schema, and silently returning
    // `[n, n)` would encode "render nothing" as a successful shard.
    const result = shardRange({ from: 0, to: 3 }, { index: 3, count: 8 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context).toMatchObject({ length: 3 });
  });

  it('drops the empty shards from shardAll rather than failing the set', () => {
    expect(shardAll({ from: 0, to: 3 }, 8)).toHaveLength(3);
  });
});
