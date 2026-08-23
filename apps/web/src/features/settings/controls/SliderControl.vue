<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { formatNumber } from '../../../i18n/format';
import { useLocaleStore } from '../../../stores/locale.store';

import type { SettingControlEmits, SettingControlProps } from './control-contract';

const props = defineProps<SettingControlProps>();
const emit = defineEmits<SettingControlEmits>();

const { t } = useI18n();
const localeStore = useLocaleStore();

/**
 * Narrowed once, and the fallbacks are unreachable by construction.
 *
 * `min`, `max` and `step` are *required* members of a slider control - the union has no
 * way to spell "a slider with no maximum", because that is not a thing that can be
 * drawn. The `??` below exists only because the guard has to have an else branch.
 */
const hints = computed(() =>
  props.descriptor.control.kind === 'slider' ? props.descriptor.control : null,
);

const min = computed(() => hints.value?.min ?? 0);
const max = computed(() => hints.value?.max ?? 1);
const step = computed(() => hints.value?.step ?? 0.01);
const current = computed(() => (typeof props.draft === 'number' ? props.draft : min.value));

/**
 * Fraction digits follow the step, not a fixed guess.
 *
 * A step of `0.05` wants two digits and a step of `1` wants none; hard-coding either
 * makes half the sliders read `0.150000` or `0`.
 */
const digits = computed(() => {
  const text = String(step.value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
});

const display = computed(() =>
  formatNumber(current.value, localeStore.locale, {
    minimumFractionDigits: digits.value,
    maximumFractionDigits: digits.value,
  }),
);
</script>

<template>
  <div class="rv-slider">
    <input
      :id="inputId"
      class="rv-slider__input"
      type="range"
      :value="current"
      :min="min"
      :max="max"
      :step="step"
      :disabled="readonly"
      :aria-describedby="describedBy"
      :aria-invalid="invalid"
      :aria-valuetext="display"
      @input="emit('change', ($event.target as HTMLInputElement).valueAsNumber)"
    />
    <output class="rv-slider__value rv-tabular" :for="inputId">
      <span class="rv-visually-hidden">{{ t('settings.slider.value', { value: display }) }}</span>
      <span aria-hidden="true">{{ display }}</span>
      <span v-if="hints?.unit" aria-hidden="true"> {{ hints.unit }}</span>
    </output>
  </div>
</template>

<style scoped>
.rv-slider {
  display: flex;
  align-items: center;
  gap: var(--rv-space-3);
  max-inline-size: 22rem;
}

/*
 * A range input mirrors with the document direction on its own: in `rtl` the minimum
 * sits at the inline start, which is the right end of the screen. Nothing to do here -
 * which is the point of never having written a physical direction anywhere.
 */
.rv-slider__input {
  flex: 1;
  accent-color: var(--rv-color-accent);
}

.rv-slider__value {
  min-inline-size: 3.5rem;
  text-align: end;
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}
</style>
