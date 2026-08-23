/**
 * The fan-out behind `GET /api/runs/:id/events`.
 *
 * Three properties, each of which a naive `Subject` per run would not have:
 *
 *  - **Replay.** Every event carries a per-run sequence number and the bus keeps a
 *    bounded history, so a client reconnecting with `Last-Event-ID: 7` receives 8
 *    onward before it starts receiving live events. Without it, a proxy hiccup during
 *    stage 6 silently loses stage 7 and the UI sits on stale progress forever.
 *  - **Termination.** The stream completes on `run-completed`, so the HTTP response
 *    ends rather than being held open by a client that will never hear anything else.
 *  - **Late subscription.** A client that connects after a run finished gets the whole
 *    history and then a completed stream, rather than an empty connection that hangs.
 *    A run is started by one request and watched by the next; the gap is normal.
 *
 * History is bounded per run and runs are evicted when they finish and nobody is
 * listening: an unbounded event log in memory is a leak with a UI attached.
 */

import type { RunId } from '@rv/contracts';
import type { Clock } from '@rv/shared-kernel';
import { toIso } from '@rv/shared-kernel';
import { Observable, Subject, concat, from } from 'rxjs';

import { isTerminalEvent, type RunEvent, type RunEventDraft } from './run-event';

/** Per-run history cap. ~11 stages of progress plus cost updates fits comfortably. */
const DEFAULT_HISTORY_LIMIT = 512;

interface RunChannel {
  readonly subject: Subject<RunEvent>;
  readonly history: RunEvent[];
  seq: number;
  finished: boolean;
}

export interface RunEventBusOptions {
  readonly clock: Clock;
  readonly historyLimit?: number;
}

export class RunEventBus {
  readonly #clock: Clock;
  readonly #historyLimit: number;
  readonly #channels = new Map<RunId, RunChannel>();

  constructor(options: RunEventBusOptions) {
    this.#clock = options.clock;
    this.#historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  /**
   * Stamps the draft with its sequence number and timestamp and fans it out.
   *
   * The bus assigns both rather than trusting the publisher: two stages running
   * concurrently would otherwise race to pick the same `seq`, and a duplicate sequence
   * number makes `Last-Event-ID` ambiguous in exactly the situation it exists for.
   */
  publish(draft: RunEventDraft): RunEvent {
    const channel = this.#channelFor(draft.runId);
    channel.seq += 1;

    const event = { ...draft, seq: channel.seq, at: toIso(this.#clock.now()) };

    channel.history.push(event);
    if (channel.history.length > this.#historyLimit) channel.history.shift();

    channel.subject.next(event);

    if (isTerminalEvent(event)) {
      channel.finished = true;
      channel.subject.complete();
    }

    return event;
  }

  /**
   * History since `afterSeq`, then live events, then completion.
   *
   * `concat` rather than `merge`: ordering is the contract. A UI that renders
   * `stage-completed` before `stage-started` shows a stage that finished before it
   * began, and there is no way for it to recover from that.
   */
  subscribe(runId: RunId, afterSeq = 0): Observable<RunEvent> {
    const channel = this.#channelFor(runId);
    const missed = channel.history.filter((event) => event.seq > afterSeq);

    if (channel.finished) return from(missed);
    return concat(from(missed), channel.subject.asObservable());
  }

  /** Events recorded for a run so far. Read by the run resource and by tests. */
  history(runId: RunId): readonly RunEvent[] {
    return this.#channels.get(runId)?.history ?? [];
  }

  /**
   * Drops a finished run's history.
   *
   * Called when the run resource is deleted or the process is shutting down. Not
   * called automatically on completion: a client that connects one second after a run
   * finishes still needs the log, and that is the common case for a short run.
   */
  forget(runId: RunId): void {
    const channel = this.#channels.get(runId);
    if (channel === undefined) return;
    if (!channel.finished) channel.subject.complete();
    this.#channels.delete(runId);
  }

  /** Completes every open stream. Nest calls this on shutdown. */
  closeAll(): void {
    for (const channel of this.#channels.values()) {
      if (!channel.finished) channel.subject.complete();
    }
    this.#channels.clear();
  }

  #channelFor(runId: RunId): RunChannel {
    const existing = this.#channels.get(runId);
    if (existing !== undefined) return existing;
    const created: RunChannel = {
      subject: new Subject<RunEvent>(),
      history: [],
      seq: 0,
      finished: false,
    };
    this.#channels.set(runId, created);
    return created;
  }
}
