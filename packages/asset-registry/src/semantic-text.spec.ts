import { describe, expect, it } from 'vitest';

import { assetEmbeddingText, cosineSimilarity } from './semantic-text';

describe('assetEmbeddingText', () => {
  it('joins semantic key, description and tags', () => {
    expect(
      assetEmbeddingText({
        semanticKey: 'flora/oak-tree/mature',
        description: 'An old, gnarled oak.',
        tags: ['tree', 'forest'],
      }),
    ).toBe('flora/oak-tree/mature\nAn old, gnarled oak.\nforest, tree');
  });

  it('is stable under tag reordering and duplication', () => {
    const first = assetEmbeddingText({
      semanticKey: 'flora/oak-tree/mature',
      description: 'An oak.',
      tags: ['tree', 'forest'],
    });
    const second = assetEmbeddingText({
      semanticKey: 'flora/oak-tree/mature',
      description: 'An oak.',
      tags: ['forest', 'tree', 'forest'],
    });

    // Otherwise re-indexing after a cosmetic tag edit would move the vector and quietly
    // break the "same query, same index revision, same ranking" guarantee.
    expect(second).toBe(first);
  });

  it('omits empty segments rather than leaving a blank line', () => {
    expect(
      assetEmbeddingText({
        semanticKey: 'prop/lantern/rusted',
        description: 'A lantern.',
        tags: [],
      }),
    ).toBe('prop/lantern/rusted\nA lantern.');
  });
});

describe('cosineSimilarity', () => {
  it('scores an identical vector as 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
  });

  it('scores an orthogonal vector as 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('scores an opposed vector as -1', () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 12);
  });

  it.each([
    ['empty', [] as number[], [] as number[]],
    ['mismatched lengths', [1, 2, 3], [1, 2]],
    ['a zero vector', [0, 0, 0], [1, 2, 3]],
  ])('returns 0 rather than NaN for %s', (_case, left, right) => {
    // A degenerate or unindexed asset must rank last, not poison the sort.
    expect(cosineSimilarity(left, right)).toBe(0);
  });

  it('stays inside [-1, 1] despite floating point drift', () => {
    const value = cosineSimilarity([1e-160, 1e-160], [1e-160, 1e-160]);
    expect(value).toBeLessThanOrEqual(1);
    expect(value).toBeGreaterThanOrEqual(-1);
  });
});
