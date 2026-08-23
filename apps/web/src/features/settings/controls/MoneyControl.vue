<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { NANO_PER_USD, formatNanoUsd } from '../../../i18n/format';
import { useLocaleStore } from '../../../stores/locale.store';

import type { SettingControlEmits, SettingControlProps } from './control-contract';

const props = defineProps<SettingControlProps>();
const emit = defineEmits<SettingControlEmits>();

const { t } = useI18n();
const localeStore = useLocaleStore();

/**
 * The stored value is integer nano-dollars; the field shows dollars.
 *
 * These two functions are the *only* place the conversion happens. The registry says
 * why: "a user typing `5` means five dollars, and every place that decides for itself
 * how many zeroes that is becomes a place it can be wrong." So the bounds and the step
 * are converted through the same pair as the value, and nothing below multiplies or
 * divides by a billion on its own.
 */
function toUsd(nanoUsd: number): number {
  return nanoUsd / NANO_PER_USD;
}

function toNanoUsd(usd: number): number {
  // Rounded, not truncated: `0.07 * 1e9` is `70000000.00000001` in binary floating
  // point, and an unrounded ceiling of seven cents would be stored as one nano-dollar
  // more than the user typed.
  return Math.round(usd * NANO_PER_USD);
}

const hints = computed(() =>
  props.descriptor.control.kind === 'money' ? props.descriptor.control : null,
);

const nanoUsd = computed(() => (typeof props.draft === 'number' ? props.draft : null));

const amount = computed(() => (nanoUsd.value === null ? null : toUsd(nanoUsd.value)));

const minUsd = computed(() =>
  hints.value?.minNanoUsd === undefined ? undefined : toUsd(hints.value.minNanoUsd),
);
const maxUsd = computed(() =>
  hints.value?.maxNanoUsd === undefined ? undefined : toUsd(hints.value.maxNanoUsd),
);
const stepUsd = computed(() => (hints.value === null ? 0.01 : toUsd(hints.value.stepNanoUsd)));

/**
 * The echo is a currency rendering, not a second input.
 *
 * The currency itself is never translated: every provider bills in USD, and showing a
 * ceiling as ریال would be a wrong number rather than a translated one. Only the digits
 * and the separators change with the locale.
 */
const display = computed(() =>
  nanoUsd.value === null ? '' : formatNanoUsd(nanoUsd.value, localeStore.locale),
);

/** `true` when clearing the field means "no ceiling" rather than "zero". */
const nullable = computed(() => hints.value?.nullable === true);

function onInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  // An empty field is not zero. `null` is a legitimate answer for a nullable ceiling
  // and a schema failure for the rest, which is exactly the difference the descriptor
  // should be the one to decide.
  emit('change', input.value === '' ? null : toNanoUsd(input.valueAsNumber));
}
</script>

<template>
  <div class="rv-money">
    <input
      :id="inputId"
      class="rv-money__input rv-tabular"
      type="number"
      inputmode="decimal"
      dir="ltr"
      :value="amount ?? ''"
      :min="minUsd"
      :max="maxUsd"
      :step="stepUsd"
      :readonly="readonly"
      :aria-describedby="describedBy"
      :aria-invalid="invalid"
      @input="onInput"
    />
    <output class="rv-money__display rv-tabular" :for="inputId">{{ display }}</output>
    <span v-if="nullable && nanoUsd === null" class="rv-money__note">
      {{ t('settings.money.noCeiling') }}
    </span>
  </div>
</template>

<style scoped>
.rv-money {
  display: flex;
  align-items: baseline;
  gap: var(--rv-space-3);
}

.rv-money__input {
  inline-size: 9rem;
  text-align: start;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
}

.rv-money__input[aria-invalid='true'] {
  border-color: var(--rv-color-danger);
}

.rv-money__display,
.rv-money__note {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}
</style>
