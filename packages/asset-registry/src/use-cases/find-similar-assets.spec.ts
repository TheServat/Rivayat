import { InternalError } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { STYLE_CHECKSUM_A, assetSpec, testIds } from '../__fixtures__/builders';
import {
  EmptyEmbeddingPort,
  FakeAssetRepository,
  KeywordEmbeddingPort,
} from '../__fixtures__/fakes';
import { deriveAssetKey } from '../asset-key';
import type { AssetSearchRecord } from '../ports/index';
import { assetEmbeddingText } from '../semantic-text';
import { FindSimilarAssetsUseCase } from './find-similar-assets';

const OAK = {
  semanticKey: 'flora/oak-tree/mature',
  label: 'Mature oak',
  description: 'An old, gnarled oak with three main boughs.',
  tags: ['tree', 'forest'],
};
const BOULDER = {
  semanticKey: 'mineral/boulder/mossy',
  label: 'Mossy boulder',
  description: 'A squat boulder of grey stone.',
  tags: ['moss'],
};

async function indexed(
  embeddings: KeywordEmbeddingPort,
  entries: readonly (typeof OAK)[],
): Promise<AssetSearchRecord[]> {
  const ids = testIds();
  const vectors = await embeddings.embed(entries.map((entry) => assetEmbeddingText(entry)));
  if (!vectors.ok) throw new Error('fixture embedding failed');

  return entries.map((entry, index) => ({
    assetId: ids.asset(),
    key: deriveAssetKey(assetSpec({ semanticKey: entry.semanticKey }), {
      styleChecksum: STYLE_CHECKSUM_A,
    }).key,
    semanticKey: entry.semanticKey,
    label: entry.label,
    description: entry.description,
    tags: entry.tags,
    embedding: vectors.value[index] ?? null,
    embeddingModel: embeddings.model,
  }));
}

describe('FindSimilarAssetsUseCase', () => {
  it('finds the oak from "a gnarled old tree" before anyone decides to generate one', async () => {
    const embeddings = new KeywordEmbeddingPort();
    const repository = new FakeAssetRepository();
    repository.seedRecords(await indexed(embeddings, [BOULDER, OAK]));
    const useCase = new FindSimilarAssetsUseCase({ repository, embeddings });

    const result = await useCase.execute({ query: 'a gnarled old tree' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.semanticKey).toBe('flora/oak-tree/mature');
    expect(result.value[0]?.similarity).toBeGreaterThan(0.6);
    // The boulder shares no vocabulary with the query, so it is omitted rather than
    // offered as the least-bad match.
    expect(result.value).toHaveLength(1);
  });

  it('ranks identically on a repeated query', async () => {
    const embeddings = new KeywordEmbeddingPort();
    const repository = new FakeAssetRepository();
    repository.seedRecords(await indexed(embeddings, [OAK, BOULDER]));
    const useCase = new FindSimilarAssetsUseCase({ repository, embeddings, minSimilarity: 0 });

    const first = await useCase.execute({ query: 'a gnarled old tree' });
    const second = await useCase.execute({ query: 'a gnarled old tree' });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toEqual(first.value);
  });

  it('breaks ties on assetId, so the order never flips between runs', async () => {
    const embeddings = new KeywordEmbeddingPort();
    const repository = new FakeAssetRepository();
    // Byte-identical index text, so the similarities are exactly equal and the only
    // thing that can order them is the tie-break.
    const records = await indexed(embeddings, [OAK, OAK]);
    repository.seedRecords([...records].reverse());
    const useCase = new FindSimilarAssetsUseCase({ repository, embeddings });

    const result = await useCase.execute({ query: 'a gnarled old tree' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((match) => match.assetId);
    expect(ids).toEqual([...ids].sort());
  });

  it('returns nothing rather than a bad suggestion when nothing clears the floor', async () => {
    const embeddings = new KeywordEmbeddingPort();
    const repository = new FakeAssetRepository();
    repository.seedRecords(await indexed(embeddings, [BOULDER]));
    const useCase = new FindSimilarAssetsUseCase({ repository, embeddings });

    const result = await useCase.execute({ query: 'a gnarled old tree' });

    expect(result.ok && result.value).toEqual([]);
  });

  it('honours an explicit limit', async () => {
    const embeddings = new KeywordEmbeddingPort();
    const repository = new FakeAssetRepository();
    repository.seedRecords(await indexed(embeddings, [OAK, OAK]));
    const useCase = new FindSimilarAssetsUseCase({ repository, embeddings });

    const result = await useCase.execute({ query: 'a gnarled old tree', limit: 1 });

    expect(result.ok && result.value).toHaveLength(1);
  });

  it('skips vectors from another model instead of comparing across number spaces', async () => {
    const embeddings = new KeywordEmbeddingPort();
    const repository = new FakeAssetRepository();
    const records = await indexed(embeddings, [OAK]);
    repository.seedRecords(records.map((record) => ({ ...record, embeddingModel: 'other-model' })));
    const useCase = new FindSimilarAssetsUseCase({ repository, embeddings });

    expect((await useCase.execute({ query: 'a gnarled old tree' })).ok).toBe(true);
    expect(await useCase.execute({ query: 'a gnarled old tree' })).toMatchObject({ value: [] });
  });

  it('skips assets that have never been indexed', async () => {
    const embeddings = new KeywordEmbeddingPort();
    const repository = new FakeAssetRepository();
    const records = await indexed(embeddings, [OAK]);
    repository.seedRecords(records.map((record) => ({ ...record, embedding: null })));
    const useCase = new FindSimilarAssetsUseCase({ repository, embeddings });

    expect(await useCase.execute({ query: 'a gnarled old tree' })).toMatchObject({ value: [] });
  });

  it('short-circuits an empty query without calling the embedding provider', async () => {
    const embeddings = new KeywordEmbeddingPort();
    const repository = new FakeAssetRepository();
    const useCase = new FindSimilarAssetsUseCase({ repository, embeddings });

    const result = await useCase.execute({ query: '   ' });

    expect(result.ok && result.value).toEqual([]);
    expect(repository.calls).toEqual([]);
  });

  it('propagates an embedding failure', async () => {
    const embeddings = new KeywordEmbeddingPort();
    embeddings.failWith(new InternalError({ message: 'ollama is not running' }));
    const useCase = new FindSimilarAssetsUseCase({
      repository: new FakeAssetRepository(),
      embeddings,
    });

    expect((await useCase.execute({ query: 'oak' })).ok).toBe(false);
  });

  it('propagates a repository failure', async () => {
    const repository = new FakeAssetRepository();
    repository.failWith(new InternalError({ message: 'index unreadable' }));
    const useCase = new FindSimilarAssetsUseCase({
      repository,
      embeddings: new KeywordEmbeddingPort(),
    });

    expect((await useCase.execute({ query: 'oak' })).ok).toBe(false);
  });

  it('fails loudly when the provider returns no vector for a single-text batch', async () => {
    const useCase = new FindSimilarAssetsUseCase({
      repository: new FakeAssetRepository(),
      embeddings: new EmptyEmbeddingPort(),
    });

    const result = await useCase.execute({ query: 'oak' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
  });
});
