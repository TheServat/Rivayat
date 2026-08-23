/**
 * How long a shot is on screen, decided by the style bible rather than by the model.
 *
 * `StyleBible.motion.camera` already carries `defaultShotMs` and `cutRhythm`, and its own
 * description says "the sequencer uses it to pace a scene". This is the sequencer keeping
 * that promise. Pacing is the single most legible signature of a series' style, and a
 * model asked for "durations in milliseconds" returns 3000 for everything.
 *
 * So the model is asked only for **relative weight** - which shots want to breathe - and
 * the absolute durations are computed here from the style's rhythm and the scene's length.
 * That has two consequences worth the arithmetic: the same shot list re-paces when the
 * style is edited, and the durations always sum to exactly the scene length, which is
 * RV-087's requirement and something no model does reliably.
 */

import type { CameraGrammar } from '@rv/contracts';
import { ValidationError, type Result, at, err, ok } from '@rv/shared-kernel';

/**
 * `cutRhythm` is declared inline inside `CameraGrammar` rather than as its own exported
 * enum, so the union is read back off the field. Indexing the type keeps the two in step
 * without a second copy of the four words.
 */
export type CutRhythm = CameraGrammar['cutRhythm'];

/**
 * Multipliers on `defaultShotMs`. Fewer, longer shots at the top; more, shorter below.
 *
 * Chosen so the ends are genuinely far apart: `languid` and `frenetic` differ by roughly
 * 5x, which is the difference between a held two-shot and a montage. A table with a 1.2x
 * spread would be a setting nobody can see.
 */
export const CUT_RHYTHM_FACTOR: Readonly<Record<CutRhythm, number>> = {
  languid: 1.8,
  measured: 1,
  brisk: 0.6,
  frenetic: 0.35,
};

export interface ShotCountInput {
  readonly sceneDurationMs: number;
  readonly camera: CameraGrammar;
  /** Every beat needs at least one shot: a beat with no shot is an unrealised beat. */
  readonly beatCount: number;
}

/**
 * How many shots this scene wants, as a hint to the model.
 *
 * Floored at one shot per beat because `Shot.beatRef` is one-to-one in that direction -
 * a beat nothing carries is a beat that does not happen. Capped at four per beat because
 * beyond that the scene is being cut for its own sake, and the cost is real: every shot is
 * a composition, a set of pins, and a render pass.
 */
export function targetShotCount(input: ShotCountInput): number {
  const nominal = input.camera.defaultShotMs * CUT_RHYTHM_FACTOR[input.camera.cutRhythm];
  const wanted = Math.round(input.sceneDurationMs / Math.max(1, nominal));
  const floor = Math.max(1, input.beatCount);
  return Math.min(Math.max(wanted, floor), floor * 4);
}

/**
 * Splits a scene's runtime across shots by weight, on frame boundaries, summing exactly.
 *
 * "Exactly" is the whole point. RV-087 allows ±1 frame; this returns 0, because the
 * residual is placed rather than discarded. A shot list whose durations sum to 11 983 ms
 * for a 12 000 ms scene produces a 17 ms gap that the choreographer fills with the last
 * frame of the previous shot, and nobody finds it.
 */
export function distributeDurations(
  weights: readonly number[],
  totalMs: number,
  fps: number,
): Result<readonly number[], ValidationError> {
  if (weights.length === 0) {
    return err(
      new ValidationError({
        message: 'Cannot distribute a scene duration across zero shots',
        context: { reason: 'no-shots' },
      }),
    );
  }

  const totalFrames = Math.round((totalMs * fps) / 1000);
  if (totalFrames < weights.length) {
    return err(
      new ValidationError({
        message: `A ${String(totalMs)} ms scene at ${String(fps)} fps is ${String(totalFrames)} frames and cannot hold ${String(weights.length)} shots`,
        context: {
          reason: 'scene-too-short-for-shots',
          totalMs,
          fps,
          totalFrames,
          shotCount: weights.length,
        },
      }),
    );
  }

  const weightSum = weights.reduce((total, weight) => total + Math.max(0, weight), 0);
  // A degenerate weight vector (all zeroes) is not an error - it means the model expressed
  // no preference - so it becomes an even split rather than a failure.
  const frames = weights.map((weight) =>
    Math.max(
      1,
      Math.round(
        (weightSum <= 0 ? 1 / weights.length : Math.max(0, weight) / weightSum) * totalFrames,
      ),
    ),
  );

  let drift = totalFrames - frames.reduce((total, count) => total + count, 0);
  while (drift !== 0) {
    // Always adjusted at the largest bucket: it distorts the intended ratio least, and -
    // when removing frames - the largest bucket is provably above 1 while the total is
    // above the shot count, so this can never drive a shot to zero.
    const index = indexOfLargest(frames);
    frames[index] = at(frames, index) + Math.sign(drift);
    drift -= Math.sign(drift);
  }

  const durations = frames.map((count) => Math.round((count * 1000) / fps));
  const residual = totalMs - durations.reduce((total, ms) => total + ms, 0);
  if (residual !== 0) {
    const index = indexOfLargest(durations);
    durations[index] = at(durations, index) + residual;
  }

  return ok(durations);
}

function indexOfLargest(values: readonly number[]): number {
  let index = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (at(values, i) > at(values, index)) index = i;
  }
  return index;
}
