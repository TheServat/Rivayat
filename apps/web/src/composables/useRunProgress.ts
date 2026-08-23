import type { RunId } from '@rv/contracts';
import { computed, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue';
import type { ComputedRef, MaybeRefOrGetter, Ref } from 'vue';

import { useStudioApi } from '../api/client';
import { ApiError } from '../api/errors';
import { RunProgressEvent } from '../api/schemas/pending-contracts';

export type SseConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed';

/** Constructs the stream. Injectable so a test drives it without a network. */
export type EventSourceFactory = (url: string) => EventSource;

export interface UseRunProgressOptions {
  /** Backoff before attempt `n`, in milliseconds. Attempt 1 is the first *re*connect. */
  readonly backoffMs?: (attempt: number) => number;
  readonly maxAttempts?: number;
  readonly createEventSource?: EventSourceFactory;
  readonly schedule?: (callback: () => void, delayMs: number) => number;
  readonly cancelSchedule?: (handle: number) => void;
}

export interface RunProgressHandle {
  readonly events: Ref<readonly RunProgressEvent[]>;
  readonly latest: ComputedRef<RunProgressEvent | null>;
  readonly connection: Ref<SseConnectionState>;
  readonly attempt: Ref<number>;
  readonly error: Ref<ApiError | null>;
  open: () => void;
  close: () => void;
}

/**
 * Exponential backoff, capped.
 *
 * No jitter, and no `Math.random()`: the studio is one client, so there is no
 * thundering herd to spread out, and non-negotiable #1 rules out unseeded randomness
 * as a matter of habit rather than only where it changes a render.
 */
function defaultBackoff(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 30_000);
}

/**
 * A run's progress stream, with reconnection.
 *
 * Three behaviours make this worth a composable rather than an inline `EventSource`:
 *
 *  - **Every message is validated.** A tick that fails `RunProgressEvent` is recorded
 *    as a schema error and dropped. A malformed progress event that reaches the UI
 *    renders a run as finished, or as costing nothing, and either is worse than a gap.
 *  - **Reconnection is bounded and observable.** The browser's own `EventSource`
 *    reconnects silently and forever; a UI needs to say "disconnected, retrying" and
 *    eventually "gave up", so the automatic behaviour is replaced with an explicit one.
 *  - **It closes itself.** `onScopeDispose` guarantees the socket dies with the
 *    component, which a hand-rolled `onUnmounted` in three screens will not.
 */
export function useRunProgress(
  runId: MaybeRefOrGetter<RunId | null>,
  options: UseRunProgressOptions = {},
): RunProgressHandle {
  const backoffMs = options.backoffMs ?? defaultBackoff;
  const maxAttempts = options.maxAttempts ?? 6;
  const createEventSource =
    options.createEventSource ?? ((url: string): EventSource => new EventSource(url));
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number): number =>
      globalThis.setTimeout(callback, delayMs) as unknown as number);
  const cancelSchedule =
    options.cancelSchedule ?? ((handle: number) => globalThis.clearTimeout(handle));

  const events = ref<readonly RunProgressEvent[]>([]);
  const connection = ref<SseConnectionState>('idle');
  const attempt = ref(0);
  const error = ref<ApiError | null>(null);
  const source = shallowRef<EventSource | null>(null);
  let retryHandle: number | null = null;

  const latest = computed<RunProgressEvent | null>(() => events.value.at(-1) ?? null);

  function teardown(): void {
    if (retryHandle !== null) {
      cancelSchedule(retryHandle);
      retryHandle = null;
    }
    source.value?.close();
    source.value = null;
  }

  function handleMessage(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch (cause) {
      error.value = new ApiError({
        failure: 'schema',
        code: 'sse-payload-not-json',
        message: 'a progress event was not JSON',
        cause,
      });
      return;
    }
    const result = RunProgressEvent.safeParse(parsed);
    if (!result.success) {
      error.value = ApiError.schema('run progress event', result.error);
      return;
    }
    events.value = [...events.value, result.data];
  }

  function connect(): void {
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

    connection.value = attempt.value === 0 ? 'connecting' : 'reconnecting';
    const stream = createEventSource(url);
    source.value = stream;

    stream.onopen = (): void => {
      connection.value = 'open';
      attempt.value = 0;
      error.value = null;
    };
    stream.onmessage = (event: MessageEvent<string>): void => {
      handleMessage(event.data);
    };
    stream.onerror = (): void => {
      // `EventSource` gives no detail on error, so the state - not the event - is what
      // tells us whether this is worth retrying.
      stream.close();
      source.value = null;
      if (attempt.value >= maxAttempts) {
        connection.value = 'failed';
        error.value = new ApiError({
          failure: 'network',
          code: 'sse-reconnect-exhausted',
          message: `gave up after ${String(maxAttempts)} reconnection attempts`,
          context: { attempts: maxAttempts },
        });
        return;
      }
      attempt.value += 1;
      connection.value = 'reconnecting';
      retryHandle = schedule(() => {
        retryHandle = null;
        connect();
      }, backoffMs(attempt.value));
    };
  }

  function open(): void {
    teardown();
    attempt.value = 0;
    error.value = null;
    connect();
  }

  function close(): void {
    teardown();
    connection.value = 'idle';
  }

  // A new run id is a new stream, not the old one pointed somewhere else.
  watch(
    () => toValue(runId),
    (id) => {
      events.value = [];
      if (id === null) close();
      else open();
    },
  );

  onScopeDispose(teardown);

  return { events, latest, connection, attempt, error, open, close };
}
