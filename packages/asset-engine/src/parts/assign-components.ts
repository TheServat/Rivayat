/**
 * Which blob is which part.
 *
 * This is the step that quietly ruins an asset if it guesses. A mis-assignment does
 * not fail: it produces a schema-valid rig with an arm bound to the wing bone, and the
 * symptom is a shot, three stages later, in which the character's arm beats. So the
 * result reports **unmatched components** and **unfilled plans** as first-class fields
 * and never invents a pairing to make the counts agree.
 *
 * The cost has three terms, which is exactly the "position, size and count" the
 * splitter is specified against:
 *
 * - **Position.** Distance from the component's centroid to the plan's `attachHint`,
 *   in normalised canvas space. The hint is not inferred - the spec declared it, from
 *   the rig template, before anything was drawn.
 * - **Size.** Log-ratio of the component's extent to the extent the template's bone
 *   length implies. Log so that "twice as big" and "half as big" are equally wrong.
 * - **Count.** Not a term but the outcome: matching is one-to-one, so a surplus
 *   component and a starved plan both survive into the report.
 *
 * Matching is greedy over globally sorted costs rather than Hungarian-optimal. With
 * fewer than thirty items on either side the two agree in practice, and greedy has the
 * property that matters more here: it is trivially deterministic, including its
 * tie-breaks.
 */

import type { PartPlan, Vec2 } from '@rv/contracts';

import type { Component } from './connected-components';

export interface PlanTarget {
  readonly name: string;
  readonly role: string;
  /** Where the rig template says this part attaches, normalised to the canvas. */
  readonly attachHint: Vec2;
  /** Expected largest dimension, as a fraction of the canvas. From the bone length. */
  readonly expectedExtent: number;
  readonly optional: boolean;
}

export interface Assignment {
  readonly plan: PlanTarget;
  readonly component: Component;
  /** Lower is a better fit. Recorded so a suspicious pairing can be inspected. */
  readonly cost: number;
}

export interface AssignmentReport {
  readonly assignments: readonly Assignment[];
  /** Components no plan claimed. A sixth blob on a five-part sheet. */
  readonly unmatched: readonly Component[];
  /** Plans nothing was found for. `optional` ones are listed too, and forgiven. */
  readonly unfilled: readonly PlanTarget[];
  /** True when every **required** plan was filled and nothing was left over. */
  readonly complete: boolean;
}

export interface AssignmentOptions {
  /** Relative weight of the positional term. */
  readonly positionWeight?: number;
  /** Relative weight of the size term. */
  readonly sizeWeight?: number;
  /**
   * Cost above which a pairing is refused outright.
   *
   * Without a ceiling, greedy matching pairs the last leftover component with the last
   * leftover plan however absurd the fit, purely because nothing else is left - which
   * is the exact silent mis-assignment this module exists to prevent.
   */
  readonly maxCost?: number;
}

const DEFAULT_POSITION_WEIGHT = 1;
const DEFAULT_SIZE_WEIGHT = 0.45;
const DEFAULT_MAX_COST = 0.85;

export function assignComponents(
  components: readonly Component[],
  plans: readonly PlanTarget[],
  canvas: { readonly width: number; readonly height: number },
  options: AssignmentOptions = {},
): AssignmentReport {
  const positionWeight = options.positionWeight ?? DEFAULT_POSITION_WEIGHT;
  const sizeWeight = options.sizeWeight ?? DEFAULT_SIZE_WEIGHT;
  const maxCost = options.maxCost ?? DEFAULT_MAX_COST;

  interface Candidate {
    readonly componentIndex: number;
    readonly planIndex: number;
    readonly cost: number;
  }

  const candidates: Candidate[] = [];
  components.forEach((component, componentIndex) => {
    plans.forEach((plan, planIndex) => {
      const cost = pairCost(component, plan, canvas, positionWeight, sizeWeight);
      if (cost > maxCost) return;
      candidates.push({ componentIndex, planIndex, cost });
    });
  });

  // Index tie-breaks after the cost keep the order total, so the same sheet always
  // splits the same way. Components are already in raster order.
  candidates.sort(
    (left, right) =>
      left.cost - right.cost ||
      left.planIndex - right.planIndex ||
      left.componentIndex - right.componentIndex,
  );

  const takenComponents = new Set<number>();
  const takenPlans = new Set<number>();
  const assignments: Assignment[] = [];

  for (const candidate of candidates) {
    if (takenComponents.has(candidate.componentIndex)) continue;
    if (takenPlans.has(candidate.planIndex)) continue;
    const component = components[candidate.componentIndex];
    const plan = plans[candidate.planIndex];
    if (component === undefined || plan === undefined) continue;
    takenComponents.add(candidate.componentIndex);
    takenPlans.add(candidate.planIndex);
    assignments.push({ plan, component, cost: candidate.cost });
  }

  // Ordered by plan so the parts come back in the order the spec listed them, which is
  // the order the rig template binds and the order a human reads.
  assignments.sort((left, right) => plans.indexOf(left.plan) - plans.indexOf(right.plan));

  const unmatched = components.filter((_, index) => !takenComponents.has(index));
  const unfilled = plans.filter((_, index) => !takenPlans.has(index));

  return {
    assignments,
    unmatched,
    unfilled,
    complete: unmatched.length === 0 && unfilled.every((plan) => plan.optional),
  };
}

function pairCost(
  component: Component,
  plan: PlanTarget,
  canvas: { readonly width: number; readonly height: number },
  positionWeight: number,
  sizeWeight: number,
): number {
  const cx = component.centroid.x / canvas.width;
  const cy = component.centroid.y / canvas.height;
  const dx = cx - plan.attachHint.x;
  const dy = cy - plan.attachHint.y;
  const positional = Math.sqrt(dx * dx + dy * dy);

  const extent =
    Math.max(component.bounds.width / canvas.width, component.bounds.height / canvas.height) ||
    1e-6;
  const expected = Math.max(plan.expectedExtent, 1e-6);
  // Halved and clamped so a wildly wrong size degrades the score without swamping a
  // position term that may be the only trustworthy signal on a loosely laid-out sheet.
  const sizeTerm = Math.min(1, Math.abs(Math.log2(extent / expected)) / 3);

  return positionWeight * positional + sizeWeight * sizeTerm;
}

/**
 * Turns the spec's plans into assignment targets.
 *
 * `expectedExtent` comes from the rig template's bone length rather than from the spec,
 * because the spec has no size field and inventing one would be a second source of
 * truth for the same number.
 */
export function toPlanTargets(
  plans: readonly PartPlan[],
  extentByRole: ReadonlyMap<string, number>,
  defaultExtent = 0.2,
): PlanTarget[] {
  return plans.map((plan) => ({
    name: plan.name,
    role: plan.role,
    attachHint: plan.attachHint ?? { x: 0.5, y: 0.5 },
    expectedExtent: extentByRole.get(plan.role) ?? defaultExtent,
    optional: plan.optional,
  }));
}
