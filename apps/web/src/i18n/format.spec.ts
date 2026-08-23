import { describe, expect, it } from 'vitest';

import { createStudioI18n } from './index';
import { formatInstant, formatNanoUsd, formatNumber, formatPercent, NANO_PER_USD } from './format';

const PERSIAN_DIGITS = /[۰-۹]/;
const LATIN_DIGITS = /[0-9]/;

describe('number formatting', () => {
  it('renders Persian digits in fa and Latin digits in en', () => {
    expect(formatNumber(1234, 'fa')).toMatch(PERSIAN_DIGITS);
    expect(formatNumber(1234, 'fa')).not.toMatch(LATIN_DIGITS);
    expect(formatNumber(1234, 'en')).toBe('1,234');
  });

  it('never returns a value a parser could read back', () => {
    // The invariant behind RV-203: a localised number is a rendering. If this ever
    // round-tripped, someone would eventually parse a budget ceiling back out of the
    // screen and get NaN.
    expect(Number(formatNumber(42, 'fa'))).toBeNaN();
  });

  it('formats percentages in the active locale', () => {
    expect(formatPercent(0.42, 'en')).toBe('42%');
    expect(formatPercent(0.42, 'fa')).toMatch(PERSIAN_DIGITS);
  });
});

describe('money formatting', () => {
  it('renders nano-dollars as dollars', () => {
    expect(formatNanoUsd(2 * NANO_PER_USD, 'en')).toBe('$2.00');
  });

  it('does not round a sub-cent charge down to zero', () => {
    // A run of cheap calls costs fractions of a cent each. Two decimal places would
    // report `$0.00` for money that was actually spent, which is the failure
    // `NanoUsdAmount` exists to prevent.
    const rendered = formatNanoUsd(25_000, 'en');
    expect(rendered).not.toBe('$0.00');
    expect(rendered).toContain('0.000025');
  });

  it('stays in USD in Persian, changing only the digits', () => {
    const rendered = formatNanoUsd(2 * NANO_PER_USD, 'fa');
    expect(rendered).toMatch(PERSIAN_DIGITS);
  });
});

describe('instant formatting', () => {
  it('renders an ISO instant differently per locale', () => {
    const iso = '2026-08-19T14:32:00+03:30';
    expect(formatInstant(iso, 'fa')).toMatch(PERSIAN_DIGITS);
    expect(formatInstant(iso, 'en')).toMatch(LATIN_DIGITS);
  });

  it('returns the input unchanged when it is not a date', () => {
    expect(formatInstant('not-a-date', 'en')).toBe('not-a-date');
  });
});

describe('pluralisation', () => {
  const i18n = createStudioI18n('fa');

  /**
   * Persian and English do not agree about zero.
   *
   * CLDR puts 0 in Persian's `one` category and in English's `other`. vue-i18n's
   * built-in rule is the English one, so the Persian rule is registered explicitly -
   * and this table is what proves the registration took effect rather than being
   * quietly ignored.
   */
  const cases: readonly [count: number, faForm: 0 | 1, enForm: 0 | 1][] = [
    [0, 0, 1],
    [1, 0, 0],
    [2, 1, 1],
    [11, 1, 1],
    [100, 1, 1],
  ];

  for (const [count, faForm, enForm] of cases) {
    it(`chooses form ${String(faForm)} in fa and ${String(enForm)} in en for ${String(count)}`, () => {
      i18n.global.locale.value = 'fa';
      const fa = i18n.global.t('settings.dirtyCount', { count }, count);
      const faForms = ['یک تغییر ذخیره‌نشده', `${String(count)} تغییر ذخیره‌نشده`];
      expect(fa).toBe(faForms[faForm]);

      i18n.global.locale.value = 'en';
      const en = i18n.global.t('settings.dirtyCount', { count }, count);
      const enForms = ['One unsaved change', `${String(count)} unsaved changes`];
      expect(en).toBe(enForms[enForm]);
    });
  }
});
