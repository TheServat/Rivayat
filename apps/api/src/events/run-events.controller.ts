/**
 * `GET /api/runs/:id/events` - the run, as it happens.
 *
 * Two things here are not decoration.
 *
 * **`Last-Event-ID`, as a header *and* as a query parameter.** The browser sends the
 * header automatically on an `EventSource` reconnect, and honouring it is what makes a
 * dropped connection invisible. But `EventSource` cannot set a header, so a client that
 * rebuilds its own connection - after a route change, a manual retry, a resumed run -
 * has no way to send one and replays from sequence 1. That made an *explicit* reconnect
 * strictly worse than an implicit one, which is a surprising enough property that
 * clients started leaning on the browser's internal retry to avoid it. `?lastEventId=`
 * is the same value by the only route such a client has.
 *
 * **Heartbeats.** Reverse proxies and load balancers close idle connections, typically
 * at 30-60 seconds. Stage 6 Produce can generate images for several minutes without
 * emitting anything, which reads as idle. A comment-only event every 15 seconds keeps
 * the socket demonstrably alive and costs nothing.
 *
 * The stream *completes* when the run does, rather than being left open. A client that
 * has to distinguish "finished" from "stalled" by timing out is a client that shows a
 * spinner after the video is ready.
 */

import { Controller, Headers, Inject, Param, Query, Sse } from '@nestjs/common';
import type { RunId } from '@rv/contracts';
import { NotFoundError, isErr } from '@rv/shared-kernel';
import { Observable, ReplaySubject, finalize, interval, map, merge, takeUntil } from 'rxjs';

import type { RunRepository } from '../application/ports/repository.ports';
import { isTerminalRunStatus, type RunSummary } from '../application/resources';
import { RUN_EVENT_BUS, RUN_REPOSITORY } from '../tokens';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RunIdParam } from './events.contracts';
import type { RunEventBus } from './run-event-bus';

/** Long enough to be cheap, short enough to beat a 30-second proxy idle timeout. */
const HEARTBEAT_MS = 15_000;

/** The shape Nest serialises into the SSE frame. */
interface SseFrame {
  readonly data: string;
  readonly id?: string;
  readonly type?: string;
  readonly retry?: number;
}

/**
 * `Last-Event-ID: 7` → 7; anything unparseable → 0, meaning "send me everything".
 *
 * Deliberately forgiving. The header is set by the browser, not by our client code,
 * and refusing the connection over a malformed one would turn a recoverable reconnect
 * into a dead stream.
 */
function parseLastEventId(header: string | undefined): number {
  if (header === undefined) return 0;
  const parsed = Number.parseInt(header, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The terminal event a finished run's stream is missing, from the run record.
 *
 * The event log lives in memory, so a run that finished before this process started -
 * or in a worker, or in the process the resume replaced - has a terminal *state* and no
 * terminal *event*. Without this the stream stays open on heartbeats and a client
 * waiting for `run-completed` waits for ever, on a run that finished yesterday.
 *
 * Reconstructed rather than invented: every field comes off the run.
 */
function terminalEventFor(run: RunSummary): {
  readonly type: 'run-completed';
  readonly runId: RunId;
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly totalNanoUsd: number;
  readonly errorKind: string | null;
  readonly errorCode: string | null;
} | null {
  if (run.status !== 'succeeded' && run.status !== 'failed' && run.status !== 'cancelled') {
    return null;
  }
  return {
    type: 'run-completed',
    runId: run.id,
    status: run.status,
    totalNanoUsd: run.spentNanoUsd,
    errorKind: run.status === 'cancelled' ? 'cancelled' : run.status === 'failed' ? 'error' : null,
    errorCode: run.errorCode,
  };
}

@Controller('runs')
export class RunEventsController {
  readonly #bus: RunEventBus;
  readonly #runs: RunRepository;

  constructor(
    @Inject(RUN_EVENT_BUS) bus: RunEventBus,
    @Inject(RUN_REPOSITORY) runs: RunRepository,
  ) {
    this.#bus = bus;
    this.#runs = runs;
  }

  /**
   * Async, so an unknown run is a 404 rather than a socket held open forever.
   *
   * Nest resolves an `@Sse()` handler's promise *before* it commits the response
   * headers, which is the whole reason the existence check can live here: throwing
   * after the headers are out could only ever produce an `event: error` frame on a
   * 200, and a client that typoed a run id deserves the status code.
   */
  @Sse(':id/events')
  async stream(
    @Param('id', new ZodValidationPipe(RunIdParam)) runId: RunId,
    @Headers('last-event-id') lastEventId?: string,
    @Query('lastEventId') lastEventIdQuery?: string,
  ): Promise<Observable<SseFrame>> {
    const run = await this.#runs.findById(runId);
    if (isErr(run)) throw run.error;
    if (run.value === null) throw new NotFoundError('run', runId);

    // A run that is over but whose stream never said so: give it the terminal event
    // from the record, once, before anyone subscribes. `publish` completes the channel,
    // so the connection below ends instead of heartbeating for ever.
    if (isTerminalRunStatus(run.value.status) && !this.#bus.isFinished(runId)) {
      const terminal = terminalEventFor(run.value);
      if (terminal !== null) this.#bus.publish(terminal);
    }

    /**
     * A `ReplaySubject`, not a plain one, and the difference is the whole bug it fixes.
     *
     * `merge` subscribes to the event stream first. For a run that has already
     * finished, that stream emits its history and completes *synchronously* - so the
     * `finalize` below fires before `takeUntil` has subscribed to this. A plain
     * `Subject` would have dropped that notification on the floor, `takeUntil` would
     * never fire, and the heartbeat would hold the response open forever on exactly
     * the request that should close immediately.
     */
    const closed = new ReplaySubject<void>(1);

    // The header wins when both are present: it is the browser's own, and it is
    // therefore the one that is right about what this connection last received.
    const since = parseLastEventId(lastEventId ?? lastEventIdQuery);

    const events = this.#bus.subscribe(runId, since).pipe(
      map((event): SseFrame => ({
        // The sequence number *is* the SSE id, which is what makes the browser send
        // it back as `Last-Event-ID`. Any other id would break replay.
        id: String(event.seq),
        type: event.type,
        data: JSON.stringify(event),
        // Advisory reconnect delay. Without it browsers use 3 s, which hammers a
        // server that is down for a deploy.
        retry: 3000,
      })),
      finalize(() => {
        closed.next();
        closed.complete();
      }),
    );

    const heartbeats = interval(HEARTBEAT_MS).pipe(
      takeUntil(closed),
      map((tick): SseFrame => ({ type: 'heartbeat', data: JSON.stringify({ tick }) })),
    );

    return merge(events, heartbeats);
  }
}
