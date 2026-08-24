import type { PipelineStageKey, RunId } from '@rv/contracts';
import { computed, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue';
import type { ComputedRef, MaybeRefOrGetter, Ref } from 'vue';

import { useStudioApi } from '../api/client';
import { ApiError } from '../api/errors';
import {
  openRunStream,
  type EventSourceFactory,
  type RunStream,
  type RunStreamState,
} from '../api/run-stream';
import type { RunEvent } from '../api/schemas/pending-contracts';

export type SseConnectionState = RunStreamState;

export interface UseRunProgressOptions {
  /** Backoff before attempt `n`, in milliseconds. Attempt 1 is the first *re*connect. */
  readonly backoffMs?: (attempt: number) => number;
  readonly maxAttempts?: number;
  readonly createEventSource?: EventSourceFactory;
  readonly schedule?: (callback: () => void, delayMs: number) => number;
  readonly cancelSchedule?: (handle: number) => void;
}

export interface RunIssue {
  readonly seq: number;
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly stage: PipelineStageKey | null;
}

/** The state a run's events fold into. Every screen watching a run wants this shape. */
export interface RunProgressState {
  /** Per stage, 0..1. A finished stage is 1 whatever its last progress frame said. */
  readonly progress: ReadonlyMap<PipelineStageKey, number>;
  /** Total spend the server has reported. `null` until it reports one. */
  readonly costNanoUsd: number | null;
  /** Headroom at the tightest ceiling, or `null` when the run is uncapped. */
  readonly remainingNanoUsd: number | null;
  readonly issues: readonly RunIssue[];
  /** Set by the terminal frame, which is also the last one on the stream. */
  readonly finishedStatus: 'succeeded' | 'failed' | 'cancelled' | null;
}

export interface RunProgressHandle {
  readonly events: Ref<readonly RunEvent[]>;
  readonly latest: ComputedRef<RunEvent | null>;
  readonly state: Ref<RunProgressState>;
  readonly connection: Ref<SseConnectionState>;
  readonly error: Ref<ApiError | null>;
  open: () => void;
  close: () => void;
}

const EMPTY: RunProgressState = {
  progress: new Map(),
  costNanoUsd: null,
  remainingNanoUsd: null,
  issues: [],
  finishedStatus: null,
};

/**
 * A run's progress, as a component sees it.
 *
 * A thin wrapper over `openRunStream` in `src/api/`: that module owns the socket, the
 * reconnection and the validation, and this one owns the refs, the fold and the Vue
 * lifetime. The split is deliberate - a transport that needs a component scope to be
 * testable is a transport nobody tests properly.
 *
 * ## What was wrong here before, and why nothing caught it
 *
 * This composable read `stream.onmessage` and validated against a flat
 * `{stage, status, fraction}` schema. Both were wrong, and both failed silently:
 *
 *  - `EventSource` delivers a frame carrying an `event:` line to
 *    `addEventListener(name, ...)` and **never** to `onmessage`. Every frame the API
 *    sends is named, so this connected, held the socket open, and received nothing -
 *    for ever, while reporting `open`.
 *  - the schema was invented from the architecture document rather than captured from
 *    the server, so even a frame that had arrived would have been rejected.
 *
 * The old unit test drove `onmessage` directly with payloads in the invented shape, so
 * the suite was green on both counts. The lesson is the one this repository keeps
 * relearning: a test that feeds a component its own assumptions measures the
 * assumptions. `run-stream.spec.ts` now asserts the opposite direction - an *unnamed*
 * frame must be ignored - so re-introducing `onmessage` fails rather than passes.
 *
 * ## Reconnection
 *
 * Owned by the browser while it is willing to retry, because only its own internal
 * retry sends `Last-Event-ID`, and only that header makes the server resume rather
 * than replay from the first event. See `src/api/run-stream.ts`; the sequence guard
 * there absorbs a replay rather than double-counting it, which is what stops an issue
 * list doubling every time a laptop lid closes.
 */
export function useRunProgress(
  runId: MaybeRefOrGetter<RunId | null>,
  options: UseRunProgressOptions = {},
): RunProgressHandle {
  const events = ref<readonly RunEvent[]>([]);
  const state = ref<RunProgressState>(EMPTY);
  const connection = ref<SseConnectionState>('idle');
  const error = ref<ApiError | null>(null);
  const stream = shallowRef<RunStream | null>(null);

  const latest = computed<RunEvent | null>(() => events.value.at(-1) ?? null);

  function fold(event: RunEvent): void {
    events.value = [...events.value, event];
    const current = state.value;

    switch (event.type) {
      case 'stage-started': {
        const progress = new Map(current.progress);
        progress.set(event.stage, 0);
        state.value = { ...current, progress };
        return;
      }
      case 'stage-progress': {
        const progress = new Map(current.progress);
        progress.set(event.stage, event.progress);
        state.value = { ...current, progress };
        return;
      }
      case 'stage-completed': {
        const progress = new Map(current.progress);
        progress.set(event.stage, 1);
        state.value = { ...current, progress };
        return;
      }
      case 'cost-updated': {
        state.value = {
          ...current,
          costNanoUsd: event.totalNanoUsd,
          remainingNanoUsd: event.remainingNanoUsd,
        };
        return;
      }
      case 'issue-raised': {
        state.value = {
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
        state.value = {
          ...current,
          costNanoUsd: event.totalNanoUsd,
          finishedStatus: event.status,
        };
        return;
      }
    }
  }

  function close(): void {
    stream.value?.close();
    stream.value = null;
    connection.value = 'idle';
  }

  function open(): void {
    close();
    error.value = null;

    const id = toValue(runId);
    if (id === null) return;

    const url = useStudioApi().runStreamUrl(id);
    if (url === null) {
      connection.value = 'failed';
      error.value = new ApiError({
        failure: 'network',
        code: 'sse-unavailable',
        message: 'the active transport does not provide a progress stream',
      });
      return;
    }

    stream.value = openRunStream({
      url,
      onEvent: fold,
      onState: (next) => {
        connection.value = next;
      },
      onError: (caught) => {
        error.value = caught;
      },
      ...(options.createEventSource === undefined
        ? {}
        : { createEventSource: options.createEventSource }),
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
      ...(options.cancelSchedule === undefined ? {} : { cancelSchedule: options.cancelSchedule }),
      ...(options.backoffMs === undefined ? {} : { backoffMs: options.backoffMs }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    });
  }

  // A new run id is a new stream, not the old one pointed somewhere else.
  watch(
    () => toValue(runId),
    (id) => {
      events.value = [];
      state.value = EMPTY;
      if (id === null) close();
      else open();
    },
  );

  // Guarantees the socket dies with the component, which a hand-rolled `onUnmounted`
  // in three screens will not.
  onScopeDispose(close);

  return { events, latest, state, connection, error, open, close };
}
