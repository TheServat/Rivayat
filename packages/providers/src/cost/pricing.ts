/**
 * Turning "what a call consumed" into nano-dollars.
 *
 * Every rate in `@rv/contracts` is quoted per **million** units, because that is how
 * the vendor pages quote them and a table that no longer reads like its source is how
 * a transcription error survives review. The conversion to a per-unit rate therefore
 * happens here, once, immediately before `priceFor` - which does the float multiply
 * exactly once and rounds to whole nanos, so error cannot accumulate across a ledger.
 *
 * Nothing in here reads a clock or a network. It is pure, and it is the only place
 * that knows how a provider's price list maps onto a `ProviderUsage`.
 */

import {
  KNOWN_MODELS,
  type ModelDescriptor,
  type Pricing,
  type ProviderKind,
  type Size,
} from '@rv/contracts';
import { ZERO_USD, type NanoUsd, nanoUsd, priceFor } from '@rv/shared-kernel';

import type { ProviderUsage } from '../ports/common';

/**
 * Image-output tokens billed for one ~1024px image.
 *
 * Not a guess: it is the worked example in `@rv/shared-kernel/money`
 * (`priceFor('0.00003', 1_290)`), and it reproduces research §2's $0.0387 for a 1K
 * image at $30 per 1M image-output tokens. Providers do not publish a formula, so an
 * adapter that learns the real count from `usageMetadata` should pass it instead of
 * this constant - it is a floor, not a truth.
 */
export const IMAGE_OUTPUT_TOKENS_PER_1K_IMAGE = 1290;

/** Pixels in the reference image the constant above was measured at. */
const REFERENCE_PIXELS = 1024 * 1024;

/**
 * Scales the reference token count by area.
 *
 * Linear in pixels because that is how every published price range behaves
 * (research §2: Gemini 3.1 Flash Image runs $0.045 at 0.5K to $0.151 at 4K), and
 * because a superlinear guess would make the budget guard refuse work it should allow.
 */
export function estimateImageOutputTokens(size: Size | null, count = 1): number {
  if (count <= 0) return 0;
  const pixels = size === null ? REFERENCE_PIXELS : size.width * size.height;
  return Math.round((pixels / REFERENCE_PIXELS) * IMAGE_OUTPUT_TOKENS_PER_1K_IMAGE * count);
}

/** A price list for something not in the catalogue: charge nothing, and say so loudly. */
export const UNPRICED: Pricing = {
  inputPerMTokensUsd: null,
  outputPerMTokensUsd: null,
  imageOutputPerMTokensUsd: null,
  approxPerImageUsd: null,
  free: false,
  note: 'no published price',
};

export function findModelDescriptor(
  provider: ProviderKind,
  model: string,
  catalogue: readonly ModelDescriptor[] = KNOWN_MODELS,
): ModelDescriptor | undefined {
  return catalogue.find(
    (descriptor) => descriptor.provider === provider && descriptor.id === model,
  );
}

/** The catalogue's price list for a model, or `UNPRICED` when we have never seen it. */
export function pricingFor(
  provider: ProviderKind,
  model: string,
  catalogue: readonly ModelDescriptor[] = KNOWN_MODELS,
): Pricing {
  return findModelDescriptor(provider, model, catalogue)?.pricing ?? UNPRICED;
}

/** Converts a "per 1M units" rate string to a per-unit rate. */
function perUnit(ratePerMillion: string): number {
  return Number.parseFloat(ratePerMillion) / 1_000_000;
}

/**
 * Prices one call.
 *
 * `free: true` short-circuits to zero rather than summing zero rates, so a local
 * ComfyUI or Ollama call is exactly `0` and never `1` nano of rounding noise.
 */
export function priceCall(pricing: Pricing, consumed: ProviderUsage): NanoUsd {
  if (pricing.free) return ZERO_USD;

  let total = 0;

  if (pricing.inputPerMTokensUsd !== null && consumed.tokens.input > 0) {
    total += priceFor(perUnit(pricing.inputPerMTokensUsd), consumed.tokens.input);
  }
  if (pricing.outputPerMTokensUsd !== null && consumed.tokens.output > 0) {
    total += priceFor(perUnit(pricing.outputPerMTokensUsd), consumed.tokens.output);
  }

  const imageTokens =
    consumed.imageOutputTokens ??
    (consumed.images.count > 0
      ? estimateImageOutputTokens(consumed.images.resolution, consumed.images.count)
      : 0);
  if (pricing.imageOutputPerMTokensUsd !== null && imageTokens > 0) {
    total += priceFor(perUnit(pricing.imageOutputPerMTokensUsd), imageTokens);
  }

  return nanoUsd(total);
}
