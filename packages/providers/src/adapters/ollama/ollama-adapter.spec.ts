import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toLlmJsonSchema } from '@rv/contracts';
import { isErr, isOk } from '@rv/shared-kernel';
import { z } from 'zod';

import { FetchStub } from '../../__fixtures__/fetch-stub';
import { ollama as fixture } from '../../__fixtures__/responses';
import { fixedClock } from '../../__fixtures__/support';
import { OLLAMA_CAPABILITIES, OllamaAdapter } from './ollama-adapter';

function adapterWith(stub: FetchStub): OllamaAdapter {
  return new OllamaAdapter({
    model: 'qwen3.5:latest',
    baseUrl: 'http://127.0.0.1:11434',
    fetch: stub.fetch,
    clock: fixedClock(),
  });
}

describe('OllamaAdapter identity', () => {
  it('declares itself honestly', () => {
    const adapter = adapterWith(new FetchStub());
    expect(adapter.kind).toBe('ollama');
    expect(adapter.modelRef).toBe('ollama:qwen3.5:latest');
    expect(adapter.id).toBe(adapter.modelRef);
    expect(adapter.dialect).toBe('ollama');
    expect(adapter.capabilities).toEqual(OLLAMA_CAPABILITIES);
  });

  it('reports enforcesSchema as false even though it sends the schema', () => {
    // Research §1 / ollama#15540: `qwen3.5` and `gemma4` accept a schema and then
    // violate it. `false` is the honest answer, and it is what keeps `StructuredCall`
    // restating the schema in the prompt and keeps its repair loop armed. Claiming
    // enforcement here would silently disarm both.
    expect(adapterWith(new FetchStub()).enforcesSchema).toBe(false);
  });

  it('can be narrowed for a model without a vision head', () => {
    const adapter = new OllamaAdapter({
      model: 'qwen3.5:latest',
      capabilities: ['text-generation', 'structured-generation'],
    });
    expect(adapter.capabilities).not.toContain('vision-scoring');
  });
});

describe('OllamaAdapter.complete', () => {
  it('posts the native /api/chat with the schema in `format`', async () => {
    const stub = new FetchStub().on('/api/chat', { json: fixture.chat('{"ok":true}') });
    const schema = toLlmJsonSchema(z.object({ ok: z.boolean() }), { dialect: 'ollama' });

    const outcome = await adapterWith(stub).complete({
      messages: [{ role: 'user', content: 'reply with {"ok":true}' }],
      jsonSchema: schema,
    });

    expect(isOk(outcome)).toBe(true);
    const request = stub.requestsFor('/api/chat')[0];
    expect(request?.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(request?.method).toBe('POST');
    const body = request?.json as Record<string, unknown>;
    expect(body.format).toEqual(schema);
    expect(body.stream).toBe(false);
  });

  it('sets temperature 0 and think false for extraction, per research §1', async () => {
    const stub = new FetchStub().on('/api/chat', { json: fixture.chat('{}') });
    await adapterWith(stub).complete({ messages: [{ role: 'user', content: 'x' }] });

    const body = stub.requestsFor('/api/chat')[0]?.json as {
      think: boolean;
      options: { temperature: number };
    };
    expect(body.think).toBe(false);
    expect(body.options.temperature).toBe(0);
  });

  it('omits `format` when the caller supplied no schema', async () => {
    const stub = new FetchStub().on('/api/chat', { json: fixture.chat('{}') });
    await adapterWith(stub).complete({ messages: [{ role: 'user', content: 'x' }] });

    const body = stub.requestsFor('/api/chat')[0]?.json as Record<string, unknown>;
    expect(body).not.toHaveProperty('format');
  });

  it('returns the text, the token counts and a zero cost', async () => {
    const stub = new FetchStub().on('/api/chat', { json: fixture.chat('hello') });
    const outcome = await adapterWith(stub).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.text).toBe('hello');
      expect(outcome.value.usage).toEqual({ inputTokens: 26, outputTokens: 42 });
      // Local inference is free, and the ledger row says so rather than saying nothing.
      expect(outcome.value.costNanoUsd).toBe(0);
      expect(outcome.value.modelId).toBe('ollama:qwen3.5:latest');
    }
  });

  it('passes maxOutputTokens through as num_predict', async () => {
    const stub = new FetchStub().on('/api/chat', { json: fixture.chat('x') });
    await adapterWith(stub).complete({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 256,
      temperature: 0.7,
      think: true,
    });

    const body = stub.requestsFor('/api/chat')[0]?.json as {
      think: boolean;
      options: { num_predict: number; temperature: number };
    };
    expect(body.options.num_predict).toBe(256);
    expect(body.options.temperature).toBe(0.7);
    expect(body.think).toBe(true);
  });

  it('reports a malformed 200 body as a retryable ProviderError', async () => {
    const stub = new FetchStub().on('/api/chat', { json: { message: {} } });
    const outcome = await adapterWith(stub).complete({
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.kind).toBe('provider');
      expect(outcome.error.retryable).toBe(true);
    }
  });
});

describe('OllamaAdapter.generateText', () => {
  it('returns prose with usage and a finish reason', async () => {
    const stub = new FetchStub().on('/api/chat', { json: fixture.chat('once upon a time') });
    const outcome = await adapterWith(stub).generateText({
      messages: [{ role: 'user', content: 'write' }],
      seed: 7,
      stopSequences: ['THE END'],
    });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.text).toBe('once upon a time');
      expect(outcome.value.finishReason).toBe('stop');
      expect(outcome.value.usage.tokens.input).toBe(26);
    }

    const body = stub.requestsFor('/api/chat')[0]?.json as {
      options: { seed: number; stop: string[] };
    };
    expect(body.options.seed).toBe(7);
    expect(body.options.stop).toEqual(['THE END']);
  });
});

describe('OllamaAdapter.embed', () => {
  it('returns one vector per input, of equal non-zero length', async () => {
    const stub = new FetchStub().on('/api/embed', { json: fixture.embed });
    const outcome = await adapterWith(stub).embed({ texts: ['a', 'b'] });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.vectors).toHaveLength(2);
      expect(outcome.value.dimensions).toBe(4);
      expect(outcome.value.vectors[0]).toHaveLength(outcome.value.dimensions);
      expect(outcome.value.vectors[1]).toHaveLength(outcome.value.dimensions);
    }
  });

  it('refuses when the server returned no vectors at all', async () => {
    const stub = new FetchStub().on('/api/embed', { json: { model: 'x', embeddings: [] } });
    const outcome = await adapterWith(stub).embed({ texts: ['a'] });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.retryable).toBe(false);
  });

  it('reports a malformed embed body', async () => {
    const stub = new FetchStub().on('/api/embed', { json: { embeddings: 'nope' } });
    const outcome = await adapterWith(stub).embed({ texts: ['a'] });
    expect(isErr(outcome)).toBe(true);
  });
});

describe('OllamaAdapter.score', () => {
  const rubric = [
    { key: 'style-match', question: 'Does it match the style bible?' },
    { key: 'silhouette', question: 'Is the silhouette readable?', weight: 3 },
  ];

  it('sends the image as base64 and returns weighted scores', async () => {
    const sheet = JSON.stringify({
      scores: [
        { key: 'style-match', score: 1, reason: 'exact' },
        { key: 'silhouette', score: 0.5, reason: 'muddy legs' },
      ],
    });
    const stub = new FetchStub().on('/api/chat', { json: fixture.chat(sheet) });

    const outcome = await adapterWith(stub).score({
      image: { mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) },
      rubric,
    });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      // (1*1 + 0.5*3) / 4 = 0.625 - the weight is applied, not ignored.
      expect(outcome.value.overall).toBeCloseTo(0.625, 10);
      expect(outcome.value.usage.images.count).toBe(1);
    }

    const body = stub.requestsFor('/api/chat')[0]?.json as {
      messages: { images: string[] }[];
      format: Record<string, unknown>;
    };
    expect(body.messages[0]?.images).toEqual([Buffer.from([1, 2, 3]).toString('base64')]);
    expect(body.format).toBeDefined();
  });

  it('strips a markdown fence before validating - the exact research §1 symptom', async () => {
    const fenced = '```json\n{"scores":[{"key":"style-match","score":0.9,"reason":"close"}]}\n```';
    const stub = new FetchStub().on('/api/chat', { json: fixture.chat(fenced) });

    const outcome = await adapterWith(stub).score({
      image: { mimeType: 'image/png', data: new Uint8Array([9]) },
      rubric: [rubric[0]!],
    });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) expect(outcome.value.scores[0]?.score).toBe(0.9);
  });

  it('fails rather than scoring an unanswered criterion', async () => {
    // Scoring a missing criterion 0 fails good assets; scoring it 1 passes bad ones.
    const partial = JSON.stringify({ scores: [{ key: 'style-match', score: 1, reason: 'ok' }] });
    const stub = new FetchStub().on('/api/chat', { json: fixture.chat(partial) });

    const outcome = await adapterWith(stub).score({
      image: { mimeType: 'image/png', data: new Uint8Array([9]) },
      rubric,
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.kind).toBe('validation');
      expect(outcome.error.context.missing).toEqual(['silhouette']);
    }
  });

  it('fails on a response that is not JSON at all', async () => {
    const stub = new FetchStub().on('/api/chat', { json: fixture.chat('I cannot see images.') });
    const outcome = await adapterWith(stub).score({
      image: { mimeType: 'image/png', data: new Uint8Array([9]) },
      rubric,
    });
    expect(isErr(outcome)).toBe(true);
  });

  it('fails on JSON that violates the score sheet', async () => {
    const bad = JSON.stringify({ scores: [{ key: 'style-match', score: 5, reason: 'ok' }] });
    const stub = new FetchStub().on('/api/chat', { json: fixture.chat(bad) });
    const outcome = await adapterWith(stub).score({
      image: { mimeType: 'image/png', data: new Uint8Array([9]) },
      rubric: [rubric[0]!],
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('validation');
  });
});

describe('the OpenAI-compatible shim', () => {
  it('is never referenced anywhere in this package', () => {
    // RV-022: research §1 identifies Ollama's OpenAI shim as the thing that does not
    // enforce JSON Schema. Assembling the path from parts keeps this assertion from
    // matching itself.
    const forbidden = `/${'v1'}/${'chat'}/${'completions'}`;
    const root = fileURLToPath(new URL('../../', import.meta.url));

    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith('.ts')) continue;
        if (readFileSync(path, 'utf8').includes(forbidden)) offenders.push(path);
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});
