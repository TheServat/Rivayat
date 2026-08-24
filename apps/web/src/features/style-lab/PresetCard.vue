<script setup lang="ts">
import { PhCheck } from '@phosphor-icons/vue';
import type { StepMode } from '@rv/contracts';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import type { StylePresetCard } from '../../api/schemas/style';
import { formatNumber } from '../../i18n/format';
import { localised } from '../../i18n/localised';
import { useLocaleStore } from '../../stores/locale.store';

import MotionFilm from './MotionFilm.vue';
import { motionPresentation } from './motion-preview';

/**
 * One style on the shelf: what it looks like, what it is made of, and how it moves.
 *
 * The card is a radio, not a button. Eleven of anything is a set to choose one from, and
 * a radio group is one tab stop with arrow keys inside it rather than eleven tab stops -
 * which is the difference between reaching the probe controls in two keystrokes and
 * reaching them in twelve.
 */
const props = defineProps<{
  preset: StylePresetCard;
  selected: boolean;
  /** False under reduced motion, or when the reader has chosen to step. */
  playing: boolean;
  frame: number;
}>();

defineEmits<{ choose: [] }>();

const { t } = useI18n();
const localeStore = useLocaleStore();

const name = computed(() => localised(props.preset.name, localeStore.locale));
const description = computed(() => localised(props.preset.description, localeStore.locale));
const motion = computed(() => props.preset.draft.motion);
const palette = computed(() => props.preset.draft.visual.palette);
const presentation = computed(() => motionPresentation(motion.value));

/**
 * Literal keys, so `vue-i18n` can check them against the catalogue.
 *
 * An interpolated `styleLab.motion.stepMode.${mode}` types as `string` and slips a typo
 * past the compiler, which is the one failure the typed catalogue exists to catch. Same
 * pattern as `api/error-messages.ts`.
 */
const STEP_MODE_KEYS = {
  smooth: 'styleLab.motion.stepMode.smooth',
  'on-2s': 'styleLab.motion.stepMode.on-2s',
  'on-3s': 'styleLab.motion.stepMode.on-3s',
  'on-4s': 'styleLab.motion.stepMode.on-4s',
} as const satisfies Record<StepMode, string>;

const stepModeLabel = computed(() => t(STEP_MODE_KEYS[motion.value.stepMode]));

/**
 * The easing curve, drawn.
 *
 * A stepped style runs on `steps()` and cannot express its curve in the animation, so the
 * curve is shown instead of implied - and for a smooth style the line and the movement
 * are the same statement made twice, which is the point of a legend.
 */
const curvePath = computed(() => {
  const curve = motion.value.easings.find((entry) => entry.name === motion.value.defaultEasing);
  if (curve === undefined) return 'M0 24 L40 0';
  // The control-point y axis runs -0.4..1.7 across the library, so the viewport is scaled
  // to hold anticipation and overshoot rather than clipping them at the box.
  const y = (value: number): number => 24 - ((value + 0.4) / 2.1) * 24;
  return `M0 ${String(y(0))} C ${String(curve.p1.x * 40)} ${String(y(curve.p1.y))}, ${String(curve.p2.x * 40)} ${String(y(curve.p2.y))}, 40 ${String(y(1))}`;
});
</script>

<template>
  <label class="sl-card" :class="{ 'sl-card--on': selected }">
    <input
      class="sl-card__radio rv-visually-hidden"
      type="radio"
      name="rv-style-preset"
      :value="preset.id"
      :checked="selected"
      @change="$emit('choose')"
    />

    <span class="sl-card__film">
      <MotionFilm :motion="motion" :palette="palette" :playing="playing" :frame="frame" />
      <span v-if="selected" class="sl-card__tick">
        <PhCheck :size="13" weight="bold" aria-hidden="true" />
        {{ t('styleLab.gallery.chosen') }}
      </span>
    </span>

    <span class="sl-card__body">
      <span class="sl-card__head">
        <span class="sl-card__name">{{ name }}</span>
        <!--
          The medium is an identifier, not copy: it is the same `ArtMedium` value the
          CLI and the prompt compiler use, so it is shown as data - monospaced and
          direction-isolated, the way the checksum and the error codes are - rather than
          translated into a word that would not match anything a user could grep for.
        -->
        <span class="sl-card__medium rv-mono" dir="ltr">{{ preset.draft.visual.medium }}</span>
      </span>

      <span class="sl-card__desc">{{ description }}</span>

      <!-- The palette, named. Colour alone is never the only channel: each swatch
           carries its own name and hex in the accessible name of its tooltip. -->
      <span class="sl-card__palette">
        <span
          v-for="colour in palette.colors"
          :key="colour.hex"
          class="sl-card__swatch"
          :style="{ backgroundColor: colour.hex }"
          :title="t('styleLab.palette.swatch', { name: colour.name, hex: colour.hex })"
        ></span>
      </span>

      <!--
        The motion readout. Four numbers and a curve, because these are the four fields
        that most decide whether two styles feel like different media, and because a
        reader who cannot watch the loop still has to be able to compare them.
      -->
      <span class="sl-card__motion">
        <span class="sl-card__chip">
          <span class="sl-card__chip-key">{{ t('styleLab.motion.fps') }}</span>
          <span class="sl-card__chip-value rv-tabular">
            {{ formatNumber(presentation.imagesPerSecond, localeStore.locale) }}
          </span>
        </span>
        <span class="sl-card__chip">
          <span class="sl-card__chip-key">{{ t('styleLab.motion.step') }}</span>
          <span class="sl-card__chip-value">{{ stepModeLabel }}</span>
        </span>
        <span class="sl-card__chip">
          <span class="sl-card__chip-key">{{ t('styleLab.motion.tempo') }}</span>
          <span class="sl-card__chip-value rv-tabular">
            {{
              t('styleLab.motion.tempoValue', {
                value: formatNumber(motion.tempo, localeStore.locale),
              })
            }}
          </span>
        </span>
        <span class="sl-card__chip">
          <span class="sl-card__chip-key">{{ t('styleLab.motion.boil') }}</span>
          <span class="sl-card__chip-value rv-tabular">
            {{
              motion.boil.enabled
                ? t('styleLab.motion.boilOn', {
                    hz: formatNumber(motion.boil.hz, localeStore.locale),
                  })
                : t('styleLab.motion.boilOff')
            }}
          </span>
        </span>
        <span class="sl-card__chip sl-card__chip--curve">
          <span class="sl-card__chip-key">{{ t('styleLab.motion.easing') }}</span>
          <span class="sl-card__chip-value">
            {{ t('styleLab.motion.easingNamed', { name: motion.defaultEasing }) }}
          </span>
          <svg class="sl-card__curve" viewBox="-2 -2 44 28" aria-hidden="true" focusable="false">
            <path :d="curvePath" />
          </svg>
        </span>
      </span>
    </span>
  </label>
</template>

<style scoped>
.sl-card {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
  padding: var(--rv-space-3);
  background-color: var(--rv-color-surface);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-lg);
  box-shadow: var(--rv-shadow-cut);
  cursor: pointer;
  /* User-driven, so it interpolates. The film inside it is content and keeps its own
     cadence - see `MotionFilm.vue`. */
  transition:
    border-color var(--rv-duration-fast) var(--rv-ease-standard),
    box-shadow var(--rv-duration-fast) var(--rv-ease-standard),
    transform var(--rv-duration-fast) var(--rv-ease-standard);
}

.sl-card:hover {
  border-color: var(--rv-color-accent);
  box-shadow: var(--rv-shadow-md);
  transform: translateY(-2px);
}

/* Chosen is carried by three channels at once: the border, the mark on the film, and the
   word "chosen" in it. A border colour on its own is a colour-only signal. */
.sl-card--on {
  border-color: var(--rv-color-accent);
  box-shadow:
    var(--rv-shadow-md),
    inset 0 0 0 2px var(--rv-color-accent);
}

/* The ring is on the card, because the input it belongs to is visually hidden. Removing
   it is not an option, so it is moved. */
.sl-card:has(.sl-card__radio:focus-visible) {
  outline: var(--rv-focus-ring-width) solid var(--rv-color-focus-ring);
  outline-offset: var(--rv-focus-ring-offset);
}

.sl-card__film {
  position: relative;
  display: block;
  overflow: hidden;
  border-radius: var(--rv-radius-sm);
  border: var(--rv-border-width) solid var(--rv-color-border);
}

.sl-card__tick {
  position: absolute;
  inset-block-start: var(--rv-space-2);
  inset-inline-end: var(--rv-space-2);
  display: inline-flex;
  align-items: center;
  gap: var(--rv-space-1);
  padding-block: 0.0625rem;
  padding-inline: var(--rv-space-2);
  border-radius: var(--rv-radius-pill);
  background-color: var(--rv-color-accent);
  color: var(--rv-color-accent-text);
  font-size: var(--rv-text-2xs);
  font-weight: var(--rv-weight-semibold);
}

.sl-card__body {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  min-inline-size: 0;
}

.sl-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--rv-space-2);
}

.sl-card__name {
  font-weight: var(--rv-weight-bold);
}

.sl-card__medium {
  color: var(--rv-color-text-faint);
  unicode-bidi: isolate;
}

.sl-card__desc {
  font-size: var(--rv-text-sm);
  line-height: var(--rv-leading-snug);
  color: var(--rv-color-text-muted);
}

.sl-card__palette {
  display: flex;
  gap: var(--rv-space-1);
}

.sl-card__swatch {
  inline-size: 1.25rem;
  block-size: 1.25rem;
  border-radius: var(--rv-radius-xs);
  border: var(--rv-border-width) solid var(--rv-color-border);
}

.sl-card__motion {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--rv-space-1) var(--rv-space-3);
  padding-block-start: var(--rv-space-2);
  border-block-start: var(--rv-border-width) solid var(--rv-color-border);
}

.sl-card__chip {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-xs);
  min-inline-size: 0;
}

.sl-card__chip--curve {
  grid-column: 1 / -1;
}

.sl-card__chip-key {
  color: var(--rv-color-text-faint);
  white-space: nowrap;
}

.sl-card__chip-value {
  color: var(--rv-color-text);
  font-weight: var(--rv-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sl-card__curve {
  inline-size: 2.75rem;
  block-size: 1.75rem;
  margin-inline-start: auto;
  overflow: visible;
}

.sl-card__curve path {
  fill: none;
  stroke: var(--rv-color-accent);
  stroke-width: 1.5;
  stroke-linecap: round;
}
</style>
