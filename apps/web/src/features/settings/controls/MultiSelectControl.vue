<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { localised } from '../../../i18n/localised';
import { useLocaleStore } from '../../../stores/locale.store';

import type { SettingControlEmits, SettingControlProps } from './control-contract';

const props = defineProps<SettingControlProps>();
const emit = defineEmits<SettingControlEmits>();

const { t } = useI18n();
const localeStore = useLocaleStore();

/**
 * A checkbox group, not a `<select multiple>`.
 *
 * `<select multiple>` is the smaller markup and the worse control: on touch it is
 * effectively unusable, ctrl-click to deselect is undiscoverable, and in a right-to-left
 * page the scrollable list box is the one native widget that still renders its
 * scrollbar and its selection highlight inconsistently across engines. A checkbox per
 * option is bigger on the page and correct everywhere.
 *
 * **The emitted order is the declaration's, never the click order.** Selecting
 * `shorts` then `yt` and selecting `yt` then `shorts` must produce the same value, or
 * the dirty check compares arrays that differ only in a sequence the user never chose
 * and every reload looks like an unsaved change.
 */
const hints = computed(() =>
  props.descriptor.control.kind === 'multi-select' ? props.descriptor.control : null,
);

const options = computed(() =>
  (props.descriptor.options ?? []).map((option, index) => ({
    index,
    value: option.value,
    label: localised(option.label, localeStore.locale),
    hint: option.hint,
    id: index === 0 ? props.inputId : `${props.inputId}-${String(index)}`,
  })),
);

const selected = computed<readonly unknown[]>(() =>
  Array.isArray(props.draft) ? (props.draft as readonly unknown[]) : [],
);

function isChosen(value: unknown): boolean {
  return selected.value.some((current) => current === value);
}

const minSelected = computed(() => hints.value?.minSelected ?? 0);
const maxSelected = computed(() => hints.value?.maxSelected ?? Number.POSITIVE_INFINITY);

const atMax = computed(() => selected.value.length >= maxSelected.value);
const belowMin = computed(() => selected.value.length < minSelected.value);

function onToggle(value: unknown, checked: boolean): void {
  // Rebuilt from the declaration rather than pushed onto the previous array: that is
  // what makes the order stable, and it also drops a stale value the registry no longer
  // offers instead of carrying it forward invisibly.
  const next = options.value
    .filter((option) => (option.value === value ? checked : isChosen(option.value)))
    .map((option) => option.value);
  emit('change', next);
}
</script>

<template>
  <!--
    `aria-describedby` is global and belongs on the group; `aria-invalid` is not, and
    lives on each checkbox instead - the widgets are what a validation state applies to.
  -->
  <div class="rv-multi" role="group" :aria-describedby="describedBy">
    <p class="rv-multi__lead">{{ t('settings.multiSelect.hint') }}</p>
    <ul class="rv-multi__list">
      <li v-for="option in options" :key="option.index" class="rv-multi__item">
        <input
          :id="option.id"
          class="rv-multi__box"
          type="checkbox"
          :checked="isChosen(option.value)"
          :disabled="readonly || (atMax && !isChosen(option.value))"
          :aria-describedby="describedBy"
          :aria-invalid="invalid"
          @change="onToggle(option.value, ($event.target as HTMLInputElement).checked)"
        />
        <label class="rv-multi__label" :for="option.id">
          <span>{{ option.label }}</span>
          <span v-if="option.hint" class="rv-multi__hint">{{ option.hint }}</span>
        </label>
      </li>
    </ul>
    <p v-if="belowMin" class="rv-multi__rule rv-multi__rule--bad">
      {{ t('settings.multiSelect.min', { count: minSelected }) }}
    </p>
    <p v-else-if="atMax && hints?.maxSelected !== undefined" class="rv-multi__rule">
      {{ t('settings.multiSelect.max', { count: hints.maxSelected }) }}
    </p>
  </div>
</template>

<style scoped>
.rv-multi {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  max-inline-size: 32rem;
}

.rv-multi__lead,
.rv-multi__rule {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
}

.rv-multi__rule--bad {
  color: var(--rv-color-danger);
}

.rv-multi__list {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  list-style: none;
  padding: 0;
}

.rv-multi__item {
  display: flex;
  align-items: baseline;
  gap: var(--rv-space-2);
}

.rv-multi__box {
  inline-size: 1rem;
  block-size: 1rem;
  accent-color: var(--rv-color-accent);
  cursor: pointer;
}

.rv-multi__label {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--rv-space-2);
  cursor: pointer;
}

/*
 * The hint is a size or a price - Latin text and digits inside a right-to-left line -
 * so it is isolated rather than aligned physically. Without the isolation a trailing
 * `1080x1920` reorders around the label.
 */
.rv-multi__hint {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
  direction: ltr;
  unicode-bidi: isolate;
}
</style>
