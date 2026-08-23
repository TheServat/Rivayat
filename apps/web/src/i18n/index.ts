import { type Locale } from '@rv/contracts';
import { createI18n } from 'vue-i18n';

import en from './messages/en';
import fa, { type MessageSchema } from './messages/fa';

export type { MessageSchema };

/**
 * The locales the studio ships, in preference order.
 *
 * `Locale` itself comes from `@rv/contracts` - it is the same enum the API validates a
 * `LocalisedText` against, and a studio that offered a third language the contracts do
 * not know about would produce settings labels the server could not store.
 */
export const SUPPORTED_LOCALES = ['fa', 'en'] as const satisfies readonly Locale[];

/** Persian, per RV-201: a fresh profile with no stored preference starts in `fa`. */
export const DEFAULT_LOCALE: Locale = 'fa';

/** Writing direction per locale. The only place the mapping is written down. */
export const LOCALE_DIRECTION: Readonly<Record<Locale, 'rtl' | 'ltr'>> = {
  fa: 'rtl',
  en: 'ltr',
};

/** The BCP-47 tag `Intl` needs, which is not the same string as the message key. */
export const LOCALE_TAG: Readonly<Record<Locale, string>> = {
  fa: 'fa-IR',
  en: 'en-GB',
};

export const messages: Readonly<Record<Locale, MessageSchema>> = { fa, en };

/**
 * True for anything the studio can actually switch to.
 *
 * Needed because the stored preference comes from `localStorage`, which is a string
 * the user can edit; widening it to `Locale` without checking would set `dir` from a
 * lookup that returns `undefined`.
 */
export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Persian pluralisation, as CLDR defines it rather than as vue-i18n guesses it.
 *
 * The library's default rule for a two-form message is `count === 1 ? 0 : 1`, which is
 * English. Persian puts 0 in the same grammatical category as 1 - "هیچ تغییری" and "یک
 * تغییر" take the same form - so a count of zero picks the *first* form. Registered per
 * locale because that is the whole point: `en` keeps the English rule.
 *
 * **A three-form message opts out of that**, and the reason is a real bug this rule
 * caused: an empty project rendered "یک قسمت" - *one* episode - because zero and one
 * share a form and the two-form message had nothing else to offer. Grammatical agreement
 * and factual accuracy are different problems, and a message that needs to *say* "none"
 * says so by supplying a third form. Two-form messages are untouched.
 */
function persianPluralRule(choice: number, choicesLength: number): number {
  if (choicesLength <= 1) return 0;
  if (choicesLength >= 3) {
    if (choice === 0) return 0;
    return choice === 1 ? 1 : choicesLength - 1;
  }
  return choice <= 1 ? 0 : choicesLength - 1;
}

/**
 * Builds the i18n instance.
 *
 * `missing` throws rather than warns. A raw key path rendered into the interface is a
 * defect that reaches the user looking like a typo, and the catalogues are typed
 * against each other precisely so this handler can never fire in a shipped build - if
 * it fires, a test or a dev session should stop, loudly. `silentFallbackWarn` stays off
 * for the same reason: falling back from `fa` to `en` is a missing Persian string, and
 * a Persian-first studio should not be quiet about one.
 */
function buildI18n(locale: Locale) {
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'en',
    messages,
    pluralRules: { fa: persianPluralRule },
    missingWarn: true,
    fallbackWarn: true,
    missing: (missingLocale: string, key: string): never => {
      throw new Error(`missing translation: ${missingLocale}.${key}`);
    },
  });
}

/**
 * The instance type, inferred rather than written out.
 *
 * `createI18n`'s return type threads the message schema, the locale union and the
 * legacy flag through five generic parameters, and every hand-written version of it
 * either widens `global` back to the legacy union - making `t()` uncallable - or drifts
 * the moment an option changes. Inferring it keeps `global` narrowed to the
 * composition API, which is what `legacy: false` actually produces.
 */
export type StudioI18n = ReturnType<typeof buildI18n>;

export function createStudioI18n(locale: Locale = DEFAULT_LOCALE): StudioI18n {
  return buildI18n(locale);
}

declare module 'vue-i18n' {
  // The catalogue shape, handed to vue-i18n so `t()` autocompletes and a typo in a key
  // is a compile error rather than a runtime `missing` throw.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface DefineLocaleMessage extends MessageSchema {}
}
