<script setup lang="ts">
import type { AnimationIR } from '@rv/contracts';
import {
  PhArrowLineLeft,
  PhArrowLineRight,
  PhCaretLeft,
  PhCaretRight,
  PhPause,
  PhPlay,
  PhRepeat,
} from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppButton from '../../components/AppButton.vue';
import { formatNumber } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';

/**
 * Play, step, and the playhead.
 *
 * **The playhead is a real slider and it is keyboard-operable.** A timeline that can
 * only be scrubbed with a mouse fails WCAG 2.2 outright, and the fix is not a hidden
 * input beside it: this is `role="slider"` with a live `aria-valuetext`, arrow keys for
 * one frame, Shift for ten, Home and End for the ends.
 *
 * Direction is the part that is easy to get wrong. Time flows toward the *inline end*,
 * so in Persian it flows right to left, the playhead starts at the right edge, and the
 * right arrow key moves **back**. That is not a special case bolted on: `inset-inline-
 * start` places the head, and one `sign` flips both the pointer maths and the keys.
 * The two icons are direction-encoding, so they mirror - `PhCaretLeft` for "forward" in
 * an RTL document is correct, not a bug.
 */
const props = defineProps<{
  ir: AnimationIR;
  timeMs: number;
  playing: boolean;
  looping: boolean;
}>();

const emit = defineEmits<{
  seek: [timeMs: number];
  step: [frames: number];
  toggle: [];
  toggleLoop: [];
}>();

const { t } = useI18n();
const localeStore = useLocaleStore();

const frameMs = computed(() => 1000 / props.ir.fps);
const frameCount = computed(() => Math.max(1, Math.round(props.ir.durationMs / frameMs.value)));
const frame = computed(() => Math.round(props.timeMs / frameMs.value));
const progress = computed(() =>
  props.ir.durationMs === 0 ? 0 : props.timeMs / props.ir.durationMs,
);

/** +1 when time runs toward the right, -1 when it runs toward the left. */
const sign = computed(() => (localeStore.direction === 'rtl' ? -1 : 1));

const valueText = computed(() =>
  t('timeline.scrub.position', {
    frame: formatNumber(frame.value, localeStore.locale),
    total: formatNumber(frameCount.value, localeStore.locale),
    seconds: formatNumber(props.timeMs / 1000, localeStore.locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  }),
);

const directionNote = computed(() =>
  localeStore.direction === 'rtl' ? t('timeline.scrub.rtlNote') : t('timeline.scrub.ltrNote'),
);

/**
 * Direction-encoding icons, chosen rather than mirrored.
 *
 * A caret that means "earlier" has to point at the start of the line, and the start of
 * the line is on the right in Persian. Phosphor's `mirrored` prop flips
 * unconditionally, which is the same bug in the other direction, so the icon is picked
 * from the document's direction instead. A play triangle is *not* in this list: it
 * depicts a physical object and does not mirror.
 */
const backIcon = computed(() => (localeStore.direction === 'rtl' ? PhCaretRight : PhCaretLeft));
const forwardIcon = computed(() => (localeStore.direction === 'rtl' ? PhCaretLeft : PhCaretRight));
const startIcon = computed(() =>
  localeStore.direction === 'rtl' ? PhArrowLineRight : PhArrowLineLeft,
);
const endIcon = computed(() =>
  localeStore.direction === 'rtl' ? PhArrowLineLeft : PhArrowLineRight,
);

/**
 * Pointer position to time, mirrored.
 *
 * `rect.right - clientX` rather than `clientX - rect.left` when the document runs
 * right-to-left. Written once, here, because a second copy in the keyframe lane is a
 * second place for the mirror to be forgotten - so the lane imports this.
 */
function fractionFromPointer(rect: DOMRect, clientX: number, rtl: boolean): number {
  if (rect.width === 0) return 0;
  const along = rtl ? rect.right - clientX : clientX - rect.left;
  return Math.min(Math.max(along / rect.width, 0), 1);
}

function scrubTo(event: PointerEvent): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const fraction = fractionFromPointer(
    target.getBoundingClientRect(),
    event.clientX,
    localeStore.direction === 'rtl',
  );
  emit('seek', fraction * props.ir.durationMs);
}

function onPointerDown(event: PointerEvent): void {
  const target = event.currentTarget;
  if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId);
  scrubTo(event);
}

function onPointerMove(event: PointerEvent): void {
  // `buttons` rather than a `dragging` flag: the browser already knows whether the
  // button is down, and a flag can survive a pointerup the window swallowed.
  if (event.buttons === 0) return;
  scrubTo(event);
}

function onKeydown(event: KeyboardEvent): void {
  const big = event.shiftKey ? 10 : 1;
  switch (event.key) {
    case 'ArrowRight':
      emit('step', sign.value * big);
      break;
    case 'ArrowLeft':
      emit('step', -sign.value * big);
      break;
    case 'ArrowUp':
      emit('step', big);
      break;
    case 'ArrowDown':
      emit('step', -big);
      break;
    case 'PageUp':
      emit('step', props.ir.fps);
      break;
    case 'PageDown':
      emit('step', -props.ir.fps);
      break;
    case 'Home':
      emit('seek', 0);
      break;
    case 'End':
      emit('seek', props.ir.durationMs);
      break;
    case ' ':
    case 'Spacebar':
      emit('toggle');
      break;
    default:
      return;
  }
  event.preventDefault();
}

defineExpose({ fractionFromPointer });
</script>

<template>
  <div class="rv-transport" :aria-label="t('timeline.transport.label')" role="group">
    <div class="rv-transport__buttons">
      <AppButton
        size="sm"
        variant="ghost"
        :aria-label="t('timeline.transport.toStart')"
        @click="emit('seek', 0)"
      >
        <component :is="startIcon" :size="16" aria-hidden="true" />
      </AppButton>
      <AppButton
        size="sm"
        variant="ghost"
        :aria-label="t('timeline.transport.back')"
        @click="emit('step', -1)"
      >
        <component :is="backIcon" :size="16" aria-hidden="true" />
      </AppButton>
      <AppButton
        size="sm"
        variant="primary"
        :aria-label="playing ? t('timeline.transport.pause') : t('timeline.transport.play')"
        :aria-pressed="playing"
        data-testid="transport-play"
        @click="emit('toggle')"
      >
        <component :is="playing ? PhPause : PhPlay" :size="16" weight="fill" aria-hidden="true" />
        {{ playing ? t('timeline.transport.pause') : t('timeline.transport.play') }}
      </AppButton>
      <AppButton
        size="sm"
        variant="ghost"
        :aria-label="t('timeline.transport.forward')"
        @click="emit('step', 1)"
      >
        <component :is="forwardIcon" :size="16" aria-hidden="true" />
      </AppButton>
      <AppButton
        size="sm"
        variant="ghost"
        :aria-label="t('timeline.transport.toEnd')"
        @click="emit('seek', ir.durationMs)"
      >
        <component :is="endIcon" :size="16" aria-hidden="true" />
      </AppButton>
      <AppButton
        size="sm"
        :variant="looping ? 'secondary' : 'ghost'"
        :aria-pressed="looping"
        :aria-label="t('timeline.transport.loop')"
        @click="emit('toggleLoop')"
      >
        <PhRepeat :size="16" aria-hidden="true" />
      </AppButton>
    </div>

    <p class="rv-transport__readout rv-tabular">
      {{
        t('timeline.transport.frame', {
          frame: formatNumber(frame, localeStore.locale),
          total: formatNumber(frameCount, localeStore.locale),
        })
      }}
      &middot;
      {{ t('timeline.transport.fps', { fps: formatNumber(ir.fps, localeStore.locale) }) }}
    </p>

    <!--
      The scrubber. `--rv-progress` places the head with `inset-inline-start`, so the
      playhead travels toward the reader's own end of the line without a second
      stylesheet, and the fill grows from the same edge.
    -->
    <div
      class="rv-transport__track"
      role="slider"
      tabindex="0"
      :aria-label="t('timeline.scrub.label')"
      :aria-valuemin="0"
      :aria-valuemax="frameCount"
      :aria-valuenow="frame"
      :aria-valuetext="valueText"
      aria-orientation="horizontal"
      data-testid="scrubber"
      :style="{ '--rv-progress': `${String(progress * 100)}%` }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @keydown="onKeydown"
    >
      <span class="rv-transport__fill" aria-hidden="true" />
      <span
        v-for="marker in ir.markers"
        :key="marker.id"
        class="rv-transport__marker"
        :style="{ '--rv-at': `${String((marker.timeMs / ir.durationMs) * 100)}%` }"
        :title="marker.label"
        aria-hidden="true"
      />
      <span class="rv-transport__head" aria-hidden="true" />
    </div>
    <p class="rv-transport__hint">{{ t('timeline.scrub.hint') }} {{ directionNote }}</p>
  </div>
</template>

<style scoped>
.rv-transport {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
}

.rv-transport__buttons {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-1);
}

.rv-transport__readout {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.rv-transport__track {
  position: relative;
  block-size: 2rem;
  inline-size: 100%;
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-sm);
  background-color: var(--rv-color-surface-sunken);
  cursor: pointer;
  touch-action: none;
}

.rv-transport__fill {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  inline-size: var(--rv-progress, 0%);
  background-color: var(--rv-color-accent-soft);
}

.rv-transport__marker {
  position: absolute;
  inset-block: 0.25rem;
  inset-inline-start: var(--rv-at, 0%);
  inline-size: 2px;
  background-color: var(--rv-color-mark);
}

/*
 * The playhead. 2px of ink, 12px of grab area: WCAG 2.2 puts a pointer target at
 * 24x24 and the visible line is not the target.
 */
.rv-transport__head {
  position: absolute;
  inset-block: -2px;
  inset-inline-start: var(--rv-progress, 0%);
  inline-size: 2px;
  background-color: var(--rv-color-accent);
  margin-inline-start: -1px;
}

.rv-transport__head::after {
  content: '';
  position: absolute;
  inset-block: 0;
  inset-inline-start: -11px;
  inline-size: 24px;
}

.rv-transport__hint {
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-text-faint);
  line-height: var(--rv-leading-snug);
}
</style>
