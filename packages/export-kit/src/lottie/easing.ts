/**
 * Our easing curves, expressed as Lottie tangent handles.
 *
 * This is the join that makes an export match its own preview. Both formats describe an
 * eased segment as a cubic bezier through `(0,0)` and `(1,1)` with two free control
 * points, so the mapping is an identity on the numbers - `cubic-bezier(x1,y1,x2,y2)`
 * becomes `o = (x1,y1)`, `i = (x2,y2)` - and the only way to get it wrong is to invent a
 * second solver. We do not: {@link sampleLottieProperty} reads the handles back through
 * `cubicBezierAt` from `@rv/anim-engine`, the same function the renderer eases with, so
 * an exporter bug shows up as a fidelity number rather than as a file that looks subtly
 * wrong on someone else's player.
 */

import { must } from '@rv/shared-kernel';
import type { Easing } from '@rv/contracts';
import type { EasingLibrary } from '@rv/anim-engine';

import type { LottieEase } from './types';

/** A segment's tangent pair, or the instruction to hold. */
export type LottieSegmentEase =
  | { readonly kind: 'bezier'; readonly out: LottieEase; readonly in: LottieEase }
  | { readonly kind: 'hold' };

/** `cubic-bezier(0,0,1,1)` - the identity curve, which our solver short-circuits. */
const LINEAR: LottieSegmentEase = {
  kind: 'bezier',
  out: { x: [0], y: [0] },
  in: { x: [1], y: [1] },
};

/**
 * Whether an easing survives the mapping unchanged.
 *
 * Only one kind does not: a stepped curve with more than one jump, or one that jumps at
 * the *start* of the interval. Lottie's `h: 1` holds the segment's start value until the
 * next keyframe, which is precisely `stepped { at: 'end', steps: 1 }` and nothing else.
 * Multi-step and jump-at-start curves change value strictly inside a segment, and Lottie
 * has no way to say that without inventing keyframes at times the IR never mentioned.
 * Those are baked instead, where the frame grid captures them exactly.
 */
export function isExactlyRepresentable(easing: Easing | undefined): boolean {
  if (easing === undefined) return true;
  if (easing.kind === 'stepped') return easing.steps === 1 && easing.at === 'end';
  return true;
}

/**
 * The Lottie handles for the segment leaving a keyframe.
 *
 * A named curve resolves through the same library the evaluator uses, so "restyle the
 * series by editing one curve" reaches the export too. A name the library does not hold
 * throws, exactly as it does in the renderer: a missing curve means the clip and the
 * style bible disagree, and easing it linearly hides that behind motion that merely
 * looks slightly wrong.
 */
export function toSegmentEase(
  easing: Easing | undefined,
  library: EasingLibrary,
): LottieSegmentEase {
  if (easing === undefined) return LINEAR;

  switch (easing.kind) {
    case 'cubic-bezier':
      return {
        kind: 'bezier',
        out: { x: [easing.x1], y: [easing.y1] },
        in: { x: [easing.x2], y: [easing.y2] },
      };
    case 'named': {
      const curve = must(library, easing.name, 'easing curve');
      return {
        kind: 'bezier',
        out: { x: [curve.p1.x], y: [curve.p1.y] },
        in: { x: [curve.p2.x], y: [curve.p2.y] },
      };
    }
    case 'stepped':
      return { kind: 'hold' };
  }
}

/** True when the curve can overshoot or undershoot the segment it eases. */
export function overshoots(easing: Easing | undefined, library: EasingLibrary): boolean {
  const segment = toSegmentEase(easing, library);
  if (segment.kind === 'hold') return false;
  const y1 = segment.out.y[0] ?? 0;
  const y2 = segment.in.y[0] ?? 1;
  return y1 < 0 || y1 > 1 || y2 < 0 || y2 > 1;
}
