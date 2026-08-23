<script setup lang="ts">
import { computed } from 'vue';

import { formatNumber } from '../../../i18n/format';
import { useLocaleStore } from '../../../stores/locale.store';

import type { SettingControlEmits, SettingControlProps } from './control-contract';

const props = defineProps<SettingControlProps>();
const emit = defineEmits<SettingControlEmits>();

const localeStore = useLocaleStore();

const numeric = computed(() => (typeof props.draft === 'number' ? props.draft : null));

// Narrowed once: `min`, `max`, `step` and `unit` live on the control object, and the
// guard is what makes reading them type-safe without a cast.
const hints = computed(() =>
  props.descriptor.control.kind === 'number' ? props.descriptor.control : null,
);

/**
 * The field itself stays ASCII; only the echo beside it is localised.
 *
 * `<input type="number">` gives Latin digits in every browser and hands back a real
 * `number` through `valueAsNumber`, so nothing here ever parses a rendered string.
 * RV-203 asks for exactly this split: Persian digits where a number is read, ASCII
 * where one is typed.
 */
const display = computed(() =>
  numeric.value === null ? '' : formatNumber(numeric.value, localeStore.locale),
);

function onInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  // An empty field is not zero. Emitting `null` lets the descriptor's schema reject it
  // as missing rather than silently storing a number the user did not type.
  emit('change', input.value === '' ? null : input.valueAsNumber);
}
</script>

<template>
  <div class="rv-number">
    <input
      :id="inputId"
      class="rv-number__input rv-tabular"
      type="number"
      inputmode="numeric"
      dir="ltr"
      :value="numeric ?? ''"
      :min="hints?.min"
      :max="hints?.max"
      :step="hints?.step"
      :readonly="readonly"
      :aria-describedby="describedBy"
      :aria-invalid="invalid"
      @input="onInput"
    />
    <span v-if="hints?.unit" class="rv-number__unit">{{ hints.unit }}</span>
    <output
      v-if="localeStore.locale === 'fa' && display !== ''"
      class="rv-number__echo rv-tabular"
      :for="inputId"
    >
      {{ display }}
    </output>
  </div>
</template>

<style scoped>
.rv-number {
  display: flex;
  align-items: baseline;
  gap: var(--rv-space-3);
}

/*
 * `dir="ltr"` on the input keeps the digits and the spinner in the order a number
 * wants, inside a right-to-left page. `text-align: start` then resolves against that
 * inner direction, which is why there is no physical alignment anywhere here.
 */
.rv-number__input {
  inline-size: 9rem;
  text-align: start;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
}

.rv-number__input[aria-invalid='true'] {
  border-color: var(--rv-color-danger);
}

.rv-number__echo,
.rv-number__unit {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}
</style>
