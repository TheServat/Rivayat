/**
 * `@rv/anim-engine` - the Animation IR evaluator.
 *
 * One entry point that matters: `evaluate(ir, timeMs)`. It is a pure function of time,
 * and every guarantee downstream - seek-safe scrubbing, resumable renders, sharded
 * renders, sprite sheets that match live playback - is a consequence of that.
 */

export type { EvaluateOptions } from './evaluate';
export { DEFAULT_EASINGS, evaluate, orderParentFirst } from './evaluate';

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
  decomposeTransform,
  identityTransform,
  rotateVec,
  transformPoint,
  transformsEqual,
} from './transform';

export type { RigPose } from './rig/pose';
export {
  anchorPoint,
  anchorPointByRole,
  anchorTransform,
  attachmentFrame,
  clipDeltasByRole,
  orderBonesParentFirst,
  poseRig,
  restPose,
} from './rig/pose';

export {
  ancestorsByRole,
  boneByRole,
  clipAnimatedRoles,
  clipDrivenRoles,
  frameLengthOf,
  orderRolesParentFirst,
  rigSignature,
  signatureAnchorPoint,
  signatureRestWorlds,
  statureOf,
} from './clips/signature';
export type { BrokenAncestry, ClipCompatibility } from './clips/compatibility';
export { checkClipCompatibility } from './clips/compatibility';
export { retargetClip, scaleBehaviour } from './clips/retarget';
export type { ClipRequest, ClipResolution, RejectedClip } from './clips/resolve';
export { resolveClip } from './clips/resolve';

export type { MotionProvider } from './motion/port';
export { MotionProviderRegistry } from './motion/registry';
export { motionRequirements } from './motion/requirements';
export { KeyframeMotionProvider } from './motion/keyframe-provider';
export { ProceduralMotionProvider } from './motion/procedural-provider';
export { deriveId, deriveSeed } from './motion/derive';

export type { ConvexPolygon } from './geometry/polygon';
export {
  convexSeparation,
  excursionBeyondRect,
  intersectConvex,
  polygonArea,
  signedDistanceToConvex,
} from './geometry/polygon';
export type { NodeExtent, SilhouetteShape } from './geometry/silhouette';
export {
  DEFAULT_ELLIPSE_SEGMENTS,
  SILHOUETTE_SHAPES,
  extentsFromIr,
  seamToleranceScenePx,
  silhouetteOf,
} from './geometry/silhouette';
export type {
  GeometryCheckOptions,
  GeometryFinding,
  GeometryFindingCode,
  GeometryReport,
  GeometryUnit,
} from './geometry/check-geometry';
export {
  GEOMETRY_FINDING_CODES,
  cameraFrameExcursion,
  checkGeometry,
} from './geometry/check-geometry';

export type { ClipHash, ClipHashOptions } from './golden/scene-hash';
export { SCENE_HASH_QUANTUM, canonicalScene, hashClip } from './golden/scene-hash';
