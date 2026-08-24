/**
 * Turning characters into nano-dollars.
 *
 * The speech twin of `pricing.ts`, kept beside it and sharing its two rules. Rates are
 * quoted per **thousand** characters because that is how ElevenLabs quotes them, the
 * conversion to a per-character rate happens here and only here, and the multiply goes
 * through `priceFor` so error cannot accumulate across a ledger of a thousand lines.
 *
 * The important property is that {@link quoteSpeechCall} and {@link priceSpeechCall}
 * read the *same* `SpeechPricing` record. An adapter that built its own estimate would
 * be free to be optimistic and nothing would ever compare the two - which is the failure
 * `quoteImage` was added to close for images, restated for a unit that is easier to
 * miscount because the adapter itself writes some of the characters.
 */

import {
  KNOWN_SPEECH_MODELS,
  type ModelRef,
  type ProviderKind,
  type SpeechModelDescriptor,
  type SpeechPricing,
  type SpeechUsage,
  UNPRICED_SPEECH,
  findSpeechModel,
} from '@rv/contracts';
import { ZERO_USD, type NanoUsd, nanoUsd, priceFor } from '@rv/shared-kernel';

import type { SpeechCostQuote } from '../ports/speech-synthesis';

/** The catalogue's price list for a voice model, or `UNPRICED_SPEECH` when unknown. */
export function speechPricingFor(
  provider: ProviderKind,
  model: string,
  catalogue: readonly SpeechModelDescriptor[] = KNOWN_SPEECH_MODELS,
): SpeechPricing {
  return findSpeechModel(provider, model, catalogue)?.pricing ?? UNPRICED_SPEECH;
}

/** Converts a "per 1K characters" rate string to a per-character rate. */
function perCharacter(ratePerThousand: string): number {
  return Number.parseFloat(ratePerThousand) / 1000;
}

/**
 * Prices one synthesis call.
 *
 * `free: true` short-circuits to exactly zero rather than multiplying by a zero rate, so
 * a local Chatterbox or Higgs call is `0` and never a nano of rounding noise - the same
 * reason `priceCall` does it.
 */
export function priceSpeechCall(pricing: SpeechPricing, consumed: SpeechUsage): NanoUsd {
  if (pricing.free) return ZERO_USD;
  if (pricing.perKCharactersUsd === null || consumed.characters <= 0) return ZERO_USD;
  return nanoUsd(priceFor(perCharacter(pricing.perKCharactersUsd), consumed.characters));
}

/**
 * The pre-call twin of {@link priceSpeechCall}.
 *
 * `characters` is supplied by the adapter and is the length of the string it is *about
 * to send*, tags included. That is the whole reason the quote lives on the port rather
 * than on the caller: only the adapter knows how many characters its own dialect adds.
 */
export function quoteSpeechCall(
  ref: ModelRef,
  pricing: SpeechPricing,
  characters: number,
): SpeechCostQuote {
  if (pricing.free) {
    return {
      kind: 'free',
      modelRef: ref,
      nanoUsd: ZERO_USD,
      reason: pricing.note ?? 'the catalogue lists this voice as free',
      characters,
    };
  }

  if (pricing.perKCharactersUsd === null) {
    return {
      kind: 'unpriced',
      modelRef: ref,
      reason: pricing.note ?? 'the catalogue has no character rate for this voice',
      characters,
    };
  }

  return {
    kind: 'estimated',
    modelRef: ref,
    nanoUsd: nanoUsd(priceFor(perCharacter(pricing.perKCharactersUsd), characters)),
    basis: `${String(characters)} characters at $${pricing.perKCharactersUsd}/1K`,
    characters,
  };
}
