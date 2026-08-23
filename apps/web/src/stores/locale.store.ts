import type { Locale } from '@rv/contracts';
import { useLocalStorage } from '@vueuse/core';
import { defineStore } from 'pinia';
import { computed, watch, type ComputedRef, type Ref } from 'vue';

import { DEFAULT_LOCALE, isSupportedLocale, LOCALE_DIRECTION, LOCALE_TAG } from '../i18n/index';

export const LOCALE_STORAGE_KEY = 'rv.locale';

export interface LocaleStore {
  readonly locale: Ref<Locale>;
  readonly direction: ComputedRef<'rtl' | 'ltr'>;
  readonly tag: ComputedRef<string>;
  setLocale: (next: Locale) => void;
}

/**
 * The active locale, and the writing direction that follows from it.
 *
 * Owning both in one store is deliberate: direction is not a separate preference a
 * user can get wrong, it is a function of the language, and the moment the two are
 * settable independently someone will ship a Persian build in `ltr`.
 *
 * The store also writes `lang` and `dir` onto `<html>`. That is a side effect in a
 * store, which is usually a smell, but the document element is the one piece of state
 * no component owns and every component depends on - CSS logical properties resolve
 * against it, so a component that set its own direction would be lying to its
 * children.
 */
export const useLocaleStore = defineStore('locale', (): LocaleStore => {
  // `useLocalStorage` writes through on every change, so the choice survives a restart
  // (RV-201). The guard matters because the stored value is user-editable text.
  const stored = useLocalStorage<string>(LOCALE_STORAGE_KEY, DEFAULT_LOCALE);
  const locale = computed<Locale>({
    get: () => (isSupportedLocale(stored.value) ? stored.value : DEFAULT_LOCALE),
    set: (next) => {
      stored.value = next;
    },
  });

  const direction = computed(() => LOCALE_DIRECTION[locale.value]);
  const tag = computed(() => LOCALE_TAG[locale.value]);

  watch(
    [locale, direction],
    ([nextLocale, nextDirection]) => {
      const root = document.documentElement;
      root.lang = nextLocale;
      root.dir = nextDirection;
    },
    { immediate: true },
  );

  function setLocale(next: Locale): void {
    locale.value = next;
  }

  return { locale, direction, tag, setLocale };
});
