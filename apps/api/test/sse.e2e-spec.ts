/**
 * `GET /api/runs/:id/events`, over a real HTTP connection.
 *
 * `run-event-bus.spec.ts` proves the bus orders, replays and terminates. This proves
 * the *transport* does: that the frames are well-formed SSE, that the `id:` field
 * carries the sequence number a browser will send back as `Last-Event-ID`, that the
 * events arrive in pipeline order, and - the one a unit test cannot show - that the
 * response actually ends rather than being left open.
 *
 * Read over the raw socket rather than through supertest's buffering, because the
 * question is when bytes arrive and whether the stream closes, and a buffered body
 * answers neither.
 */

import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunSummary } from '../src/application/resources';
import { CREATE_PROJECT, IDEA_BRIEF } from './fixtures';
import { bootHarness, type Harness } from './harness';

interface SseFrame {
  readonly id: string | null;
  readonly event: string | null;
  readonly data: string;
}

/** Splits an SSE body into frames. Deliberately strict about the wire format. */
function parseFrames(body: string): SseFrame[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const field = (name: string): string | null => {
        const line = lines.find((entry) => entry.startsWith(`${name}: `));
        return line === undefined ? null : line.slice(name.length + 2);
      };
      return { id: field('id'), event: field('event'), data: field('data') ?? '' };
    });
}

/**
 * Opens the stream and reads until the server closes it.
 *
 * The timeout is a guard against a stream that never terminates - which is precisely
 * the regression this file exists to catch, so it must fail rather than hang.
 */
async function readStream(port: number, path: string, timeoutMs = 8000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

describe('the run event stream', () => {
  let harness: Harness;
  let port: number;

  beforeAll(async () => {
    harness = await bootHarness();
    await harness.app.listen(0);
    port = (harness.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await harness.close();
  });

  async function completedRun(): Promise<RunSummary> {
    const project = (
      await request(harness.server).post('/api/projects').send(CREATE_PROJECT).expect(201)
    ).body as { id: string };

    const started = (
      await request(harness.server)
        .post('/api/runs')
        .send({
          projectId: project.id,
          stages: ['intake'],
          seed: 1,
          payload: { brief: IDEA_BRIEF },
        })
        .expect(202)
    ).body as RunSummary;

    // Settle before subscribing: the bus replays its whole history to a late
    // subscriber, so this exercises replay *and* termination in one connection.
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const current = (await request(harness.server).get(`/api/runs/${started.id}`).expect(200))
        .body as RunSummary;
      if (current.status === 'succeeded' || current.status === 'failed') return current;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the run never settled');
  }

  it('emits the stage events in order and terminates cleanly', async () => {
    const run = await completedRun();
    const body = await readStream(port, `/api/runs/${run.id}/events`);
    const frames = parseFrames(body);

    expect(frames.map((frame) => frame.event)).toEqual([
      'stage-started',
      'stage-progress',
      'stage-progress',
      'stage-completed',
      'run-completed',
    ]);

    // Terminated: `readStream` resolved, which only happens when the server ended the
    // response. A stream left open would have hit the abort and thrown instead.
    const last = frames.at(-1);
    expect(last?.event).toBe('run-completed');
    expect(JSON.parse(last?.data ?? '{}')).toMatchObject({ status: 'succeeded', errorKind: null });
  });

  it('numbers every frame with the sequence a browser sends back as Last-Event-ID', async () => {
    const run = await completedRun();
    const frames = parseFrames(await readStream(port, `/api/runs/${run.id}/events`));

    expect(frames.map((frame) => frame.id)).toEqual(['1', '2', '3', '4', '5']);
    for (const frame of frames) {
      const payload = JSON.parse(frame.data) as { seq: number; runId: string; at: string };
      expect(String(payload.seq)).toBe(frame.id);
      expect(payload.runId).toBe(run.id);
      expect(payload.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('replays only what a reconnecting client missed', async () => {
    const run = await completedRun();
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/runs/${run.id}/events`, {
      headers: { accept: 'text/event-stream', 'last-event-id': '3' },
    });
    const frames = parseFrames(await response.text());

    expect(frames.map((frame) => frame.id)).toEqual(['4', '5']);
  });

  it('ignores a malformed Last-Event-ID rather than refusing the connection', async () => {
    const run = await completedRun();
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/runs/${run.id}/events`, {
      headers: { accept: 'text/event-stream', 'last-event-id': 'not-a-number' },
    });
    const frames = parseFrames(await response.text());

    // The header is set by the browser, not by our client code. Refusing over a bad one
    // turns a recoverable reconnect into a dead stream.
    expect(frames).toHaveLength(5);
  });

  it('advertises a reconnect delay so a restarting server is not hammered', async () => {
    const run = await completedRun();
    const body = await readStream(port, `/api/runs/${run.id}/events`);
    expect(body).toContain('retry: 3000');
  });

  it('rejects a malformed run id before opening a stream', async () => {
    await request(harness.server).get('/api/runs/not-an-id/events').expect(400);
  });

  it('404s a run that does not exist rather than holding the socket open', async () => {
    // The failure this replaces was not an error, it was silence: an unknown run got a
    // 200 and a stream that never emitted and never closed, so a typo cost a
    // connection until the client gave up.
    await request(harness.server)
      .get('/api/runs/run_01J0000000000000000000000Z/events')
      .expect(404);
  });
});
