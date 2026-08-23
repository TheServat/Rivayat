<script setup lang="ts">
import { computed } from 'vue';

import type { SettingControlEmits, SettingControlProps } from './control-contract';

const props = defineProps<SettingControlProps>();
const emit = defineEmits<SettingControlEmits>();

const text = computed(() => (typeof props.draft === 'string' ? props.draft : ''));

// Narrowed once: the component knows its own kind, so the guard - not a cast - is what
// turns `control` into the object that carries `multiline` and `placeholder`.
const hints = computed(() =>
  props.descriptor.control.kind === 'text' ? props.descriptor.control : null,
);
</script>

<template>
  <textarea
    v-if="hints?.multiline === true"
    :id="inputId"
    class="rv-text rv-text--area"
    rows="3"
    :value="text"
    :placeholder="hints.placeholder"
    :readonly="readonly"
    :aria-describedby="describedBy"
    :aria-invalid="invalid"
    @input="emit('change', ($event.target as HTMLTextAreaElement).value)"
  ></textarea>
  <input
    v-else
    :id="inputId"
    class="rv-text"
    type="text"
    :value="text"
    :placeholder="hints?.placeholder"
    :readonly="readonly"
    :aria-describedby="describedBy"
    :aria-invalid="invalid"
    @input="emit('change', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.rv-text {
  inline-size: 100%;
  max-inline-size: 28rem;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
  font-size: var(--rv-text-md);
}

.rv-text--area {
  font-family: var(--rv-font-mono);
  resize: vertical;
}

.rv-text[aria-invalid='true'] {
  border-color: var(--rv-color-danger);
}
</style>
