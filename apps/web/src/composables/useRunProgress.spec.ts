import type { RunId } from '@rv/contracts';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { effectScope, ref } from 'vue';

import { setStudioApi, StudioApi } from '../api/client';
import type { RunEvent } from '../api/schemas/pending-contracts';
import type { StudioTransport } from '../api/transport';
import { FakeEventSource } from '../test/fake-event-source';

import { useRunProgress } from './useRunProgress';

const RUN: RunId = 'run_01JQZK3M7X8YB4N2VTC6WPHRDE';

const streamingTransport: StudioTransport = {
  kind: 'http',
  send: () => Promise.reject(new Error('not used')),
  eventSourceUrl: (path) => `http://api.test${path}`,
};

function started(seq: number): RunEvent {
  return {
    type: 'stage-started',
    runId: RUN,
    stage: 'story',
    seq,
    at: '2026-08-23T10:00:00Z',
  };
}

function progress(seq: number, fraction: number): RunEvent {
  return {
    type: 'stage-progress',
    runId: RUN,
    stage: 'story',
    progress: fraction,
    detail: null,
    item: null,
    seq,
    at: '2026-08-23T10:00:01Z',
  };
}

function cost(seq: number, total: number, remaining: number | null): RunEvent {
  return {
    type: 'cost-updated',
    runId: RUN,
    stage: 'story',
    deltaNanoUsd: 1000,
    totalNanoUsd: total,
    remainingNanoUsd: remaining,
    seq,
    at: '2026-08-23T10:00:02Z',
  };
}

function issue(seq: number): RunEvent {
  return {
    type: 'issue-raised',
    runId: RUN,
    stage: 'story',
    severity: 'warning',
    code: 'story.beat-thin',
    message: 'a beat carries no turn',
    seq,
    at: '2026-08-23T10:00:03Z',
  };
}

/** Runs `body` inside an effect scope, then disposes it - as a component would. */
function inScope<T>(body: () => T): { value: T; stop: () => void } {
  const scope = effectScope();
  const value = scope.run(body) as T;
  return {
    value,
    stop: () => {
      scope.stop();
    },
  };
}

function current(): FakeEventSource {
  const source = FakeEventSource.opened.at(-1);
  if (source === undefined) throw new Error('no stream was opened');
  return source;
}

describe('useRunProgress', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setStudioApi(new StudioApi(streamingTransport));
    FakeEventSource.opened.length = 0;
  });

  function open(options: Parameters<typeof useRunProgress>[1] = {}) {
    return inScope(() =>
      useRunProgress(ref(RUN), {
        createEventSource: (url) => new FakeEventSource(url).asEventSource(),
        ...options,
      }),
    );
  }

  it('hears the named frames the API actually sends', () => {
    // This is the regression. The composable used to read `stream.onmessage`, which
    // `EventSource` never calls for a frame carrying an `event:` line - so it connected,
    // reported `open`, and received nothing for ever.
    const { value: handle, stop } = open();
    handle.open();
    expect(current().url).toBe(`http://api.test/runs/${RUN}/events`);

    current().open();
    expect(handle.connection.value).toBe('open');

    current().emit(started(1));
    current().emit(progress(2, 0.5));
    expect(handle.events.value).toHaveLength(2);
    expect(handle.latest.value?.type).toBe('stage-progress');
    stop();
  });

  it('ignores an unnamed frame, so wiring onmessage back in cannot pass', () => {
    const { value: handle, stop } = open();
    handle.open();
    current().message(JSON.stringify(progress(1, 0.5)));
    expect(handle.events.value).toHaveLength(0);
    expect(handle.error.value).toBeNull();
    stop();
  });

  it('folds progress per stage, and a finished stage is finished', () => {
    const { value: handle, stop } = open();
    handle.open();
    current().emit(progress(1, 0.4));
    expect(handle.state.value.progress.get('story')).toBe(0.4);

    current().emit({
      type: 'stage-completed',
      runId: RUN,
      stage: 'story',
      durationMs: 4200,
      costNanoUsd: 250,
      seq: 2,
      at: '2026-08-23T10:00:04Z',
    });
    expect(handle.state.value.progress.get('story')).toBe(1);
    stop();
  });

  it('carries spend and headroom, which is the half of a run that is actionable', () => {
    // "You have spent $3.40 of your $5" at minute four is actionable. The same sentence
    // at the end is a receipt.
    const { value: handle, stop } = open();
    handle.open();
    current().emit(cost(1, 3_400_000_000, 1_600_000_000));
    expect(handle.state.value.costNanoUsd).toBe(3_400_000_000);
    expect(handle.state.value.remainingNanoUsd).toBe(1_600_000_000);
    stop();
  });

  it('records the terminal status from the last frame on the stream', () => {
    const { value: handle, stop } = open();
    handle.open();
    current().emit({
      type: 'run-completed',
      runId: RUN,
      status: 'cancelled',
      totalNanoUsd: 0,
      errorKind: null,
      errorCode: null,
      seq: 1,
      at: '2026-08-23T10:00:05Z',
    });
    expect(handle.state.value.finishedStatus).toBe('cancelled');
    // The server closes the socket after the terminal frame; so do we, rather than
    // letting the browser treat that close as a drop and reconnect to a finished run.
    expect(current().closed).toBe(true);
    expect(handle.connection.value).toBe('idle');
    stop();
  });

  /**
   * A malformed tick is dropped, not absorbed.
   *
   * A progress event that fails its schema could say the run finished, or that it cost
   * nothing. Letting one through is worse than a gap in the stream, because the UI has
   * no way to tell a wrong number from a right one.
   */
  it('rejects a frame that fails its schema and keeps the stream open', () => {
    const { value: handle, stop } = open();
    handle.open();
    current().open();

    current().raw('stage-progress', JSON.stringify({ ...progress(1, 0.5), progress: 42 }));
    expect(handle.events.value).toHaveLength(0);
    expect(handle.error.value?.failure).toBe('schema');
    expect(handle.connection.value).toBe('open');

    current().emit(progress(2, 0.6));
    expect(handle.events.value).toHaveLength(1);
    stop();
  });

  it('rejects a payload that is not JSON at all', () => {
    const { value: handle, stop } = open();
    handle.open();
    current().raw('stage-started', '<html>gateway timeout</html>');
    expect(handle.events.value).toHaveLength(0);
    expect(handle.error.value?.code).toBe('run-event-not-json');
    stop();
  });

  it('lets the browser retry a transient drop, because only it sends Last-Event-ID', () => {
    const { value: handle, stop } = open();
    handle.open();
    current().open();
    current().drop();

    expect(handle.connection.value).toBe('reconnecting');
    // No second socket: throwing this one away would lose the id the server resumes
    // from, and the whole run would replay from its first event.
    expect(FakeEventSource.opened).toHaveLength(1);
    expect(current().closed).toBe(false);
    stop();
  });

  it('delivers what a reconnect missed and nothing twice', () => {
    const { value: handle, stop } = open();
    handle.open();
    current().open();
    current().emit(started(1));
    current().emit(issue(2));

    current().drop();
    current().open();
    // Worst case the server replays the history it already sent, then the rest.
    current().emit(started(1));
    current().emit(issue(2));
    current().emit(progress(3, 0.9));

    expect(handle.events.value.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(handle.state.value.issues).toHaveLength(1);
    stop();
  });

  it('rebuilds the socket only once the browser has given up on it', () => {
    const delays: number[] = [];
    const { value: handle, stop } = open({
      schedule: (callback, delayMs) => {
        delays.push(delayMs);
        callback();
        return 0;
      },
      cancelSchedule: () => undefined,
      maxAttempts: 3,
    });

    handle.open();
    for (let attempt = 0; attempt < 3; attempt += 1) current().fail();

    expect(delays).toEqual([500, 1000, 2000]);
    expect(FakeEventSource.opened).toHaveLength(4);
    expect(handle.connection.value).toBe('reconnecting');
    stop();
  });

  it('gives up after the attempt budget rather than retrying forever', () => {
    const { value: handle, stop } = open({
      schedule: (callback) => {
        callback();
        return 0;
      },
      cancelSchedule: () => undefined,
      maxAttempts: 2,
    });

    handle.open();
    for (let attempt = 0; attempt < 4; attempt += 1) current().fail();

    expect(handle.connection.value).toBe('failed');
    expect(handle.error.value?.code).toBe('run-stream-reconnect-exhausted');
    stop();
  });

  it('reports a transport with no stream instead of silently doing nothing', () => {
    setStudioApi(
      new StudioApi({
        kind: 'fixture',
        send: () => Promise.reject(new Error('not used')),
        eventSourceUrl: () => null,
      }),
    );
    const { value: handle, stop } = open();
    handle.open();

    expect(handle.connection.value).toBe('failed');
    expect(handle.error.value?.code).toBe('sse-unavailable');
    stop();
  });

  it('opens a fresh stream and drops old events when the run id changes', async () => {
    const runId = ref<RunId | null>(RUN);
    const scope = effectScope();
    const handle = scope.run(() =>
      useRunProgress(runId, {
        createEventSource: (url) => new FakeEventSource(url).asEventSource(),
      }),
    );
    if (handle === undefined) throw new Error('scope did not run');

    handle.open();
    current().emit(progress(1, 0.4));
    expect(handle.events.value).toHaveLength(1);

    const other = 'run_01JQZM5P9R7S2T4V6W8X0Y1Z3A' as RunId;
    runId.value = other;
    await Promise.resolve();

    expect(handle.events.value).toHaveLength(0);
    expect(handle.state.value.progress.size).toBe(0);
    expect(current().url).toContain(other);

    runId.value = null;
    await Promise.resolve();
    expect(handle.connection.value).toBe('idle');
    scope.stop();
  });

  it('does nothing at all when there is no run to watch', () => {
    const { value: handle, stop } = inScope(() =>
      useRunProgress(ref(null), {
        createEventSource: (url) => new FakeEventSource(url).asEventSource(),
      }),
    );
    handle.open();
    expect(FakeEventSource.opened).toHaveLength(0);
    expect(handle.connection.value).toBe('idle');
    expect(handle.latest.value).toBeNull();
    stop();
  });

  it('cancels a pending retry when it is closed', () => {
    const { value: handle, stop } = open();
    handle.open();
    current().fail();
    expect(handle.connection.value).toBe('reconnecting');

    handle.close();
    expect(handle.connection.value).toBe('idle');
    expect(FakeEventSource.opened).toHaveLength(1);
    stop();
  });

  it('closes the stream when the owning scope is disposed', () => {
    const { value: handle, stop } = open();
    handle.open();
    expect(current().closed).toBe(false);

    stop();
    expect(current().closed).toBe(true);
  });
});
