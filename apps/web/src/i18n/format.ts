import type { Locale } from '@rv/contracts';

import { LOCALE_TAG } from './index';

/**
 * Locale-aware formatting.
 *
 * The rule this module exists to enforce: **Persian digits are a rendering, never a
 * value.** Everything here takes a Latin-digit `number` and returns a `string` for the
 * screen. Nothing here parses a string back into a number, and nothing anywhere else
 * is allowed to either - `۱۲۳` is not `123` to `Number()`, so a round trip through a
 * localised string silently produces `NaN`, and the first place that shows up is a
 * budget ceiling that was quietly cleared.
 *
 * Numeric *input* stays ASCII (`<input type="number">`), which is what RV-203 asks for
 * and what every browser's number control gives us for free.
 */

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  // Cached because `Intl.NumberFormat` construction is the expensive half, and a
  // settings screen formats a few hundred values on every keystroke of its filter.
  const key = `${locale}:${JSON.stringify(options)}`;
  const existing = numberFormats.get(key);
  if (existing !== undefined) return existing;
  const created = new Intl.NumberFormat(LOCALE_TAG[locale], options);
  numberFormats.set(key, created);
  return created;
}

/** A count or a plain quantity: Persian digits in `fa`, Latin digits in `en`. */
export function formatNumber(
  value: number,
  locale: Locale,
  options: Intl.NumberFormatOptions = {},
): string {
  return numberFormat(locale, options).format(value);
}

/** `0.42` -> `۴۲٪` / `42%`. */
export function formatPercent(value: number, locale: Locale): string {
  return numberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value);
}

/** 1 USD, in the integer nano-dollars `@rv/contracts` measures money in. */
export const NANO_PER_USD = 1_000_000_000;

/**
 * Nano-dollars as money.
 *
 * Formatted in USD in both locales because that is the currency every provider bills
 * in; translating the *amount* would be a lie, so only the digits and the separators
 * change. Six fraction digits because a single cheap call genuinely costs
 * $0.000025 and rounding it to two makes the ledger read `$0.00` for a run that spent
 * money - the exact failure `NanoUsdAmount` exists to prevent.
 */
export function formatNanoUsd(nanoUsd: number, locale: Locale): string {
  const usd = nanoUsd / NANO_PER_USD;
  const fractionDigits = usd !== 0 && Math.abs(usd) < 0.01 ? 6 : 2;
  return numberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    // `narrowSymbol` rather than the default: `en-GB` renders USD as `US$`, which is
    // correct for a British reader and wrong for a cost column where every figure is
    // in the same currency and the prefix is noise.
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: fractionDigits,
  }).format(usd);
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * An ISO instant as a date and time.
 *
 * `fa-IR` resolves to the Persian (Solar Hijri) calendar in `Intl`, which is the
 * correct answer for a Persian user and is exactly why the raw ISO string is never
 * shown: the two are not the same date written differently, they are different
 * calendars, and only one of them is readable to the reader.
 */
export function formatInstant(iso: string, locale: Locale): string {
  const key = `${locale}:instant`;
  let formatter = dateFormats.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(LOCALE_TAG[locale], {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    dateFormats.set(key, formatter);
  }
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : formatter.format(parsed);
}
