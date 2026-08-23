<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import type { SettingModelChoice } from '../../../api/schemas/settings';
import AppBadge from '../../../components/AppBadge.vue';

import type { SettingControlEmits, SettingControlProps } from './control-contract';

const props = defineProps<SettingControlProps>();
const emit = defineEmits<SettingControlEmits>();

const { t } = useI18n();

const hints = computed(() =>
  props.descriptor.control.kind === 'model-picker' ? props.descriptor.control : null,
);

/**
 * The models this slot may be filled from.
 *
 * Filtered on the control's own `capability` (singular - a slot wants one thing) and
 * `providers`, against the live catalogue rather than the descriptor's frozen options:
 * the registry seeds the picker from `KNOWN_MODELS`, and the OpenRouter sync replaces
 * that list at runtime. A picker that only offered the seed would go stale the first
 * time the catalogue moved.
 */
const candidates = computed<readonly SettingModelChoice[]>(() => {
  const control = hints.value;
  if (control === null) return props.models;
  return props.models.filter(
    (model) =>
      control.providers.includes(model.provider) && model.capabilities.includes(control.capability),
  );
});

/**
 * Whether this slot stores `provider:model` or the provider-native id on its own.
 *
 * Both spellings are real and both use this control: a per-stage slot is open to three
 * providers and stores a `ModelRef`, while a provider's own default-model slot is
 * already scoped to one provider and stores a bare `ProviderModelId`. Guessing wrong is
 * silent - `ProviderModelId` is just a bounded string, so a qualified reference stored
 * in one would validate and then name a model no adapter can find.
 *
 * So it is read off the registry's own declared options, which are the exact values the
 * schema accepts. Only when there are none - a slot the catalogue currently offers
 * nothing for - does it fall back to the rule those options follow: a slot open to
 * several providers has to qualify, a single-provider slot has nothing to qualify.
 */
const qualified = computed(() => {
  const declared = props.descriptor.options?.[0]?.value;
  if (typeof declared === 'string') {
    return candidates.value.some((model) => model.ref === declared);
  }
  return (hints.value?.providers.length ?? 0) > 1;
});

function storedValueFor(model: SettingModelChoice): string {
  return qualified.value ? model.ref : model.model;
}

/** Options addressed by index, so `null` survives the trip through a `<select>`. */
const choices = computed(() =>
  candidates.value.map((model, index) => ({
    index: String(index),
    provider: model.provider,
    label: model.label,
    hint: model.pricing,
    free: model.free,
    stored: storedValueFor(model),
  })),
);

const providers = computed(() => [...new Set(choices.value.map((choice) => choice.provider))]);

const current = computed(() => (typeof props.draft === 'string' ? props.draft : null));

const selected = computed(() => choices.value.find((choice) => choice.stored === current.value));

/**
 * The `<select>`'s own value.
 *
 * `''` is the empty selection, `'null'` is the explicit "let the router decide" - which
 * is a real answer for every per-stage slot and the default for all twelve of them, not
 * an absence.
 */
const selectedIndex = computed(() => {
  if (current.value === null) return props.draft === null ? 'null' : '';
  return selected.value?.index ?? '';
});

const nullable = computed(() => hints.value?.nullable === true);
const allowCustom = computed(() => hints.value?.allowCustom === true);

/** The value is real but absent from the catalogue - a locally pulled Ollama tag, say. */
const isCustom = computed(() => current.value !== null && selected.value === undefined);

function onSelect(event: Event): void {
  const raw = (event.target as HTMLSelectElement).value;
  if (raw === 'null') {
    emit('change', null);
    return;
  }
  const chosen = choices.value.find((choice) => choice.index === raw);
  if (chosen !== undefined) emit('change', chosen.stored);
}

function onCustom(event: Event): void {
  const typed = (event.target as HTMLInputElement).value;
  emit('change', typed === '' && nullable.value ? null : typed);
}
</script>

<template>
  <div class="rv-model">
    <select
      :id="inputId"
      class="rv-model__select"
      :value="selectedIndex"
      :disabled="readonly"
      :aria-describedby="describedBy"
      :aria-invalid="invalid"
      @change="onSelect"
    >
      <option v-if="selectedIndex === ''" value="" disabled>
        {{ isCustom ? t('settings.modelPicker.custom') : t('settings.modelPicker.choose') }}
      </option>
      <option v-if="nullable" value="null">{{ t('settings.modelPicker.router') }}</option>
      <optgroup v-for="provider in providers" :key="provider" :label="provider">
        <option
          v-for="choice in choices.filter((entry) => entry.provider === provider)"
          :key="choice.index"
          :value="choice.index"
        >
          {{ choice.label }} — {{ choice.hint }}
        </option>
      </optgroup>
    </select>

    <p v-if="choices.length === 0" class="rv-model__empty">
      {{ t('settings.modelPicker.empty') }}
    </p>

    <!--
      A free-text field beside the list, not instead of it. `allowCustom` exists because
      the catalogue is seed data: Ollama serves whatever the operator pulled, and a
      closed picker would make a locally available model unreachable from the screen
      whose whole job is to reach every option.
    -->
    <label v-if="allowCustom" class="rv-model__custom">
      <span class="rv-model__caption">{{ t('settings.modelPicker.customLabel') }}</span>
      <input
        class="rv-model__input"
        type="text"
        dir="ltr"
        spellcheck="false"
        autocomplete="off"
        :value="current ?? ''"
        :readonly="readonly"
        :aria-describedby="describedBy"
        @input="onCustom"
      />
    </label>

    <p v-if="selected" class="rv-model__meta">
      <AppBadge v-if="selected.free" tone="success">
        {{ t('settings.modelPicker.free') }}
      </AppBadge>
      <span class="rv-model__ref">{{ current }}</span>
    </p>
  </div>
</template>

<style scoped>
.rv-model {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  max-inline-size: 32rem;
}

.rv-model__select {
  inline-size: 100%;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
  font-size: var(--rv-text-md);
}

.rv-model__select[aria-invalid='true'] {
  border-color: var(--rv-color-danger);
}

.rv-model__custom {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-model__caption,
.rv-model__empty {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
}

/* A model id is a Latin token; it reads left-to-right on a right-to-left page. */
.rv-model__input {
  text-align: start;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
  font-family: var(--rv-font-mono);
  font-size: var(--rv-text-sm);
}

.rv-model__meta {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-model__ref {
  font-family: var(--rv-font-mono);
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
  direction: ltr;
  unicode-bidi: isolate;
}
</style>
