/**
 * What S8 knew about a composition that the composition itself cannot say.
 *
 * An `AnimationIR` is a flat timeline. It has no shots - by design, because the
 * evaluator is a pure function of time and a cut is not a thing you can evaluate - and
 * it carries exactly one `camera.focusNodeId` for its whole duration. S11 needs the
 * opposite: a crop *per shot*, each solved against the subject that shot is about
 * (`ReframeInput.shots`, `ShotFraming.focus`).
 *
 * The two facts are not in tension, they are simply held in different documents. This
 * is the second one: the shot boundaries, the subject per shot, the safe area the
 * author declared and the manual crops they wrote for the aspects the solver gets
 * wrong. Everything here comes from the `Shot[]` S8 compiled, so nothing in it is
 * inferred and nothing in it can contradict the IR - it is filed under the
 * composition's own content hash, so a record and an IR either belong together or the
 * record is not found.
 *
 * Without it a delivery is still possible and is *worse*: the whole timeline becomes
 * one shot, and a nine-shot episode gets one crop solved against an average of nine
 * subjects. That fallback is honest and it is a fallback; `ReframePlanSet.derivedShots`
 * exists to say which of the two happened.
 */

import {
  AnimationId,
  DeliveryAspect,
  Fps,
  IsoInstant,
  Millis,
  NodeId,
  NormRect,
  PositiveInt,
  Sha256Hex,
  ShotId,
  Size,
  Slug,
} from '@rv/contracts';
import { z } from 'zod';

/** One shot, as the reframer needs it: when it is, and what it is about. */
export const ShotTimeline = z.strictObject({
  shotId: ShotId,
  /** Offset from the start of the composition. Shots are contiguous and in order. */
  startMs: Millis,
  durationMs: PositiveInt,
  /**
   * The node the crop must keep, or `null` for a shot that is about no single thing.
   *
   * A node id rather than a point, because the point moves: the reframer samples the
   * node across the shot **through the camera** and solves one crop over the travel.
   */
  focusNodeId: NodeId.nullable().default(null),
  /** How big the subject is, in composition fractions. The author's own number. */
  focusRegion: NormRect,
  safeArea: NormRect,
  /**
   * Hand-authored crops, per delivery aspect.
   *
   * Straight from `SceneSpace.overrides`: "add an entry only after seeing the automatic
   * crop fail". An author who has framed a shot by hand must not have it re-solved
   * underneath them, so these win outright at delivery.
   */
  overrides: z.partialRecord(DeliveryAspect, NormRect).default({}),
});
export type ShotTimeline = z.infer<typeof ShotTimeline>;

/**
 * Where the motion for one performance came from.
 *
 * Recorded because the answer is not visible in the IR. An instance node names a clip
 * by name; whether that name resolved to the asset's own clip or to a library clip
 * retargeted onto this rig is the difference between "reused" and "reused *and*
 * rescaled", and only the second one has a fragment to bake.
 */
export const ClipBinding = z.strictObject({
  instance: Slug,
  clip: Slug,
  origin: z.enum(['asset', 'library']),
  /** Content hash of the retargeted fragment. `null` for an asset's own clip. */
  fragmentId: Sha256Hex.nullable().default(null),
});
export type ClipBinding = z.infer<typeof ClipBinding>;

export const Choreography = z.strictObject({
  /** The composition this describes. The record and the IR share one address. */
  compositionId: Sha256Hex,
  animationId: AnimationId,
  sceneSpace: Size,
  fps: Fps,
  durationMs: PositiveInt,
  shots: z.array(ShotTimeline).min(1),
  clips: z.array(ClipBinding).default([]),
  createdAt: IsoInstant,
});
export type Choreography = z.infer<typeof Choreography>;
