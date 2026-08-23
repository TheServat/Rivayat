/**
 * `@rv/anim-engine` - the Animation IR evaluator.
 *
 * One entry point that matters: `evaluate(ir, timeMs)`. It is a pure function of time,
 * and every guarantee downstream - seek-safe scrubbing, resumable renders, sharded
 * renders, sprite sheets that match live playback - is a consequence of that.
 */

export type { EvaluateOptions } from './evaluate';
export { evaluate, orderParentFirst } from './evaluate';

export type { EasingLibrary } from './easing';
export {
  applyEasing,
  buildEasingLibrary,
  cubicBezierAt,
  quantiseToStep,
  steppedAt,
} from './easing';

export type { Extrapolation } from './track';
export { foldTracks, valueAt } from './track';

export type { ChannelDeltas, BehaviourContext } from './behaviours';
export { behaviourWeight, evaluateBehaviour, parallaxFactor } from './behaviours';

export { fractalNoise1d, noise1d, signedNoise1d } from './noise';

export {
  composeTransform,
  identityTransform,
  rotateVec,
  transformPoint,
  transformsEqual,
} from './transform';
