/**
 * Frame index to timestamp, in exactly one place.
 *
 * Trivial arithmetic that must not be written twice. `frame * 1000 / fps` and
 * `frame / fps * 1000` differ in the last bit for some inputs, and a render whose
 * frame 1,801 was produced by one expression and re-produced by the other is *almost*
 * identical - which is the worst possible outcome for a system whose resume test is a
 * byte comparison.
 *
 * Nothing here reads a clock. The only "time" in a render is the frame index.
 */

import { ValidationError, err, ok, type AppError, type Result } from '@rv/shared-kernel';
import type { FrameRange } from '@rv/contracts';

/** Presentation time of a frame, in milliseconds. */
export function frameTimeMs(frame: number, fps: number): number {
  return (frame * 1000) / fps;
}

/**
 * Frames in a timeline of `durationMs` at `fps`.
 *
 * Rounded, not floored: a 1,000 ms clip at 30 fps is 30 frames, and flooring
 * `1000/1000*30` after floating-point drift would silently drop the last one.
 */
export function frameCount(durationMs: number, fps: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * fps));
}

/** The whole timeline as a half-open range. */
export function fullRange(durationMs: number, fps: number): FrameRange {
  return { from: 0, to: frameCount(durationMs, fps) };
}

export function rangeLength(range: FrameRange): number {
  return range.to - range.from;
}

export function containsFrame(range: FrameRange, frame: number): boolean {
  return frame >= range.from && frame < range.to;
}

/** Every frame index in the range, ascending. */
export function* framesIn(range: FrameRange): Generator<number> {
  for (let frame = range.from; frame < range.to; frame += 1) yield frame;
}

/**
 * A requested sub-range, validated against the timeline it claims to slice.
 *
 * A shard or a "re-render just this shot" request that runs off the end of the
 * timeline would otherwise produce frames the evaluator extrapolates - visually
 * plausible, and not part of the film.
 */
export function clampToTimeline(
  requested: FrameRange | null,
  timeline: FrameRange,
): Result<FrameRange, AppError> {
  if (requested === null) return ok(timeline);
  if (requested.from < timeline.from || requested.to > timeline.to) {
    return err(
      new ValidationError({
        message: `frame range [${String(requested.from)}, ${String(requested.to)}) is outside the timeline [${String(timeline.from)}, ${String(timeline.to)})`,
        context: { requested, timeline },
      }),
    );
  }
  return ok(requested);
}
