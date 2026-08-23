<script setup lang="ts">
import { PhCircleHalf, PhMoonStars, PhSun } from '@phosphor-icons/vue';
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';

import { THEME_PREFERENCES, useThemeStore, type ThemePreference } from '../stores/theme.store';

import SwitchControl from './SwitchControl.vue';

const { t } = useI18n();
const theme = useThemeStore();

/** Literal keys so the catalogue can type-check them; see `api/error-messages.ts`. */
const THEME_KEYS = {
  system: 'theme.system',
  light: 'theme.light',
  dark: 'theme.dark',
} as const satisfies Record<ThemePreference, string>;

/**
 * The glyph shows the *preference*, not the resolved theme.
 *
 * A half-filled circle for "match system" is the only honest answer here: showing a sun
 * because the machine happens to be light right now would claim the choice was "light",
 * and the next sunset would make the control a liar.
 */
const GLYPHS = {
  system: PhCircleHalf,
  light: PhSun,
  dark: PhMoonStars,
} as const satisfies Record<ThemePreference, Component>;

const glyph = computed<Component>(() => GLYPHS[theme.preference]);

const options = computed(() =>
  THEME_PREFERENCES.map((preference) => ({
    value: preference,
    label: t(THEME_KEYS[preference]),
  })),
);

function onChange(value: string): void {
  const next = THEME_PREFERENCES.find((preference) => preference === value);
  if (next !== undefined) theme.setPreference(next);
}
</script>

<template>
  <SwitchControl
    :label="t('theme.label')"
    :options="options"
    :model-value="theme.preference"
    :glyph="glyph"
    test-id="theme-switcher"
    @update:model-value="onChange"
  />
</template>
