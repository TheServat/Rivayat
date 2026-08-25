/**
 * The streaming half of the HTTP client, which exists because of a deadline nobody set.
 *
 * Node's fetch caps the wait for the first response *header* at 300 seconds. Ollama with
 * `stream: false` sends nothing until generation is complete, so any call taking longer
 * than five minutes failed with `fetch failed` - a network fault that was not one, and
 * one our own timeout could not raise because the cap is below it and belongs to the HTTP
 * stack. `postNdjson` moves the first byte to the start of generation.
 *
 * These tests are about reassembly, because that is the part that can be silently wrong:
 * a client that dropped a chunk, or split a line at the wrong place, returns a shorter
 * answer rather than an error.
 */

import { FixedClock, isErr, isOk } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { JsonHttpClient } from './json-http';

const CLOCK = new FixedClock(1_700_000_000_000);

interface Chunks {
  text: string;
  done: boolean;
}

/** Concatenates `text`, and takes `done` from whichever chunk last stated it. */
function merge(accumulated: Chunks | undefined, chunk: unknown): Chunks {
  const base = accumulated ?? { text: '', done: false };
  const next = chunk as { text?: unknown; done?: unknown };
  return {
    text: base.text + (typeof next.text === 'string' ? next.text : ''),
    done: typeof next.done === 'boolean' ? next.done : base.done,
  };
}

/**
 * A client whose fetch answers with exactly these byte chunks.
 *
 * The chunk boundaries are the point. A real socket splits wherever it likes, and the
 * one place this code can be wrong is at a boundary that falls mid-line.
 */
function clientEmitting(chunks: readonly string[]): JsonHttpClient {
  const encoder = new TextEncoder();
  return new JsonHttpClient({
    baseUrl: 'http://localhost',
    provider: 'test',
    clock: CLOCK,
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        ),
      ),
  });
}

describe('postNdjson', () => {
  it('reassembles one object per line into a single result', async () => {
    const client = clientEmitting([
      '{"text":"a"}\n',
      '{"text":"b"}\n',
      '{"text":"c","done":true}\n',
    ]);

    const outcome = await client.postNdjson('/api/chat', {}, merge);

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value).toEqual({ text: 'abc', done: true });
  });

  it('survives a chunk boundary that falls in the middle of a line', async () => {
    // The failure this prevents is not an error - it is a shorter answer. A client that
    // parsed each chunk as it arrived would throw on `{"te`, and one that discarded the
    // unparseable remainder would silently lose the token it contained.
    const client = clientEmitting(['{"te', 'xt":"a"}\n{"text":"b"', '}\n{"done":true}\n']);

    const outcome = await client.postNdjson('/api/chat', {}, merge);

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value).toEqual({ text: 'ab', done: true });
  });

  it('reads a final line that arrived without a trailing newline', async () => {
    // Ollama does terminate its last line, but a stream that ends cleanly without one is
    // valid NDJSON, and dropping it would lose exactly the chunk carrying `done` and the
    // token counts - which is the chunk everything downstream reads.
    const client = clientEmitting(['{"text":"a"}\n{"text":"b","done":true}']);

    const outcome = await client.postNdjson('/api/chat', {}, merge);

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value).toEqual({ text: 'ab', done: true });
  });

  it('ignores blank lines rather than failing on them', async () => {
    const client = clientEmitting(['{"text":"a"}\n\n{"text":"b","done":true}\n']);

    const outcome = await client.postNdjson('/api/chat', {}, merge);

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.text).toBe('ab');
  });

  it('reports a stream that contained no complete line, rather than inventing a result', async () => {
    const client = clientEmitting([]);

    const outcome = await client.postNdjson('/api/chat', {}, merge);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('provider');
    // Retryable: an empty stream is a dropped connection far more often than a contract
    // change, and one more attempt against a local model costs nothing.
    expect(outcome.error.retryable).toBe(true);
  });

  it('reports unparseable JSON as a provider failure, not as a partial success', async () => {
    const client = clientEmitting(['{"text":"a"}\nnot json at all\n']);

    const outcome = await client.postNdjson('/api/chat', {}, merge);

    expect(isErr(outcome)).toBe(true);
  });

  it('refuses before opening a socket when the caller has already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    let opened = 0;
    const client = new JsonHttpClient({
      baseUrl: 'http://localhost',
      provider: 'test',
      clock: CLOCK,
      fetch: () => {
        opened += 1;
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });

    const outcome = await client.postNdjson('/api/chat', {}, merge, {
      signal: controller.signal,
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('cancelled');
    // A cancelled call must provably make zero requests, not one it then discards.
    expect(opened).toBe(0);
  });

  it('surfaces a non-2xx as the status it was, before trying to stream it', async () => {
    const client = new JsonHttpClient({
      baseUrl: 'http://localhost',
      provider: 'test',
      clock: CLOCK,
      fetch: () => Promise.resolve(new Response('model not found', { status: 404 })),
    });

    const outcome = await client.postNdjson('/api/chat', {}, merge);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    // The failure is the status, reported as the HTTP layer classifies it - not
    // "streamed no complete line", which is what a client that fed an error body to the
    // parser would say. The distinction matters to whoever reads the log: one names a
    // provider that answered, the other names a connection that did not.
    expect(outcome.error.message).not.toContain('streamed no complete line');
    expect(outcome.error.context.operation).toBe('POST /api/chat');
  });
});
