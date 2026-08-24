/**
 * Solving one composition onto every delivery format, without rendering anything.
 *
 * The whole of architecture section 7's "reframing is computed, not re-authored" is
 * already in `@rv/render-engine`; this is the joint that makes it reachable from the
 * studio while the user is still choosing formats. It touches no encoder, no provider
 * and no disk, so it is a synchronous request rather than a run.
 *
 * The one decision here is where the *focus* comes from, and it has a wrong answer that
 * looks right. The crop is applied to the rendered master, which has the camera baked
 * into every layer by `cameraMatrix`, so a subject can only be located in the space the
 * master is in. `sampleFocusTrack` does that - it evaluates the node and projects
 * through the camera. Reading `node.position` and normalising it answers a different
 * question, and on the repo's own 400x300 fixture with the camera panning and zooming
 * the two answers differed by a quarter of the frame width, against a 9:16 crop that is
 * only a third of it. The subject left the frame.
 */

import {
  FORMAT_PRESETS,
  Ids,
  type AnimationIR,
  type FormatProfileId,
  type NormRect,
  type ReframePlan,
} from '@rv/contracts';
import {
  buildReframePlans,
  sampleFocusTrack,
  staticFocusTrack,
  type ShotFraming,
} from '@rv/render-engine';
import { isErr, ok, type AppError, type Result } from '@rv/shared-kernel';

import {
  DEFAULT_FOCUS_REGION,
  type ReframeBody,
  type ReframePlanSet,
  type ReframeShotInput,
} from './reframe.contracts';

export interface ReframeServiceDeps {
  readonly ids: Ids;
}

export class ReframeService {
  readonly #ids: Ids;

  constructor(deps: ReframeServiceDeps) {
    this.#ids = deps.ids;
  }

  plan(body: ReframeBody): Result<ReframePlanSet, AppError> {
    const derived = body.shots === undefined;
    const shots = (body.shots ?? [this.#wholeTimeline(body)]).map((shot) =>
      this.#framing(body.ir, shot, body.focusRegion),
    );

    const plans = buildReframePlans(
      { composition: body.ir.sceneSpace, shots },
      body.formats,
      body.maxPanPerSecond === undefined ? {} : { maxPanPerSecond: body.maxPanPerSecond },
    );
    if (isErr(plans)) return plans;

    const byFormat: Partial<Record<FormatProfileId, ReframePlan>> = {};
    for (const [format, plan] of plans.value) byFormat[format] = plan;

    return ok({ derivedShots: derived, plans: byFormat });
  }

  /**
   * The composition as one shot.
   *
   * What a composition with no shot list *is*, rather than a stand-in for the shot list
   * S7 will produce. The response says `derivedShots: true` so a client can tell the
   * two apart.
   */
  #wholeTimeline(body: ReframeBody): ReframeShotInput {
    return {
      shotId: this.#ids.shot(),
      startMs: 0,
      durationMs: Math.max(1, Math.round(body.ir.durationMs)),
    };
  }

  #framing(ir: AnimationIR, shot: ReframeShotInput, fallbackRegion?: NormRect): ShotFraming {
    const region = shot.focusRegion ?? fallbackRegion ?? DEFAULT_FOCUS_REGION;
    const nodeId = shot.focusNodeId ?? ir.camera?.focusNodeId;

    // A tracked node is sampled across the shot and projected through the camera; a
    // composition that names no subject is framed on the region itself, which for the
    // default is the middle third. Both are honest answers to different inputs.
    const focus =
      nodeId === undefined
        ? staticFocusTrack(region)
        : sampleFocusTrack(ir, nodeId, region, {
            startMs: shot.startMs,
            durationMs: shot.durationMs,
          });

    return {
      shotId: shot.shotId,
      startMs: shot.startMs,
      durationMs: shot.durationMs,
      // The composition's own safe region, when the caller named one. Advisory either
      // way: a violation becomes a note and `needsReview`, never a refusal, because a
      // flagged crop is something an author can fix and a refusal is not.
      safeArea: shot.safeArea ?? FULL_FRAME,
      focus,
      // `must-keep`: a subject the author named is a subject that has to survive the
      // crop. `prefer` would let the solver drop it silently when the aspect is tight,
      // which is the one outcome nobody would choose on purpose.
      priority: 'must-keep',
      ...(shot.override === undefined ? {} : { override: shot.override }),
    };
  }
}

/** No advisory region: the whole composition is fair game unless a caller says otherwise. */
const FULL_FRAME: NormRect = { x: 0, y: 0, width: 1, height: 1 };

/** Every format this build can solve. Data from the contract, never a second list. */
export const REFRAMABLE_FORMATS: readonly FormatProfileId[] = Object.keys(
  FORMAT_PRESETS,
) as FormatProfileId[];
