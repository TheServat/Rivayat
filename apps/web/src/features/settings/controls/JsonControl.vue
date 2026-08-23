<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import type { SettingControlEmits, SettingControlProps } from './control-contract';

const props = defineProps<SettingControlProps>();
const emit = defineEmits<SettingControlEmits>();

const { t } = useI18n();

/**
 * The textarea holds text; the setting holds a value.
 *
 * They are separate refs on purpose. Half-typed JSON is not a value, so emitting on
 * every keystroke would either spam the store with `null` or silently keep the last
 * parseable state while the user looks at something else. Instead the text is local,
 * the parse result drives a local error, and only a successful parse reaches the store.
 */
const text = ref(serialise(props.draft));
const parseError = ref<string | null>(null);

function serialise(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

// Re-serialise when the store's value changes from outside - a discard, a save, or a
// cleared override - but never while the user's text still parses to the same value.
watch(
  () => props.draft,
  (next) => {
    if (parseError.value !== null) return;
    const current = safeParse(text.value);
    if (current.ok && JSON.stringify(current.value) === JSON.stringify(next)) return;
    text.value = serialise(next);
  },
);

function safeParse(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

function onInput(event: Event): void {
  const raw = (event.target as HTMLTextAreaElement).value;
  text.value = raw;
  const parsed = safeParse(raw);
  if (!parsed.ok) {
    parseError.value = t('settings.json.invalid');
    return;
  }
  parseError.value = null;
  emit('change', parsed.value);
}

const errorId = computed(() => `${props.inputId}-json-error`);

const hints = computed(() =>
  props.descriptor.control.kind === 'json' ? props.descriptor.control : null,
);
</script>

<template>
  <div class="rv-json">
    <textarea
      :id="inputId"
      class="rv-json__input"
      rows="5"
      dir="ltr"
      spellcheck="false"
      :value="text"
      :placeholder="hints?.placeholder"
      :readonly="readonly"
      :aria-describedby="parseError === null ? describedBy : `${describedBy} ${errorId}`"
      :aria-invalid="invalid || parseError !== null"
      @input="onInput"
    ></textarea>
    <p v-if="parseError !== null" :id="errorId" class="rv-json__error">{{ parseError }}</p>
  </div>
</template>

<style scoped>
.rv-json {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  max-inline-size: 32rem;
}

.rv-json__input {
  inline-size: 100%;
  text-align: start;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  background-color: var(--rv-color-surface-sunken);
  padding: var(--rv-space-3);
  font-family: var(--rv-font-mono);
  font-size: var(--rv-text-sm);
  resize: vertical;
}

.rv-json__input[aria-invalid='true'] {
  border-color: var(--rv-color-danger);
}

.rv-json__error {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-danger);
}
</style>
