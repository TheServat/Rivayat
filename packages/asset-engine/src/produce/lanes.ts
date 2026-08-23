/**
 * Which port actually draws the pixels, per lane.
 *
 * `generate/decomposition-policy.ts` already answers "props take the parts-sheet path,
 * characters take the multi-reference path" - research §3's finding, as a table. What
 * it does not say, because it must not, is *who* runs each lane: that is a wiring
 * decision, and hard-coding it would put a provider name inside the engine.
 *
 * So this is the second half of the same table. A `GenerationLane` maps to an
 * `ImageGenerationPort` plus the binding the ledger needs to price the call, and a
 * lane with no binding is a **typed refusal naming the lane**, never a silent
 * substitution. That distinction is the whole reason this file exists: a run
 * configured with only the free local lane must fail loudly on the first character
 * rather than quietly generating one without its identity anchors.
 *
 * `backgroundHint` lives here for the same reason. The local lane draws on a field the
 * prompt declared, so the key knows what colour to remove; a cloud lane returning RGBA
 * does not, and guessing on its behalf is how a pale wing gets eaten.
 */

import { type AppError, type Result, UnsupportedCapabilityError, err, ok } from '@rv/shared-kernel';
import type { AssetSpec, ProviderKind } from '@rv/contracts';
import type { ImageGenerationPort } from '@rv/providers';

import type { PromptEncoder } from '../generate/request-composer';
import {
  DEFAULT_DECOMPOSITION_POLICY,
  type DecompositionPolicy,
  type GenerationLane,
  type SubjectRoute,
  routeSubject,
} from '../generate/decomposition-policy';

/**
 * Every lane, as a list to iterate.
 *
 * Derived from a `Record<GenerationLane, true>` rather than typed out, so a new lane
 * in `decomposition-policy.ts` breaks this file at compile time instead of silently
 * never being wired.
 */
const LANE_PRESENCE: Readonly<Record<GenerationLane, true>> = {
  'local-parts-sheet': true,
  'cloud-multi-reference': true,
};

export const GENERATION_LANES: readonly GenerationLane[] = Object.keys(
  LANE_PRESENCE,
) as GenerationLane[];

export interface LaneBinding {
  readonly images: ImageGenerationPort;
  /** Recorded on every ledger row so a run's spend can be attributed. */
  readonly provider: ProviderKind;
  readonly model: string;
  /**
   * The flat field this lane's prompts ask for, when it has one.
   *
   * Absent means "let the matting engine sample it". Present means the caller knows,
   * and a key beats a learned matte on a declared field (research §4).
   */
  readonly backgroundHint?: { readonly r: number; readonly g: number; readonly b: number };
  /**
   * The text encoder behind this lane. Defaults to `long`.
   *
   * SD 1.5 is `clip-77`; a Gemini or FLUX lane is `long`. Declared on the binding
   * rather than inferred from the lane name, because the local lane will not always be
   * SD 1.5 - research §2 has SDXL and FLUX queued behind the same graphs.
   */
  readonly promptEncoder?: PromptEncoder;
}

export interface ProduceLanes {
  /**
   * Partial on purpose.
   *
   * A free-lane-only run genuinely has no cloud binding, and `Record<GenerationLane,
   * …>` would force one to be invented. The consequence - a spec routed to a lane
   * nobody configured - is a named failure, which is the honest outcome.
   */
  readonly byLane: Readonly<Partial<Record<GenerationLane, LaneBinding>>>;
  /** Defaults to {@link DEFAULT_DECOMPOSITION_POLICY}. `FREE_LANE_POLICY` forces local. */
  readonly policy?: DecompositionPolicy;
}

export interface ResolvedLane {
  readonly route: SubjectRoute;
  readonly lane: GenerationLane;
  readonly binding: LaneBinding;
}

/**
 * The lane one spec generates in, or why it cannot.
 *
 * Two lookups and no branching: the policy table decides the lane from the subject
 * class, the binding table decides the port from the lane. "Why did my character go to
 * the cloud" and "why did it fail" are both answered by reading one of those two
 * tables.
 */
export function resolveLane(spec: AssetSpec, lanes: ProduceLanes): Result<ResolvedLane, AppError> {
  const route = routeSubject(spec, lanes.policy ?? DEFAULT_DECOMPOSITION_POLICY);
  const binding = lanes.byLane[route.lane];
  if (binding === undefined) {
    return err(
      new UnsupportedCapabilityError(
        'router',
        `the ${route.lane} lane, which ${spec.subjectClass} subjects route to - ${route.reason} Configure a binding for it, or route this subject class elsewhere with a DecompositionPolicy`,
      ),
    );
  }
  return ok({ route, lane: route.lane, binding });
}
