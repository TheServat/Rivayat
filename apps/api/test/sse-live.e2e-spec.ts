/**
 * The event stream of a run that is still running, and a browser that drops in the
 * middle of it.
 *
 * `sse.e2e-spec.ts` reads the stream of a run that has already finished, which
 * exercises replay and termination and cannot exercise anything else: every event is in
 * the history before the connection opens, so "delivered live" and "replayed" are
 * indistinguishable. Everything a progress UI actually depends on lives in the gap that
 * leaves.
 *
 * So this drives a real S10 render - a few seconds of frames, emitting as it goes - and
 * asserts the four things a client needs and cannot get from a poll:
 *
 *  1. **Events arrive while the stage is working**, not in a batch at the end.
 *  2. **`stage-progress` carries the unit of work**, structured. A progress list renders
 *     "frame 412 of 1,800"; it cannot parse that out of a localised sentence, which is
 *     why `ProgressItem` exists next to `detail` rather than instead of it.
 *  3. **A reconnect misses nothing and repeats nothing.** The browser sends
 *     `Last-Event-ID` on its own; honouring it is the difference between a blip and a
 *     UI stuck on stage 5 forever.
 *  4. **The stream ends** with a terminal event carrying the reason.
 *
 * The run is cancelled rather than completed, which keeps the file off FFmpeg: the
 * encode is the only part of a render that needs the binary, and this file is about the
 * transport.
 */

import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunSummary } from '../src/application/resources';
import type { RunEvent } from '../src/events/run-event';
import type { RunEventBus } from '../src/events/run-event-bus';
import { RUN_EVENT_BUS } from '../src/tokens';
import { CREATE_PROJECT } from './fixtures';
import { renderPayload } from './render-fixtures';
import { bootHarness, type Harness } from './harness';

interface Frame {
  readonly id: number;
  readonly event: string;
  readonly data: RunEvent;
}

/** Parses whole SSE frames out of a rolling buffer, leaving any partial one behind. */
function drainFrames(buffer: string): { readonly frames: Frame[]; readonly rest: string } {
  const chunks = buffer.split('\n\n');
  const rest = chunks.pop() ?? '';
  const frames: Frame[] = [];

  for (const chunk of chunks) {
    const lines = chunk.split('\n').filter((line) => line.length > 0);
    const field = (name: string): string | undefined =>
      lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);

    const id = field('id');
    const event = field('event');
    const data = field('data');
    // Heartbeats carry no id; they exist to keep a proxy from closing an idle socket.
    if (id === undefined || event === undefined || data === undefined) continue;
    frames.push({ id: Number(id), event, data: JSON.parse(data) as RunEvent });
  }

  return { frames, rest };
}

/**
 * Reads the stream until `stop` says enough, then closes the connection.
 *
 * Returns as soon as the predicate is satisfied, which is what makes this a *live*
 * reader: a test that waited for the response body to complete could only ever observe
 * a finished run.
 */
async function readUntil(
  port: number,
  runId: string,
  stop: (frames: readonly Frame[]) => boolean,
  lastEventId?: number,
  /** `query` is the only route open to an `EventSource` a client rebuilt itself. */
  via: 'header' | 'query' = 'header',
): Promise<Frame[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 30_000);

  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (lastEventId !== undefined && via === 'header') {
    headers['last-event-id'] = String(lastEventId);
  }
  const query =
    lastEventId !== undefined && via === 'query' ? `?lastEventId=${String(lastEventId)}` : '';

  const collected: Frame[] = [];
  try {
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/api/runs/${runId}/events${query}`,
      { headers, signal: controller.signal },
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    // Typed, because `ReadableStream`'s default type parameter is `any` in this lib and
    // every `decode` below would inherit it.
    const body: ReadableStream<Uint8Array> | null = response.body;
    if (body === null) throw new Error('the SSE response had no body');
    const reader = body.getReader();

    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (value !== undefined) {
        buffer += decoder.decode(value, { stream: true });
        const drained = drainFrames(buffer);
        buffer = drained.rest;
        collected.push(...drained.frames);
      }
      if (stop(collected)) {
        // What a browser tab closing does. The server must survive it and the run must
        // carry on.
        await reader.cancel();
        break;
      }
      if (done) break;
    }
  } finally {
    clearTimeout(timer);
  }
  return collected;
}

describe('the run event stream, live', () => {
  let harness: Harness;
  let port: number;
  let projectId: string;

  beforeAll(async () => {
    harness = await bootHarness();
    await harness.app.listen(0);
    port = (harness.server.address() as AddressInfo).port;

    const created = await request(harness.server)
      .post('/api/projects')
      .send(CREATE_PROJECT)
      .expect(201);
    projectId = (created.body as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  async function startRender(): Promise<string> {
    const started = await request(harness.server)
      .post('/api/runs')
      .send({
        projectId,
        stages: ['render'],
        seed: 42,
        payload: { render: renderPayload(7) },
      })
      .expect(202);
    return (started.body as RunSummary).id;
  }

  it('delivers progress while the stage is working, and a reconnect neither misses nor repeats', async () => {
    const runId = await startRender();

    // ── first connection: watch it work ────────────────────────────────
    const first = await readUntil(port, runId, (frames) => frames.length >= 4);
    expect(first[0]?.event).toBe('stage-started');

    const progress = first.filter((frame) => frame.event === 'stage-progress');
    expect(progress.length).toBeGreaterThan(0);

    // Live, not replayed: the run has not finished, so a terminal event cannot be
    // among these.
    expect(first.some((frame) => frame.event === 'run-completed')).toBe(false);

    // The unit of work, structured. `detail` is prose for a human next to it.
    const sample = progress.at(-1)?.data;
    if (sample?.type !== 'stage-progress') throw new Error('expected a progress event');
    expect(sample.item).toMatchObject({ kind: 'frame' });
    expect(sample.item?.total).toBeGreaterThan(0);
    expect(sample.stage).toBe('render');

    const lastSeen = first.at(-1)?.id ?? 0;
    expect(lastSeen).toBeGreaterThan(0);

    // ── the browser drops and comes back ───────────────────────────────
    const second = await readUntil(port, runId, (frames) => frames.length >= 2, lastSeen);

    // Nothing missed: the first event after the reconnect is the very next sequence
    // number. Nothing repeated: it is not 1, which is what a stream that replayed
    // from the beginning would send.
    expect(second[0]?.id).toBe(lastSeen + 1);
    expect(second[0]?.id).not.toBe(1);

    // ── stop it, and read the tail to termination ──────────────────────
    await request(harness.server).post(`/api/runs/${runId}/cancel`).expect(202);

    const tail = await readUntil(
      port,
      runId,
      (frames) => frames.some((frame) => frame.event === 'run-completed'),
      second.at(-1)?.id ?? lastSeen,
    );

    const terminal = tail.at(-1);
    expect(terminal?.event).toBe('run-completed');
    if (terminal?.data.type !== 'run-completed') throw new Error('expected a terminal event');
    expect(terminal.data.status).toBe('cancelled');
    expect(terminal.data.errorKind).toBe('cancelled');

    // ── the whole stream, across three connections ─────────────────────
    const everything = [...first, ...second, ...tail].map((frame) => frame.id);
    const ordered = [...new Set(everything)].sort((left, right) => left - right);
    expect(ordered[0]).toBe(1);
    // Gap-free: `Last-Event-ID` is meaningless if the sequence has holes in it, and a
    // client cannot tell a hole from an event it has not received yet.
    for (const [index, seq] of ordered.entries()) expect(seq).toBe(index + 1);
  }, 120_000);

  it('resumes from a query parameter, which is the only route an EventSource has', async () => {
    const runId = await startRender();
    const first = await readUntil(port, runId, (frames) => frames.length >= 3);
    const lastSeen = first.at(-1)?.id ?? 0;
    expect(lastSeen).toBeGreaterThan(0);

    // `EventSource` cannot set a header. A client that rebuilds its own connection had
    // no way to say where it got to, so it replayed from 1 - which made an explicit
    // reconnect strictly worse than the browser's implicit one, and pushed clients into
    // relying on the browser's internal retry to avoid it.
    const resumed = await readUntil(port, runId, (frames) => frames.length >= 1, lastSeen, 'query');

    expect(resumed[0]?.id).toBe(lastSeen + 1);
    expect(resumed[0]?.id).not.toBe(1);

    await request(harness.server).post(`/api/runs/${runId}/cancel`).expect(202);
  }, 120_000);

  it('ends the stream of a run that finished before this process was watching', async () => {
    // The seeded run, or any run resumed after a restart: terminal in the database and
    // unknown to the in-memory bus. Its channel is open, empty and would never complete,
    // so a client waiting for a terminal event waited behind heartbeats for ever.
    const runId = await startRender();
    await request(harness.server).post(`/api/runs/${runId}/cancel`).expect(202);
    // Drop the history, which is exactly what a restart does to it.
    harness.app.get<RunEventBus>(RUN_EVENT_BUS).forget(runId);

    const frames = await readUntil(port, runId, (list) =>
      list.some((frame) => frame.event === 'run-completed'),
    );

    const terminal = frames.at(-1);
    expect(terminal?.event).toBe('run-completed');
    if (terminal?.data.type !== 'run-completed') throw new Error('expected a terminal event');
    // Reconstructed from the run record, so it carries the reason and not just the fact.
    expect(terminal.data.status).toBe('cancelled');
    expect(terminal.data.errorKind).toBe('cancelled');
  }, 120_000);

  it('replays from the beginning when the client claims a sequence this stream never sent', async () => {
    // A resumed run is watched by a browser that still holds an id from before the
    // restart. The bus is per-process, so the new channel numbers from 1 and a naive
    // `seq > 40` filter sends that client nothing, for ever, about a run that is
    // visibly progressing. Replaying is idempotent for the client; silence is not
    // recoverable at all.
    const runId = await startRender();
    const frames = await readUntil(port, runId, (list) => list.length >= 2, 9_999);

    expect(frames[0]?.id).toBe(1);
    expect(frames[0]?.event).toBe('stage-started');

    await request(harness.server).post(`/api/runs/${runId}/cancel`).expect(202);
  }, 120_000);
});
