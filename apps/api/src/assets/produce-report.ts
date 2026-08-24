/**
 * Eight step records for one take, built from what the engine said while it ran.
 *
 * `ProduceAssetsOutput` says where each asset *ended up* - registered, reused, rejected,
 * failed - and that is not the same question the Assets screen asks. "Where did this
 * stop, and why" needs the steps that ran, the ones that were skipped because a
 * checkpoint already covered them, the one that failed, and the ones that were never
 * reached. Only the progress stream carries all four, so it is collected as it arrives.
 *
 * `not-reached` is a real state and not a synonym for `failed`. An asset that stopped at
 * `matte` did not fail at `rig`; it never got there, and a screen that paints both red
 * sends the user to look at the rig.
 *
 * **What this cannot say, and does not pretend to.** `ProduceProgress` carries a step's
 * duration but not its cost, so `costNanoUsd` is zero on every step record and the take's
 * real total sits on `spentNanoUsd`. Per-step attribution needs one more field on the
 * engine's progress event; it is reported rather than invented, because a plausible
 * split across eight steps is exactly the kind of number that gets quoted back later.
 */

import type { ProduceProgress, ProduceStep } from '@rv/asset-engine';
import { PRODUCE_STEPS } from '@rv/asset-engine';
import type { AssetId, AssetKey, AssetVersionId } from '@rv/contracts';

import { AssetProduceReport, type ProduceStepRecord } from '../modules/assets/assets.contracts';

/** The last thing the engine said about one step of one asset. */
interface StepObservation {
  readonly attempt: number;
  readonly phase: ProduceProgress['phase'];
  readonly durationMs: number;
  readonly detail: string | undefined;
}

/**
 * Collects the engine's progress ticks, keyed the way the engine emits them.
 *
 * By semantic key rather than by asset key because that is the only identifier a
 * `ProduceProgress` carries - the dedup key is not known to the step that is running,
 * and a take that fails at `generate` has no asset id at all.
 */
export class ProduceProgressLog {
  readonly #bySemanticKey = new Map<string, Map<ProduceStep, StepObservation>>();

  /**
   * The latest tick wins for a given step.
   *
   * A repair attempt re-runs a step, and what the reader wants to know is where the take
   * finally got to - the earlier attempt is visible in `attempt` on the record that
   * survived.
   */
  record(event: ProduceProgress): void {
    const steps =
      this.#bySemanticKey.get(event.semanticKey) ?? new Map<ProduceStep, StepObservation>();
    steps.set(event.step, {
      attempt: event.attempt,
      phase: event.phase,
      durationMs: Math.max(0, Math.round(event.durationMs)),
      detail: event.detail,
    });
    this.#bySemanticKey.set(event.semanticKey, steps);
  }

  /** All eight steps, in engine order, with the ones that never ran named as such. */
  stepsFor(semanticKey: string): ProduceStepRecord[] {
    const observed = this.#bySemanticKey.get(semanticKey);
    return PRODUCE_STEPS.map((step) => {
      const seen = observed?.get(step);
      if (seen === undefined) {
        return { step, outcome: 'not-reached' as const, attempt: 0, durationMs: 0, costNanoUsd: 0 };
      }
      return {
        step,
        outcome: seen.phase,
        attempt: seen.attempt,
        durationMs: seen.durationMs,
        costNanoUsd: 0,
        ...(seen.detail === undefined ? {} : { detail: seen.detail }),
      };
    });
  }
}

export interface ProduceReportInput {
  readonly key: AssetKey;
  /**
   * A plain string, validated on the way into the report.
   *
   * `ProducedAsset.semanticKey` is `string` in the engine, and casting it to the branded
   * `SemanticKey` here would be asserting what the schema is about to check anyway.
   */
  readonly semanticKey: string;
  readonly label: string;
  readonly assetId?: AssetId;
  readonly versionId?: AssetVersionId;
  readonly failedStep?: ProduceStep;
  readonly spentNanoUsd: number;
}

/**
 * One take's report, parsed rather than cast.
 *
 * Parsing here is what stops a malformed report reaching the store - and the store is
 * what a regeneration reads its spec from, so a document that does not satisfy the schema
 * has to fail on the way in rather than on the way out.
 */
export function buildProduceReport(
  input: ProduceReportInput,
  steps: readonly ProduceStepRecord[],
): AssetProduceReport | null {
  const parsed = AssetProduceReport.safeParse({
    key: input.key,
    semanticKey: input.semanticKey,
    label: input.label,
    ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
    ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
    steps,
    ...(input.failedStep === undefined ? {} : { failedStep: input.failedStep }),
    spentNanoUsd: Math.max(0, Math.round(input.spentNanoUsd)),
  });
  return parsed.success ? parsed.data : null;
}
