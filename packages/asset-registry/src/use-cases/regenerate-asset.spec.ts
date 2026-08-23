/**
 * Refusal paths only; the append itself is proven against real SQLite in
 * `@rv/persistence`, where a version can actually be read back after another is added.
 */

import { InternalError, type Result, ok } from '@rv/shared-kernel';
import type { IsoInstant, RegenerateIntent } from '@rv/contracts';
import { describe, expect, it } from 'vitest';

import {
  STYLE_CHECKSUM_A,
  assetSpec,
  asset as buildAsset,
  fixedClock,
  newAssetVersion,
  testIds,
} from '../__fixtures__/builders';
import { FakeAssetRepository } from '../__fixtures__/fakes';
import { deriveAssetKey } from '../asset-key';
import type { AppendVersionOptions, AssetVersionDraft, StoredAssetVersion } from '../ports/index';
import { RegenerateAssetUseCase } from './regenerate-asset';

const SPEC = assetSpec();
const STYLE_BIBLE_ID = testIds().styleBible();
const VALID_INTENT: RegenerateIntent = { reason: 'new-take', keepPrevious: true };

function setup(): { repository: FakeAssetRepository; useCase: RegenerateAssetUseCase } {
  const repository = new FakeAssetRepository();
  return {
    repository,
    useCase: new RegenerateAssetUseCase({ repository, ids: testIds(), clock: fixedClock() }),
  };
}

describe('RegenerateAssetUseCase', () => {
  it('refuses an intent whose keepPrevious is false, before touching the repository', async () => {
    const { repository, useCase } = setup();

    const result = await useCase.execute({
      spec: SPEC,
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
      version: newAssetVersion(testIds()),
      intent: { reason: 'new-take', keepPrevious: false } as unknown as RegenerateIntent,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
    expect(repository.calls).toEqual([]);
  });

  it('refuses an unrecognised reason', async () => {
    const { useCase } = setup();

    const result = await useCase.execute({
      spec: SPEC,
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
      version: newAssetVersion(testIds()),
      intent: { reason: 'because-i-said-so' } as unknown as RegenerateIntent,
    });

    expect(result.ok && 'unreachable').toBe(false);
  });

  it('reports not-found rather than quietly creating the asset', async () => {
    const { repository, useCase } = setup();

    const result = await useCase.execute({
      spec: SPEC,
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
      version: newAssetVersion(testIds()),
      intent: VALID_INTENT,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // "Regenerate" against a key that misses means the spec or the style moved under
    // the caller. Creating it here would hide that.
    expect(result.error.kind).toBe('not-found');
    expect(repository.wrote).toBe(false);
  });

  it('refuses to report success if the store dropped a previous version', async () => {
    // A repository that "appends" by replacing. No shipped implementation does this;
    // the guard exists because the invariant is too important to trust to review, and
    // an untested guard is a comment.
    class LossyRepository extends FakeAssetRepository {
      override appendVersion(
        draft: AssetVersionDraft,
        _options: AppendVersionOptions,
        _now: IsoInstant,
      ): Promise<Result<StoredAssetVersion>> {
        const ids = testIds();
        const replacement = { ...newAssetVersion(ids), assetId: draft.assetId, ordinal: 2 };
        const asset = {
          ...buildAsset(ids, { id: draft.assetId }),
          versions: [replacement],
          currentVersionId: replacement.id,
        };
        return Promise.resolve(ok({ asset, version: replacement }));
      }
    }

    const repository = new LossyRepository();
    const { key } = deriveAssetKey(SPEC, { styleChecksum: STYLE_CHECKSUM_A });
    repository.seed(buildAsset(testIds(), { key }));
    const useCase = new RegenerateAssetUseCase({
      repository,
      ids: testIds(),
      clock: fixedClock(),
    });

    const result = await useCase.execute({
      spec: SPEC,
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
      version: newAssetVersion(testIds()),
      intent: VALID_INTENT,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
    expect(result.error.context).toMatchObject({ assetKey: key });
  });

  it('propagates a lookup failure', async () => {
    const { repository, useCase } = setup();
    repository.failWith(new InternalError({ message: 'index unreadable' }));

    const result = await useCase.execute({
      spec: SPEC,
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
      version: newAssetVersion(testIds()),
      intent: VALID_INTENT,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
  });
});
