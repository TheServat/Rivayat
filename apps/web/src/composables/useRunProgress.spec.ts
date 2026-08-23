import type { RunId } from '@rv/contracts';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { effectScope, ref } from 'vue';

import { setStudioApi, StudioApi } from '../api/client';
import type { StudioTransport } from '../api/transport';

import { useRunProgress } from './useRunProgress';

const RUN: RunId = 'run_01JQZK3M7X8YB4N2VTC6WPHRDE';

/** A hand-driven `EventSource`: the test decides when it opens, sends and fails. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emit(payload: unknown): void {
    this.onmessage?.(new MessageEvent<string>('message', { data: JSON.stringify(payload) }));
  }

  emitRaw(data: string): void {
    this.onmessage?.(new MessageEvent<string>('message', { data }));
  }
}

const streamingTransport: StudioTransport = {
  kind: 'http',
  send: () => Promise.reject(new Error('not used')),
  eventSourceUrl: (path) => `http://api.test${path}`,
};

function progress(fraction: number): unknown {
  return {
    runId: RUN,
    stage: 'story',
    status: 'running',
    fraction,
    jobId: null,
    spentNanoUsd: 0,
    at: '2026-08-23T10:00:00Z',
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

describe('useRunProgress', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setStudioApi(new StudioApi(streamingTransport));
    FakeEventSource.instances = [];
  });

  function open(options: Parameters<typeof useRunProgress>[1] = {}) {
    return inScope(() =>
      useRunProgress(ref(RUN), {
        createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
        ...options,
      }),
    );
  }

  it('collects validated progress events in order', () => {
    const { value: handle, stop } = open();
    handle.open();
    const stream = FakeEventSource.instances[0];
    expect(stream?.url).toBe(`http://api.test/runs/${RUN}/events`);

    stream?.onopen?.();
    expect(handle.connection.value).toBe('open');

    stream?.emit(progress(0.25));
    stream?.emit(progress(0.5));
    expect(handle.events.value).toHaveLength(2);
    expect(handle.latest.value?.fraction).toBe(0.5);
    stop();
  });

  /**
   * A malformed tick is dropped, not absorbed.
   *
   * A progress event that fails its schema could say the run finished, or that it cost
   * nothing. Letting one through is worse than a gap in the stream, because the UI has
   * no way to tell a wrong number from a right one.
   */
  it('rejects an event that fails its schema and keeps the stream open', () => {
    const { value: handle, stop } = open();
    handle.open();
    const stream = FakeEventSource.instances[0];
    stream?.onopen?.();

    stream?.emit({ ...(progress(0.5) as object), fraction: 42 });
    expect(handle.events.value).toHaveLength(0);
    expect(handle.error.value?.failure).toBe('schema');
    expect(handle.connection.value).toBe('open');

    stream?.emit(progress(0.6));
    expect(handle.events.value).toHaveLength(1);
    stop();
  });

  it('rejects a payload that is not JSON at all', () => {
    const { value: handle, stop } = open();
    handle.open();
    FakeEventSource.instances[0]?.emitRaw('<html>gateway timeout</html>');
    expect(handle.events.value).toHaveLength(0);
    expect(handle.error.value?.code).toBe('sse-payload-not-json');
    stop();
  });

  it('reconnects with growing backoff after a drop', () => {
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      FakeEventSource.instances.at(-1)?.onerror?.();
    }

    expect(delays).toEqual([500, 1000, 2000]);
    expect(FakeEventSource.instances).toHaveLength(4);
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
    for (let attempt = 0; attempt < 4; attempt += 1) {
      FakeEventSource.instances.at(-1)?.onerror?.();
    }

    expect(handle.connection.value).toBe('failed');
    expect(handle.error.value?.code).toBe('sse-reconnect-exhausted');
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
        createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
      }),
    );
    if (handle === undefined) throw new Error('scope did not run');

    handle.open();
    FakeEventSource.instances[0]?.emit(progress(0.4));
    expect(handle.events.value).toHaveLength(1);

    const other = 'run_01JQZM5P9R7S2T4V6W8X0Y1Z3A' as RunId;
    runId.value = other;
    await Promise.resolve();

    expect(handle.events.value).toHaveLength(0);
    expect(FakeEventSource.instances.at(-1)?.url).toContain(other);

    runId.value = null;
    await Promise.resolve();
    expect(handle.connection.value).toBe('idle');
    scope.stop();
  });

  it('does nothing at all when there is no run to watch', () => {
    const { value: handle, stop } = inScope(() =>
      useRunProgress(ref(null), {
        createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
      }),
    );
    handle.open();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(handle.connection.value).toBe('idle');
    expect(handle.latest.value).toBeNull();
    stop();
  });

  it('backs off on a real timer by default, and cancels it on close', () => {
    // The default `schedule` is `setTimeout`; the point here is that closing cancels
    // the pending retry rather than letting it reopen a stream nobody is watching.
    const { value: handle, stop } = inScope(() =>
      useRunProgress(ref(RUN), {
        createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
      }),
    );
    handle.open();
    FakeEventSource.instances[0]?.onerror?.();
    expect(handle.connection.value).toBe('reconnecting');

    handle.close();
    expect(handle.connection.value).toBe('idle');
    expect(FakeEventSource.instances).toHaveLength(1);
    stop();
  });

  it('closes the stream when the owning scope is disposed', () => {
    const { value: handle, stop } = open();
    handle.open();
    const stream = FakeEventSource.instances[0];
    expect(stream?.closed).toBe(false);

    stop();
    expect(stream?.closed).toBe(true);
  });
});
