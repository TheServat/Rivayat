/**
 * Refusal paths only.
 *
 * The success paths need a store that can actually assign an ordinal and fail a unique
 * index, so they live in `@rv/persistence` against real in-memory SQLite. What is
 * asserted here is the guard: that the door does not open without an intent, and that
 * a malformed intent never reaches storage.
 */

import { InternalError } from '@rv/shared-kernel';
import type { RegenerateIntent } from '@rv/contracts';
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
import { RegisterAssetVersionUseCase } from './register-asset-version';

function setup(): { repository: FakeAssetRepository; useCase: RegisterAssetVersionUseCase } {
  const repository = new FakeAssetRepository();
  return {
    repository,
    useCase: new RegisterAssetVersionUseCase({
      repository,
      ids: testIds(),
      clock: fixedClock(),
    }),
  };
}

const SPEC = assetSpec();
const STYLE_BIBLE_ID = testIds().styleBible();

function seedExisting(repository: FakeAssetRepository): void {
  const { key } = deriveAssetKey(SPEC, { styleChecksum: STYLE_CHECKSUM_A });
  repository.seed(buildAsset(testIds(), { key }));
}

describe('RegisterAssetVersionUseCase', () => {
  it('refuses a second take with no RegenerateIntent, and does not write', async () => {
    const { repository, useCase } = setup();
    seedExisting(repository);

    const result = await useCase.execute({
      spec: SPEC,
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
      version: newAssetVersion(testIds()),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('conflict');
    expect(result.error.context).toMatchObject({ semanticKey: SPEC.semanticKey });
    expect(repository.wrote).toBe(false);
  });

  it('refuses an intent that tries to make regeneration destructive', async () => {
    const { repository, useCase } = setup();
    seedExisting(repository);

    const result = await useCase.execute({
      spec: SPEC,
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
      version: newAssetVersion(testIds()),
      // `keepPrevious` is `literal(true)` in the contract; setting it false must not
      // reach storage, because storage would have no way to refuse it.
      intent: { reason: 'new-take', keepPrevious: false } as unknown as RegenerateIntent,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
    expect(repository.wrote).toBe(false);
  });

  it('propagates a lookup failure instead of creating a duplicate asset', async () => {
    const { repository, useCase } = setup();
    repository.failWith(new InternalError({ message: 'index unreadable' }));

    const result = await useCase.execute({
      spec: SPEC,
      styleBibleId: STYLE_BIBLE_ID,
      styleChecksum: STYLE_CHECKSUM_A,
      version: newAssetVersion(testIds()),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
  });
});
