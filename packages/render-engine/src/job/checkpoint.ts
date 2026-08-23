/**
 * Frame-range algebra - the whole of resume and sharding, as set operations.
 *
 * `RenderCheckpoint` stores *ranges* rather than a high-water mark, and its docstring
 * says why: "a sharded job completes its frames out of order and a single number would
 * either lose work or redo it." Once the state is a set of half-open intervals, resume
 * is `requested \ completed` and sharding is a partition of `requested`. Both are the
 * same three functions.
 *
 * Half-open `[from, to)` throughout, which is what makes `[0,30)` and `[30,60)` join
 * into `[0,60)` with no off-by-one anywhere.
 */

import type { FrameRange, RenderCheckpoint } from '@rv/contracts';

import type { CheckpointRecord } from '../ports/storage';

/** Sorted, merged, and with empty ranges dropped. The canonical form. */
export function normaliseRanges(ranges: readonly FrameRange[]): readonly FrameRange[] {
  const sorted = ranges
    .filter((range) => range.to > range.from)
    .slice()
    .sort((left, right) => left.from - right.from || left.to - right.to);

  const merged: FrameRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    // Touching counts as overlapping: [0,30) and [30,60) describe one contiguous run,
    // and keeping them apart would make `completedRanges` grow without bound on a
    // frame-by-frame checkpoint.
    if (last !== undefined && range.from <= last.to) {
      if (range.to > last.to) merged[merged.length - 1] = { from: last.from, to: range.to };
      continue;
    }
    merged.push({ from: range.from, to: range.to });
  }
  return merged;
}

/** `target \ done`: what is still owed. */
export function subtractRanges(
  target: FrameRange,
  done: readonly FrameRange[],
): readonly FrameRange[] {
  const remaining: FrameRange[] = [];
  let cursor = target.from;

  for (const range of normaliseRanges(done)) {
    if (range.to <= cursor) continue;
    if (range.from >= target.to) break;
    if (range.from > cursor) remaining.push({ from: cursor, to: Math.min(range.from, target.to) });
    cursor = Math.max(cursor, range.to);
    if (cursor >= target.to) break;
  }

  if (cursor < target.to) remaining.push({ from: cursor, to: target.to });
  return remaining;
}

export function countFrames(ranges: readonly FrameRange[]): number {
  return normaliseRanges(ranges).reduce((total, range) => total + (range.to - range.from), 0);
}

export function rangesContain(ranges: readonly FrameRange[], frame: number): boolean {
  return ranges.some((range) => frame >= range.from && frame < range.to);
}

/** Adds one completed frame, keeping the set canonical. */
export function withFrame(ranges: readonly FrameRange[], frame: number): readonly FrameRange[] {
  return normaliseRanges([...ranges, { from: frame, to: frame + 1 }]);
}

/**
 * The highest frame such that every frame below it is done.
 *
 * `RenderCheckpoint.lastCompletedFrame` is documented as the "highest contiguous frame
 * finished", which is not the same as the highest finished frame: a shard that owns
 * `[100, 200)` has finished frame 199 and is contiguously complete up to nothing.
 */
export function lastContiguousFrame(ranges: readonly FrameRange[]): number | null {
  const first = normaliseRanges(ranges)[0];
  if (first?.from !== 0) return null;
  return first.to - 1;
}

// ── the contract shape ──────────────────────────────────────────────────────

/**
 * A stored record as the wire-level `RenderCheckpoint`.
 *
 * The conversion lives here, once. `CheckpointRecord` carries an `irHash` the contract
 * has no field for and the contract carries an `IsoInstant` a store cannot invent, so
 * they are genuinely different shapes rather than one shape written twice.
 */
export function toRenderCheckpoint(record: CheckpointRecord): RenderCheckpoint {
  const ranges = normaliseRanges(record.completedRanges);
  return {
    completedRanges: [...ranges],
    lastCompletedFrame: lastContiguousFrame(ranges),
    lastFrameHash: record.lastFrameHash,
    updatedAt: record.updatedAtIso,
  };
}

/**
 * Whether a stored checkpoint may be resumed against this IR.
 *
 * The honesty check `RenderCheckpoint` describes: "a resumed worker re-evaluates the
 * last completed frame and compares. A mismatch means the IR changed underneath the
 * job, and continuing would splice two different films together." Comparing the IR
 * digest catches the same thing one step earlier and without re-rendering a frame.
 */
export function isResumable(record: CheckpointRecord | null, irHash: string): boolean {
  return record !== null && record.irHash === irHash;
}
