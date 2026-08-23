/**
 * Track evaluation - the value of one animated channel at one instant.
 *
 * Two properties matter more than speed here:
 *
 *  - **Purity.** `valueAt(track, t)` reads nothing but its arguments. No cursor, no
 *    "last evaluated frame", no cached segment. A cursor would make scrubbing backwards
 *    give a different answer from playing forwards, which is precisely the bug that
 *    makes a distributed render disagree with its own preview.
 *  - **Exactness at the keyframes.** Evaluating exactly on a keyframe returns that
 *    keyframe's value, not an interpolation that rounds to it. Golden-file tests compare
 *    frame hashes, so "almost" is a failure.
 */

import { at } from '@rv/shared-kernel';
import type { Keyframe, Track } from '@rv/contracts';

import { applyEasing, type EasingLibrary } from './easing';

export type Extrapolation = Track['before'];

/**
 * Maps a time outside the track's span back inside it.
 *
 * Returns the wrapped time, or `undefined` when the mode is `hold` and the caller
 * should clamp to the nearest keyframe instead.
 */
function wrap(
  timeMs: number,
  startMs: number,
  endMs: number,
  mode: Extrapolation,
): number | undefined {
  if (mode === 'hold') return undefined;

  const span = endMs - startMs;
  // A zero-length span cannot be wrapped into; hold is the only sane answer.
  if (span <= 0) return undefined;

  const offset = timeMs - startMs;
  // `%` in JS keeps the sign of the dividend, so a negative offset needs correcting.
  const cycles = Math.floor(offset / span);
  const withinCycle = offset - cycles * span;

  if (mode === 'loop') return startMs + withinCycle;

  // ping-pong: odd cycles run backwards.
  const reversed = ((cycles % 2) + 2) % 2 === 1;
  return startMs + (reversed ? span - withinCycle : withinCycle);
}

/** Index of the last keyframe at or before `timeMs`. Binary search, so O(log n). */
function segmentIndex(keyframes: readonly Keyframe[], timeMs: number): number {
  let low = 0;
  let high = keyframes.length - 1;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (at(keyframes, mid).timeMs <= timeMs) low = mid;
    else high = mid - 1;
  }

  return low;
}

/**
 * The track's value at `timeMs`.
 *
 * Keyframes are guaranteed strictly ordered and non-empty by the schema, so neither is
 * re-checked here.
 */
export function valueAt(track: Track, timeMs: number, library: EasingLibrary): number {
  const keyframes = track.keyframes;
  const first = at(keyframes, 0);
  const last = at(keyframes, keyframes.length - 1);

  if (keyframes.length === 1) return first.value;

  let time = timeMs;
  if (time < first.timeMs) {
    time = wrap(time, first.timeMs, last.timeMs, track.before) ?? first.timeMs;
  } else if (time > last.timeMs) {
    time = wrap(time, first.timeMs, last.timeMs, track.after) ?? last.timeMs;
  }

  const index = segmentIndex(keyframes, time);
  const from = at(keyframes, index);
  if (index === keyframes.length - 1) return from.value;

  const to = at(keyframes, index + 1);
  const span = to.timeMs - from.timeMs;
  const progress = (time - from.timeMs) / span;

  // Easing belongs to the keyframe being left, not the one being approached: an
  // animator setting "ease out" on a pose means the motion *away* from that pose.
  const eased = applyEasing(from.easing, progress, library);
  return from.value + (to.value - from.value) * eased;
}

/**
 * Evaluates every track for one node, folded into a channel map.
 *
 * Additive tracks are summed on top of whatever came before, which is how a hand-tweak
 * layers over a procedural behaviour instead of replacing it.
 */
export function foldTracks(
  tracks: readonly Track[],
  timeMs: number,
  library: EasingLibrary,
  into = new Map<string, number>(),
): Map<string, number> {
  for (const track of tracks) {
    const value = valueAt(track, timeMs, library);
    if (track.additive) {
      into.set(track.channel, (into.get(track.channel) ?? 0) + value);
    } else {
      into.set(track.channel, value);
    }
  }
  return into;
}
