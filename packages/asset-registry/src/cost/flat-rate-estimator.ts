/**
 * A stand-in price table, so a demand plan can be produced before the router exists.
 *
 * It is deliberately crude and deliberately *pure*: one rate per quality tier, scaled
 * by the number of parts, because parts are what an image model is actually asked to
 * produce. RV-028 replaces it with the real per-model table from `@rv/providers`; the
 * `AssetCostEstimator` port is the seam, so nothing else moves when it does.
 *
 * Numbers are nano-dollars and are placeholders - they are not researched prices and
 * must not be quoted as such.
 */

import { type NanoUsd, nanoUsd } from '@rv/shared-kernel';
import type { AssetSpec, QualityTarget } from '@rv/contracts';

import type { AssetCostEstimator } from '../ports/cost-estimator';

/** Nano-USD per generated part, by quality tier. Placeholder rates. */
export const DEFAULT_PART_RATES: Readonly<Record<QualityTarget, number>> = Object.freeze({
  draft: 2_000_000,
  preview: 6_000_000,
  final: 30_000_000,
});

export class FlatRateAssetCostEstimator implements AssetCostEstimator {
  readonly #rates: Readonly<Record<QualityTarget, number>>;

  constructor(rates: Readonly<Record<QualityTarget, number>> = DEFAULT_PART_RATES) {
    this.#rates = rates;
  }

  estimateNanoUsd(spec: AssetSpec): NanoUsd {
    return nanoUsd(this.#rates[spec.quality] * spec.parts.length);
  }
}
