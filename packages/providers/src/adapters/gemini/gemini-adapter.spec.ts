import { afterEach, describe, expect, it, vi } from 'vitest';
import { toLlmJsonSchema } from '@rv/contracts';
import { isErr, isOk } from '@rv/shared-kernel';
import { z } from 'zod';

import { FetchStub } from '../../__fixtures__/fetch-stub';
import { gemini as fixture, pngBytes, pngSha256 } from '../../__fixtures__/responses';
import { fixedClock } from '../../__fixtures__/support';
import { GEMINI_CAPABILITIES, GEMINI_TEXT_CAPABILITIES, GeminiAdapter } from './gemini-adapter';

/**
 * The SDK is exercised for real; only its transport is stubbed.
 *
 * `@google/genai` calls bare `fetch`, so replacing the global is enough - and it is a
 * far stronger test than a hand-written client double, because it proves the request
 * we build is one the SDK will actually accept and that the fixture is one it can parse.
 */
function withStub(stub: FetchStub): void {
  vi.stubGlobal('fetch', stub.fetch);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function adapter(model = 'gemini-2.5-flash'): GeminiAdapter {
  return new GeminiAdapter({ apiKey: 'test-key', model, clock: fixedClock() });
}

function imageAdapter(): GeminiAdapter {
  return new GeminiAdapter({
    apiKey: 'test-key',
    model: 'gemini-3.1-flash-lite-image',
    clock: fixedClock(),
    // Research §2 rate for the cheapest credible image model, so the ledger figure in
    // the assertions below is the documented one and not an invented one.
    pricing: {
      inputPerMTokensUsd: null,
      outputPerMTokensUsd: null,
      imageOutputPerMTokensUsd: '30',
      approxPerImageUsd: '0.0336',
      free: false,
    },
  });
}

describe('GeminiAdapter identity', () => {
  it('declares the gemini dialect and server-side schema enforcement', () => {
    const subject = adapter();
    expect(subject.kind).toBe('gemini');
    expect(subject.modelRef).toBe('gemini:gemini-2.5-flash');
    expect(subject.dialect).toBe('gemini');
    expect(subject.enforcesSchema).toBe(true);
    expect(subject.capabilities).toEqual(GEMINI_CAPABILITIES);
  });

  it('offers a narrowed set for the free text tier - research §2: no free image tier', () => {
    expect(GEMINI_TEXT_CAPABILITIES).not.toContain('image-generation');
    expect(GEMINI_TEXT_CAPABILITIES).not.toContain('image-edit');
  });
});

describe('GeminiAdapter.complete', () => {
  it('populates responseSchema from toLlmJsonSchema and sets the JSON mime type', async () => {
    const stub = new FetchStub().on('generateContent', { json: fixture.text('{"ok":true}') });
    withStub(stub);
    const schema = toLlmJsonSchema(z.object({ ok: z.boolean() }), { dialect: 'gemini' });

    const outcome = await adapter().complete({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'reply with json' },
      ],
      jsonSchema: schema,
    });

    expect(isOk(outcome)).toBe(true);
    const body = stub.requests[0]?.json as {
      generationConfig?: Record<string, unknown>;
      systemInstruction?: unknown;
    };
    // The SDK nests generation settings under `generationConfig` on the wire, and it
    // normalises JSON-Schema type names onto Gemini's `Type` enum - `object` becomes
    // `OBJECT`. That transformation is the SDK's, not ours; what matters is that the
    // schema `toLlmJsonSchema` produced survived it intact, keys and `required` and all.
    expect(body.generationConfig?.responseMimeType).toBe('application/json');
    expect(body.generationConfig?.responseSchema).toEqual({
      type: 'OBJECT',
      properties: { ok: { type: 'BOOLEAN' } },
      required: ['ok'],
    });
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(['ok']);
    expect(body.systemInstruction).toBeDefined();
  });

  it('prices a free-tier text call at exactly zero', async () => {
    withStub(new FetchStub().on('generateContent', { json: fixture.text('hi') }));

    const outcome = await adapter('gemini-2.5-flash').complete({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.text).toBe('hi');
      expect(outcome.value.costNanoUsd).toBe(0);
      expect(outcome.value.usage).toEqual({ inputTokens: 12, outputTokens: 31 });
    }
  });

  it('maps an assistant turn onto the model role the API expects', async () => {
    const stub = new FetchStub().on('generateContent', { json: fixture.text('ok') });
    withStub(stub);

    await adapter().complete({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' },
      ],
    });

    const body = stub.requests[0]?.json as { contents: { role: string }[] };
    expect(body.contents.map((content) => content.role)).toEqual(['user', 'model', 'user']);
  });
});

describe('GeminiAdapter.generateText', () => {
  it('returns the prose, the finish reason and the token counts', async () => {
    withStub(new FetchStub().on('generateContent', { json: fixture.text('a scene') }));

    const outcome = await adapter().generateText({
      messages: [{ role: 'user', content: 'write a scene' }],
      seed: 3,
      maxOutputTokens: 500,
      stopSequences: ['END'],
    });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.text).toBe('a scene');
      expect(outcome.value.finishReason).toBe('STOP');
      expect(outcome.value.usage.tokens.output).toBe(31);
    }
  });
});

describe('GeminiAdapter.generateImage', () => {
  it('asks for both modalities and returns hashed bytes', async () => {
    const stub = new FetchStub().on('generateContent', { json: fixture.image(3) });
    withStub(stub);

    const outcome = await imageAdapter().generateImage({
      prompt: 'a brass pocket watch',
      negativePrompt: 'text, watermark',
      size: { width: 1024, height: 1024 },
      seed: 424242,
    });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.images).toHaveLength(1);
      expect(outcome.value.images[0]?.data).toEqual(pngBytes(3));
      expect(outcome.value.images[0]?.sha256).toBe(pngSha256(3));
      expect(outcome.value.images[0]?.seed).toBe(424242);
      // Read from `candidatesTokensDetails`, not estimated.
      expect(outcome.value.usage.imageOutputTokens).toBe(1290);
    }

    const body = stub.requests[0]?.json as {
      generationConfig?: { responseModalities?: string[] };
      contents: { parts: { text?: string }[] }[];
    };
    expect(body.generationConfig?.responseModalities).toEqual(['TEXT', 'IMAGE']);
    // Gemini has no negative-prompt channel, so it is folded into the text and stated.
    expect(body.contents[0]?.parts[0]?.text).toContain('Avoid: text, watermark');
  });

  it('refuses non-retryably when the model returned no image part', async () => {
    // A safety block: the identical request will be refused again, so retrying is
    // spending money to be told the same thing.
    withStub(new FetchStub().on('generateContent', { json: fixture.refused }));

    const outcome = await imageAdapter().generateImage({ prompt: 'something disallowed' });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.kind).toBe('provider');
      expect(outcome.error.retryable).toBe(false);
    }
  });
});

describe('GeminiAdapter.editImage', () => {
  it('sends the base, the mask and every reference as inline image parts', async () => {
    const stub = new FetchStub().on('generateContent', { json: fixture.image(5) });
    withStub(stub);

    const outcome = await imageAdapter().editImage({
      base: { mimeType: 'image/png', data: pngBytes(1) },
      references: [
        { mimeType: 'image/png', data: pngBytes(2) },
        { mimeType: 'image/png', data: pngBytes(4) },
      ],
      instruction: 'make the coat green',
    });

    expect(isOk(outcome)).toBe(true);
    const parts = (stub.requests[0]?.json as { contents: { parts: Record<string, unknown>[] }[] })
      .contents[0]?.parts;
    // Three inline images plus the instruction text - RV-023's acceptance criterion.
    expect(parts?.filter((part) => 'inlineData' in part)).toHaveLength(3);
    expect(parts?.filter((part) => 'text' in part)).toHaveLength(1);
  });
});

describe('GeminiAdapter.score', () => {
  it('returns the weighted overall from a valid sheet', async () => {
    const sheet = JSON.stringify({
      scores: [{ key: 'alpha-clean', score: 0.8, reason: 'slight fringe' }],
    });
    withStub(new FetchStub().on('generateContent', { json: fixture.text(sheet) }));

    const outcome = await adapter().score({
      image: { mimeType: 'image/png', data: pngBytes(1) },
      rubric: [{ key: 'alpha-clean', question: 'Is the alpha clean?' }],
    });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) expect(outcome.value.overall).toBeCloseTo(0.8, 10);
  });

  it('surfaces a violating sheet as a validation failure', async () => {
    withStub(new FetchStub().on('generateContent', { json: fixture.text('not json') }));

    const outcome = await adapter().score({
      image: { mimeType: 'image/png', data: pngBytes(1) },
      rubric: [{ key: 'alpha-clean', question: 'Is the alpha clean?' }],
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('validation');
  });
});

describe('GeminiAdapter error mapping', () => {
  it('maps a 429 to a retryable RateLimitError', async () => {
    withStub(
      new FetchStub().on('generateContent', {
        status: 429,
        headers: { 'retry-after': '9' },
        json: fixture.error(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded'),
      }),
    );

    const outcome = await adapter().generateText({ messages: [{ role: 'user', content: 'x' }] });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.kind).toBe('rate-limit');
      expect(outcome.error.retryable).toBe(true);
    }
  });

  it('maps a 503 to a retryable ProviderError and a 400 to a permanent one', async () => {
    withStub(
      new FetchStub().on('generateContent', {
        status: 503,
        json: fixture.error(503, 'UNAVAILABLE', 'overloaded'),
      }),
    );
    const transient = await adapter().generateText({ messages: [{ role: 'user', content: 'x' }] });
    expect(isErr(transient) && transient.error.retryable).toBe(true);

    vi.unstubAllGlobals();
    withStub(
      new FetchStub().on('generateContent', {
        status: 400,
        json: fixture.error(400, 'INVALID_ARGUMENT', 'bad schema'),
      }),
    );
    const permanent = await adapter().generateText({ messages: [{ role: 'user', content: 'x' }] });
    expect(isErr(permanent) && permanent.error.retryable).toBe(false);
  });

  it('maps a network failure to a retryable ProviderError', async () => {
    withStub(new FetchStub().on('generateContent', { throws: new TypeError('fetch failed') }));

    const outcome = await adapter().generateText({ messages: [{ role: 'user', content: 'x' }] });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.kind).toBe('provider');
      expect(outcome.error.retryable).toBe(true);
    }
  });

  it('returns CancelledError without issuing a request when the signal is already aborted', async () => {
    const stub = new FetchStub().on('generateContent', { json: fixture.text('never') });
    withStub(stub);
    const controller = new AbortController();
    controller.abort();

    const outcome = await adapter().generateText({
      messages: [{ role: 'user', content: 'x' }],
      signal: controller.signal,
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('cancelled');
    expect(stub.requests).toHaveLength(0);
  });

  it('never throws - every failure comes back as a Result', async () => {
    withStub(new FetchStub().on('generateContent', { status: 500, text: 'kaboom' }));
    await expect(
      adapter().generateText({ messages: [{ role: 'user', content: 'x' }] }),
    ).resolves.toBeDefined();
  });
});

describe('GeminiAdapter client injection', () => {
  it('accepts a hand-written double for tests that do not care about the wire', async () => {
    const subject = new GeminiAdapter({
      apiKey: 'unused',
      model: 'gemini-2.5-flash',
      clock: fixedClock(),
      client: {
        models: {
          generateContent: () =>
            Promise.resolve({
              candidates: [{ content: { parts: [{ text: 'doubled' }] } }],
            } as never),
        },
      },
    });

    const outcome = await subject.generateText({ messages: [{ role: 'user', content: 'x' }] });
    expect(isOk(outcome) && outcome.value.text).toBe('doubled');
  });
});
