/**
 * Speech pricing: the estimate and the invoice, proved to come from one table.
 *
 * The property worth testing is not that the arithmetic is right - it is one multiply.
 * It is that {@link quoteSpeechCall} and {@link priceSpeechCall} cannot disagree, and
 * that an unpriced voice is never rendered as a free one.
 */

import { describe, expect, it } from 'vitest';
import type { SpeechPricing } from '@rv/contracts';
import { KNOWN_SPEECH_MODELS, UNPRICED_SPEECH } from '@rv/contracts';

import { priceSpeechCall, quoteSpeechCall, speechPricingFor } from './speech-pricing';

const REF = 'elevenlabs:eleven_v3';

describe('speechPricingFor', () => {
  it('finds a voice the catalogue knows', () => {
    expect(speechPricingFor('elevenlabs', 'eleven_v3').perKCharactersUsd).toBe('0.10');
  });

  it('returns the unpriced record for a voice it has never seen, not a free one', () => {
    const pricing = speechPricingFor('elevenlabs', 'eleven_v9');
    expect(pricing).toEqual(UNPRICED_SPEECH);
    expect(pricing.free).toBe(false);
  });

  it('reads an injected catalogue rather than the shipped one', () => {
    const custom = [
      {
        ...KNOWN_SPEECH_MODELS[0],
        provider: 'higgs' as const,
        id: 'private/weights',
        pricing: { perKCharactersUsd: '9.99', free: false },
      },
    ];
    expect(
      speechPricingFor('higgs', 'private/weights', custom as typeof KNOWN_SPEECH_MODELS)
        .perKCharactersUsd,
    ).toBe('9.99');
  });
});

describe('the estimate and the invoice agree', () => {
  const paid: SpeechPricing = { perKCharactersUsd: '0.10', free: false };

  it('prices the same characters to the same number, before and after the call', () => {
    for (const characters of [1, 7, 250, 1000, 4999]) {
      const quote = quoteSpeechCall(REF, paid, characters);
      const invoice = priceSpeechCall(paid, { characters, audioMs: 3200 });
      expect(quote.kind).toBe('estimated');
      if (quote.kind === 'estimated') expect(quote.nanoUsd).toBe(invoice);
    }
  });

  it('charges $0.10 for exactly a thousand characters, as the vendor quotes it', () => {
    expect(priceSpeechCall(paid, { characters: 1000, audioMs: 0 })).toBe(100_000_000);
  });

  it('does not round a short line down to nothing', () => {
    // One character at $0.10/1K is $0.0001, which is 100_000 nano-dollars. In
    // micro-dollars it would be 100; in whole cents it would vanish, and a series of
    // ten thousand short lines would report as free.
    expect(priceSpeechCall(paid, { characters: 1, audioMs: 0 })).toBe(100_000);
  });

  it('sums exactly over many small lines', () => {
    const total = Array.from({ length: 10_000 }, () =>
      priceSpeechCall(paid, { characters: 1, audioMs: 0 }),
    ).reduce((sum, value) => sum + value, 0);
    // Ten thousand single characters is ten thousand characters is $1.00, exactly.
    expect(total).toBe(1_000_000_000);
  });
});

describe('the free and unpriced arms', () => {
  it('prices a free voice at exactly zero, with no rounding noise', () => {
    const free: SpeechPricing = { perKCharactersUsd: '0', free: true };
    expect(priceSpeechCall(free, { characters: 99_999, audioMs: 0 })).toBe(0);
    const quote = quoteSpeechCall('chatterbox:local', free, 99_999);
    expect(quote.kind).toBe('free');
    if (quote.kind === 'free') expect(quote.nanoUsd).toBe(0);
  });

  it('still records the characters on a free call, so the free lane is visible', () => {
    const quote = quoteSpeechCall('chatterbox:local', { perKCharactersUsd: '0', free: true }, 42);
    expect(quote.characters).toBe(42);
  });

  it('never reports an unpriced voice as costing zero', () => {
    const quote = quoteSpeechCall(REF, UNPRICED_SPEECH, 1000);
    expect(quote.kind).toBe('unpriced');
    expect(quote).not.toHaveProperty('nanoUsd');
  });

  it('charges nothing for an unpriced voice at invoice time, because there is no rate', () => {
    // The honest consequence of an unpriced model: the ledger cannot invent a number.
    // What stops this being a hole is the quote, which refuses to say zero beforehand.
    expect(priceSpeechCall(UNPRICED_SPEECH, { characters: 1000, audioMs: 0 })).toBe(0);
  });

  it('charges nothing for a call that sent nothing', () => {
    expect(
      priceSpeechCall({ perKCharactersUsd: '0.10', free: false }, { characters: 0, audioMs: 0 }),
    ).toBe(0);
  });

  it('carries the catalogue note into the reason, so a UI never has to invent one', () => {
    const quote = quoteSpeechCall(
      REF,
      { perKCharactersUsd: null, free: false, note: 'ask sales' },
      10,
    );
    expect(quote.kind).toBe('unpriced');
    if (quote.kind === 'unpriced') expect(quote.reason).toBe('ask sales');
  });

  it('explains a free price with the catalogue note when there is one', () => {
    const quote = quoteSpeechCall(
      'higgs:local',
      { perKCharactersUsd: '0', free: true, note: 'local inference' },
      10,
    );
    if (quote.kind === 'free') expect(quote.reason).toBe('local inference');
  });

  it('states the basis of an estimate, so a ledger row can be audited', () => {
    const quote = quoteSpeechCall(REF, { perKCharactersUsd: '0.10', free: false }, 250);
    if (quote.kind === 'estimated') expect(quote.basis).toContain('250 characters');
  });
});
