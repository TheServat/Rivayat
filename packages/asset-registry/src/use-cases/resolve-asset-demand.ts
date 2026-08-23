/**
 * "What do we already have, and what would the rest cost?"
 *
 * This is the screen the user approves before a single dollar moves, so the use-case
 * has one hard constraint beyond correctness: **it writes nothing and calls no
 * provider**. It reads the dedup index, prices the misses from a pure estimator, and
 * returns. A test asserts the zero-write property directly, because a plan that costs
 * money to produce is not a plan.
 */

import { type NanoUsd, type Result, ZERO_USD, isErr, nanoUsd, ok } from '@rv/shared-kernel';
import type {
  AssetDemandPlan,
  AssetKey,
  AssetResolution,
  AssetSpec,
  Sha256Hex,
  Slug,
  StyleBibleId,
} from '@rv/contracts';

import { deriveAssetKey } from '../asset-key';
import type { AssetCostEstimator, AssetRepository } from '../ports/index';

export interface ResolveAssetDemandInput {
  readonly specs: readonly AssetSpec[];
  readonly styleBibleId: StyleBibleId;
  /** The locked style's checksum. Change it and every spec in the list misses. */
  readonly styleChecksum: Sha256Hex;
  readonly variantKey?: Slug;
  /**
   * Ceiling for this plan. Specs that would push the running total past it come back
   * `blocked-by-budget` rather than silently inflating the estimate.
   */
  readonly budgetNanoUsd?: NanoUsd;
  /**
   * Spend above which a human has to say yes. Defaults to zero - any spend at all is
   * confirmed, which is the safe default for a tool that generates images.
   */
  readonly confirmationThresholdNanoUsd?: NanoUsd;
}

export interface ResolveAssetDemandDeps {
  readonly repository: AssetRepository;
  readonly estimator: AssetCostEstimator;
}

export class ResolveAssetDemandUseCase {
  readonly #repository: AssetRepository;
  readonly #estimator: AssetCostEstimator;

  constructor(deps: ResolveAssetDemandDeps) {
    this.#repository = deps.repository;
    this.#estimator = deps.estimator;
  }

  async execute(input: ResolveAssetDemandInput): Promise<Result<AssetDemandPlan>> {
    // Collapse by key first. Two shots asking for the same oak tree are one generation,
    // and a plan that lists it twice would quote twice the money for one file.
    const byKey = new Map<AssetKey, AssetSpec>();
    for (const spec of input.specs) {
      const context =
        input.variantKey === undefined
          ? { styleChecksum: input.styleChecksum }
          : { styleChecksum: input.styleChecksum, variantKey: input.variantKey };
      const { key } = deriveAssetKey(spec, context);
      if (!byKey.has(key)) byKey.set(key, spec);
    }

    const existing = await this.#repository.findManyByKeys([...byKey.keys()]);
    if (isErr(existing)) return existing;

    const budget = input.budgetNanoUsd;
    const resolutions: AssetResolution[] = [];
    let hitCount = 0;
    let missCount = 0;
    let total = 0;

    for (const [key, spec] of byKey) {
      const asset = existing.value.get(key);

      if (asset !== undefined) {
        hitCount += 1;
        resolutions.push({
          key,
          spec,
          outcome: 'cache-hit',
          existingAssetId: asset.id,
          existingVersionId: asset.currentVersionId,
          styleBibleId: input.styleBibleId,
          estimatedCostNanoUsd: ZERO_USD,
          reason: `Already in the library as ${asset.semanticKey}; costs nothing to reuse.`,
        });
        continue;
      }

      const estimate = this.#estimator.estimateNanoUsd(spec);

      if (budget !== undefined && total + estimate > budget) {
        resolutions.push({
          key,
          spec,
          outcome: 'blocked-by-budget',
          styleBibleId: input.styleBibleId,
          estimatedCostNanoUsd: estimate,
          reason: `Would take the plan past the ${String(budget)} nano-USD budget; not included in the total.`,
        });
        continue;
      }

      missCount += 1;
      total += estimate;
      resolutions.push({
        key,
        spec,
        outcome: 'miss',
        styleBibleId: input.styleBibleId,
        estimatedCostNanoUsd: estimate,
        reason: 'Not in the library for this style; must be generated.',
      });
    }

    const threshold = input.confirmationThresholdNanoUsd ?? ZERO_USD;
    return ok({
      resolutions,
      hitCount,
      missCount,
      totalEstimatedNanoUsd: nanoUsd(total),
      requiresConfirmation: total > threshold,
    });
  }
}
