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
 * Options are addressed by index, not by their value.
 *
 * A `<select>` can only carry strings, and a setting's option value may be a boolean,
 * a number or an object. Round-tripping through `String(value)` would turn `0` and
 * `'0'` into the same choice; the index keeps the original JSON value intact all the
 * way back to the store.
 */
const options = computed(() =>
  (props.descriptor.options ?? []).map((option, index) => ({
    index: String(index),
    label: localised(option.label, localeStore.locale),
    value: option.value,
  })),
);

const selectedIndex = computed(() => {
  const found = options.value.findIndex((option) => option.value === props.draft);
  return found === -1 ? '' : String(found);
});

function onChange(event: Event): void {
  const index = Number((event.target as HTMLSelectElement).value);
  const chosen = options.value[index];
  if (chosen !== undefined) emit('change', chosen.value);
}
</script>

<template>
  <select
    :id="inputId"
    class="rv-select"
    :value="selectedIndex"
    :disabled="readonly"
    :aria-describedby="describedBy"
    :aria-invalid="invalid"
    @change="onChange"
  >
    <option v-if="selectedIndex === ''" value="" disabled>{{ t('common.none') }}</option>
    <option v-for="option in options" :key="option.index" :value="option.index">
      {{ option.label }}
    </option>
  </select>
</template>

<style scoped>
.rv-select {
  inline-size: 100%;
  max-inline-size: 22rem;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
  font-size: var(--rv-text-md);
}

.rv-select[aria-invalid='true'] {
  border-color: var(--rv-color-danger);
}
</style>
