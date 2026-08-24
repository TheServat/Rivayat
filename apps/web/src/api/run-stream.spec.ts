import { describe, expect, it } from 'vitest';

import type { ApiError } from './errors';

import { FakeEventSource } from '../test/fake-event-source';
import type { RunEvent } from './schemas/pending-contracts';
import { openRunStream, type RunStreamState } from './run-stream';

const RUN_ID = 'run_01M0QZHAN8BCTP6WMZNQP587ZK';

function harness(options: { maxAttempts?: number } = {}) {
  const events: RunEvent[] = [];
  const states: RunStreamState[] = [];
  const errors: ApiError[] = [];
  const sources: FakeEventSource[] = [];
  const scheduled: (() => void)[] = [];
  const cancelled: number[] = [];

  const stream = openRunStream({
    url: 'http://test.invalid/api/runs/x/events',
    onEvent: (event) => events.push(event),
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source.asEventSource();
    },
    schedule: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancelSchedule: (handle) => cancelled.push(handle),
    backoffMs: () => 1,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });

  return { stream, events, states, errors, sources, scheduled, cancelled };
}

function current(sources: readonly FakeEventSource[]): FakeEventSource {
  const source = sources.at(-1);
  if (source === undefined) throw new Error('no stream was opened');
  return source;
}

const started: RunEvent = {
  type: 'stage-started',
  runId: RUN_ID,
  stage: 'render',
  seq: 1,
  at: '2026-08-23T18:53:40.941Z',
};

function progress(seq: number, fraction: number): RunEvent {
  return {
    type: 'stage-progress',
    runId: RUN_ID,
    stage: 'render',
    progress: fraction,
    detail: null,
    item: { kind: 'frame', key: String(seq), index: seq, total: 1800 },
    seq,
    at: '2026-08-23T18:54:00.000Z',
  };
}

function issue(seq: number): RunEvent {
  return {
    type: 'issue-raised',
    runId: RUN_ID,
    stage: 'render',
    severity: 'warning',
    code: 'reframe.needs-review',
    message: 'a shot could not hold its focus inside the TikTok safe area',
    seq,
    at: '2026-08-23T18:54:13.000Z',
  };
}

const completed: RunEvent = {
  type: 'run-completed',
  runId: RUN_ID,
  status: 'failed',
  totalNanoUsd: 0,
  errorKind: 'validation',
  errorCode: 'VALIDATION_FAILED',
  seq: 2,
  at: '2026-08-23T18:53:40.950Z',
};

describe('the run event stream', () => {
  it('reads named frames, which is the only kind the API sends', () => {
    // Captured live: a real run emits `event: stage-started` then
    // `event: run-completed`. `EventSource` routes a named frame to its named listener
    // and *never* to `onmessage`, so a client wired to `onmessage` connects fine, holds
    // the socket open, and shows a run frozen at whatever it last polled.
    const { events, sources } = harness();
    current(sources).emit(started);
    expect(events).toEqual([started]);
  });

  it('ignores an unnamed frame, so wiring onmessage back in cannot pass this suite', () => {
    const { events, errors, sources } = harness();
    current(sources).message(JSON.stringify(started));
    expect(events).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('folds every kind the API declares', () => {
    const { events, sources } = harness();
    const source = current(sources);
    const all: RunEvent[] = [
      started,
      {
        type: 'stage-progress',
        runId: RUN_ID,
        stage: 'render',
        progress: 0.4,
        detail: null,
        item: { kind: 'frame', key: '720', index: 720, total: 1800 },
        seq: 2,
        at: '2026-08-23T18:54:00.000Z',
      },
      {
        type: 'stage-completed',
        runId: RUN_ID,
        stage: 'render',
        durationMs: 12_000,
        costNanoUsd: 0,
        seq: 3,
        at: '2026-08-23T18:54:12.000Z',
      },
      {
        type: 'cost-updated',
        runId: RUN_ID,
        stage: 'render',
        deltaNanoUsd: 1000,
        totalNanoUsd: 1000,
        remainingNanoUsd: 4_999_999_000,
        seq: 4,
        at: '2026-08-23T18:54:12.100Z',
      },
      {
        type: 'issue-raised',
        runId: RUN_ID,
        stage: 'render',
        severity: 'warning',
        code: 'reframe.needs-review',
        message: 'a shot could not hold its focus inside the TikTok safe area',
        seq: 5,
        at: '2026-08-23T18:54:13.000Z',
      },
    ];
    for (const event of all) source.emit(event);
    expect(events.map((event) => event.type)).toEqual([
      'stage-started',
      'stage-progress',
      'stage-completed',
      'cost-updated',
      'issue-raised',
    ]);
  });

  it('drops a frame that does not satisfy the contract instead of folding it', () => {
    // A malformed progress event renders a run as finished, or as costing nothing.
    // Either is worse than a gap in the timeline.
    const { events, errors, sources } = harness();
    current(sources).raw('stage-progress', JSON.stringify({ type: 'stage-progress', progress: 3 }));
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.failure).toBe('schema');
  });

  it('reports a frame that is not JSON at all', () => {
    const { errors, sources } = harness();
    current(sources).raw('stage-started', '<html>proxy error</html>');
    expect(errors[0]?.code).toBe('run-event-not-json');
  });

  it('closes itself on the terminal frame rather than reconnecting to a finished run', () => {
    const { states, sources } = harness();
    const source = current(sources);
    source.open();
    source.emit(completed);

    expect(source.closed).toBe(true);
    expect(states.at(-1)).toBe('idle');
    // And a late error from the closing socket does not start a retry.
    source.fail();
    expect(sources).toHaveLength(1);
  });

  it('treats a heartbeat as proof of life, not as state', () => {
    // Stage 6 can generate images for minutes without emitting anything, which reads
    // as idle to a proxy and as "stuck" to a user. The heartbeat is the difference.
    const { events, states, sources } = harness();
    const source = current(sources);
    source.raw('heartbeat', JSON.stringify({ tick: 1 }));
    expect(events).toEqual([]);
    expect(states.at(-1)).toBe('open');
  });

  it('lets the browser retry a transient drop, because only it can send Last-Event-ID', () => {
    // The header is set by `EventSource`'s own internal retry. Throwing the socket away
    // and building a new one loses it, and the server then treats the reconnect as a
    // first connection and replays the run from seq 1.
    const { states, sources, scheduled } = harness();
    const source = current(sources);
    source.open();
    source.drop();

    expect(states).toEqual(['connecting', 'open', 'reconnecting']);
    // No second socket, and nothing scheduled: the browser is already on it.
    expect(sources).toHaveLength(1);
    expect(scheduled).toHaveLength(0);
    expect(source.closed).toBe(false);

    source.open();
    expect(states.at(-1)).toBe('open');
  });

  it('delivers what a reconnect missed and not one event twice', () => {
    // The invariant a user feels: leave the page at minute two, come back at minute
    // six, and the run is where it should be - not restarted, and not showing every
    // issue it has ever raised a second time.
    const { events, sources } = harness();
    const source = current(sources);
    source.open();
    source.emit(started);
    source.emit(progress(2, 0.2));
    source.emit(issue(3));

    source.drop();
    source.open();

    // Worst case: the server replays the whole history, which is what it does for a
    // socket that had no id to offer. Then the frames that were actually missed.
    source.emit(started);
    source.emit(progress(2, 0.2));
    source.emit(issue(3));
    source.emit(progress(4, 0.9));

    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    // And the one that matters for the monitor: the issue list did not double.
    expect(events.filter((event) => event.type === 'issue-raised')).toHaveLength(1);
  });

  it('never goes backwards, even if the server rewinds', () => {
    const { events, stream, sources } = harness();
    const source = current(sources);
    source.emit(progress(5, 0.5));
    source.emit(progress(2, 0.2));
    expect(events.map((event) => event.seq)).toEqual([5]);
    expect(stream.lastSeq()).toBe(5);
  });

  it('builds a new socket only once the browser has given up on the old one', () => {
    // `readyState === CLOSED` is a 404, a wrong content type, a server that is gone.
    // The browser will not retry that, so this code must - and the sequence guard
    // absorbs the full replay the fresh socket receives.
    const { states, sources, scheduled } = harness();
    current(sources).fail();

    expect(states).toEqual(['connecting', 'reconnecting']);
    expect(scheduled).toHaveLength(1);

    scheduled[0]?.();
    expect(sources).toHaveLength(2);
    expect(states.at(-1)).toBe('reconnecting');
  });

  it('resumes from where it got to even across a rebuilt socket', () => {
    const { events, sources, scheduled } = harness();
    current(sources).emit(started);
    current(sources).emit(progress(2, 0.4));

    current(sources).fail();
    scheduled.at(-1)?.();

    // A fresh `EventSource` sends no `Last-Event-ID`, so the server sends everything.
    const rebuilt = current(sources);
    rebuilt.open();
    rebuilt.emit(started);
    rebuilt.emit(progress(2, 0.4));
    rebuilt.emit(progress(3, 0.8));

    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('gives up after a bounded number of attempts instead of retrying forever', () => {
    // The browser's own `EventSource` retries silently and for ever. A screen someone
    // left for four minutes has to be able to say it gave up.
    const { states, errors, scheduled, sources } = harness({ maxAttempts: 2 });
    current(sources).fail();
    scheduled.at(-1)?.();
    current(sources).fail();
    scheduled.at(-1)?.();
    current(sources).fail();

    expect(states.at(-1)).toBe('failed');
    expect(errors.at(-1)?.code).toBe('run-stream-reconnect-exhausted');
    expect(errors.at(-1)?.retryable).toBe(true);
  });

  it('counts a transient drop towards the same ceiling', () => {
    // Otherwise a socket that flaps between CONNECTING and error for ever never
    // reaches the give-up path, and the screen says "reconnecting" until it is closed.
    const { states, sources } = harness({ maxAttempts: 1 });
    current(sources).drop();
    expect(states.at(-1)).toBe('reconnecting');
    current(sources).drop();
    expect(states.at(-1)).toBe('failed');
  });

  it('cancels a pending retry when it is closed', () => {
    const { stream, sources, scheduled, cancelled, states } = harness();
    current(sources).fail();
    expect(scheduled).toHaveLength(1);

    stream.close();
    expect(cancelled).toHaveLength(1);
    expect(states.at(-1)).toBe('idle');

    // Idempotent: a watcher and a scope disposal both call it.
    stream.close();
    expect(current(sources).closed).toBe(true);
  });

  it('stops reconnecting once closed', () => {
    const { stream, sources, scheduled } = harness();
    stream.close();
    current(sources).fail();
    expect(scheduled).toHaveLength(0);
    expect(sources).toHaveLength(1);
  });
});
