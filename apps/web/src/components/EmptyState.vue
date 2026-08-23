<script setup lang="ts">
/**
 * The layout every screen with nothing on it shares.
 *
 * An empty screen is an invitation, not an apology, so this is a two-column
 * composition — the drawing on one side, the words on the other — rather than a
 * centred shrug. It owns no heading of its own: the caller supplies the heading at the
 * level its own document outline needs, because an `<h2>` hard-coded in here would
 * eventually sit above an `<h1>` somewhere.
 *
 * Below 52rem it stacks, drawing first. On a 390px phone the drawing is still worth
 * its space: it is the only thing on these screens that says what the product is.
 */
</script>

<template>
  <section class="rv-empty">
    <div class="rv-empty__art">
      <slot name="art" />
    </div>
    <div class="rv-empty__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.rv-empty {
  display: grid;
  grid-template-columns: minmax(0, 22rem) minmax(0, 1fr);
  align-items: center;
  gap: var(--rv-space-6);
  padding: var(--rv-space-6);
  background-color: var(--rv-color-surface);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-lg);
  box-shadow: var(--rv-shadow-cut);
}

.rv-empty__art {
  display: flex;
  justify-content: center;
}

.rv-empty__body {
  display: flex;
  flex-direction: column;
  align-items: start;
  gap: var(--rv-space-3);
  min-inline-size: 0;
}

@media (max-width: 52rem) {
  .rv-empty {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--rv-space-5);
    padding: var(--rv-space-5);
  }
}
</style>
