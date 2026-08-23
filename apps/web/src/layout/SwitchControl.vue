<script setup lang="ts">
import { PhCaretDown } from '@phosphor-icons/vue';
import type { Component } from 'vue';

/**
 * The shell both display switchers wear.
 *
 * It owns the `<select>` rather than taking one in a slot, because slot content is
 * styled in the *parent's* scope and a control whose appearance depends on which file
 * happened to render it is a control that will drift. Theme and language are the same
 * object with different contents, so they are the same component with different props.
 *
 * The element underneath is a real `<select>`. A custom listbox would buy a prettier
 * popup and cost keyboard semantics, screen-reader support and the native picker on a
 * phone. `appearance: none` removes the platform arrow and nothing else.
 *
 * The value is emitted raw. Validating it belongs to whoever owns the union — a
 * `localStorage` entry and a DOM `<option>` are both user-editable, so "the select said
 * so" is not a guarantee of anything.
 */
defineProps<{
  /** Visually hidden, because the glyph is the visible label and it is not a word. */
  label: string;
  options: readonly { readonly value: string; readonly label: string }[];
  modelValue: string;
  /** The glyph for the current value. Swapped with a quarter turn when it changes. */
  glyph: Component;
  testId: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function onChange(event: Event): void {
  emit('update:modelValue', (event.target as HTMLSelectElement).value);
}
</script>

<template>
  <label class="rv-switch">
    <span class="rv-visually-hidden">{{ label }}</span>

    <span class="rv-switch__glyph" aria-hidden="true">
      <Transition name="rv-swap" mode="out-in">
        <component :is="glyph" :key="modelValue" :size="16" weight="bold" />
      </Transition>
    </span>

    <select class="rv-switch__select" :value="modelValue" :data-testid="testId" @change="onChange">
      <option v-for="option in options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>

    <PhCaretDown class="rv-switch__caret" :size="11" weight="bold" aria-hidden="true" />
  </label>
</template>

<style scoped>
.rv-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  color: var(--rv-color-text-muted);
}

/*
 * The glyph and the caret are decoration painted over the control; the `<select>`
 * itself is the full width of the pill, so the focus ring wraps what a person would
 * point at rather than a rectangle inside it.
 */
.rv-switch__glyph {
  position: absolute;
  inset-inline-start: 0.625rem;
  display: flex;
  pointer-events: none;
}

.rv-switch__caret {
  position: absolute;
  inset-inline-end: 0.625rem;
  pointer-events: none;
  opacity: 0.7;
}

.rv-switch__select {
  appearance: none;
  min-block-size: 2rem;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-pill);
  background-color: var(--rv-color-surface);
  color: var(--rv-color-text);
  padding-block: var(--rv-space-1);
  padding-inline: 2rem 1.75rem;
  font-size: var(--rv-text-xs);
  font-weight: var(--rv-weight-medium);
  cursor: pointer;
  transition:
    border-color var(--rv-duration-instant) var(--rv-ease-standard),
    background-color var(--rv-duration-instant) var(--rv-ease-standard);
}

.rv-switch:hover .rv-switch__select {
  border-color: var(--rv-color-accent);
}

.rv-switch:hover {
  color: var(--rv-color-accent);
}
</style>
