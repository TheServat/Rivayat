import { describe, expect, it } from 'vitest';

import { assetSpec } from '../__fixtures__/builders';
import { DEFAULT_PART_RATES, FlatRateAssetCostEstimator } from './flat-rate-estimator';

const PART = { name: 'trunk', role: 'trunk', description: 'Trunk', zOrder: 0 };

describe('FlatRateAssetCostEstimator', () => {
  const estimator = new FlatRateAssetCostEstimator();

  it('scales with the number of parts, because parts are what is generated', () => {
    const one = estimator.estimateNanoUsd(assetSpec({ parts: [PART] }));
    const two = estimator.estimateNanoUsd(
      assetSpec({ parts: [PART, { ...PART, name: 'canopy', role: 'canopy', zOrder: 1 }] }),
    );

    expect(two).toBe(one * 2);
  });

  it.each(['draft', 'preview', 'final'] as const)('prices the %s tier from the table', (tier) => {
    expect(estimator.estimateNanoUsd(assetSpec({ quality: tier, parts: [PART] }))).toBe(
      DEFAULT_PART_RATES[tier],
    );
  });

  it('orders the tiers cheapest to dearest', () => {
    expect(DEFAULT_PART_RATES.draft).toBeLessThan(DEFAULT_PART_RATES.preview);
    expect(DEFAULT_PART_RATES.preview).toBeLessThan(DEFAULT_PART_RATES.final);
  });

  it('accepts a replacement table, which is how the real price list lands', () => {
    const custom = new FlatRateAssetCostEstimator({ draft: 1, preview: 2, final: 3 });
    expect(custom.estimateNanoUsd(assetSpec({ quality: 'final', parts: [PART] }))).toBe(3);
  });
});
