<script setup lang="ts">
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';

import AppShell from './layout/AppShell.vue';
import { useLocaleStore } from './stores/locale.store';

const localeStore = useLocaleStore();
const { locale } = useI18n({ useScope: 'global' });

/**
 * The store is the source of truth for the language; vue-i18n follows it.
 *
 * One direction only. If both could write, a locale set through the switcher and a
 * locale set by a route guard would fight, and the loser would be whichever ran second
 * - which is not a thing anyone can reason about. The store also owns `lang` and `dir`
 * on `<html>`, so language and direction can never disagree.
 */
watch(
  () => localeStore.locale,
  (next) => {
    locale.value = next;
  },
  { immediate: true },
);
</script>

<template>
  <AppShell />
</template>
