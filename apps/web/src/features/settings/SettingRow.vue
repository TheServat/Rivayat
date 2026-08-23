<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import type {
  SettingDescriptorMeta,
  SettingModelChoice,
  SettingScope,
  SettingValue,
} from '../../api/schemas/settings';
import AppBadge from '../../components/AppBadge.vue';
import AppButton from '../../components/AppButton.vue';
import { localised } from '../../i18n/localised';
import { useLocaleStore } from '../../stores/locale.store';

import { componentForControl } from './controls/index';
import ProvenanceBadge from './ProvenanceBadge.vue';

const props = defineProps<{
  descriptor: SettingDescriptorMeta;
  value: SettingValue | undefined;
  draft: unknown;
  models: readonly SettingModelChoice[];
  /** The layer this view writes to, so provenance can say "here" rather than a name. */
  target: SettingScope;
  dirty: boolean;
  clearable: boolean;
  /** The view's layer may read this setting but not write it. */
  readonly: boolean;
  /** Validation message from the descriptor's own schema, or `null`. */
  problem: string | null;
}>();

const emit = defineEmits<{
  change: [value: unknown];
  clear: [];
  revert: [];
}>();

const { t } = useI18n();
const localeStore = useLocaleStore();

/**
 * One row, whatever the setting is.
 *
 * The row knows about a label, help text, provenance, an override it may be able to
 * clear, and a slot where *some* control goes. It does not know which - the control is
 * looked up by `descriptor.control.kind` in the registry. That is the whole mechanism
 * architecture 7b asks for, and it is why adding a setting is a registry entry rather
 * than a change here.
 */
const control = computed(() => componentForControl(props.descriptor.control.kind));

// Keys contain dots; ids must not, or a CSS selector built from one silently addresses
// a class.
const slug = computed(() => props.descriptor.key.replace(/\./g, '-'));
const inputId = computed(() => `setting-${slug.value}`);
const helpId = computed(() => `${inputId.value}-help`);
const errorId = computed(() => `${inputId.value}-error`);
const describedBy = computed(() =>
  props.problem === null ? helpId.value : `${helpId.value} ${errorId.value}`,
);

const label = computed(() => localised(props.descriptor.label, localeStore.locale));
const help = computed(() => localised(props.descriptor.help, localeStore.locale));

/**
 * The one actionable thing to tell someone who cannot edit this row.
 *
 * A machine-scope setting is `.env`, and `.env` is not writable through an API - so
 * "read-only" on its own is a dead end. The variable's name is the whole of the
 * instruction: it says which line to open and edit.
 */
const envVariable = computed(() => (props.readonly ? (props.descriptor.env?.name ?? null) : null));

/**
 * Layers whose stored value the resolver refused.
 *
 * Reported rather than hidden: a row silently showing its fallback would leave the
 * operator looking at a value the database does not contain, with no way to find out
 * why.
 */
const ignored = computed(() => props.value?.ignored ?? []);

/** Literal keys so the catalogue can type-check them; see `api/error-messages.ts`. */
const LAYER_KEYS = {
  machine: 'settings.scope.machine',
  global: 'settings.scope.global',
  project: 'settings.scope.project',
  run: 'settings.scope.run',
} as const satisfies Record<SettingScope, string>;
</script>

<template>
  <div class="rv-row" :class="{ 'rv-row--dirty': dirty }" :data-setting-key="descriptor.key">
    <div class="rv-row__head">
      <label class="rv-row__label" :for="inputId">{{ label }}</label>
      <div class="rv-row__flags">
        <ProvenanceBadge
          v-if="value"
          :origin="value.origin"
          :target="target"
          :shadowed="value.shadowed"
          data-testid="provenance"
        />
        <AppBadge v-if="readonly" tone="neutral" :title="t('settings.readOnlyHint')">
          {{ t('settings.readOnly') }}
        </AppBadge>
        <AppBadge
          v-if="descriptor.requiresRestart"
          tone="warning"
          :title="t('settings.requiresRestartHint')"
        >
          {{ t('settings.requiresRestart') }}
        </AppBadge>
        <AppBadge v-if="dirty" tone="info">{{ t('settings.unsaved') }}</AppBadge>
      </div>
    </div>

    <p :id="helpId" class="rv-row__help">{{ help }}</p>

    <p v-if="envVariable !== null" class="rv-row__env">
      {{ t('settings.envVariable', { name: envVariable }) }}
    </p>

    <p v-for="entry in ignored" :key="entry.scope" class="rv-row__ignored" role="status">
      {{ t('settings.ignored', { layer: t(LAYER_KEYS[entry.scope]) }) }}
      <span class="rv-row__ignored-detail">{{ entry.message }}</span>
    </p>

    <div class="rv-row__control">
      <component
        :is="control"
        :descriptor="descriptor"
        :value="value"
        :draft="draft"
        :invalid="problem !== null"
        :readonly="readonly"
        :input-id="inputId"
        :described-by="describedBy"
        :models="models"
        @change="emit('change', $event)"
      />
    </div>

    <p v-if="problem !== null" :id="errorId" class="rv-row__error" role="alert">
      {{ t('settings.invalid') }} {{ problem }}
    </p>

    <div class="rv-row__actions">
      <code class="rv-row__key">{{ descriptor.key }}</code>
      <!--
        The hint is a `title`, not an `aria-label`. An `aria-label` would *replace* the
        accessible name with a sentence that does not contain the visible words, so
        "click clear override" would stop working for a voice-control user (WCAG 2.5.3).
      -->
      <AppButton
        v-if="clearable"
        variant="ghost"
        size="sm"
        :title="t('settings.clearOverrideHint')"
        @click="emit('clear')"
      >
        {{ t('settings.clearOverride') }}
      </AppButton>
      <AppButton v-if="dirty" variant="ghost" size="sm" @click="emit('revert')">
        {{ t('common.discard') }}
      </AppButton>
    </div>
  </div>
</template>

<style scoped>
.rv-row {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  padding-block: var(--rv-space-4);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-row:last-child {
  border-block-end: none;
}

/*
 * The dirty marker is an inline-start bar. In `rtl` it sits on the right of the row
 * and in `ltr` on the left, without a second rule - which is the only reason a
 * logical property is worth insisting on for something this small.
 */
.rv-row--dirty {
  border-inline-start: 3px solid var(--rv-color-accent);
  padding-inline-start: var(--rv-space-3);
  margin-inline-start: calc(-1 * var(--rv-space-3) - 3px);
}

.rv-row__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2);
  justify-content: space-between;
}

.rv-row__label {
  font-weight: var(--rv-weight-medium);
}

.rv-row__flags {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-row__help {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
  max-inline-size: 46rem;
}

.rv-row__env {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
  font-family: var(--rv-font-mono);
  /* A variable name is a Latin token inside a right-to-left line. */
  unicode-bidi: isolate;
}

.rv-row__ignored {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-warning);
}

.rv-row__ignored-detail {
  color: var(--rv-color-text-faint);
  font-size: var(--rv-text-xs);
}

.rv-row__control {
  padding-block-start: var(--rv-space-1);
}

.rv-row__error {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-danger);
}

.rv-row__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-row__key {
  font-family: var(--rv-font-mono);
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
  direction: ltr;
  unicode-bidi: isolate;
}
</style>
