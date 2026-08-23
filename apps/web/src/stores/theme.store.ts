import { usePreferredDark, useLocalStorage } from '@vueuse/core';
import { defineStore } from 'pinia';
import { computed, watch, type ComputedRef, type Ref } from 'vue';

export const THEME_STORAGE_KEY = 'rv.theme';

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeStore {
  readonly preference: Ref<ThemePreference>;
  readonly resolved: ComputedRef<ResolvedTheme>;
  setPreference: (next: ThemePreference) => void;
}

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/**
 * Light, dark, or whatever the machine says.
 *
 * Three states rather than two, because "follow the OS" is a real preference and
 * collapsing it into a boolean means a user who changes their machine to dark at dusk
 * has to change the studio too. `data-theme` is written onto `<html>` only for an
 * explicit choice; `system` removes the attribute entirely and lets the
 * `prefers-color-scheme` block in `tokens.css` decide, so the two mechanisms never
 * disagree.
 */
export const useThemeStore = defineStore('theme', (): ThemeStore => {
  const stored = useLocalStorage<string>(THEME_STORAGE_KEY, 'system');
  const preference = computed<ThemePreference>({
    get: () => (isThemePreference(stored.value) ? stored.value : 'system'),
    set: (next) => {
      stored.value = next;
    },
  });

  const prefersDark = usePreferredDark();
  const resolved = computed<ResolvedTheme>(() => {
    if (preference.value === 'system') return prefersDark.value ? 'dark' : 'light';
    return preference.value;
  });

  watch(
    preference,
    (next) => {
      const root = document.documentElement;
      // `system` removes the attribute rather than writing one, so the
      // `prefers-color-scheme` block in `tokens.css` is what decides. Writing
      // `data-theme="system"` would give the CSS a third state to handle and a
      // reason for the two mechanisms to disagree.
      if (next === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', next);
    },
    { immediate: true },
  );

  function setPreference(next: ThemePreference): void {
    preference.value = next;
  }

  return { preference, resolved, setPreference };
});
