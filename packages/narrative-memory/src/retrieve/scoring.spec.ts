import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRIEVAL_WEIGHTS, RetrievalWeights, Unit01 } from '@rv/contracts';

import { storyTime } from '../__fixtures__/builders';
import {
  IMPORTANCE_SCORE,
  ZERO_BREAKDOWN,
  importanceScore,
  proximityScore,
  recencyScore,
  similarityScore,
  weightedTotal,
} from './scoring';
import { DEFAULT_TOKEN_COUNTER, PER_FACT_OVERHEAD_TOKENS, estimateTokens } from './tokens';

const WEIGHTS = RetrievalWeights.parse(DEFAULT_RETRIEVAL_WEIGHTS);

describe('proximityScore', () => {
  it('falls off harmonically and bottoms out at nothing for an unreached entity', () => {
    expect(proximityScore(0)).toBe(1);
    expect(proximityScore(1)).toBe(0.5);
    expect(proximityScore(3)).toBeCloseTo(0.25);
    expect(proximityScore(undefined)).toBe(0);
  });
});

describe('similarityScore', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(similarityScore([1, 0, 1], [1, 0, 1])).toBeCloseTo(1);
    expect(similarityScore([1, 0], [0, 1])).toBe(0);
  });

  it('floors a negative cosine rather than mapping it into the middle of the range', () => {
    // Mapping [-1,1] onto [0,1] would hand this a free 0.5 and flatten the term.
    expect(similarityScore([1, 0], [-1, 0])).toBe(0);
  });

  it('scores a degenerate or mismatched vector 0 rather than NaN', () => {
    expect(similarityScore([], [])).toBe(0);
    expect(similarityScore([1, 2], [1])).toBe(0);
    expect(similarityScore([0, 0], [1, 1])).toBe(0);
  });
});

describe('recencyScore', () => {
  it('is 1 for a fact established at the scene and 0 for the oldest one in play', () => {
    expect(recencyScore(storyTime(100), storyTime(100), 0)).toBe(1);
    expect(recencyScore(storyTime(0), storyTime(100), 0)).toBe(0);
    expect(recencyScore(storyTime(50), storyTime(100), 0)).toBe(0.5);
  });

  it('treats an unbounded start as the oldest thing in play', () => {
    expect(recencyScore(null, storyTime(100), 0)).toBe(0);
  });

  it('scores a fact that has not happened yet at 0', () => {
    expect(recencyScore(storyTime(200), storyTime(100), 0)).toBe(0);
  });

  it('is 1 when everything sits at one ordinal, rather than dividing by zero', () => {
    expect(recencyScore(storyTime(100), storyTime(100), 100)).toBe(1);
  });
});

describe('importanceScore', () => {
  it('ranks a lead above background and gives a passing mention nothing', () => {
    expect(importanceScore('lead')).toBe(1);
    expect(importanceScore('background')).toBe(0.25);
    expect(importanceScore('mentioned')).toBe(0);
    for (const value of Object.values(IMPORTANCE_SCORE)) {
      expect(Unit01.safeParse(value).success).toBe(true);
    }
  });
});

describe('weightedTotal', () => {
  it('stays inside Unit01 even when every weight is maxed', () => {
    const maxed = RetrievalWeights.parse({
      graphProximity: 1,
      semanticSimilarity: 1,
      storyRecency: 1,
      importance: 1,
      isOpenLoop: 1,
    });
    const perfect = {
      graphProximity: 1,
      semanticSimilarity: 1,
      storyRecency: 1,
      importance: 1,
      isOpenLoop: 1,
    };
    expect(weightedTotal(perfect, maxed)).toBe(1);
    expect(Unit01.safeParse(weightedTotal(perfect, WEIGHTS)).success).toBe(true);
  });

  it('is 0, not NaN, when every weight is off', () => {
    const off = RetrievalWeights.parse({
      graphProximity: 0,
      semanticSimilarity: 0,
      storyRecency: 0,
      importance: 0,
      isOpenLoop: 0,
    });
    expect(weightedTotal({ ...ZERO_BREAKDOWN, importance: 1 }, off)).toBe(0);
  });

  it('weights each term as docs/02 §4 specifies', () => {
    expect(weightedTotal({ ...ZERO_BREAKDOWN, graphProximity: 1 }, WEIGHTS)).toBeCloseTo(0.3);
    expect(weightedTotal({ ...ZERO_BREAKDOWN, isOpenLoop: 1 }, WEIGHTS)).toBeCloseTo(0.15);
    expect(weightedTotal(ZERO_BREAKDOWN, WEIGHTS)).toBe(0);
  });
});

describe('estimateTokens', () => {
  it('counts nothing for nothing', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('runs about four Latin characters to a token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('counts non-Latin script more densely, because the vocabularies do', () => {
    // Persian is the default UI locale; a single ratio would under-count it by half.
    expect(estimateTokens('روباه')).toBeGreaterThan(estimateTokens('fox'));
  });

  it('adds the per-fact rendering overhead in the default counter', () => {
    expect(DEFAULT_TOKEN_COUNTER.count('abcd')).toBe(1 + PER_FACT_OVERHEAD_TOKENS);
  });
});
