<script setup lang="ts">
// `aria-label` and friends fall through to the root `<button>`; see `AppBadge.vue`.
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'md' | 'sm';
    type?: 'button' | 'submit';
    disabled?: boolean;
  }>(),
  { variant: 'secondary', size: 'md', type: 'button', disabled: false },
);
</script>

<template>
  <button
    :type="type"
    :class="['rv-button', `rv-button--${variant}`, `rv-button--${size}`]"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
/*
 * Press is the one place this interface allows itself a physical feel.
 *
 * A button that does nothing visible for 400ms gets clicked twice, so the
 * acknowledgement has to land inside a frame: the surface drops 1px and shrinks by 2%
 * on `:active`, at 90ms, which is below the threshold where a person registers it as
 * an animation at all and above the threshold where they register it as a response.
 * Hover is a colour change only — a button that grows under the cursor is exhausting
 * across a form of forty of them.
 */
.rv-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--rv-space-2);
  min-block-size: 2.25rem;
  border: var(--rv-border-width) solid transparent;
  border-radius: var(--rv-radius-md);
  padding-block: var(--rv-space-2);
  padding-inline: var(--rv-space-4);
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-medium);
  line-height: var(--rv-leading-tight);
  cursor: pointer;
  transition:
    background-color var(--rv-duration-instant) var(--rv-ease-standard),
    border-color var(--rv-duration-instant) var(--rv-ease-standard),
    color var(--rv-duration-instant) var(--rv-ease-standard),
    box-shadow var(--rv-duration-instant) var(--rv-ease-standard),
    transform var(--rv-duration-instant) var(--rv-ease-standard);
}

.rv-button--sm {
  /* Still 32px tall: WCAG 2.2 SC 2.5.8 wants 24×24 minimum for a pointer target and
     the padding, not the label, is what provides it. */
  min-block-size: 2rem;
  padding-block: var(--rv-space-1);
  padding-inline: var(--rv-space-3);
  font-size: var(--rv-text-xs);
}

.rv-button:active:not(:disabled) {
  transform: translateY(1px) scale(0.98);
}

.rv-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.rv-button--primary {
  background-color: var(--rv-color-accent);
  color: var(--rv-color-accent-text);
  box-shadow: var(--rv-shadow-sm);
}

.rv-button--primary:hover:not(:disabled) {
  background-color: var(--rv-color-accent-hover);
  box-shadow: var(--rv-shadow-md);
}

.rv-button--secondary {
  background-color: var(--rv-color-surface);
  border-color: var(--rv-color-border-strong);
  color: var(--rv-color-text);
}

.rv-button--secondary:hover:not(:disabled) {
  background-color: var(--rv-color-surface-raised);
  border-color: var(--rv-color-accent);
  color: var(--rv-color-accent);
}

.rv-button--ghost {
  background-color: transparent;
  color: var(--rv-color-text-muted);
}

.rv-button--ghost:hover:not(:disabled) {
  background-color: var(--rv-color-surface-sunken);
  color: var(--rv-color-text);
}

.rv-button--danger {
  background-color: var(--rv-color-danger-soft);
  border-color: var(--rv-color-danger);
  color: var(--rv-color-danger);
}

.rv-button--danger:hover:not(:disabled) {
  background-color: var(--rv-color-danger);
  color: var(--rv-color-text-inverse);
}

@media (prefers-reduced-motion: reduce) {
  /* The press feedback survives as a colour shift; the movement does not. */
  .rv-button:active:not(:disabled) {
    transform: none;
  }
}
</style>
