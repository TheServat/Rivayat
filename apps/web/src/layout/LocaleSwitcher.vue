<script setup lang="ts">
import type { Locale } from '@rv/contracts';
import { PhTranslate } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { SUPPORTED_LOCALES } from '../i18n/index';
import { useLocaleStore } from '../stores/locale.store';

import SwitchControl from './SwitchControl.vue';

const { t } = useI18n();
const localeStore = useLocaleStore();

/** Literal keys so the catalogue can type-check them; see `api/error-messages.ts`. */
const LOCALE_KEYS = {
  fa: 'locale.fa',
  en: 'locale.en',
} as const satisfies Record<Locale, string>;

/**
 * Each language names itself, in itself — «فارسی», not «Persian».
 *
 * Someone who cannot read the current interface language is exactly the person using
 * this control, so the one string they must be able to recognise is written in the
 * language it selects. That also means the glyph cannot be a flag: a flag is a country
 * and Persian is not one country.
 */
const options = computed(() =>
  SUPPORTED_LOCALES.map((locale) => ({ value: locale, label: t(LOCALE_KEYS[locale]) })),
);

/**
 * Switching language switches direction, without a reload.
 *
 * The store writes `lang` and `dir` on `<html>`, so every CSS logical property in the
 * application re-resolves on the same tick — including `--rv-flip`, which is what makes
 * an animation that travels toward the trailing edge travel toward the correct one.
 * Nothing here mirrors anything by hand; if a screen needed that, the screen would have
 * a physical `left` in it somewhere.
 */
function onChange(value: string): void {
  const next = SUPPORTED_LOCALES.find((locale) => locale === value);
  if (next !== undefined) localeStore.setLocale(next);
}
</script>

<template>
  <SwitchControl
    :label="t('locale.label')"
    :options="options"
    :model-value="localeStore.locale"
    :glyph="PhTranslate"
    test-id="locale-switcher"
    @update:model-value="onChange"
  />
</template>
