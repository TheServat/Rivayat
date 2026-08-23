<script setup lang="ts">
import { computed } from 'vue';

import type { SettingControlEmits, SettingControlProps } from './control-contract';

const props = defineProps<SettingControlProps>();
const emit = defineEmits<SettingControlEmits>();

const text = computed(() => (typeof props.draft === 'string' ? props.draft : ''));

// Narrowed once, here, rather than cast at each use: the component knows its own kind,
// and the guard is what turns `control` into the object that actually carries hints.
const hints = computed(() =>
  props.descriptor.control.kind === 'url' ? props.descriptor.control : null,
);
</script>

<template>
  <input
    :id="inputId"
    class="rv-url"
    type="url"
    inputmode="url"
    dir="ltr"
    spellcheck="false"
    autocomplete="off"
    :value="text"
    :placeholder="hints?.placeholder"
    :readonly="readonly"
    :aria-describedby="describedBy"
    :aria-invalid="invalid"
    @input="emit('change', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
/*
 * `dir="ltr"` because a URL is a left-to-right string even on a right-to-left page:
 * without it the scheme and the port swap sides and the field becomes unreadable.
 * `text-align: start` then resolves inside that, so the rule stays logical.
 */
.rv-url {
  inline-size: 100%;
  max-inline-size: 28rem;
  text-align: start;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-3);
  font-family: var(--rv-font-mono);
  font-size: var(--rv-text-sm);
}

.rv-url[aria-invalid='true'] {
  border-color: var(--rv-color-danger);
}
</style>
