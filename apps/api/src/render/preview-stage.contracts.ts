/**
 * What S9 Preview takes, and what "preview" is allowed to mean.
 *
 * A preview exists to be looked at before a full render is paid for, so it has to be
 * cheap. There are three ways to make it cheap and they are not equivalent, so the
 * choice is stated here rather than left to a default:
 *
 *  - **Fewer shots.** Rejected. Cutting the timeline down answers "does this shot look
 *    right in isolation", which nobody asked, and hides the two things a preview is
 *    actually consulted about: the cuts and the pacing.
 *  - **Lower resolution.** Taken. Cost is linear in pixels and every decision a preview
 *    informs - framing, staging, colour, timing - survives a smaller frame.
 *  - **Fewer frames.** Taken, with a constraint: {@link previewFps} snaps the requested
 *    rate to a **divisor** of the composition's own. Preview frame `k` is then exactly
 *    master frame `k * (fps / previewFps)` - the same instant, evaluated by the same
 *    pure function, drawn by the same backend. A preview at a rate that did not divide
 *    would sample instants the master never renders, which is precisely the kind of
 *    small lie that makes a downstream decision guesswork.
 *
 * What is *not* a dial: the evaluator, the backend, the draw list and the encoder are
 * S10's. A preview that took a shortcut through a different renderer would be a
 * different picture, and the whole point of looking at it is that it is not.
 *
 * At the defaults - 640 px wide from a 1920 px composition, 12 fps from 24 - a preview
 * is about a twentieth of the render: a ninth of the pixels, half the frames.
 */

import { AnimationIR, FrameRange, RenderBackend, Sha256Hex, Size } from '@rv/contracts';
import { z } from 'zod';

/** Wide enough to judge staging on, small enough to be nearly free. */
export const DEFAULT_PREVIEW_WIDTH = 640;
/** Two frames of the master per preview frame at 24 fps, and motion still reads. */
export const DEFAULT_PREVIEW_FPS = 12;

export const PreviewStageRequest = z.strictObject({
  ir: AnimationIR.optional(),
  compositionId: Sha256Hex.optional().describe(
    'A stored composition. Defaults to the one this run’s choreograph stage produced.',
  ),
  maxWidth: z
    .number()
    .int()
    .min(64)
    .max(3840)
    .default(DEFAULT_PREVIEW_WIDTH)
    .describe('Longest edge of the preview. The composition’s aspect is preserved exactly.'),
  fps: z
    .number()
    .int()
    .min(1)
    .max(120)
    .default(DEFAULT_PREVIEW_FPS)
    .describe('Requested cadence. Snapped down to a divisor of the composition’s own rate.'),
  /** `null` previews the whole timeline, which is the point. A range is for a re-look. */
  frames: FrameRange.nullable().default(null),
  backend: RenderBackend.default('auto'),
  keepFrames: z.boolean().default(false),
});
export type PreviewStageRequest = z.infer<typeof PreviewStageRequest>;

/**
 * The cadence a preview is actually rendered at: the largest divisor of `fps` that is
 * no greater than what was asked for.
 *
 * A divisor, so every preview instant is also a master instant. `frameTimeMs` is
 * `frame * 1000 / fps`, and for a divisor `d` of `fps` the preview's frame `k` lands on
 * `k * 1000 / d`, which is master frame `k * fps / d` exactly - the same double, not a
 * near-miss, because both are one correctly-rounded division of exact integers.
 *
 * There is always an answer: 1 divides everything.
 */
export function previewFps(compositionFps: number, requested: number): number {
  const ceiling = Math.min(Math.max(1, Math.floor(requested)), compositionFps);
  for (let candidate = ceiling; candidate > 1; candidate -= 1) {
    if (compositionFps % candidate === 0) return candidate;
  }
  return 1;
}

/**
 * The preview's pixel size: the composition, scaled to fit `maxWidth`, kept even.
 *
 * Even because 4:2:0 chroma subsampling halves both dimensions and `libx264` refuses an
 * odd one outright - the same reason `reframe-filter.ts` floors its crops to even. A
 * composition already smaller than `maxWidth` is not scaled *up*: a preview larger than
 * the render would cost more than the thing it is previewing.
 */
export function previewSize(scene: Size, maxWidth: number): Size {
  const scale = Math.min(1, maxWidth / scene.width);
  return {
    width: even(scene.width * scale),
    height: even(scene.height * scale),
  };
}

function even(value: number): number {
  return Math.max(2, Math.floor(Math.round(value) / 2) * 2);
}
