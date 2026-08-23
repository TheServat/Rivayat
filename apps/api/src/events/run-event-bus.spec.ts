/**
 * The three properties the SSE endpoint is built on.
 *
 * Ordering, because a UI that renders `stage-completed` before `stage-started` shows a
 * stage that finished before it began and cannot recover. Replay, because without it a
 * proxy blip loses whichever events landed while the socket was down and the UI sits on
 * stale progress until the run ends. Termination, because a stream that never completes
 * makes "finished" indistinguishable from "stalled".
 */

import type { RunId } from '@rv/contracts';
import { FixedClock, instant } from '@rv/shared-kernel';
import { firstValueFrom, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { RunEventBus } from './run-event-bus';
import type { RunEvent } from './run-event';

const RUN = 'run_01J0000000000000000000000A' as RunId;

function bus(): RunEventBus {
  return new RunEventBus({ clock: new FixedClock(instant(1_700_000_000_000)) });
}

/** Collects everything a subscription yields, including the completion. */
function collect(stream: ReturnType<RunEventBus['subscribe']>): Promise<RunEvent[]> {
  return firstValueFrom(stream.pipe(toArray()));
}

describe('RunEventBus', () => {
  it('numbers events per run, monotonically and without gaps', () => {
    const events = bus();
    const first = events.publish({ type: 'stage-started', runId: RUN, stage: 'intake' });
    const second = events.publish({
      type: 'stage-completed',
      runId: RUN,
      stage: 'intake',
      durationMs: 12,
      costNanoUsd: 0,
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it('stamps the injected clock, not the wall clock', () => {
    const event = bus().publish({ type: 'stage-started', runId: RUN, stage: 'intake' });
    expect(event.at).toBe('2023-11-14T22:13:20.000Z');
  });

  it('replays the whole history to a subscriber that arrives late', async () => {
    const events = bus();
    events.publish({ type: 'stage-started', runId: RUN, stage: 'intake' });
    events.publish({
      type: 'stage-completed',
      runId: RUN,
      stage: 'intake',
      durationMs: 1,
      costNanoUsd: 0,
    });
    events.publish({
      type: 'run-completed',
      runId: RUN,
      status: 'succeeded',
      totalNanoUsd: 0,
      errorKind: null,
      errorCode: null,
    });

    const received = await collect(events.subscribe(RUN));
    expect(received.map((event) => event.type)).toEqual([
      'stage-started',
      'stage-completed',
      'run-completed',
    ]);
  });

  it('replays only what a reconnecting client missed', async () => {
    const events = bus();
    for (const stage of ['intake', 'resolve'] as const) {
      events.publish({ type: 'stage-started', runId: RUN, stage });
    }
    events.publish({
      type: 'run-completed',
      runId: RUN,
      status: 'succeeded',
      totalNanoUsd: 0,
      errorKind: null,
      errorCode: null,
    });

    const received = await collect(events.subscribe(RUN, 2));
    expect(received.map((event) => event.seq)).toEqual([3]);
  });

  it('delivers history before live events, in order', async () => {
    const events = bus();
    events.publish({ type: 'stage-started', runId: RUN, stage: 'intake' });

    const pending = collect(events.subscribe(RUN));
    events.publish({
      type: 'stage-progress',
      runId: RUN,
      stage: 'intake',
      progress: 0.5,
      detail: null,
    });
    events.publish({
      type: 'run-completed',
      runId: RUN,
      status: 'succeeded',
      totalNanoUsd: 0,
      errorKind: null,
      errorCode: null,
    });

    const received = await pending;
    expect(received.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('completes the stream on the terminal event and never after it', async () => {
    const events = bus();
    const pending = collect(events.subscribe(RUN));

    events.publish({
      type: 'run-completed',
      runId: RUN,
      status: 'failed',
      totalNanoUsd: 42,
      errorKind: 'unsupported',
      errorCode: 'UNSUPPORTED_CAPABILITY',
    });

    const received = await pending;
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('run-completed');
  });

  it('keeps the sequence counters of two runs apart', () => {
    const other = 'run_01J0000000000000000000000B' as RunId;
    const events = bus();
    events.publish({ type: 'stage-started', runId: RUN, stage: 'intake' });
    const first = events.publish({ type: 'stage-started', runId: other, stage: 'intake' });

    // Sequence numbers are per-run: a shared counter would make `Last-Event-ID`
    // meaningless the moment two runs overlap, which is the normal case.
    expect(first.seq).toBe(1);
    expect(events.history(RUN)).toHaveLength(1);
    expect(events.history(other)).toHaveLength(1);
  });

  it('bounds the history it keeps', () => {
    const events = new RunEventBus({
      clock: new FixedClock(instant(0)),
      historyLimit: 3,
    });
    for (let index = 0; index < 10; index += 1) {
      events.publish({
        type: 'stage-progress',
        runId: RUN,
        stage: 'intake',
        progress: 0,
        detail: null,
      });
    }
    const history = events.history(RUN);
    expect(history).toHaveLength(3);
    expect(history.at(-1)?.seq).toBe(10);
  });

  it('forgets a run, closing its stream and dropping its history', async () => {
    const events = bus();
    const pending = collect(events.subscribe(RUN));
    events.publish({ type: 'stage-started', runId: RUN, stage: 'intake' });

    events.forget(RUN);

    // An unbounded event log in memory is a leak with a UI attached, so `forget` has
    // to both release the history and complete anyone still listening.
    await expect(pending).resolves.toHaveLength(1);
    expect(events.history(RUN)).toEqual([]);
  });

  it('ignores a forget for a run it never saw', () => {
    const events = bus();
    expect(() => {
      events.forget('run_01J0000000000000000000000C');
    }).not.toThrow();
  });

  it('numbers a forgotten run from one again, because its history is gone', () => {
    const events = bus();
    events.publish({ type: 'stage-started', runId: RUN, stage: 'intake' });
    events.forget(RUN);
    expect(events.publish({ type: 'stage-started', runId: RUN, stage: 'intake' }).seq).toBe(1);
  });

  it('closes open streams on shutdown', async () => {
    const events = bus();
    const pending = collect(events.subscribe(RUN));
    events.closeAll();
    await expect(pending).resolves.toEqual([]);
  });
});
