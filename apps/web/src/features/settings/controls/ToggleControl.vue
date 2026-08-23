<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import type { SettingControlEmits, SettingControlProps } from './control-contract';

const props = defineProps<SettingControlProps>();
const emit = defineEmits<SettingControlEmits>();

const { t } = useI18n();

const checked = computed(() => props.draft === true);
</script>

<template>
  <div class="rv-toggle">
    <input
      :id="inputId"
      class="rv-toggle__input"
      type="checkbox"
      :checked="checked"
      :disabled="readonly"
      :aria-describedby="describedBy"
      :aria-invalid="invalid"
      @change="emit('change', ($event.target as HTMLInputElement).checked)"
    />
    <span class="rv-toggle__state" aria-hidden="true">
      {{ checked ? t('common.on') : t('common.off') }}
    </span>
  </div>
</template>

<style scoped>
.rv-toggle {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-toggle__input {
  inline-size: 1.1rem;
  block-size: 1.1rem;
  accent-color: var(--rv-color-accent);
  cursor: pointer;
}

.rv-toggle__state {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}
</style>
