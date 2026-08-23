/**
 * Money, in nano-dollars.
 *
 * Provider prices are quoted per million tokens, so a single token can cost
 * $0.00000025. Two things follow:
 *
 *  1. Accumulating thousands of those in IEEE-754 doubles drifts, and a cost ledger
 *     that drifts is worse than none - the budget guard would eventually refuse a
 *     cheap call or wave through an expensive one. So the ledger is integers.
 *  2. The integer unit has to be *smaller than the smallest real price*. Micro-dollars
 *     (1e-6) are not: $0.00000025 rounds to zero, and a ledger that rounds per-call
 *     costs to zero reports $0.00 for a run that actually cost money. Nano-dollars
 *     (1e-9) sit two orders of magnitude below the cheapest quoted rate.
 *
 * `Number.MAX_SAFE_INTEGER` nano-dollars is about $9,007,199 - far beyond any run.
 *
 * Floats appear only at the boundaries: parsing a price string, and formatting.
 */

import type { Brand } from './brand';
import { ValidationError } from './errors';

/** Integer nano-dollars. 1_000_000_000 = $1.00. */
export type NanoUsd = Brand<number, 'NanoUsd'>;

const NANOS_PER_USD = 1_000_000_000;

export const ZERO_USD = 0 as NanoUsd;

export function nanoUsd(value: number): NanoUsd {
  if (!Number.isFinite(value)) {
    throw new ValidationError({ message: `Not a finite amount: ${String(value)}` });
  }
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new ValidationError({ message: `Amount exceeds safe integer range: ${String(value)}` });
  }
  return Math.round(value) as NanoUsd;
}

export function fromUsd(usd: number): NanoUsd {
  return nanoUsd(usd * NANOS_PER_USD);
}

export function toUsd(value: NanoUsd): number {
  return value / NANOS_PER_USD;
}

export function addUsd(a: NanoUsd, b: NanoUsd): NanoUsd {
  return (a + b) as NanoUsd;
}

export function subUsd(a: NanoUsd, b: NanoUsd): NanoUsd {
  return (a - b) as NanoUsd;
}

export function sumUsd(values: Iterable<NanoUsd>): NanoUsd {
  let total = 0;
  for (const value of values) total += value;
  return total as NanoUsd;
}

/** Scale by a count - e.g. price-per-token times tokens used. Rounds to whole nanos. */
export function scaleUsd(value: NanoUsd, factor: number): NanoUsd {
  return nanoUsd(value * factor);
}

export function compareUsd(a: NanoUsd, b: NanoUsd): number {
  return a - b;
}

export function maxUsd(a: NanoUsd, b: NanoUsd): NanoUsd {
  return a >= b ? a : b;
}

/**
 * Converts a provider's "dollars per unit" price into nano-dollars for `units`.
 *
 * The multiplication happens in floating point exactly once, then rounds - so
 * precision is lost at the nano-dollar boundary rather than accumulating across the
 * ledger.
 *
 * @example priceFor('0.00000025', 1_320_000) // Gemini Flash Lite input, 1.32M tokens
 * @example priceFor('0.00003', 1_290)        // one ~1K Gemini image (~1290 tokens)
 */
export function priceFor(dollarsPerUnit: string | number, units: number): NanoUsd {
  const rate =
    typeof dollarsPerUnit === 'string' ? Number.parseFloat(dollarsPerUnit) : dollarsPerUnit;
  if (!Number.isFinite(rate)) {
    throw new ValidationError({ message: `Unparseable price: ${String(dollarsPerUnit)}` });
  }
  return nanoUsd(rate * units * NANOS_PER_USD);
}

/**
 * Human-readable, with enough decimals to stay meaningful.
 *
 * A fixed 2 decimals would render every per-call cost as "$0.00", which is exactly how
 * a per-image bill goes unnoticed until it lands. The precision scales with magnitude.
 */
export function formatUsd(value: NanoUsd): string {
  if (value === 0) return '$0.00';
  const usd = toUsd(value);
  const abs = Math.abs(usd);
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : 9;
  return `$${usd.toFixed(decimals)}`;
}
