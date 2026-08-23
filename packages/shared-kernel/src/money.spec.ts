import { describe, expect, it } from 'vitest';

import { ValidationError } from './errors';
import {
  ZERO_USD,
  addUsd,
  compareUsd,
  formatUsd,
  fromUsd,
  maxUsd,
  nanoUsd,
  priceFor,
  scaleUsd,
  subUsd,
  sumUsd,
  toUsd,
} from './money';

describe('conversion', () => {
  it('round-trips whole dollars', () => {
    expect(toUsd(fromUsd(1.5))).toBe(1.5);
  });

  it('stores nano-dollars as integers', () => {
    expect(fromUsd(1)).toBe(1_000_000_000);
    expect(nanoUsd(2.6)).toBe(3);
  });

  it('represents the cheapest quoted per-token rate without rounding to zero', () => {
    // $0.00000025/token is Gemini 3.1 Flash Lite input. In micro-dollars this would
    // be 0.25 -> rounds to 0, and the whole ledger silently reports nothing.
    expect(fromUsd(0.00000025)).toBe(250);
  });

  it('rejects a non-finite amount', () => {
    expect(() => nanoUsd(Number.NaN)).toThrow(ValidationError);
    expect(() => nanoUsd(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
  });

  it('rejects an amount beyond the safe integer range', () => {
    expect(() => fromUsd(1e12)).toThrow(/safe integer range/);
  });
});

describe('arithmetic', () => {
  it('adds without drift over many tiny amounts', () => {
    // 10_000 single tokens at $0.0000003 each = $0.003, exactly.
    const each = priceFor('0.0000003', 1);
    expect(each).toBe(300);

    let total = ZERO_USD;
    for (let i = 0; i < 10_000; i += 1) total = addUsd(total, each);
    expect(toUsd(total)).toBe(0.003);
  });

  it('subtracts', () => {
    expect(subUsd(fromUsd(1), fromUsd(0.25))).toBe(fromUsd(0.75));
  });

  it('sums an iterable', () => {
    expect(sumUsd([fromUsd(1), fromUsd(2), fromUsd(0.5)])).toBe(fromUsd(3.5));
    expect(sumUsd([])).toBe(0);
  });

  it('scales by a factor', () => {
    expect(scaleUsd(fromUsd(0.01), 3)).toBe(fromUsd(0.03));
  });

  it('compares and sorts', () => {
    expect(compareUsd(fromUsd(1), fromUsd(2))).toBeLessThan(0);
    expect(compareUsd(fromUsd(2), fromUsd(1))).toBeGreaterThan(0);
    expect(compareUsd(fromUsd(1), fromUsd(1))).toBe(0);
    expect([fromUsd(3), fromUsd(1), fromUsd(2)].sort(compareUsd)).toEqual([
      fromUsd(1),
      fromUsd(2),
      fromUsd(3),
    ]);
  });

  it('takes a maximum', () => {
    expect(maxUsd(fromUsd(1), fromUsd(2))).toBe(fromUsd(2));
    expect(maxUsd(fromUsd(2), fromUsd(1))).toBe(fromUsd(2));
  });
});

describe('priceFor - real provider rate cards', () => {
  it('prices Gemini 3.1 Flash Lite input at its published rate', () => {
    // $0.25 / 1M input tokens, 1.32M tokens -> $0.33
    expect(toUsd(priceFor('0.00000025', 1_320_000))).toBeCloseTo(0.33, 9);
  });

  it('prices one ~1K Gemini image at the published ~$0.039', () => {
    // $30 / 1M image-output tokens; a 1K image is ~1290 tokens.
    expect(toUsd(priceFor('0.00003', 1_290))).toBeCloseTo(0.0387, 6);
  });

  it('prices a whole 60-second short in the range the architecture claims', () => {
    // ~80 unique assets on the cheapest good image model.
    const perImage = priceFor('0.00003', 1_290);
    expect(toUsd(scaleUsd(perImage, 80))).toBeCloseTo(3.096, 3);
  });

  it('accepts a numeric rate as well as the string the API returns', () => {
    expect(priceFor(0.00003, 1000)).toBe(priceFor('0.00003', 1000));
  });

  it('rejects an unparseable rate rather than silently pricing at zero', () => {
    expect(() => priceFor('free', 1000)).toThrow(ValidationError);
  });
});

describe('formatUsd - small amounts must stay visible', () => {
  it.each([
    [fromUsd(0), '$0.00'],
    [fromUsd(12.5), '$12.50'],
    [fromUsd(1), '$1.00'],
    [fromUsd(0.0336), '$0.0336'],
    [fromUsd(0.000123), '$0.000123'],
    [fromUsd(0.0000003), '$0.000000300'],
    [fromUsd(-2.5), '$-2.50'],
  ])('%i -> %s', (value, expected) => {
    expect(formatUsd(value)).toBe(expected);
  });

  it('never collapses a real per-call cost to $0.00', () => {
    for (const usd of [0.0000305, 0.00000025, 0.0039]) {
      expect(formatUsd(fromUsd(usd))).not.toBe('$0.00');
    }
  });
});
