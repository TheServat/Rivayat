<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import type { SettingScope } from '../../api/schemas/settings';
import AppButton from '../../components/AppButton.vue';
import ErrorNotice from '../../components/ErrorNotice.vue';
import { useLocaleStore } from '../../stores/locale.store';
import { useSettingsStore } from '../../stores/settings.store';

import SettingsPanel from './SettingsPanel.vue';

const { t } = useI18n();
const settings = useSettingsStore();
const localeStore = useLocaleStore();

/**
 * The settings screen.
 *
 * Everything below the header is generated from the registry: panels come from the
 * groups the descriptors declare, rows from the descriptors, controls from each
 * descriptor's `control`. There is no per-setting markup anywhere in this feature, so
 * a setting that is added to the registry appears here and a setting that is removed
 * disappears - which is the drift §7b exists to prevent.
 */
onMounted(() => {
  void settings.load(localeStore.locale);
});

// The search filter matches against localised labels, so it has to be re-evaluated in
// the new language - the store keeps the locale it filtered with.
watch(
  () => localeStore.locale,
  (next) => {
    if (settings.status === 'ready') void settings.load(next);
  },
);

const blocked = computed(() => settings.invalidKeys.length > 0);
const canSave = computed(() => settings.dirtyCount > 0 && !blocked.value && !settings.saving);

/** Literal keys, so the catalogue can type-check them. See `api/error-messages.ts`. */
const LAYER_KEYS = {
  machine: 'settings.scope.machine',
  global: 'settings.scope.global',
  project: 'settings.scope.project',
  run: 'settings.scope.run',
} as const satisfies Record<SettingScope, string>;

/**
 * Which layer a save from this screen lands on.
 *
 * Stated rather than implied. Every row's provenance badge is relative to it, and a
 * reader who cannot see which layer they are editing cannot read "set here" either.
 */
const targetName = computed(() => t(LAYER_KEYS[settings.target]));

/**
 * Dismissed for this visit only, deliberately.
 *
 * The warning describes a line in `.env` that still does nothing. Remembering the
 * dismissal would hide it on the next load too, which is how a typo'd variable survives
 * a year - and this is the one screen where it can be found.
 */
const warningsDismissed = ref(false);
watch(
  () => settings.warnings,
  () => {
    warningsDismissed.value = false;
  },
);
</script>

<template>
  <div class="rv-settings">
    <header class="rv-settings__header">
      <h1 class="rv-settings__title">{{ t('settings.title') }}</h1>
      <p class="rv-settings__subtitle">{{ t('settings.subtitle') }}</p>
      <p v-if="settings.status === 'ready'" class="rv-settings__target">
        {{ t('settings.editingLayer', { layer: targetName }) }}
      </p>
    </header>

    <aside
      v-if="settings.warnings.length > 0 && !warningsDismissed"
      class="rv-settings__warnings"
      role="status"
    >
      <p class="rv-settings__warnings-title">{{ t('settings.warnings.title') }}</p>
      <ul class="rv-settings__warnings-list">
        <li v-for="warning in settings.warnings" :key="warning.variable">
          <code class="rv-settings__warnings-var">{{ warning.variable }}</code>
          {{ warning.message }}
        </li>
      </ul>
      <AppButton variant="ghost" size="sm" @click="warningsDismissed = true">
        {{ t('common.close') }}
      </AppButton>
    </aside>

    <div class="rv-settings__bar">
      <label class="rv-settings__search">
        <span class="rv-visually-hidden">{{ t('settings.search') }}</span>
        <input
          v-model="settings.query"
          class="rv-settings__search-input"
          type="search"
          :placeholder="t('settings.searchHint')"
        />
      </label>

      <div class="rv-settings__actions">
        <p v-if="settings.dirtyCount > 0" class="rv-settings__dirty" role="status">
          {{ t('settings.dirtyCount', settings.dirtyCount) }}
        </p>
        <AppButton
          v-if="settings.dirtyCount > 0"
          variant="ghost"
          size="sm"
          @click="settings.discardAll()"
        >
          {{ t('common.discard') }}
        </AppButton>
        <AppButton variant="primary" size="sm" :disabled="!canSave" @click="settings.save()">
          {{ t('common.saveAll') }}
        </AppButton>
      </div>
    </div>

    <p v-if="settings.status === 'loading'" class="rv-settings__state" role="status">
      {{ t('common.loading') }}
    </p>

    <ErrorNotice
      v-else-if="settings.status === 'error' && settings.error"
      :error="settings.error"
      @retry="settings.load(localeStore.locale)"
    />

    <template v-else-if="settings.status === 'ready'">
      <p v-if="settings.panels.length === 0" class="rv-settings__state">
        {{ t('settings.noMatches') }}
      </p>
      <div v-else class="rv-settings__panels">
        <SettingsPanel
          v-for="panel in settings.panels"
          :key="panel.group"
          :group="panel.group"
          :descriptors="panel.descriptors"
          :models="settings.models"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.rv-settings {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
}

.rv-settings__title {
  font-size: var(--rv-text-2xl);
}

.rv-settings__subtitle {
  color: var(--rv-color-text-muted);
  max-inline-size: 52rem;
}

.rv-settings__target {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-accent);
}

.rv-settings__warnings {
  display: flex;
  flex-direction: column;
  align-items: start;
  gap: var(--rv-space-2);
  border: var(--rv-border-width) solid var(--rv-color-warning);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-warning-soft);
  padding: var(--rv-space-4);
}

.rv-settings__warnings-title {
  font-weight: var(--rv-weight-bold);
  color: var(--rv-color-warning);
}

.rv-settings__warnings-list {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  font-size: var(--rv-text-sm);
  list-style: none;
  padding: 0;
}

/* A variable name is a Latin token inside a right-to-left sentence. */
.rv-settings__warnings-var {
  font-family: var(--rv-font-mono);
  font-size: var(--rv-text-xs);
  unicode-bidi: isolate;
}

.rv-settings__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--rv-space-3);
  position: sticky;
  inset-block-start: 0;
  z-index: var(--rv-z-sticky);
  background-color: var(--rv-color-canvas);
  padding-block: var(--rv-space-2);
}

.rv-settings__search-input {
  inline-size: 18rem;
  max-inline-size: 100%;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-pill);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-4);
}

.rv-settings__actions {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-settings__dirty {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-accent);
}

.rv-settings__state {
  color: var(--rv-color-text-muted);
}

.rv-settings__panels {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-5);
}
</style>
