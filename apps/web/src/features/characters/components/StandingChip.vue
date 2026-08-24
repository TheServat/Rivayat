<script setup lang="ts">
import {
  PhChatCircleText,
  PhCheckCircle,
  PhEye,
  PhEyeSlash,
  PhSealQuestion,
  PhWarningDiamond,
} from '@phosphor-icons/vue';
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';

import type { EpistemicStanding } from '../api/epistemic';

import { STANDING_DASH, STANDING_MESSAGE_KEY, STANDING_WIDTH } from './standing-pattern';

/**
 * What one fact is, in this viewer's head — said three ways at once.
 *
 * Colour is the third channel, never the first and never the only one. Roughly one man
 * in twelve cannot separate the red from the green, and the distinction this chip
 * carries — *knows* against *believes falsely* — is the single distinction the whole
 * epistemic model exists to make. So each standing gets a **word**, a **glyph** and a
 * **stroke pattern**, and the colour is what makes the group scannable once you already
 * know which is which.
 *
 * The stroke swatch is not decoration either: it is the same pattern the diagram draws
 * the edge in, so the legend and the graph teach each other.
 */
const props = withDefaults(
  defineProps<{
    standing: EpistemicStanding;
    /** Adds the one-line explanation under the word. Used by the legend, not the nodes. */
    explain?: boolean;
    size?: 'sm' | 'md';
  }>(),
  { explain: false, size: 'sm' },
);

const { t } = useI18n();

const GLYPH: Readonly<Record<EpistemicStanding, Component>> = {
  knows: PhCheckCircle,
  'believes-falsely': PhWarningDiamond,
  suspects: PhSealQuestion,
  witnessed: PhEye,
  told: PhChatCircleText,
  blind: PhEyeSlash,
};

const label = computed(() =>
  t(`characters.graph.epistemic.${STANDING_MESSAGE_KEY[props.standing]}`),
);
const hint = computed(() =>
  t(`characters.graph.epistemic.${STANDING_MESSAGE_KEY[props.standing]}Hint`),
);
const glyph = computed(() => GLYPH[props.standing]);
const dash = computed(() => STANDING_DASH[props.standing]);
const width = computed(() => STANDING_WIDTH[props.standing]);
</script>

<template>
  <span class="rv-standing" :data-standing="standing" :data-size="size">
    <component :is="glyph" :size="size === 'md' ? 16 : 13" weight="fill" aria-hidden="true" />
    <!--
      The legend carries the diagram's own stroke, so the pattern in the key and the
      pattern on the edge are one decision rather than two that drift apart.
    -->
    <svg
      v-if="explain"
      class="rv-standing__swatch"
      viewBox="0 0 28 6"
      aria-hidden="true"
      focusable="false"
    >
      <line
        x1="1"
        y1="3"
        x2="27"
        y2="3"
        :stroke-dasharray="dash"
        :stroke-width="width"
        stroke="currentcolor"
        stroke-linecap="round"
      />
    </svg>
    <span class="rv-standing__text">
      <span class="rv-standing__word">{{ label }}</span>
      <span v-if="explain" class="rv-standing__hint">{{ hint }}</span>
    </span>
  </span>
</template>

<style scoped>
.rv-standing {
  display: inline-flex;
  align-items: start;
  gap: var(--rv-space-1);
  border-radius: var(--rv-radius-pill);
  padding-block: 0.0625rem;
  padding-inline: var(--rv-space-2);
  font-size: var(--rv-text-2xs);
  font-weight: var(--rv-weight-medium);
  line-height: var(--rv-leading-snug);
  border: var(--rv-border-width) solid transparent;
}

.rv-standing[data-size='md'] {
  font-size: var(--rv-text-xs);
  padding-block: var(--rv-space-1);
}

.rv-standing__swatch {
  inline-size: 1.75rem;
  block-size: 0.375rem;
  margin-block-start: 0.35rem;
  flex: none;
}

.rv-standing__text {
  display: flex;
  flex-direction: column;
  min-inline-size: 0;
}

.rv-standing__hint {
  font-weight: var(--rv-weight-regular);
  color: var(--rv-color-text-muted);
}

/* Held and true. */
.rv-standing[data-standing='knows'],
.rv-standing[data-standing='witnessed'],
.rv-standing[data-standing='told'] {
  background-color: var(--rv-color-success-soft);
  color: var(--rv-color-success);
  border-color: color-mix(in oklch, currentcolor 28%, transparent);
}

/* Held and false. The one that must never be mistaken for the one above. */
.rv-standing[data-standing='believes-falsely'] {
  background-color: var(--rv-color-danger-soft);
  color: var(--rv-color-danger);
  border-color: color-mix(in oklch, currentcolor 40%, transparent);
}

.rv-standing[data-standing='suspects'] {
  background-color: var(--rv-color-info-soft);
  color: var(--rv-color-info);
  border-color: color-mix(in oklch, currentcolor 28%, transparent);
}

/* Not held at all: the dramatic irony available to the scene. */
.rv-standing[data-standing='blind'] {
  background-color: var(--rv-color-surface-sunken);
  color: var(--rv-color-text-faint);
  border-color: var(--rv-color-border);
  border-style: dashed;
}
</style>
