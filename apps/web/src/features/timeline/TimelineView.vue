<script setup lang="ts">
import { PhArrowCounterClockwise, PhArrowClockwise } from '@phosphor-icons/vue';
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../components/AppBadge.vue';
import AppButton from '../../components/AppButton.vue';
import AppSkeleton from '../../components/AppSkeleton.vue';
import EmptyState from '../../components/EmptyState.vue';
import ErrorNotice from '../../components/ErrorNotice.vue';
import TimelineMotif from '../../components/motifs/TimelineMotif.vue';
import { formatNumber } from '../../i18n/format';
import { useLocaleStore } from '../../stores/locale.store';

import BehaviourInspector from './BehaviourInspector.vue';
import ScenePlayer from './ScenePlayer.vue';
import TrackLanes from './TrackLanes.vue';
import TransportBar from './TransportBar.vue';
import type { IrOp, SetBehaviourParamOp } from './ir-ops';
import { useTimelineStore } from './timeline.store';

/**
 * The timeline: a preview that agrees with the renderer, and edits that undo.
 *
 * **Playback reads no clock.** The loop below takes the timestamp `requestAnimationFrame`
 * hands it and derives `t` from the start of the run: `t = startTime + elapsed`. It
 * never accumulates per-frame deltas, so playing to 4.2s and scrubbing to 4.2s set the
 * same state, and a dropped frame changes nothing about which frame is shown next. That
 * is also why nothing here calls `performance.now()` - the callback argument is the
 * only time source, and CLAUDE.md's first non-negotiable stays intact.
 *
 * **Every edit is one typed op with a declared inverse.** Dragging a keyframe issues
 * `moveKeyframe`; moving a slider issues `setBehaviourParam`. Undo restores the previous
 * IR object, which is exact rather than approximate because ops never mutate. There is
 * no confirmation dialog anywhere on this screen: everything here is reversible, and a
 * dialog on a reversible action trains people to click through the one that is not.
 */
const { t } = useI18n();
const timeline = useTimelineStore();
const localeStore = useLocaleStore();

let rafId: number | null = null;
/** The wall position playback started from, and the timestamp it started at. */
let startTimeMs = 0;
let startStamp: number | null = null;

function tick(stamp: number): void {
  if (!timeline.playing || timeline.ir === null) return;
  startStamp ??= stamp;
  const elapsed = stamp - startStamp;
  const next = startTimeMs + elapsed;
  if (next >= timeline.durationMs) {
    if (timeline.looping) {
      // Restart from the top rather than wrapping the modulus of an accumulated total:
      // the second is arithmetic on a number that has been added to sixty times a
      // second and is the reason long playbacks drift.
      startTimeMs = 0;
      startStamp = stamp;
      timeline.seek(0);
    } else {
      timeline.seek(timeline.durationMs);
      timeline.setPlaying(false);
      return;
    }
  } else {
    timeline.seek(next);
  }
  rafId = globalThis.requestAnimationFrame(tick);
}

function stopLoop(): void {
  if (rafId !== null) globalThis.cancelAnimationFrame(rafId);
  rafId = null;
  startStamp = null;
}

watch(
  () => timeline.playing,
  (playing) => {
    stopLoop();
    if (!playing) return;
    startTimeMs = timeline.timeMs >= timeline.durationMs ? 0 : timeline.timeMs;
    if (startTimeMs === 0) timeline.seek(0);
    rafId = globalThis.requestAnimationFrame(tick);
  },
);

onMounted(() => {
  void timeline.load();
  globalThis.addEventListener('keydown', onGlobalKey);
});

onBeforeUnmount(() => {
  stopLoop();
  globalThis.removeEventListener('keydown', onGlobalKey);
});

/** Ctrl+Z and Ctrl+Shift+Z, because undo is the whole safety net on this screen. */
function onGlobalKey(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
  event.preventDefault();
  if (event.shiftKey) timeline.redo();
  else timeline.undo();
}

const OP_KEYS: Readonly<Record<IrOp['kind'], string>> = {
  moveKeyframe: 'timeline.op.moveKeyframe',
  setEasing: 'timeline.op.setEasing',
  setBehaviourParam: 'timeline.op.setBehaviourParam',
};

const refusalMessage = computed(() => {
  const refusal = timeline.refusal;
  if (refusal === null) return null;
  return t(`timeline.refusal.${refusal.code}`, { subject: refusal.subject });
});

const selectedKeyframe = computed(() => {
  const selection = timeline.selection;
  const document = timeline.ir;
  if (selection === null || document === null) return null;
  const track = document.tracks.find((candidate) => candidate.id === selection.trackId);
  const keyframe = track?.keyframes[selection.index];
  return track === undefined || keyframe === undefined ? null : { track, keyframe };
});

function move(payload: {
  trackId: string;
  index: number;
  timeMs: number;
  value: number;
  gesture?: string;
}): void {
  const { gesture, ...op } = payload;
  // One drag, one undo entry. Passed through rather than inferred, because only the lane
  // knows where a gesture starts and ends.
  timeline.apply({ kind: 'moveKeyframe', ...op }, gesture);
}

function changeBehaviour(op: SetBehaviourParamOp): void {
  timeline.apply(op);
}
</script>

<template>
  <div class="rv-timeline">
    <header class="rv-timeline__header">
      <h1 class="rv-timeline__title">{{ t('timeline.title') }}</h1>
      <p class="rv-timeline__subtitle">{{ t('timeline.subtitle') }}</p>
    </header>

    <template v-if="timeline.status === 'loading'">
      <p class="rv-visually-hidden" role="status">{{ t('timeline.loading') }}</p>
      <div class="rv-timeline__layout" aria-hidden="true">
        <div class="rv-sheet rv-timeline__panel">
          <AppSkeleton inline-size="100%" block-size="18rem" shape="block" />
          <AppSkeleton inline-size="60%" block-size="0.875rem" />
          <AppSkeleton inline-size="100%" block-size="2rem" shape="block" />
        </div>
        <div class="rv-sheet rv-timeline__panel">
          <AppSkeleton inline-size="40%" block-size="1.25rem" />
          <AppSkeleton
            v-for="row in 4"
            :key="row"
            inline-size="100%"
            block-size="2.25rem"
            shape="block"
          />
        </div>
      </div>
    </template>

    <section
      v-else-if="timeline.status === 'unavailable'"
      class="rv-timeline__unavailable rv-sheet"
      role="status"
    >
      <h2 class="rv-timeline__unavailable-title">{{ t('timeline.unavailable.heading') }}</h2>
      <p class="rv-timeline__subtitle">{{ t('timeline.unavailable.body') }}</p>
      <p class="rv-mono rv-timeline__hint" dir="ltr">
        {{ t('timeline.unavailable.endpoint', { method: 'GET', path: '/api/animations' }) }}
      </p>
      <p class="rv-timeline__hint">{{ t('timeline.unavailable.story', { story: 'RV-211' }) }}</p>
    </section>

    <ErrorNotice
      v-else-if="timeline.status === 'error' && timeline.error"
      :error="timeline.error"
      @retry="timeline.load()"
    />

    <EmptyState v-else-if="timeline.ir === null">
      <template #art>
        <TimelineMotif />
      </template>
      <p class="rv-timeline__lead">{{ t('timeline.empty.heading') }}</p>
      <p class="rv-timeline__subtitle">{{ t('timeline.empty.body') }}</p>
    </EmptyState>

    <template v-else>
      <div class="rv-timeline__layout">
        <div class="rv-sheet rv-timeline__panel">
          <ScenePlayer :ir="timeline.ir" :time-ms="timeline.timeMs" />
          <TransportBar
            :ir="timeline.ir"
            :time-ms="timeline.timeMs"
            :playing="timeline.playing"
            :looping="timeline.looping"
            @seek="timeline.seek($event)"
            @step="timeline.stepFrames($event)"
            @toggle="timeline.togglePlay()"
            @toggle-loop="timeline.setLooping(!timeline.looping)"
          />
          <p class="rv-timeline__agreement">
            <strong>{{ t('timeline.agreement.heading') }}</strong>
            {{ t('timeline.agreement.body') }}
          </p>
        </div>

        <div class="rv-sheet rv-timeline__panel">
          <div class="rv-timeline__history">
            <AppButton
              size="sm"
              variant="secondary"
              :disabled="!timeline.canUndo"
              @click="timeline.undo()"
            >
              <PhArrowCounterClockwise :size="14" aria-hidden="true" />
              {{ t('timeline.history.undo') }}
            </AppButton>
            <AppButton
              size="sm"
              variant="ghost"
              :disabled="!timeline.canRedo"
              @click="timeline.redo()"
            >
              <PhArrowClockwise :size="14" aria-hidden="true" />
              {{ t('timeline.history.redo') }}
            </AppButton>
            <span class="rv-timeline__hint" data-testid="edit-count">
              {{
                t(
                  'timeline.history.edits',
                  { count: formatNumber(timeline.editCount, localeStore.locale) },
                  timeline.editCount,
                )
              }}
            </span>
            <AppBadge v-if="timeline.editCount > 0" tone="warning">
              {{ t('timeline.history.unsaved') }}
            </AppBadge>
            <span v-if="timeline.lastOp" class="rv-timeline__hint">
              {{ t(OP_KEYS[timeline.lastOp.kind]) }}
            </span>
          </div>
          <p v-if="timeline.editCount > 0" class="rv-timeline__hint">
            {{ t('timeline.history.unsavedHint') }}
          </p>

          <p v-if="refusalMessage" class="rv-timeline__refusal" role="alert">
            {{ refusalMessage }}
          </p>

          <TrackLanes
            :ir="timeline.ir"
            :time-ms="timeline.timeMs"
            :selection="timeline.selection"
            @select="timeline.select($event)"
            @move="move"
            @seek="timeline.seek($event)"
          />

          <p v-if="selectedKeyframe" class="rv-timeline__hint">
            {{ t('timeline.keyframe.heading') }}:
            <span class="rv-mono" dir="ltr">{{ selectedKeyframe.track.channel }}</span>
            {{
              t('timeline.keyframe.at', {
                ms: formatNumber(selectedKeyframe.keyframe.timeMs, localeStore.locale),
                value: formatNumber(selectedKeyframe.keyframe.value, localeStore.locale, {
                  maximumFractionDigits: 2,
                }),
              })
            }}
            &middot; {{ t('timeline.keyframe.hint') }}
          </p>
          <p v-else class="rv-timeline__hint">{{ t('timeline.keyframe.none') }}</p>

          <BehaviourInspector
            :ir="timeline.ir"
            :selected-id="timeline.selectedBehaviourId"
            @select="timeline.selectBehaviour($event)"
            @change="changeBehaviour"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.rv-timeline {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-5);
}

.rv-timeline__header {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-timeline__title {
  font-size: var(--rv-text-2xl);
}

.rv-timeline__subtitle {
  color: var(--rv-color-text-muted);
  max-inline-size: 46rem;
}

.rv-timeline__lead {
  font-size: var(--rv-text-lg);
  font-weight: var(--rv-weight-medium);
}

.rv-timeline__hint {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  line-height: var(--rv-leading-snug);
  overflow-wrap: anywhere;
}

.rv-timeline__layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--rv-space-4);
  align-items: start;
}

@media (min-width: 72rem) {
  .rv-timeline__layout {
    grid-template-columns: minmax(0, 26rem) minmax(0, 1fr);
  }
}

.rv-timeline__panel {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
  padding: var(--rv-space-4);
  min-inline-size: 0;
}

.rv-timeline__agreement {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  line-height: var(--rv-leading-snug);
  padding: var(--rv-space-2);
  border-inline-start: 3px solid var(--rv-color-accent);
  background-color: var(--rv-color-accent-soft);
  border-radius: var(--rv-radius-sm);
}

.rv-timeline__history {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-timeline__refusal {
  padding: var(--rv-space-2) var(--rv-space-3);
  border: var(--rv-border-width) solid var(--rv-color-danger);
  background-color: var(--rv-color-danger-soft);
  border-radius: var(--rv-radius-md);
  color: var(--rv-color-danger);
  font-size: var(--rv-text-sm);
}

.rv-timeline__unavailable {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
  padding: var(--rv-space-5);
  border-color: var(--rv-color-info);
  background-color: var(--rv-color-info-soft);
}

.rv-timeline__unavailable-title {
  font-size: var(--rv-text-lg);
  color: var(--rv-color-info);
}
</style>
