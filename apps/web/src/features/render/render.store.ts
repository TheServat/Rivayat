/**
 * Everything the Render and delivery screen knows.
 *
 * Three independent loads - the format table, the project's runs, the project's cost
 * report - each with its own status, and that is deliberate rather than untidy. They
 * fail independently, and the *partial* state is the common one: the platform specs
 * are static data that always arrive, while the cost report depends on a project
 * having runs. Folding the three into one status would hide seven perfectly good
 * format previews behind a failed ledger read.
 *
 * The store fetches, folds and holds. It formats nothing: money and dates depend on
 * the active locale, which is a rendering concern, and a store that pre-formatted them
 * would have to be reloaded to switch language.
 */

import type { FormatProfile, FormatProfileId, ProjectId, RunId } from '@rv/contracts';
import { defineStore } from 'pinia';
import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { useStudioApi } from '../../api/client';
import { ApiError, isApiError } from '../../api/errors';

import { RenderApi } from './render-api';
import { isLiveRunStatus, type CostReport, type RunEvent, type RunSummary } from './render-wire';
import {
  openRunStream,
  type EventSourceFactory,
  type RunStream,
  type RunStreamState,
} from '../../api/run-stream';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** One issue the run reported, kept in arrival order so the newest is last. */
export interface RunIssue {
  readonly seq: number;
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly stage: string | null;
}

/** What the stream has told us since it opened, folded. */
export interface LiveRunState {
  readonly progress: ReadonlyMap<string, number>;
  readonly costNanoUsd: number | null;
  readonly remainingNanoUsd: number | null;
  readonly issues: readonly RunIssue[];
  readonly finishedStatus: 'succeeded' | 'failed' | 'cancelled' | null;
}

const EMPTY_LIVE: LiveRunState = {
  progress: new Map(),
  costNanoUsd: null,
  remainingNanoUsd: null,
  issues: [],
  finishedStatus: null,
};

export interface RenderStore {
  readonly formats: Ref<readonly FormatProfile[]>;
  readonly formatsStatus: Ref<LoadStatus>;
  readonly formatsError: Ref<ApiError | null>;

  readonly projectId: Ref<ProjectId | null>;

  readonly runs: Ref<readonly RunSummary[]>;
  readonly runsStatus: Ref<LoadStatus>;
  readonly runsError: Ref<ApiError | null>;

  readonly cost: Ref<CostReport | null>;
  readonly costStatus: Ref<LoadStatus>;
  readonly costError: Ref<ApiError | null>;

  readonly selected: Ref<ReadonlySet<FormatProfileId>>;
  readonly selectedFormats: ComputedRef<readonly FormatProfile[]>;

  readonly activeRunId: Ref<RunId | null>;
  readonly activeRun: ComputedRef<RunSummary | null>;
  readonly live: Ref<LiveRunState>;
  readonly streamState: Ref<RunStreamState>;
  readonly streamError: Ref<ApiError | null>;
  readonly acting: Ref<'cancel' | 'resume' | null>;
  readonly actionError: Ref<ApiError | null>;

  loadFormats: () => Promise<void>;
  loadProject: (projectId: ProjectId) => Promise<void>;
  reloadRuns: () => Promise<void>;
  reloadCost: () => Promise<void>;
  selectRun: (runId: RunId | null) => void;
  toggleFormat: (id: FormatProfileId) => void;
  setSelection: (ids: readonly FormatProfileId[]) => void;
  cancelActiveRun: () => Promise<void>;
  resumeActiveRun: () => Promise<void>;
  watchActiveRun: (createEventSource?: EventSourceFactory) => void;
  stopWatching: () => void;
}

function asApiError(caught: unknown, code: string, message: string): ApiError {
  return isApiError(caught)
    ? caught
    : new ApiError({ failure: 'network', code, message, cause: caught });
}

export const useRenderStore = defineStore('render', (): RenderStore => {
  const api = (): RenderApi => new RenderApi(useStudioApi().transport);

  const formats = ref<readonly FormatProfile[]>([]);
  const formatsStatus = ref<LoadStatus>('idle');
  const formatsError = ref<ApiError | null>(null);

  const projectId = ref<ProjectId | null>(null);

  const runs = ref<readonly RunSummary[]>([]);
  const runsStatus = ref<LoadStatus>('idle');
  const runsError = ref<ApiError | null>(null);

  const cost = ref<CostReport | null>(null);
  const costStatus = ref<LoadStatus>('idle');
  const costError = ref<ApiError | null>(null);

  const selected = ref<ReadonlySet<FormatProfileId>>(new Set());
  const activeRunId = ref<RunId | null>(null);
  const live = ref<LiveRunState>(EMPTY_LIVE);
  const streamState = ref<RunStreamState>('idle');
  const streamError = ref<ApiError | null>(null);
  const acting = ref<'cancel' | 'resume' | null>(null);
  const actionError = ref<ApiError | null>(null);

  let stream: RunStream | null = null;

  const selectedFormats = computed(() =>
    formats.value.filter((profile) => selected.value.has(profile.id)),
  );

  const activeRun = computed(() => runs.value.find((run) => run.id === activeRunId.value) ?? null);

  async function loadFormats(): Promise<void> {
    formatsStatus.value = 'loading';
    formatsError.value = null;
    try {
      const list = await api().formats();
      formats.value = list;
      // Everything is selected the first time, because "seven deliverables from one
      // composition" is the product, and a screen that starts with nothing chosen asks
      // the user to re-state the default before it will show them anything.
      if (selected.value.size === 0) {
        selected.value = new Set(list.map((profile) => profile.id));
      }
      formatsStatus.value = 'ready';
    } catch (caught) {
      formatsStatus.value = 'error';
      formatsError.value = asApiError(
        caught,
        'render-formats-failed',
        'the delivery formats could not be loaded',
      );
    }
  }

  async function reloadRuns(): Promise<void> {
    const id = projectId.value;
    if (id === null) return;
    runsStatus.value = 'loading';
    runsError.value = null;
    try {
      const list = await api().runs(id);
      // Newest first: the run someone came back to check on is the last one they
      // started, and making them scroll past six finished ones to find it is the
      // whole difference between a monitor and a log.
      runs.value = [...list].sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1));
      // Only when nothing is being watched yet: a reload that lands on run 3 must not
      // be dragged to run 7 the moment the list refreshes behind it.
      activeRunId.value ??= runs.value[0]?.id ?? null;
      runsStatus.value = 'ready';
    } catch (caught) {
      runsStatus.value = 'error';
      runsError.value = asApiError(caught, 'render-runs-failed', 'the runs could not be loaded');
    }
  }

  async function reloadCost(): Promise<void> {
    const id = projectId.value;
    if (id === null) return;
    costStatus.value = 'loading';
    costError.value = null;
    try {
      cost.value = await api().cost(id);
      costStatus.value = 'ready';
    } catch (caught) {
      costStatus.value = 'error';
      costError.value = asApiError(
        caught,
        'render-cost-failed',
        'the cost report could not be loaded',
      );
    }
  }

  async function loadProject(next: ProjectId): Promise<void> {
    if (projectId.value !== next) {
      stopWatching();
      activeRunId.value = null;
      runs.value = [];
      cost.value = null;
      live.value = EMPTY_LIVE;
    }
    projectId.value = next;
    // Settled, not raced: a failed cost read must not swallow a successful run read,
    // which is exactly the partial state this screen has to survive.
    await Promise.allSettled([reloadRuns(), reloadCost()]);
  }

  function selectRun(runId: RunId | null): void {
    if (activeRunId.value === runId) return;
    stopWatching();
    activeRunId.value = runId;
    live.value = EMPTY_LIVE;
    actionError.value = null;
  }

  function toggleFormat(id: FormatProfileId): void {
    const next = new Set(selected.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected.value = next;
  }

  function setSelection(ids: readonly FormatProfileId[]): void {
    selected.value = new Set(ids);
  }

  function fold(event: RunEvent): void {
    const current = live.value;
    switch (event.type) {
      case 'stage-started': {
        const progress = new Map(current.progress);
        progress.set(event.stage, 0);
        live.value = { ...current, progress };
        return;
      }
      case 'stage-progress': {
        const progress = new Map(current.progress);
        progress.set(event.stage, event.progress);
        live.value = { ...current, progress };
        return;
      }
      case 'stage-completed': {
        const progress = new Map(current.progress);
        progress.set(event.stage, 1);
        live.value = { ...current, progress };
        return;
      }
      case 'cost-updated': {
        live.value = {
          ...current,
          costNanoUsd: event.totalNanoUsd,
          remainingNanoUsd: event.remainingNanoUsd,
        };
        return;
      }
      case 'issue-raised': {
        live.value = {
          ...current,
          issues: [
            ...current.issues,
            {
              seq: event.seq,
              severity: event.severity,
              code: event.code,
              message: event.message,
              stage: event.stage,
            },
          ],
        };
        return;
      }
      case 'run-completed': {
        live.value = {
          ...current,
          costNanoUsd: event.totalNanoUsd,
          finishedStatus: event.status,
        };
        // The run's own record is now authoritative and carries the per-stage
        // durations and artefacts the stream never sends.
        void reloadRuns();
        void reloadCost();
        return;
      }
    }
  }

  function watchActiveRun(createEventSource?: EventSourceFactory): void {
    const run = activeRun.value;
    if (run === null || !isLiveRunStatus(run.status)) return;
    const url = useStudioApi().runStreamUrl(run.id);
    if (url === null) {
      streamState.value = 'failed';
      streamError.value = new ApiError({
        failure: 'network',
        code: 'run-stream-unavailable',
        message: 'the active transport provides no progress stream',
      });
      return;
    }
    stopWatching();
    streamError.value = null;
    stream = openRunStream({
      url,
      onEvent: fold,
      onState: (state) => {
        streamState.value = state;
      },
      onError: (error) => {
        streamError.value = error;
      },
      ...(createEventSource === undefined ? {} : { createEventSource }),
    });
  }

  function stopWatching(): void {
    stream?.close();
    stream = null;
    streamState.value = 'idle';
  }

  async function act(kind: 'cancel' | 'resume'): Promise<void> {
    const run = activeRun.value;
    if (run === null || acting.value !== null) return;
    acting.value = kind;
    actionError.value = null;
    try {
      const updated = kind === 'cancel' ? await api().cancel(run.id) : await api().resume(run.id);
      runs.value = runs.value.map((entry) => (entry.id === updated.id ? updated : entry));
      if (kind === 'resume') {
        live.value = EMPTY_LIVE;
        watchActiveRun();
      }
    } catch (caught) {
      actionError.value = asApiError(
        caught,
        `render-${kind}-failed`,
        `the run could not be ${kind === 'cancel' ? 'cancelled' : 'resumed'}`,
      );
      // The server refused; its copy of the run is the true one. Re-reading is how a
      // 409 "already finished" turns into the right button rather than a stale one.
      await reloadRuns();
    } finally {
      acting.value = null;
    }
  }

  return {
    formats,
    formatsStatus,
    formatsError,
    projectId,
    runs,
    runsStatus,
    runsError,
    cost,
    costStatus,
    costError,
    selected,
    selectedFormats,
    activeRunId,
    activeRun,
    live,
    streamState,
    streamError,
    acting,
    actionError,
    loadFormats,
    loadProject,
    reloadRuns,
    reloadCost,
    selectRun,
    toggleFormat,
    setSelection,
    cancelActiveRun: () => act('cancel'),
    resumeActiveRun: () => act('resume'),
    watchActiveRun,
    stopWatching,
  };
});
