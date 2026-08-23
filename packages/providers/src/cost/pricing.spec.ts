import { describe, expect, it } from 'vitest';
import { KNOWN_MODELS, type Pricing } from '@rv/contracts';
import { formatUsd, sumUsd, type NanoUsd } from '@rv/shared-kernel';

import type { ProviderUsage } from '../ports/common';
import {
  IMAGE_OUTPUT_TOKENS_PER_1K_IMAGE,
  UNPRICED,
  estimateImageOutputTokens,
  findModelDescriptor,
  priceCall,
  pricingFor,
} from './pricing';

function consumed(parts: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    images: { count: 0, resolution: null },
    latencyMs: 0,
    ...parts,
  };
}

describe('priceCall', () => {
  it('prices a ~1K Gemini image at $30/1M image-output tokens to $0.0387', () => {
    // Research §2: $30 per 1M image-output tokens, ~1290 tokens for a 1024px image.
    // This is the number the whole cost model is anchored on, so it is asserted
    // exactly rather than approximately.
    const pricing = pricingFor('openrouter', 'google/gemini-2.5-flash-image');
    const cost = priceCall(
      pricing,
      consumed({
        imageOutputTokens: 1290,
        images: { count: 1, resolution: { width: 1024, height: 1024 } },
      }),
    );

    expect(cost).toBe(38_700_000);
    expect(formatUsd(cost)).toBe('$0.0387');
  });

  it('estimates the image-token count when the provider did not report one', () => {
    const pricing = pricingFor('openrouter', 'google/gemini-2.5-flash-image');
    const cost = priceCall(
      pricing,
      consumed({ images: { count: 1, resolution: { width: 1024, height: 1024 } } }),
    );
    expect(cost).toBe(38_700_000);
  });

  it('scales the estimate with pixel area', () => {
    expect(estimateImageOutputTokens({ width: 512, height: 512 })).toBe(
      Math.round(IMAGE_OUTPUT_TOKENS_PER_1K_IMAGE / 4),
    );
    expect(estimateImageOutputTokens(null)).toBe(IMAGE_OUTPUT_TOKENS_PER_1K_IMAGE);
    expect(estimateImageOutputTokens({ width: 1024, height: 1024 }, 3)).toBe(
      IMAGE_OUTPUT_TOKENS_PER_1K_IMAGE * 3,
    );
    expect(estimateImageOutputTokens({ width: 1024, height: 1024 }, 0)).toBe(0);
  });

  it('sums ten thousand $0.0000003 calls to exactly $0.003 with no float drift', () => {
    // $0.30 per 1M tokens, one token per call -> 300 nano-dollars.
    const pricing: Pricing = {
      inputPerMTokensUsd: '0.3',
      outputPerMTokensUsd: null,
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: false,
    };

    const one = priceCall(
      pricing,
      consumed({ tokens: { input: 1, output: 0, cached: 0, reasoning: 0 } }),
    );
    expect(one).toBe(300);

    const total = sumUsd(Array.from({ length: 10_000 }, () => one));
    // Integer nano-dollars: exact equality, not `toBeCloseTo`. A float ledger would
    // land at 2999999.9999996 here and the budget guard would inherit the error.
    expect(total).toBe(3_000_000);
    expect(formatUsd(total)).toBe('$0.003000');
  });

  it('charges nothing at all for a free model', () => {
    const pricing = pricingFor('ollama', 'qwen3.5:latest');
    expect(pricing.free).toBe(true);
    expect(
      priceCall(
        pricing,
        consumed({ tokens: { input: 5_000, output: 5_000, cached: 0, reasoning: 0 } }),
      ),
    ).toBe(0);
  });

  it('adds input and output token charges', () => {
    const pricing: Pricing = {
      inputPerMTokensUsd: '1',
      outputPerMTokensUsd: '2',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: false,
    };
    const cost = priceCall(
      pricing,
      consumed({ tokens: { input: 1_000_000, output: 500_000, cached: 0, reasoning: 0 } }),
    );
    expect(cost).toBe(2_000_000_000);
  });

  it('charges nothing when the model has no published rate', () => {
    expect(
      priceCall(
        UNPRICED,
        consumed({ tokens: { input: 100, output: 100, cached: 0, reasoning: 0 } }),
      ),
    ).toBe(0);
  });
});

describe('pricingFor', () => {
  it('finds a catalogue entry by provider and model', () => {
    expect(findModelDescriptor('ollama', 'qwen3.5:latest')?.label).toBe('Qwen 3.5 (local)');
  });

  it('falls back to UNPRICED for a model we have never seen', () => {
    // "Not published" and "free" are different answers; conflating them is how a bill
    // goes unnoticed, so an unknown model must not resolve to a free price list.
    const pricing = pricingFor('openrouter', 'someone/brand-new-model');
    expect(pricing).toBe(UNPRICED);
    expect(pricing.free).toBe(false);
  });

  it('honours a supplied catalogue over the seed table', () => {
    expect(findModelDescriptor('ollama', 'qwen3.5:latest', [])).toBeUndefined();
  });
});

describe('the catalogue itself', () => {
  it('prices every image model in research §2 to its documented per-image figure', () => {
    // Table-driven so that a change to `KNOWN_MODELS` that breaks the documented
    // price fails here rather than on an invoice.
    const documented = KNOWN_MODELS.filter(
      (model) => model.pricing.approxPerImageUsd !== null && !model.pricing.free,
    );
    expect(documented.length).toBeGreaterThan(0);

    for (const model of documented) {
      const expected = Math.round(Number.parseFloat(model.pricing.approxPerImageUsd ?? '0') * 1e9);
      const rate = Number.parseFloat(model.pricing.imageOutputPerMTokensUsd ?? '0');
      // The documented per-image figure divided by the rate is the token count the
      // vendor billed; it must land within a token or two of our 1K constant.
      const impliedTokens = (expected / 1e9 / rate) * 1_000_000;
      expect(impliedTokens).toBeGreaterThan(1_000);
      expect(impliedTokens).toBeLessThan(1_400);
    }
  });

  it('never prices an Ollama or ComfyUI call above zero', () => {
    const local = KNOWN_MODELS.filter(
      (model) => model.provider === 'ollama' || model.provider === 'comfyui',
    );
    for (const model of local) {
      const cost: NanoUsd = priceCall(
        model.pricing,
        consumed({
          tokens: { input: 100_000, output: 100_000, cached: 0, reasoning: 0 },
          images: { count: 4, resolution: { width: 768, height: 768 } },
        }),
      );
      expect(cost).toBe(0);
    }
  });
});
