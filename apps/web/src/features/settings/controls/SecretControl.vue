<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../../components/AppBadge.vue';

import type { SettingControlEmits, SettingControlProps } from './control-contract';

const props = defineProps<SettingControlProps>();
const emit = defineEmits<SettingControlEmits>();

const { t } = useI18n();

/**
 * A secret is present or absent. It is never a value.
 *
 * `SettingValue` is a discriminated union on `secret`, and the secret branch has no
 * `value` property at all - architecture 7b's "the UI can report that a key is
 * *present*, never what it is" is enforced by the shape, not by a redaction step. So
 * there is nothing to leak here even by accident: the component has no value to render.
 * The input below is write-only, starts empty on every load, and what a user types into
 * it is their own input on its way out, never something read back in.
 */
const present = computed(() => (props.value?.secret === true ? props.value.set : false));

const hints = computed(() =>
  props.descriptor.control.kind === 'secret' ? props.descriptor.control : null,
);

/** Only ever the freshly typed replacement; `null` means "no change to the secret". */
const pending = computed(() => (typeof props.draft === 'string' ? props.draft : ''));
</script>

<template>
  <div class="rv-secret">
    <div class="rv-secret__state">
      <AppBadge :tone="present ? 'success' : 'neutral'">
        {{ present ? t('settings.secret.present') : t('settings.secret.absent') }}
      </AppBadge>
      <span class="rv-secret__note">{{ t('settings.secret.never') }}</span>
    </div>
    <input
      :id="inputId"
      class="rv-secret__input"
      type="password"
      dir="ltr"
      autocomplete="new-password"
      spellcheck="false"
      :value="pending"
      :placeholder="hints?.placeholder ?? t('settings.secret.placeholder')"
      :readonly="readonly"
      :aria-describedby="describedBy"
      :aria-invalid="invalid"
      @input="emit('change', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>

<style scoped>
.rv-secret {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  max-inline-size: 28rem;
}

.rv-secret__state {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-secret__note {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-faint);
}

.rv-secret__input {
  text-align: start;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
  font-family: var(--rv-font-mono);
  font-size: var(--rv-text-sm);
}

.rv-secret__input[aria-invalid='true'] {
  border-color: var(--rv-color-danger);
}
</style>
