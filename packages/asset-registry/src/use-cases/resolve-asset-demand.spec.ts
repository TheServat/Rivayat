import { InternalError, nanoUsd } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import {
  STYLE_CHECKSUM_A,
  STYLE_CHECKSUM_B,
  assetSpec,
  asset as buildAsset,
  testIds,
} from '../__fixtures__/builders';
import { FakeAssetRepository } from '../__fixtures__/fakes';
import { deriveAssetKey } from '../asset-key';
import { FlatRateAssetCostEstimator } from '../cost/flat-rate-estimator';
import { ResolveAssetDemandUseCase } from './resolve-asset-demand';

function setup(): { repository: FakeAssetRepository; useCase: ResolveAssetDemandUseCase } {
  const repository = new FakeAssetRepository();
  return {
    repository,
    useCase: new ResolveAssetDemandUseCase({
      repository,
      estimator: new FlatRateAssetCostEstimator(),
    }),
  };
}

const STYLE_BIBLE_ID = testIds().styleBible();

describe('ResolveAssetDemandUseCase', () => {
  it('reports a miss for a spec the library has never seen, and never writes', async () => {
    const { repository, useCase } = setup();

    const result = await useCase.execute({
      specs: [assetSpec()],
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.missCount).toBe(1);
    expect(result.value.hitCount).toBe(0);
    expect(result.value.totalEstimatedNanoUsd).toBeGreaterThan(0);
    expect(repository.wrote).toBe(false);
  });

  it('reports a hit at zero cost once the asset exists', async () => {
    const { repository, useCase } = setup();
    const ids = testIds();
    const spec = assetSpec();
    const { key } = deriveAssetKey(spec, { styleChecksum: STYLE_CHECKSUM_A });
    const stored = buildAsset(ids, { key });
    repository.seed(stored);

    const result = await useCase.execute({
      specs: [spec],
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [resolution] = result.value.resolutions;
    expect(resolution?.outcome).toBe('cache-hit');
    expect(resolution?.estimatedCostNanoUsd).toBe(0);
    expect(resolution?.existingAssetId).toBe(stored.id);
    expect(resolution?.existingVersionId).toBe(stored.currentVersionId);
    expect(result.value.totalEstimatedNanoUsd).toBe(0);
    expect(result.value.requiresConfirmation).toBe(false);
    expect(repository.wrote).toBe(false);
  });

  it('misses when only the style checksum moved - a restyle forks the library', async () => {
    const { repository, useCase } = setup();
    const spec = assetSpec();
    const { key } = deriveAssetKey(spec, { styleChecksum: STYLE_CHECKSUM_A });
    repository.seed(buildAsset(testIds(), { key }));

    const result = await useCase.execute({
      specs: [spec],
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_B,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.missCount).toBe(1);
    expect(result.value.resolutions[0]?.outcome).toBe('miss');
  });

  it('collapses repeated specs, so one oak tree is quoted once', async () => {
    const { useCase } = setup();
    const spec = assetSpec();

    const result = await useCase.execute({
      specs: [spec, spec, assetSpec()],
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resolutions).toHaveLength(1);
    expect(result.value.missCount).toBe(1);
  });

  it('blocks the specs that would breach the budget instead of inflating the total', async () => {
    const { useCase } = setup();
    const one = assetSpec({ semanticKey: 'flora/oak-tree/mature' });
    const two = assetSpec({ semanticKey: 'flora/birch-tree/young' });
    const perSpec = new FlatRateAssetCostEstimator().estimateNanoUsd(one);

    const result = await useCase.execute({
      specs: [one, two],
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
      budgetNanoUsd: perSpec,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.missCount).toBe(1);
    expect(result.value.totalEstimatedNanoUsd).toBe(perSpec);
    expect(result.value.resolutions.map((resolution) => resolution.outcome)).toEqual([
      'miss',
      'blocked-by-budget',
    ]);
    // The blocked line still quotes what it would have cost, so the user can raise the
    // budget with a number in front of them.
    expect(result.value.resolutions[1]?.estimatedCostNanoUsd).toBe(perSpec);
  });

  it('asks for confirmation only above the threshold', async () => {
    const { useCase } = setup();
    const spec = assetSpec();
    const cost = new FlatRateAssetCostEstimator().estimateNanoUsd(spec);

    const under = await useCase.execute({
      specs: [spec],
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
      confirmationThresholdNanoUsd: nanoUsd(cost + 1),
    });
    const over = await useCase.execute({
      specs: [spec],
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
      confirmationThresholdNanoUsd: nanoUsd(cost - 1),
    });

    expect(under.ok && under.value.requiresConfirmation).toBe(false);
    expect(over.ok && over.value.requiresConfirmation).toBe(true);
  });

  it('keys on the variant when one is asked for', async () => {
    const { repository, useCase } = setup();
    const spec = assetSpec();
    const { key } = deriveAssetKey(spec, {
      styleChecksum: STYLE_CHECKSUM_A,
      variantKey: 'winter',
    });
    repository.seed(buildAsset(testIds(), { key }));

    const winter = await useCase.execute({
      specs: [spec],
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
      variantKey: 'winter',
    });
    const base = await useCase.execute({
      specs: [spec],
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
    });

    expect(winter.ok && winter.value.hitCount).toBe(1);
    expect(base.ok && base.value.hitCount).toBe(0);
  });

  it('propagates a repository failure rather than reporting an empty library', async () => {
    const { repository, useCase } = setup();
    repository.failWith(new InternalError({ message: 'disk on fire' }));

    const result = await useCase.execute({
      specs: [assetSpec()],
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
  });

  it('returns an empty plan for an empty demand', async () => {
    const { useCase } = setup();

    const result = await useCase.execute({
      specs: [],
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      resolutions: [],
      hitCount: 0,
      missCount: 0,
      totalEstimatedNanoUsd: 0,
      requiresConfirmation: false,
    });
  });
});
