/**
 * `GET /api/runs/:id/events` - the run, as it happens.
 *
 * Two things here are not decoration.
 *
 * **`Last-Event-ID`.** The browser sends it automatically on an `EventSource`
 * reconnect. Honouring it is what makes a dropped connection invisible: the bus
 * replays everything after that sequence number before resuming live delivery. Ignore
 * it and a proxy blip during stage 6 leaves the UI reporting stage 5 until the run
 * ends.
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

import { Controller, Headers, Inject, Param, Sse } from '@nestjs/common';
import type { RunId } from '@rv/contracts';
import { NotFoundError, isErr } from '@rv/shared-kernel';
import { Observable, ReplaySubject, finalize, interval, map, merge, takeUntil } from 'rxjs';

import type { RunRepository } from '../application/ports/repository.ports';
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
  ): Promise<Observable<SseFrame>> {
    const run = await this.#runs.findById(runId);
    if (isErr(run)) throw run.error;
    if (run.value === null) throw new NotFoundError('run', runId);

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

    const events = this.#bus.subscribe(runId, parseLastEventId(lastEventId)).pipe(
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
