<script setup lang="ts">
import type { AnimationIR, Track } from '@rv/contracts';
import { PhWaveSine } from '@phosphor-icons/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../components/AppBadge.vue';
import { formatNumber } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';

import {
  MOTION_CONSEQUENCE_KEYS,
  MOTION_SOURCE_KEYS,
  motionSourceFor,
  type MotionSource,
} from './motion-source';
import type { TimelineSelection } from './timeline.store';

/**
 * Tracks, keyframes and markers, laid along the same time axis as the playhead.
 *
 * Two things this component is careful about.
 *
 * **Direction.** Every position is `inset-inline-start: <fraction>`, so the whole lane
 * mirrors with the document and the keyframe at t=0 sits where the reader starts. The
 * pointer maths is mirrored to match, and the arrow keys are flipped by the same sign,
 * so a keyframe dragged toward the reader's "later" always gets later.
 *
 * **Where the motion came from.** A track is one source of motion among several - the
 * IR already carries procedural behaviours as well as keyframes, and
 * `docs/universal_ai_animation_system.md` §17 has physics, retargeting and AI motion
 * behind them. So every lane says what drives it, and a lane whose channel a behaviour
 * *also* writes says what a drag will do to that behaviour: replace it, or sum with it.
 * The evaluator's rule is "tracks replace unless additive", and a user who is not told
 * that watches their edit apparently vanish under a gust of wind.
 */
const props = defineProps<{
  ir: AnimationIR;
  timeMs: number;
  selection: TimelineSelection | null;
}>();

const emit = defineEmits<{
  select: [selection: TimelineSelection];
  move: [
    payload: {
      trackId: string;
      index: number;
      timeMs: number;
      value: number;
      /**
       * Present while a pointer is down.
       *
       * One drag is one edit. Without an identity for the gesture, the eight
       * `pointermove` events a short drag emits become eight undo entries and the user
       * unwinds their own drag a pixel at a time - which is a real defect a real
       * browser found, and one jsdom cannot: it stubs pointer capture.
       */
      gesture?: string;
    },
  ];
  seek: [timeMs: number];
}>();

const { t } = useI18n();
const localeStore = useLocaleStore();

const rtl = computed(() => localeStore.direction === 'rtl');
const sign = computed(() => (rtl.value ? -1 : 1));
const frameMs = computed(() => 1000 / props.ir.fps);

interface Lane {
  readonly track: Track;
  readonly nodeName: string;
  readonly source: MotionSource;
}

const lanes = computed<Lane[]>(() =>
  props.ir.tracks.map((track) => ({
    track,
    nodeName: props.ir.nodes.find((node) => node.id === track.nodeId)?.name ?? track.nodeId,
    source: motionSourceFor(props.ir, track),
  })),
);

const playheadPercent = computed(() =>
  props.ir.durationMs === 0 ? 0 : (props.timeMs / props.ir.durationMs) * 100,
);

function percentOf(timeMs: number): number {
  return props.ir.durationMs === 0 ? 0 : (timeMs / props.ir.durationMs) * 100;
}

/** The same mirror as the transport's, applied to a lane's own box. */
function fractionFrom(rect: DOMRect, clientX: number): number {
  if (rect.width === 0) return 0;
  const along = rtl.value ? rect.right - clientX : clientX - rect.left;
  return Math.min(Math.max(along / rect.width, 0), 1);
}

function laneRect(event: PointerEvent): DOMRect | null {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return null;
  const lane = target.closest('.rv-lanes__lane');
  return lane instanceof HTMLElement ? lane.getBoundingClientRect() : null;
}

/** Monotonic within the session; only has to be unique, never meaningful. */
let gestureSeq = 0;
let gesture: string | null = null;

function onKeyDown(track: Track, index: number, value: number, event: KeyboardEvent): void {
  const step = event.shiftKey ? 10 : 1;
  const keyframe = track.keyframes[index];
  if (keyframe === undefined) return;
  switch (event.key) {
    case 'ArrowRight':
      emit('move', {
        trackId: track.id,
        index,
        timeMs: keyframe.timeMs + sign.value * step * frameMs.value,
        value,
      });
      break;
    case 'ArrowLeft':
      emit('move', {
        trackId: track.id,
        index,
        timeMs: keyframe.timeMs - sign.value * step * frameMs.value,
        value,
      });
      break;
    // Up and down change the *value*, which has no direction and therefore does not
    // mirror: up is more in both scripts.
    case 'ArrowUp':
      emit('move', { trackId: track.id, index, timeMs: keyframe.timeMs, value: value + step });
      break;
    case 'ArrowDown':
      emit('move', { trackId: track.id, index, timeMs: keyframe.timeMs, value: value - step });
      break;
    default:
      return;
  }
  event.preventDefault();
}

function onPointerDown(track: Track, index: number, event: PointerEvent): void {
  emit('select', { trackId: track.id, index });
  gestureSeq += 1;
  gesture = `${track.id}:${String(index)}:${String(gestureSeq)}`;
  const target = event.currentTarget;
  if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId);
}

function endGesture(): void {
  gesture = null;
}

function onPointerMove(track: Track, index: number, value: number, event: PointerEvent): void {
  if (event.buttons === 0 || gesture === null) return;
  const rect = laneRect(event);
  if (rect === null) return;
  emit('move', {
    trackId: track.id,
    index,
    timeMs: fractionFrom(rect, event.clientX) * props.ir.durationMs,
    value,
    gesture,
  });
}

function isSelected(track: Track, index: number): boolean {
  return props.selection?.trackId === track.id && props.selection.index === index;
}
</script>

<template>
  <section class="rv-lanes" aria-labelledby="rv-lanes-heading">
    <h2 id="rv-lanes-heading" class="rv-lanes__title">{{ t('timeline.tracks.heading') }}</h2>

    <p v-if="lanes.length === 0" class="rv-lanes__hint">{{ t('timeline.tracks.none') }}</p>

    <div v-else class="rv-lanes__grid">
      <!-- markers first: they are the reading of the shot everything else hangs off -->
      <p class="rv-lanes__label">{{ t('timeline.tracks.markers') }}</p>
      <div class="rv-lanes__lane rv-lanes__lane--markers">
        <span
          class="rv-lanes__playhead"
          :style="{ '--rv-at': `${String(playheadPercent)}%` }"
          aria-hidden="true"
        />
        <button
          v-for="marker in ir.markers"
          :key="marker.id"
          type="button"
          class="rv-lanes__marker"
          :style="{ '--rv-at': `${String(percentOf(marker.timeMs))}%` }"
          :data-kind="marker.kind"
          @click="emit('seek', marker.timeMs)"
        >
          <span class="rv-visually-hidden">
            {{ t(`timeline.markerKind.${marker.kind}`) }} — {{ marker.label }}
          </span>
          <span class="rv-lanes__marker-label" aria-hidden="true">{{ marker.label }}</span>
        </button>
      </div>

      <template v-for="lane in lanes" :key="lane.track.id">
        <div class="rv-lanes__label">
          <span class="rv-lanes__channel rv-mono" dir="ltr">{{ lane.track.channel }}</span>
          <span class="rv-lanes__node">{{ lane.nodeName }}</span>
          <!--
            Where this track's motion comes from. Today the IR can only say "keyframes"
            and "keyframes over a behaviour"; when it declares a provider outright, this
            badge reads the field and nothing else here changes.
          -->
          <AppBadge :tone="lane.source.editsAreLiteral ? 'neutral' : 'warning'">
            <template #icon>
              <PhWaveSine v-if="!lane.source.editsAreLiteral" :size="12" aria-hidden="true" />
            </template>
            {{ t(MOTION_SOURCE_KEYS[lane.source.kind]) }}
          </AppBadge>
        </div>

        <div class="rv-lanes__lane" :data-literal="lane.source.editsAreLiteral">
          <span
            class="rv-lanes__playhead"
            :style="{ '--rv-at': `${String(playheadPercent)}%` }"
            aria-hidden="true"
          />
          <button
            v-for="(keyframe, index) in lane.track.keyframes"
            :key="`${lane.track.id}:${String(index)}`"
            type="button"
            class="rv-lanes__key"
            :style="{ '--rv-at': `${String(percentOf(keyframe.timeMs))}%` }"
            :data-selected="isSelected(lane.track, index)"
            :aria-pressed="isSelected(lane.track, index)"
            :aria-label="
              t('timeline.tracks.select', {
                index: formatNumber(index + 1, localeStore.locale),
                channel: lane.track.channel,
              }) +
              ' ' +
              t('timeline.keyframe.at', {
                ms: formatNumber(keyframe.timeMs, localeStore.locale),
                value: formatNumber(keyframe.value, localeStore.locale, {
                  maximumFractionDigits: 2,
                }),
              })
            "
            @pointerdown="onPointerDown(lane.track, index, $event)"
            @pointermove="onPointerMove(lane.track, index, keyframe.value, $event)"
            @pointerup="endGesture"
            @pointercancel="endGesture"
            @lostpointercapture="endGesture"
            @keydown="onKeyDown(lane.track, index, keyframe.value, $event)"
            @focus="emit('select', { trackId: lane.track.id, index })"
          />
        </div>

        <p
          v-if="MOTION_CONSEQUENCE_KEYS[lane.source.kind]"
          class="rv-lanes__consequence"
          data-testid="motion-consequence"
        >
          {{
            t(MOTION_CONSEQUENCE_KEYS[lane.source.kind] ?? '', {
              behaviours: lane.source.contenders
                .map((kind) => t(`timeline.behaviourKind.${kind}`))
                .join('، '),
            })
          }}
        </p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.rv-lanes {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-3);
}

.rv-lanes__title {
  font-size: var(--rv-text-lg);
}

.rv-lanes__hint {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
}

.rv-lanes__grid {
  display: grid;
  grid-template-columns: minmax(9rem, 14rem) minmax(0, 1fr);
  gap: var(--rv-space-2) var(--rv-space-3);
  align-items: center;
}

.rv-lanes__label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-1);
  font-size: var(--rv-text-xs);
}

.rv-lanes__channel {
  font-weight: var(--rv-weight-semibold);
  color: var(--rv-color-text);
}

.rv-lanes__node {
  color: var(--rv-color-text-muted);
}

.rv-lanes__lane {
  position: relative;
  block-size: 2.25rem;
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-sm);
  background-color: var(--rv-color-surface-sunken);
  touch-action: none;
}

/* A lane whose channel a behaviour also drives is drawn as a weave rather than a flat
   fill: the value on screen is not only what the keyframes say. */
.rv-lanes__lane[data-literal='false'] {
  background-image: repeating-linear-gradient(
    135deg,
    transparent 0 6px,
    var(--rv-color-warning-soft) 6px 12px
  );
}

.rv-lanes__lane--markers {
  block-size: 1.75rem;
  background-color: transparent;
  border-style: dashed;
}

.rv-lanes__playhead {
  position: absolute;
  inset-block: -2px;
  inset-inline-start: var(--rv-at, 0%);
  inline-size: 2px;
  margin-inline-start: -1px;
  background-color: var(--rv-color-accent);
}

.rv-lanes__key {
  position: absolute;
  inset-block-start: 50%;
  inset-inline-start: var(--rv-at, 0%);
  /* 24x24 target for WCAG 2.2 SC 2.5.8; the diamond inside it is 12px of ink. */
  inline-size: 1.5rem;
  block-size: 1.5rem;
  margin-inline-start: -0.75rem;
  margin-block-start: -0.75rem;
  padding: 0;
  border: none;
  background: none;
  cursor: grab;
}

.rv-lanes__key::before {
  content: '';
  position: absolute;
  inset: 0.375rem;
  background-color: var(--rv-color-accent);
  border: var(--rv-border-width) solid var(--rv-color-surface);
  transform: rotate(45deg);
  transition: background-color var(--rv-duration-instant) var(--rv-ease-standard);
}

.rv-lanes__key:hover::before {
  background-color: var(--rv-color-accent-hover);
}

/* Selected is a shape change as well as a colour one: a diamond that grows and gains a
   gold edge, so the state survives a reader who cannot separate the two hues. */
.rv-lanes__key[data-selected='true']::before {
  inset: 0.25rem;
  background-color: var(--rv-color-mark);
  border-color: var(--rv-color-mark-strong);
}

.rv-lanes__marker {
  position: absolute;
  inset-block: 0;
  inset-inline-start: var(--rv-at, 0%);
  display: flex;
  align-items: center;
  gap: var(--rv-space-1);
  min-inline-size: 1.5rem;
  min-block-size: 1.5rem;
  padding: 0;
  padding-inline-start: var(--rv-space-1);
  border: none;
  border-inline-start: 2px solid var(--rv-color-mark);
  background: none;
  cursor: pointer;
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-2xs);
  white-space: nowrap;
}

.rv-lanes__marker-label {
  overflow: hidden;
  text-overflow: ellipsis;
  max-inline-size: 9rem;
}

.rv-lanes__consequence {
  grid-column: 1 / -1;
  padding-block: var(--rv-space-1);
  padding-inline: var(--rv-space-2);
  border-inline-start: 3px solid var(--rv-color-warning);
  background-color: var(--rv-color-warning-soft);
  border-radius: var(--rv-radius-sm);
  color: var(--rv-color-warning);
  font-size: var(--rv-text-xs);
  line-height: var(--rv-leading-snug);
}
</style>
