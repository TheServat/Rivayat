<script setup lang="ts">
// `title`, `data-testid` and the rest are not props: the component has a single root
// element, so Vue forwards unrecognised attributes to it. Declaring them would mean
// declaring a default for each, and a default of `undefined` renders an empty
// attribute under `exactOptionalPropertyTypes`.
withDefaults(
  defineProps<{
    tone?: 'neutral' | 'accent' | 'info' | 'warning' | 'success' | 'danger';
  }>(),
  { tone: 'neutral' },
);
</script>

<template>
  <span :class="['rv-badge', `rv-badge--${tone}`]">
    <!--
      An icon slot, not an icon prop.

      Roughly one man in twelve cannot separate the danger tone from the success one by
      hue, so a badge that carries state has to carry a second channel. Every badge here
      already has a word in it; where the word is short enough to be scanned rather than
      read — Locked, Unlocked — the caller passes a glyph as well, and the shape does the
      work the colour cannot.
    -->
    <slot name="icon" />
    <slot />
  </span>
</template>

<style scoped>
.rv-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--rv-space-1);
  border: var(--rv-border-width) solid transparent;
  border-radius: var(--rv-radius-pill);
  padding-block: 0.0625rem;
  padding-inline: var(--rv-space-2);
  font-size: var(--rv-text-xs);
  font-weight: var(--rv-weight-medium);
  line-height: var(--rv-leading-snug);
  white-space: nowrap;
}

/* The border is drawn in the badge's own ink at low opacity rather than in a border
   token: on a near-black page a soft fill alone has almost no edge, and a badge with
   no edge stops reading as an object. */
.rv-badge--neutral {
  background-color: var(--rv-color-surface-sunken);
  border-color: var(--rv-color-border);
  color: var(--rv-color-text-muted);
}

.rv-badge--accent {
  background-color: var(--rv-color-accent-soft);
  border-color: var(--rv-color-accent-line);
  color: var(--rv-color-accent);
}

.rv-badge--info {
  background-color: var(--rv-color-info-soft);
  color: var(--rv-color-info);
  border-color: currentcolor;
}

.rv-badge--warning {
  background-color: var(--rv-color-warning-soft);
  color: var(--rv-color-warning);
  border-color: currentcolor;
}

.rv-badge--success {
  background-color: var(--rv-color-success-soft);
  color: var(--rv-color-success);
  border-color: currentcolor;
}

.rv-badge--danger {
  background-color: var(--rv-color-danger-soft);
  color: var(--rv-color-danger);
  border-color: currentcolor;
}

/* A full-strength border in the ink colour is too loud at this size; the fill already
   carries the tone, so the edge only has to define the shape. */
.rv-badge--info,
.rv-badge--warning,
.rv-badge--success,
.rv-badge--danger {
  border-color: color-mix(in oklch, currentcolor 28%, transparent);
}
</style>
