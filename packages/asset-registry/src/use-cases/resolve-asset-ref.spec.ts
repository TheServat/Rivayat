import { InternalError } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import {
  asset as buildAsset,
  assetVersion,
  testIds,
  variant as buildVariant,
} from '../__fixtures__/builders';
import { FakeAssetRepository } from '../__fixtures__/fakes';
import { ResolveAssetRefUseCase } from './resolve-asset-ref';

const BEFORE_E06 = { from: null, until: { ordinal: 60 } };
const FROM_E06 = { from: { ordinal: 60 }, until: null };

describe('ResolveAssetRefUseCase', () => {
  it('serves the current version when the ref pins nothing', async () => {
    const ids = testIds();
    const repository = new FakeAssetRepository();
    const asset = buildAsset(ids);
    repository.seed(asset);
    const useCase = new ResolveAssetRefUseCase({ repository });

    const result = await useCase.execute({ ref: { assetId: asset.id } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version.id).toBe(asset.currentVersionId);
    expect(result.value.variant).toBeNull();
    expect(result.value.parts).toEqual(result.value.version.parts);
  });

  it('serves a pinned version even when a newer one is current', async () => {
    const ids = testIds();
    const base = buildAsset(ids);
    const second = assetVersion(ids, base.id, 2);
    const asset = { ...base, versions: [...base.versions, second], currentVersionId: second.id };
    const repository = new FakeAssetRepository();
    repository.seed(asset);
    const useCase = new ResolveAssetRefUseCase({ repository });

    const pinned = await useCase.execute({
      ref: { assetId: asset.id, versionId: base.versions[0]?.id ?? second.id },
    });

    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.value.version.ordinal).toBe(1);
  });

  it('reports a missing asset rather than an empty answer', async () => {
    const repository = new FakeAssetRepository();
    const useCase = new ResolveAssetRefUseCase({ repository });

    const result = await useCase.execute({ ref: { assetId: testIds().asset() } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });

  it('reports a pinned version that does not exist', async () => {
    const ids = testIds();
    const asset = buildAsset(ids);
    const repository = new FakeAssetRepository();
    repository.seed(asset);
    const useCase = new ResolveAssetRefUseCase({ repository });

    const result = await useCase.execute({
      ref: { assetId: asset.id, versionId: testIds(1_900_000_000_000).assetVersion() },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-found');
  });

  it('applies the variant to the parts it replaces and leaves the rest alone', async () => {
    const ids = testIds();
    const base = buildAsset(ids);
    const scarred = buildVariant(ids, 'scarred');
    const asset = {
      ...base,
      versions: base.versions.map((version) => ({ ...version, variants: [scarred] })),
    };
    const repository = new FakeAssetRepository();
    repository.seed(asset);
    const useCase = new ResolveAssetRefUseCase({ repository });

    const result = await useCase.execute({ ref: { assetId: asset.id, variantKey: 'scarred' } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const canopy = result.value.parts.find((part) => part.name === 'canopy');
    const trunk = result.value.parts.find((part) => part.name === 'trunk');
    expect(canopy?.imageHash).toBe(scarred.replacedParts.canopy);
    // Untouched parts are reused byte-for-byte; that is what makes a variant cheap.
    expect(trunk?.imageHash).toBe(
      result.value.version.parts.find((part) => part.name === 'trunk')?.imageHash,
    );
  });

  it('serves the pre-E06 variant before E06 and the post-E06 variant after', async () => {
    const ids = testIds();
    const base = buildAsset(ids);
    const intact = buildVariant(ids, 'eye', BEFORE_E06);
    const scarred = buildVariant(ids, 'eye', FROM_E06);
    const asset = {
      ...base,
      versions: base.versions.map((version) => ({ ...version, variants: [intact, scarred] })),
    };
    const repository = new FakeAssetRepository();
    repository.seed(asset);
    const useCase = new ResolveAssetRefUseCase({ repository });

    const early = await useCase.execute({
      ref: { assetId: asset.id, variantKey: 'eye' },
      at: { ordinal: 50 },
    });
    // Half-open: the variant that runs *until* 60 is not the one to draw at 60.
    const boundary = await useCase.execute({
      ref: { assetId: asset.id, variantKey: 'eye' },
      at: { ordinal: 60 },
    });
    const late = await useCase.execute({
      ref: { assetId: asset.id, variantKey: 'eye' },
      at: { ordinal: 90 },
    });

    expect(early.ok && early.value.variant?.id).toBe(intact.id);
    expect(boundary.ok && boundary.value.variant?.id).toBe(scarred.id);
    expect(late.ok && late.value.variant?.id).toBe(scarred.id);
  });

  it('prefers the latest applicable start when several variants overlap', async () => {
    const ids = testIds();
    const base = buildAsset(ids);
    const unbounded = buildVariant(ids, 'eye', { from: null, until: null });
    const later = buildVariant(ids, 'eye', { from: { ordinal: 40 }, until: null });
    const asset = {
      ...base,
      versions: base.versions.map((version) => ({ ...version, variants: [unbounded, later] })),
    };
    const repository = new FakeAssetRepository();
    repository.seed(asset);
    const useCase = new ResolveAssetRefUseCase({ repository });

    const before = await useCase.execute({
      ref: { assetId: asset.id, variantKey: 'eye' },
      at: { ordinal: 10 },
    });
    const after = await useCase.execute({
      ref: { assetId: asset.id, variantKey: 'eye' },
      at: { ordinal: 80 },
    });

    expect(before.ok && before.value.variant?.id).toBe(unbounded.id);
    expect(after.ok && after.value.variant?.id).toBe(later.id);
  });

  it('reports an unknown variant key with the keys that do exist', async () => {
    const ids = testIds();
    const asset = buildAsset(ids);
    const repository = new FakeAssetRepository();
    repository.seed(asset);
    const useCase = new ResolveAssetRefUseCase({ repository });

    const result = await useCase.execute({ ref: { assetId: asset.id, variantKey: 'winter' } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context).toMatchObject({ resource: 'AssetVariant', id: 'winter' });
  });

  it('reports a variant that exists but is not valid at the requested story time', async () => {
    const ids = testIds();
    const base = buildAsset(ids);
    const scarred = buildVariant(ids, 'eye', FROM_E06);
    const asset = {
      ...base,
      versions: base.versions.map((version) => ({ ...version, variants: [scarred] })),
    };
    const repository = new FakeAssetRepository();
    repository.seed(asset);
    const useCase = new ResolveAssetRefUseCase({ repository });

    const result = await useCase.execute({
      ref: { assetId: asset.id, variantKey: 'eye' },
      at: { ordinal: 10 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The story time is part of the identity of the failure: "eye" exists, "eye@10"
    // does not.
    expect(result.error.context).toMatchObject({ resource: 'AssetVariant', id: 'eye@10' });
  });

  it('propagates a repository failure', async () => {
    const repository = new FakeAssetRepository();
    const asset = buildAsset(testIds());
    repository.seed(asset);
    repository.failWith(new InternalError({ message: 'index unreadable' }));
    const useCase = new ResolveAssetRefUseCase({ repository });

    expect((await useCase.execute({ ref: { assetId: asset.id } })).ok).toBe(false);
  });
});
