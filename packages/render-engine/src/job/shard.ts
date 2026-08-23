/**
 * Splitting a render across workers.
 *
 * `RenderShard`'s own words: "Sharding and resuming are the same mechanism seen from
 * two directions: a shard is handed a range up front, a resumed job computes the
 * complement of what it already finished." So this file is small by design - the
 * interesting machinery is in `checkpoint.ts`, and sharding is a partition.
 *
 * Contiguous blocks, not round-robin. Two reasons: frames written contiguously
 * concatenate with the `concat` demuxer and no re-encode, and a contiguous shard's
 * frames are adjacent in time, so a worker's page cache and the encoder's motion
 * estimation both behave. Interleaving would produce four sets of frames that only a
 * frame-store merge could reassemble.
 */

import { ValidationError, err, ok, type AppError, type Result } from '@rv/shared-kernel';
import type { FrameRange, RenderShard } from '@rv/contracts';

/**
 * The slice of `total` that `shard` owns.
 *
 * The remainder goes to the earliest shards one frame at a time rather than all to the
 * last one: with 101 frames over 4 workers, `26/25/25/25` finishes sooner than
 * `25/25/25/26` and, more importantly, no shard is ever empty when `count <= length`.
 */
export function shardRange(total: FrameRange, shard: RenderShard): Result<FrameRange, AppError> {
  if (shard.index >= shard.count) {
    return err(
      new ValidationError({
        message: `shard ${String(shard.index)} of ${String(shard.count)} does not exist`,
        context: { shard },
      }),
    );
  }

  const length = total.to - total.from;
  const base = Math.floor(length / shard.count);
  const remainder = length % shard.count;

  const from = total.from + base * shard.index + Math.min(shard.index, remainder);
  const to = from + base + (shard.index < remainder ? 1 : 0);

  if (to <= from) {
    // More workers than frames. An empty shard is a legitimate outcome and not an
    // error, but it must not be expressed as a `FrameRange` - the schema requires at
    // least one frame, and a zero-length range would silently encode as `[n, n)`.
    return err(
      new ValidationError({
        message: `shard ${String(shard.index)} of ${String(shard.count)} has no frames: only ${String(length)} to share`,
        context: { shard, length },
      }),
    );
  }

  return ok({ from, to });
}

/** Every non-empty shard of `total`, in order. Their concatenation is `total`. */
export function shardAll(total: FrameRange, count: number): readonly FrameRange[] {
  const ranges: FrameRange[] = [];
  for (let index = 0; index < count; index += 1) {
    const range = shardRange(total, { index, count });
    if (range.ok) ranges.push(range.value);
  }
  return ranges;
}
