/**
 * A run's event stream, with reconnection that does not lose its place.
 *
 * Framework-free on purpose: it is a transport, so it belongs beside the other
 * transports rather than in a feature folder or behind a composable. `useRunProgress`
 * is the Vue wrapper over it, and the render screen's store drives it directly - two
 * consumers, one implementation, which is the only arrangement in which fixing a bug
 * here fixes it everywhere.
 *
 * Four things here are load-bearing, and the first would have shipped broken.
 *
 * **Named events need named listeners.** The API sends every frame with an `event:`
 * line - `stage-started`, `cost-updated`, `run-completed`, `heartbeat`. `EventSource`
 * routes a named frame to `addEventListener(name, ...)` and *never* to `onmessage`,
 * which only receives frames with no name at all. A client wired to `onmessage`
 * connects successfully, holds the socket open, receives nothing, and reports the run
 * as stuck at whatever it last polled. Verified against the live API: a real run emits
 * `event: stage-started` then `event: run-completed`, and nothing else.
 *
 * **The browser owns the reconnect, because only the browser can resume.** The server
 * replays from `Last-Event-ID`, and that header is sent *only* by `EventSource`'s own
 * internal retry - a freshly constructed one has no id to send, so the server treats
 * it as "send me everything" and the whole run replays from seq 1. So a drop is not
 * met by throwing the socket away: while `readyState` is `CONNECTING` the browser is
 * already retrying with the right header and this code only counts and reports. A new
 * socket is built only when the browser has given up entirely (`readyState ===
 * CLOSED`), which is what a 404 or a dead server looks like.
 *
 * **Sequence numbers are the duplicate guard.** `seq` is per-run, monotonic and
 * gap-free, so anything at or below the highest already delivered is a replay.
 * Dropping those here rather than in the store means every consumer gets the same
 * guarantee: a reconnect mid-render delivers the events that were missed and not one
 * event twice. Without it a reconnect appends the whole issue list a second time.
 *
 * **Every frame is validated.** A tick that fails `RunEvent` is dropped and recorded,
 * never folded into state. A malformed progress event renders a run as finished, or as
 * costing nothing, and both are worse than a gap in the timeline.
 */

import { ApiError } from './errors';

import { RUN_EVENT_NAMES, RUN_HEARTBEAT_EVENT, RunEvent } from './schemas/pending-contracts';

export type RunStreamState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed';

/** Constructs the stream. Injectable so a test drives it with no network. */
export type EventSourceFactory = (url: string) => EventSource;

export interface RunStreamOptions {
  readonly url: string;
  readonly onEvent: (event: RunEvent) => void;
  readonly onState: (state: RunStreamState) => void;
  readonly onError: (error: ApiError) => void;
  readonly createEventSource?: EventSourceFactory;
  readonly schedule?: (callback: () => void, delayMs: number) => number;
  readonly cancelSchedule?: (handle: number) => void;
  readonly backoffMs?: (attempt: number) => number;
  readonly maxAttempts?: number;
}

export interface RunStream {
  /** Idempotent. Safe to call from a scope disposal and from a status watcher. */
  close: () => void;
  /** Highest sequence delivered. Exposed so a caller can prove replay was cut. */
  lastSeq: () => number;
}

/** `EventSource.CLOSED`. A literal, because the double under test carries no statics. */
const CLOSED_STATE = 2;

/**
 * Exponential backoff, capped, with no jitter.
 *
 * The studio is one client, so there is no thundering herd to spread out, and
 * non-negotiable #1 rules out unseeded randomness as a habit rather than only where it
 * changes a render.
 */
function defaultBackoff(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 30_000);
}

export function openRunStream(options: RunStreamOptions): RunStream {
  const createEventSource =
    options.createEventSource ?? ((url: string): EventSource => new EventSource(url));
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number): number =>
      globalThis.setTimeout(callback, delayMs) as unknown as number);
  const cancelSchedule =
    options.cancelSchedule ?? ((handle: number): void => globalThis.clearTimeout(handle));
  const backoffMs = options.backoffMs ?? defaultBackoff;
  const maxAttempts = options.maxAttempts ?? 6;

  let source: EventSource | null = null;
  let retryHandle: number | null = null;
  let attempt = 0;
  let lastSeq = 0;
  let closed = false;

  function teardown(): void {
    if (retryHandle !== null) {
      cancelSchedule(retryHandle);
      retryHandle = null;
    }
    source?.close();
    source = null;
  }

  function giveUp(): void {
    teardown();
    options.onState('failed');
    options.onError(
      new ApiError({
        failure: 'network',
        code: 'run-stream-reconnect-exhausted',
        message: `gave up after ${String(maxAttempts)} reconnection attempts`,
        retryable: true,
        context: { attempts: maxAttempts, lastSeq },
      }),
    );
  }

  function handleFrame(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch (cause) {
      options.onError(
        new ApiError({
          failure: 'schema',
          code: 'run-event-not-json',
          message: 'a run event was not JSON',
          cause,
        }),
      );
      return;
    }
    const result = RunEvent.safeParse(parsed);
    if (!result.success) {
      options.onError(ApiError.schema('run event', result.error));
      return;
    }

    // A replayed frame is not news. The server resends history from `Last-Event-ID`,
    // and resends *all* of it to a socket with no id to offer, so this is what stops a
    // reconnect duplicating every issue the run has raised.
    if (result.data.seq <= lastSeq) return;
    lastSeq = result.data.seq;

    options.onEvent(result.data);

    // The server closes the socket right after the terminal frame. Closing from this
    // side too stops the browser treating that close as a drop and reconnecting to a
    // finished run for the next thirty seconds.
    if (result.data.type === 'run-completed') {
      closed = true;
      teardown();
      options.onState('idle');
    }
  }

  function connect(): void {
    if (closed) return;
    options.onState(attempt === 0 ? 'connecting' : 'reconnecting');

    const stream = createEventSource(options.url);
    source = stream;

    stream.onopen = (): void => {
      attempt = 0;
      options.onState('open');
    };

    for (const name of RUN_EVENT_NAMES) {
      stream.addEventListener(name, (event: Event): void => {
        const data: unknown = (event as MessageEvent<unknown>).data;
        if (typeof data === 'string') handleFrame(data);
      });
    }

    // A heartbeat carries no state; receiving one only proves the socket is alive,
    // which is exactly what a four-minute silent stage needs it to prove.
    stream.addEventListener(RUN_HEARTBEAT_EVENT, (): void => {
      options.onState('open');
    });

    stream.onerror = (): void => {
      if (closed) return;
      attempt += 1;

      if (attempt > maxAttempts) {
        giveUp();
        return;
      }

      options.onState('reconnecting');

      // `CONNECTING` means the browser is already retrying, and it - not this code - is
      // the only thing that can send `Last-Event-ID`. Leaving the socket alone is what
      // makes a mid-render drop resume rather than replay.
      if (stream.readyState !== CLOSED_STATE) return;

      // `CLOSED` means the browser has given up on this socket for good: a 404, a wrong
      // content type, a server that is gone. A new one is the only way back, and the
      // sequence guard above absorbs the full replay it will receive.
      stream.close();
      source = null;
      retryHandle = schedule(() => {
        retryHandle = null;
        connect();
      }, backoffMs(attempt));
    };
  }

  connect();

  return {
    close: (): void => {
      closed = true;
      teardown();
      options.onState('idle');
    },
    lastSeq: (): number => lastSeq,
  };
}
