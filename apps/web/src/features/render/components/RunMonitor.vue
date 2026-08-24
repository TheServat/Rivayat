<script setup lang="ts">
import {
  PhBroadcast,
  PhCheckCircle,
  PhCircleDashed,
  PhProhibit,
  PhWarningOctagon,
} from '@phosphor-icons/vue';
import type { PipelineStageKey, RunId } from '@rv/contracts';
import { useNow } from '@vueuse/core';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import AppBadge from '../../../components/AppBadge.vue';
import AppButton from '../../../components/AppButton.vue';
import ErrorNotice from '../../../components/ErrorNotice.vue';
import RegistrationMark from '../../../components/RegistrationMark.vue';
import type { ApiError } from '../../../api/errors';
import { formatInstant, formatNanoUsd, formatNumber, formatPercent } from '../../../i18n/format';
import { useLocaleStore } from '../../../stores/locale.store';
import { elapsedBetween, formatClock } from '../duration';
import { STAGE_KEYS, STATUS_KEYS, STREAM_KEYS } from '../labels';
import type { LiveRunState } from '../render.store';
import {
  isLiveRunStatus,
  type RunStageResult,
  type RunSummary,
  type RunStatus,
} from '../render-wire';
import type { RunStreamState } from '../../../api/run-stream';

/**
 * A render takes minutes, which is well past the point where someone will leave and
 * come back. So this panel is built around three things rather than around a spinner:
 *
 *  - **It is not a modal.** The run has a URL, the page can be closed, and the panel
 *    says so in words. A dialog the user must not close is the failure mode this
 *    screen was written to avoid.
 *  - **Resume is a first-class button**, not a recovery path. The run is checkpointed
 *    by content hash, so a killed render finds the frames it already wrote; hiding
 *    that behind "start again" throws away the whole mechanism.
 *  - **Progress steps.** The house rule is that the interface interpolates when a
 *    person drives it and steps when the machine does. A render is the machine
 *    driving, so the bar advances in twelve discrete positions a second - the cadence
 *    of the animation the studio itself produces - while the buttons beside it glide.
 */
const props = defineProps<{
  run: RunSummary | null;
  runs: readonly RunSummary[];
  live: LiveRunState;
  streamState: RunStreamState;
  streamError: ApiError | null;
  acting: 'cancel' | 'resume' | null;
  actionError: ApiError | null;
}>();

const emit = defineEmits<{
  select: [runId: RunId];
  cancel: [];
  resume: [];
  retry: [];
}>();

const { t } = useI18n();
const localeStore = useLocaleStore();

/**
 * A one-second tick, for the elapsed clock of a run that is still going.
 *
 * Presentation only, and deliberately not in the store: non-negotiable #1 keeps the
 * wall clock out of domain and application code, and "how long has this been running"
 * is neither. A finished run reads its elapsed time from its own two timestamps and
 * never consults this.
 */
const now = useNow({ interval: 1000 });

const locale = computed(() => localeStore.locale);

const isLive = computed(() => props.run !== null && isLiveRunStatus(props.run.status));

const elapsedMs = computed(() => {
  const run = props.run;
  if (run === null) return null;
  if (run.finishedAt !== null) return elapsedBetween(run.startedAt, run.finishedAt);
  const started = Date.parse(run.startedAt);
  return Number.isNaN(started) ? null : Math.max(0, now.value.getTime() - started);
});

const stageResults = computed(() => {
  const run = props.run;
  if (run === null) return new Map<PipelineStageKey, RunStageResult>();
  return new Map(run.stages.map((stage) => [stage.stage, stage]));
});

function stageStatus(stage: PipelineStageKey): RunStatus | null {
  return stageResults.value.get(stage)?.status ?? null;
}

/**
 * How far into a stage we are: the stream's figure while it is running, and the
 * record's verdict once it has finished.
 *
 * The stream is preferred because it is the only source that knows about the *middle*
 * of a stage. The record is authoritative at the ends, which is why a completed stage
 * reads 1 even if the last progress frame it sent was 0.7 before the socket dropped.
 */
function stageFraction(stage: PipelineStageKey): number {
  const status = stageStatus(stage);
  if (status === 'succeeded') return 1;
  if (status === 'failed' || status === 'cancelled') return 1;
  return props.live.progress.get(stage) ?? 0;
}

const overall = computed(() => {
  const run = props.run;
  if (run === null || run.requestedStages.length === 0) return 0;
  const total = run.requestedStages.reduce((sum, stage) => sum + stageFraction(stage), 0);
  return total / run.requestedStages.length;
});

/** Live total when the stream has one, the record's denormalised sum otherwise. */
const spentNanoUsd = computed(() => props.live.costNanoUsd ?? props.run?.spentNanoUsd ?? 0);

const canCancel = computed(
  () => props.run !== null && (props.run.status === 'queued' || props.run.status === 'running'),
);

/**
 * Everything except `succeeded` and `cancelled`, which are the only two the runner
 * refuses outright.
 *
 * `queued` and `running` are on the list on purpose, and it is the case that matters
 * most. A run whose worker was killed leaves a row that still says `running` with
 * nothing behind it - the runner records that as `WORKER_LOST` and re-queues it, which
 * is the documented path back. Restricting the button to `failed` would make the one
 * render a user most needs to rescue the one they cannot, because nothing ever wrote a
 * terminal state for it. If the run really is executing, the server answers 409 saying
 * so, and that is a sentence someone can act on; a dead end is not.
 *
 * `cancelled` genuinely has no outgoing edge in `PIPELINE_STATUS_TRANSITIONS`, so it
 * gets a note rather than a button: continuing is a *new* run, which finds the same
 * frames because the render checkpoint is keyed by content and not by run id.
 */
const canResume = computed(
  () => props.run !== null && props.run.status !== 'succeeded' && props.run.status !== 'cancelled',
);

/** True for the two states where resume is a rescue rather than a continuation. */
const isRecovery = computed(
  () => props.run !== null && (props.run.status === 'queued' || props.run.status === 'running'),
);

const artifacts = computed(() => {
  const run = props.run;
  if (run === null) return [];
  return run.stages.flatMap((stage) =>
    stage.artifacts.map((artifact) => {
      const at = artifact.indexOf(':');
      return {
        id: `${stage.stage}:${artifact}`,
        kind: at === -1 ? artifact : artifact.slice(0, at),
        ref: at === -1 ? '' : artifact.slice(at + 1),
      };
    }),
  );
});

const budget = computed(() => {
  const run = props.run;
  if (run?.budgetNanoUsd == null || run.budgetNanoUsd <= 0) return null;
  return {
    ceiling: run.budgetNanoUsd,
    spent: spentNanoUsd.value,
    fraction: Math.min(1, spentNanoUsd.value / run.budgetNanoUsd),
    over: spentNanoUsd.value > run.budgetNanoUsd,
  };
});

const statusTone = (status: RunStatus): 'neutral' | 'info' | 'success' | 'danger' | 'warning' => {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'neutral';
  if (status === 'paused') return 'warning';
  return 'info';
};

function runOptionLabel(run: RunSummary): string {
  return `${formatInstant(run.startedAt, locale.value)} · ${t(STATUS_KEYS[run.status])}`;
}
</script>

<template>
  <section class="rv-run" aria-labelledby="rv-run-heading">
    <header class="rv-run__head">
      <div class="rv-run__title">
        <h2 id="rv-run-heading">{{ t('render.run.heading') }}</h2>
        <p class="rv-run__lead">{{ t('render.run.lead') }}</p>
      </div>

      <div v-if="runs.length > 0" class="rv-run__picker">
        <label class="rv-run__picker-label" for="rv-run-select">{{ t('render.run.picker') }}</label>
        <select
          id="rv-run-select"
          class="rv-run__select"
          :value="run?.id ?? ''"
          @change="emit('select', ($event.target as HTMLSelectElement).value as RunId)"
        >
          <option v-for="entry in runs" :key="entry.id" :value="entry.id">
            {{ runOptionLabel(entry) }}
          </option>
        </select>
      </div>
    </header>

    <p v-if="run === null" class="rv-run__none">
      {{ t('render.run.none') }}
      <span class="rv-run__none-hint">{{ t('render.run.noneHint') }}</span>
    </p>

    <div v-else class="rv-run__sheet rv-sheet">
      <div class="rv-run__summary">
        <AppBadge :tone="statusTone(run.status)">
          <template #icon>
            <PhCheckCircle
              v-if="run.status === 'succeeded'"
              :size="13"
              weight="fill"
              aria-hidden="true"
            />
            <PhWarningOctagon
              v-else-if="run.status === 'failed'"
              :size="13"
              weight="fill"
              aria-hidden="true"
            />
            <PhProhibit
              v-else-if="run.status === 'cancelled'"
              :size="13"
              weight="bold"
              aria-hidden="true"
            />
            <PhCircleDashed v-else :size="13" weight="bold" aria-hidden="true" />
          </template>
          {{ t(STATUS_KEYS[run.status]) }}
        </AppBadge>

        <!--
          The live badge is state, not decoration: "the run is quiet" and "the socket
          is dead" look identical without it, and the difference is four minutes of a
          user watching a bar that will never move.
        -->
        <span v-if="isLive" class="rv-run__stream" :data-state="streamState">
          <RegistrationMark :busy="streamState === 'open' || streamState === 'connecting'" />
          {{ t(STREAM_KEYS[streamState]) }}
        </span>

        <span class="rv-run__meta rv-tabular">{{
          t('render.run.started', { when: formatInstant(run.startedAt, locale) })
        }}</span>
        <span v-if="run.finishedAt" class="rv-run__meta rv-tabular">{{
          t('render.run.finished', { when: formatInstant(run.finishedAt, locale) })
        }}</span>
        <span v-if="elapsedMs !== null" class="rv-run__meta rv-tabular">
          {{ t('render.run.elapsed') }}
          <bdi>{{ formatClock(elapsedMs, locale) }}</bdi>
        </span>
        <span class="rv-run__meta rv-tabular">{{
          t('render.run.seed', { seed: formatNumber(run.seed, locale, { useGrouping: false }) })
        }}</span>
      </div>

      <!--
        The fill is coloured by outcome, not by amount. A run that failed at stage one
        of two still reads 100 % on the "how far did it get" question, and painting that
        in the accent - the colour of everything going well - tells someone their broken
        render finished. Failed is danger ink, cancelled is grey, and the two are
        distinguishable at a glance from across the room.
      -->
      <div
        class="rv-run__bar"
        :data-status="run.status"
        role="progressbar"
        :aria-valuenow="Math.round(overall * 100)"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuetext="t('render.run.progress', { percent: formatPercent(overall, locale) })"
      >
        <span class="rv-run__fill" :style="{ inlineSize: `${overall * 100}%` }" />
      </div>

      <ol class="rv-run__stages">
        <li v-for="stage in run.requestedStages" :key="stage" class="rv-run__stage">
          <span class="rv-run__stage-name">{{ t(STAGE_KEYS[stage]) }}</span>
          <AppBadge
            v-if="stageStatus(stage)"
            :tone="statusTone(stageResults.get(stage)?.status ?? 'queued')"
          >
            {{ t(STATUS_KEYS[stageResults.get(stage)?.status ?? 'queued']) }}
          </AppBadge>
          <AppBadge v-else tone="neutral">{{ t('render.status.queued') }}</AppBadge>
          <span class="rv-run__stage-figure rv-tabular">
            <bdi>{{ formatClock(stageResults.get(stage)?.durationMs ?? 0, locale) }}</bdi>
          </span>
          <span class="rv-run__stage-figure rv-tabular">{{
            formatNanoUsd(stageResults.get(stage)?.costNanoUsd ?? 0, locale)
          }}</span>
          <!-- An input hash is what makes a resume skip a stage rather than redo it,
               so it is worth saying which stages are already banked. -->
          <span v-if="stageResults.get(stage)?.inputHash" class="rv-run__stage-flag">
            {{ t('render.run.checkpoint') }}
          </span>
        </li>
      </ol>

      <div v-if="budget" class="rv-run__budget">
        <p class="rv-run__budget-label">{{ t('render.cost.budget.label') }}</p>
        <div
          class="rv-run__bar rv-run__bar--budget"
          :data-over="budget.over"
          role="progressbar"
          :aria-valuenow="Math.round(budget.fraction * 100)"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuetext="
            t('render.cost.budget.spent', {
              spent: formatNanoUsd(budget.spent, locale),
              ceiling: formatNanoUsd(budget.ceiling, locale),
            })
          "
        >
          <span class="rv-run__fill" :style="{ inlineSize: `${budget.fraction * 100}%` }" />
        </div>
        <p class="rv-run__budget-figure rv-tabular">
          {{
            t('render.cost.budget.spent', {
              spent: formatNanoUsd(budget.spent, locale),
              ceiling: formatNanoUsd(budget.ceiling, locale),
            })
          }}
          <span v-if="budget.over" class="rv-run__budget-over">{{
            t('render.cost.budget.over')
          }}</span>
        </p>
      </div>

      <!--
        A user stopping a render and a render breaking are different events, so they
        get different words, different colour, different iconography and different
        exits. Collapsing them into one "stopped" treatment tells someone their work
        broke when in fact they stopped it, which is the more alarming of the two
        readings and the wrong one.
      -->
      <p v-if="run.status === 'cancelled'" class="rv-run__note">
        {{ t('render.run.cancelledNote') }}
      </p>
      <template v-else-if="run.status === 'failed'">
        <p class="rv-run__note rv-run__note--broke">{{ t('render.run.failedNote') }}</p>
        <p v-if="run.errorCode" class="rv-run__error rv-mono">
          {{ t('render.run.errorCode', { code: run.errorCode }) }}
        </p>
      </template>
      <p v-else-if="run.errorCode" class="rv-run__error rv-mono">
        {{ t('render.run.errorCode', { code: run.errorCode }) }}
      </p>

      <div v-if="live.issues.length > 0" class="rv-run__issues">
        <h3 class="rv-eyebrow">{{ t('render.run.issues') }}</h3>
        <ul>
          <li v-for="issue in live.issues" :key="issue.seq" :data-severity="issue.severity">
            <span class="rv-mono">{{ issue.code }}</span>
            <span>{{ issue.message }}</span>
          </li>
        </ul>
      </div>

      <div class="rv-run__artifacts">
        <h3 class="rv-eyebrow">{{ t('render.run.artifacts') }}</h3>
        <p v-if="artifacts.length === 0" class="rv-run__quiet">{{ t('render.run.noArtifacts') }}</p>
        <ul v-else>
          <li v-for="artifact in artifacts" :key="artifact.id">
            <AppBadge tone="neutral">{{ artifact.kind }}</AppBadge>
            <span class="rv-mono">{{ artifact.ref }}</span>
          </li>
        </ul>
        <!-- Whether each file satisfies its platform spec is a probe of the finished
             bytes, and nothing serves that result yet. Saying so beats a green tick. -->
        <p class="rv-run__quiet">{{ t('render.spec.awaitingHint') }}</p>
      </div>

      <div class="rv-run__controls">
        <AppButton
          v-if="canCancel"
          variant="danger"
          :disabled="acting !== null"
          @click="emit('cancel')"
        >
          {{ acting === 'cancel' ? t('render.run.cancelling') : t('render.run.cancel') }}
        </AppButton>
        <AppButton
          v-if="canResume"
          :variant="isRecovery ? 'secondary' : 'primary'"
          :disabled="acting !== null"
          @click="emit('resume')"
        >
          <PhBroadcast :size="15" aria-hidden="true" />
          {{ acting === 'resume' ? t('render.run.resuming') : t('render.run.resume') }}
        </AppButton>
        <p v-if="isRecovery" class="rv-run__quiet">{{ t('render.run.recoverHint') }}</p>
        <p v-else-if="canResume" class="rv-run__quiet">{{ t('render.run.resumeHint') }}</p>
        <p v-if="isLive" class="rv-run__quiet">{{ t('render.run.survivable') }}</p>
      </div>

      <ErrorNotice v-if="actionError" :error="actionError" @retry="emit('retry')" />
      <ErrorNotice v-else-if="streamError" :error="streamError" @retry="emit('retry')" />
    </div>
  </section>
</template>

<style scoped>
.rv-run {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
}

.rv-run__head {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  justify-content: space-between;
  gap: var(--rv-space-4);
}

.rv-run__title {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-run__title h2 {
  font-size: var(--rv-text-lg);
}

.rv-run__lead {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
}

.rv-run__picker {
  display: flex;
  align-items: center;
  gap: var(--rv-space-2);
}

.rv-run__picker-label {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.rv-run__select {
  min-block-size: 2.25rem;
  padding-block: var(--rv-space-1);
  padding-inline: var(--rv-space-2);
  background-color: var(--rv-color-surface);
  border: var(--rv-border-width) solid var(--rv-color-border-strong);
  border-radius: var(--rv-radius-md);
  font-size: var(--rv-text-sm);
}

.rv-run__none {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  padding: var(--rv-space-5);
  background-color: var(--rv-color-surface);
  border: var(--rv-border-width) dashed var(--rv-color-border-strong);
  border-radius: var(--rv-radius-lg);
}

.rv-run__none-hint {
  color: var(--rv-color-text-muted);
  font-size: var(--rv-text-sm);
}

.rv-run__sheet {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-4);
  padding: var(--rv-space-4);
}

.rv-run__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2) var(--rv-space-4);
}

.rv-run__stream {
  display: inline-flex;
  align-items: center;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-xs);
  color: var(--rv-color-accent);
}

.rv-run__stream[data-state='reconnecting'],
.rv-run__stream[data-state='failed'] {
  color: var(--rv-color-warning);
}

.rv-run__meta {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.rv-run__bar {
  position: relative;
  block-size: 0.5rem;
  background-color: var(--rv-color-surface-sunken);
  border: var(--rv-border-width) solid var(--rv-color-border);
  border-radius: var(--rv-radius-pill);
  overflow: hidden;
}

/*
 * The one place this interface deliberately refuses to interpolate.
 *
 * A render is the machine working, and the house rule is that machine-driven motion is
 * held on 2s. So the fill advances in twelve discrete positions a second - the cadence
 * of the animation the studio itself produces - instead of gliding. After a minute on
 * this screen you can tell a run is moving without reading the number.
 */
.rv-run__fill {
  display: block;
  block-size: 100%;
  background-color: var(--rv-color-accent);
  transition: inline-size var(--rv-duration-deliberate) var(--rv-step-2s-long);
}

.rv-run__bar[data-status='succeeded'] .rv-run__fill {
  background-color: var(--rv-color-success);
}

.rv-run__bar[data-status='failed'] .rv-run__fill {
  background-color: var(--rv-color-danger);
}

.rv-run__bar[data-status='cancelled'] .rv-run__fill {
  background-color: var(--rv-color-text-faint);
}

.rv-run__bar[data-status='paused'] .rv-run__fill {
  background-color: var(--rv-color-warning);
}

.rv-run__bar--budget .rv-run__fill {
  background-color: var(--rv-color-mark);
}

.rv-run__bar--budget[data-over='true'] .rv-run__fill {
  background-color: var(--rv-color-danger);
}

.rv-run__stages {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
}

.rv-run__stage {
  display: grid;
  grid-template-columns: minmax(6rem, 1fr) auto auto auto auto;
  align-items: center;
  gap: var(--rv-space-3);
  padding-block: var(--rv-space-2);
  border-block-end: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-run__stage:last-child {
  border-block-end: none;
}

.rv-run__stage-name {
  font-size: var(--rv-text-sm);
  font-weight: var(--rv-weight-medium);
}

.rv-run__stage-figure {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.rv-run__stage-flag {
  font-size: var(--rv-text-2xs);
  color: var(--rv-color-success);
}

.rv-run__budget {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-2);
}

.rv-run__budget-label {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
}

.rv-run__budget-figure {
  font-size: var(--rv-text-sm);
}

.rv-run__budget-over {
  color: var(--rv-color-danger);
  font-weight: var(--rv-weight-medium);
  margin-inline-start: var(--rv-space-2);
}

.rv-run__error {
  color: var(--rv-color-danger);
}

/* Two stops, two treatments. Cancelled reads as quiet and finished; failed reads as a
   fault, with the ink and the rule that go with one. */
.rv-run__note {
  font-size: var(--rv-text-sm);
  color: var(--rv-color-text-muted);
  padding-inline-start: var(--rv-space-3);
  border-inline-start: 2px solid var(--rv-color-border-strong);
}

.rv-run__note--broke {
  color: var(--rv-color-danger);
  border-inline-start-color: var(--rv-color-danger);
}

.rv-run__issues ul,
.rv-run__artifacts ul {
  display: flex;
  flex-direction: column;
  gap: var(--rv-space-1);
  margin-block-start: var(--rv-space-2);
}

.rv-run__issues li,
.rv-run__artifacts li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-2);
  font-size: var(--rv-text-sm);
}

.rv-run__issues li[data-severity='error'] {
  color: var(--rv-color-danger);
}

.rv-run__issues li[data-severity='warning'] {
  color: var(--rv-color-warning);
}

.rv-run__quiet {
  font-size: var(--rv-text-xs);
  color: var(--rv-color-text-muted);
  margin-block-start: var(--rv-space-2);
}

.rv-run__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--rv-space-3);
  padding-block-start: var(--rv-space-2);
  border-block-start: var(--rv-border-width) solid var(--rv-color-border);
}

.rv-run__controls .rv-run__quiet {
  margin-block-start: 0;
  max-inline-size: 30rem;
}
</style>
