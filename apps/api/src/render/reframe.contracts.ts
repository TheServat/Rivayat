/**
 * What `POST /api/render/reframe` takes, and how a composition with no shot list is
 * still framed.
 *
 * Reframing is *computed, not re-authored* (architecture section 7): one composition
 * becomes seven deliverables by solving a crop per shot per format against the verified
 * safe zones. `buildReframePlans` in `@rv/render-engine` does that in microseconds and
 * needs no render, no encoder and no money - which is exactly why it belongs behind a
 * synchronous endpoint the studio can call while the user is still choosing formats.
 *
 * **`shots` is optional, and the default is the honest one.** S7 Sequence is still a
 * stub, so nothing in this build produces a `Shot[]`; a body that demanded one would
 * make the endpoint unreachable from the only client there is. When it is absent the
 * whole timeline is treated as a single shot, which is what a composition without a
 * shot list *is*. The plan then says one thing per format instead of one thing per cut,
 * and says it correctly.
 *
 * **The focus comes from the camera, and it is projected rather than normalised.** The
 * crop is applied to the rendered master, which has the camera baked into every layer,
 * so a subject can only be located in the space the master is actually in.
 * `sampleFocusTrack` uses `projectToNorm` for that; normalising a raw scene position
 * answers a different question - where the subject sits on the authoring canvas - and
 * gets every shot whose camera moves wrong. On the repo's own fixture that gap reached a
 * quarter of the frame width against a crop only a third of it, so the subject left the
 * frame entirely.
 */

import { AnimationIR, FormatProfileId, NodeId, NormRect, ReframePlan, ShotId } from '@rv/contracts';
import { z } from 'zod';

/**
 * The subject region when nobody has said how big the subject is.
 *
 * A centred third: large enough that a crop keeping it inside the safe area keeps the
 * actual subject there too, small enough that the solver has room to move. It is a
 * default, not a guess about content - a caller that knows better sends `focusRegion`.
 */
export const DEFAULT_FOCUS_REGION: NormRect = {
  x: 1 / 3,
  y: 1 / 3,
  width: 1 / 3,
  height: 1 / 3,
};

/** One shot to solve, as a client supplies it. */
export const ReframeShotInput = z.strictObject({
  shotId: ShotId,
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  /**
   * The node that must stay in frame. Falls back to the IR's own `camera.focusNodeId`.
   *
   * A node id rather than a point, because the point moves: the reframer samples the
   * node across the shot and solves one crop over the whole travel.
   */
  focusNodeId: NodeId.optional(),
  /** How big the subject is, in composition fractions. */
  focusRegion: NormRect.optional(),
  /** Advisory region no crop should cut into. Becomes a note rather than a refusal. */
  safeArea: NormRect.optional(),
  /**
   * A hand-authored crop for this shot. Wins outright over anything solved.
   *
   * Present because "every artefact of every earlier stage is editable in the UI" - an
   * author who has framed a shot by hand must not have it re-solved underneath them.
   */
  override: NormRect.optional(),
});
export type ReframeShotInput = z.infer<typeof ReframeShotInput>;

export const ReframeBody = z.strictObject({
  ir: AnimationIR,
  formats: z
    .array(FormatProfileId)
    .min(1)
    .describe('Delivery targets. Each is solved from the same composition (architecture 7).'),
  shots: z
    .array(ReframeShotInput)
    .min(1)
    .optional()
    .describe('In timeline order. Omit for a composition that has not been cut into shots.'),
  /** Subject size for the derived shot, when the composition has no shot list. */
  focusRegion: NormRect.optional(),
  /**
   * Ceiling on crop travel, as a fraction of the composition per second.
   *
   * Exposed because it is the one solver parameter with a visible consequence: a pan
   * faster than this reads as a whip, so the solver clamps it and flags the shot rather
   * than shipping the whip.
   */
  maxPanPerSecond: z.number().positive().max(2).optional(),
});
export type ReframeBody = z.infer<typeof ReframeBody>;

/**
 * The plans, keyed by format.
 *
 * A record rather than an array so a client can look up the format it is rendering a
 * card for without scanning, and an envelope rather than a bare record so the response
 * has somewhere to say how it was solved.
 *
 * `derivedShots` is on the wire because it changes what the plan *means*: one shot over
 * the whole timeline is a correct answer to "frame this composition" and a misleading
 * answer to "frame this episode", and only the client knows which it asked.
 */
export const ReframePlanSet = z.strictObject({
  derivedShots: z
    .boolean()
    .describe('True when the whole timeline was treated as one shot, because none were supplied.'),
  plans: z.partialRecord(FormatProfileId, ReframePlan),
});
export type ReframePlanSet = z.infer<typeof ReframePlanSet>;
