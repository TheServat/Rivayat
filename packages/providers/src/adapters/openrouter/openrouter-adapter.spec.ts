import { describe, expect, it } from 'vitest';
import { FREE_TIER_FACTS, KNOWN_MODELS, type ModelDescriptor } from '@rv/contracts';
import { isErr, isOk, millis } from '@rv/shared-kernel';

import { FetchStub } from '../../__fixtures__/fetch-stub';
import { openrouter as fixture, pngBytes, pngSha256 } from '../../__fixtures__/responses';
import { fixedClock } from '../../__fixtures__/support';
import { OPENROUTER_CAPABILITIES, OpenRouterAdapter } from './openrouter-adapter';

const BASE_URL = 'https://openrouter.ai/api/v1';

function adapterWith(
  stub: FetchStub,
  overrides: Partial<ConstructorParameters<typeof OpenRouterAdapter>[0]> = {},
): OpenRouterAdapter {
  return new OpenRouterAdapter({
    apiKey: 'sk-or-test',
    model: 'google/gemma-4-31b-it:free',
    baseUrl: BASE_URL,
    fetch: stub.fetch,
    clock: fixedClock(),
    ...overrides,
  });
}

describe('OpenRouterAdapter identity', () => {
  it('uses the strict OpenAI dialect', () => {
    const adapter = adapterWith(new FetchStub());
    expect(adapter.kind).toBe('openrouter');
    expect(adapter.dialect).toBe('openai-strict');
    expect(adapter.enforcesSchema).toBe(true);
    expect(adapter.modelRef).toBe('openrouter:google/gemma-4-31b-it:free');
  });

  it('does not declare image-edit by default', () => {
    // Only some OpenRouter image models accept an image alongside the prompt -
    // research §2 records `openai/gpt-5-image-mini` as having none at all - so edit is
    // opt-in per model rather than a blanket claim the router would trip over.
    expect(OPENROUTER_CAPABILITIES).not.toContain('image-edit');
  });
});

describe('OpenRouterAdapter headers', () => {
  it('sends the HTTP-Referer and X-Title headers OpenRouter asks for', async () => {
    const stub = new FetchStub().on('/chat/completions', { json: fixture.chat('ok') });
    await adapterWith(stub, {
      referer: 'https://rivayat.example',
      title: 'Rivayat Studio',
    }).generateText({ messages: [{ role: 'user', content: 'hi' }] });

    const headers = stub.requests[0]?.headers ?? {};
    expect(headers['http-referer']).toBe('https://rivayat.example');
    expect(headers['x-title']).toBe('Rivayat Studio');
    expect(headers.authorization).toBe('Bearer sk-or-test');
  });

  it('falls back to a project default rather than sending the traffic anonymously', async () => {
    const stub = new FetchStub().on('/chat/completions', { json: fixture.chat('ok') });
    await adapterWith(stub).generateText({ messages: [{ role: 'user', content: 'hi' }] });

    const headers = stub.requests[0]?.headers ?? {};
    expect(headers['http-referer']).toBeTruthy();
    expect(headers['x-title']).toBeTruthy();
  });
});

describe('OpenRouterAdapter.complete', () => {
  it('sends a strict json_schema response format', async () => {
    const stub = new FetchStub().on('/chat/completions', { json: fixture.chat('{"a":1}') });
    await adapterWith(stub).complete({
      messages: [{ role: 'user', content: 'json please' }],
      jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    });

    const body = stub.requests[0]?.json as {
      response_format: { type: string; json_schema: { strict: boolean; schema: unknown } };
      temperature: number;
    };
    expect(body.response_format.type).toBe('json_schema');
    // `strict: true` is what makes the schema binding rather than advisory.
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.temperature).toBe(0);
  });

  it('reports usage and a zero cost for a `:free` model', async () => {
    const stub = new FetchStub().on('/chat/completions', { json: fixture.chat('free answer') });
    const outcome = await adapterWith(stub).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.text).toBe('free answer');
      expect(outcome.value.usage).toEqual({ inputTokens: 14, outputTokens: 27 });
      expect(outcome.value.costNanoUsd).toBe(0);
    }
  });

  it('surfaces an error reported inside a 200 body', async () => {
    // A happy status is not proof of a happy call on OpenRouter.
    const stub = new FetchStub().on('/chat/completions', { json: fixture.embeddedError });
    const outcome = await adapterWith(stub).generateText({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.kind).toBe('provider');
      // 503 upstream: retrying can plausibly land on a different instance.
      expect(outcome.error.retryable).toBe(true);
    }
  });

  it('treats an embedded error with no numeric code as retryable', async () => {
    const stub = new FetchStub().on('/chat/completions', {
      json: { choices: [], error: { message: 'unknown' } },
    });
    const outcome = await adapterWith(stub).generateText({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(isErr(outcome) && outcome.error.retryable).toBe(true);
  });

  it('reports a malformed body as retryable', async () => {
    const stub = new FetchStub().on('/chat/completions', { json: { nope: true } });
    const outcome = await adapterWith(stub).generateText({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(isErr(outcome) && outcome.error.retryable).toBe(true);
  });
});

describe('OpenRouterAdapter images', () => {
  const imageModel = { model: 'google/gemini-2.5-flash-image' } as const;

  it('asks for the image modality and decodes the data URL', async () => {
    const stub = new FetchStub().on('/chat/completions', { json: fixture.image(6) });
    const outcome = await adapterWith(stub, imageModel).generateImage({
      prompt: 'a watch',
      seed: 11,
      size: { width: 1024, height: 1024 },
    });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.images[0]?.data).toEqual(pngBytes(6));
      expect(outcome.value.images[0]?.sha256).toBe(pngSha256(6));
      expect(outcome.value.images[0]?.size).toEqual({ width: 1024, height: 1024 });
    }

    const body = stub.requests[0]?.json as { modalities: string[]; seed: number };
    expect(body.modalities).toEqual(['image', 'text']);
    expect(body.seed).toBe(11);
  });

  it('sends the base and every reference as an image_url part when editing', async () => {
    const stub = new FetchStub().on('/chat/completions', { json: fixture.image(7) });
    await adapterWith(stub, imageModel).editImage({
      base: { mimeType: 'image/png', data: pngBytes(1) },
      mask: { mimeType: 'image/png', data: pngBytes(2) },
      references: [{ mimeType: 'image/png', data: pngBytes(3) }],
      instruction: 'green coat',
    });

    const parts = (stub.requests[0]?.json as { messages: { content: { type: string }[] }[] })
      .messages[0]?.content;
    expect(parts?.filter((part) => part.type === 'image_url')).toHaveLength(3);
    expect(parts?.at(-1)?.type).toBe('text');
  });

  it('refuses non-retryably when the completion carried no image', async () => {
    const stub = new FetchStub().on('/chat/completions', { json: fixture.chat('sorry, no') });
    const outcome = await adapterWith(stub, imageModel).generateImage({ prompt: 'x' });

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.retryable).toBe(false);
  });

  it('ignores an image entry whose url is not a base64 data URL', async () => {
    const stub = new FetchStub().on('/chat/completions', {
      json: {
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '',
              images: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }],
            },
          },
        ],
      },
    });
    const outcome = await adapterWith(stub, imageModel).generateImage({ prompt: 'x' });
    expect(isErr(outcome)).toBe(true);
  });
});

describe('OpenRouterAdapter.score', () => {
  it('scores through the strict schema and weights the result', async () => {
    const sheet = JSON.stringify({
      scores: [
        { key: 'identity', score: 0.4, reason: 'face drifts' },
        { key: 'parts', score: 1, reason: 'all present' },
      ],
    });
    const stub = new FetchStub().on('/chat/completions', { json: fixture.chat(sheet) });

    const outcome = await adapterWith(stub).score({
      image: { mimeType: 'image/png', data: pngBytes(1) },
      references: [{ mimeType: 'image/png', data: pngBytes(2) }],
      rubric: [
        { key: 'identity', question: 'Does it match the anchors?', weight: 3 },
        { key: 'parts', question: 'Are all parts present?' },
      ],
    });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.overall).toBeCloseTo((0.4 * 3 + 1) / 4, 10);
      expect(outcome.value.usage.images.count).toBe(2);
    }
  });
});

describe('OpenRouterAdapter.syncCatalogue', () => {
  it('indexes models with context length, modalities and pricing', async () => {
    const stub = new FetchStub().on('/models', { json: fixture.models });
    const outcome = await adapterWith(stub).syncCatalogue();

    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;

    const glm = outcome.value.models.get('z-ai/glm-5.2:free');
    expect(glm?.contextLength).toBe(256_000);
    expect(glm?.inputModalities).toEqual(['text']);
    expect(glm?.outputModalities).toEqual(['text']);
    expect(glm?.free).toBe(true);

    const image = outcome.value.models.get('google/gemini-2.5-flash-image');
    expect(image?.outputModalities).toContain('image');
    expect(image?.pricing.promptPerTokenUsd).toBe('0.0000003');
    expect(image?.free).toBe(false);
  });

  it('reports the free subset as exactly the ids ending in :free', async () => {
    const stub = new FetchStub().on('/models', { json: fixture.models });
    const outcome = await adapterWith(stub).syncCatalogue();

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.freeModelIds).toEqual([
        'google/gemma-4-31b-it:free',
        'z-ai/glm-5.2:free',
      ]);
    }
  });

  it('returns an empty list for listImageCapable({ free: true })', async () => {
    // Codifies research §2 so a regression is caught: zero `:free` models emit images.
    const stub = new FetchStub().on('/models', { json: fixture.models });
    const adapter = adapterWith(stub);
    await adapter.syncCatalogue();

    expect(adapter.listImageCapable({ free: true })).toEqual([]);
    expect(adapter.listImageCapable().map((entry) => entry.id)).toEqual([
      'google/gemini-2.5-flash-image',
    ]);
    expect(FREE_TIER_FACTS.openRouterFreeModelsProduceImages).toBe(false);
  });

  it('lists nothing before the first sync rather than guessing', () => {
    expect(adapterWith(new FetchStub()).listImageCapable()).toEqual([]);
  });

  it('reports a malformed catalogue body as retryable', async () => {
    const stub = new FetchStub().on('/models', { json: { data: 'nope' } });
    const outcome = await adapterWith(stub).syncCatalogue();
    expect(isErr(outcome) && outcome.error.retryable).toBe(true);
  });
});

describe('OpenRouterAdapter.catalogue TTL', () => {
  const seed: readonly ModelDescriptor[] = KNOWN_MODELS.filter(
    (model) => model.id === 'z-ai/glm-5.2:free',
  );

  it('serves from the snapshot inside the TTL', async () => {
    const stub = new FetchStub().on('/models', { json: fixture.models });
    const adapter = adapterWith(stub, { catalogueTtlMs: 60_000, catalogue: seed });

    await adapter.catalogue();
    await adapter.catalogue();

    expect(stub.requestsFor('/models')).toHaveLength(1);
  });

  it('refreshes once past the TTL', async () => {
    const clock = fixedClock();
    const stub = new FetchStub().on('/models', { json: fixture.models });
    const adapter = adapterWith(stub, { clock, catalogueTtlMs: 1_000, catalogue: seed });

    await adapter.catalogue();
    clock.advance(millis(2_000));
    await adapter.catalogue();

    expect(stub.requestsFor('/models')).toHaveLength(2);
  });

  it('falls back to the stale snapshot when the refresh fails', async () => {
    // A stale catalogue still routes correctly; failing a whole run because a metadata
    // endpoint blipped would be the tail wagging the dog.
    const clock = fixedClock();
    const stub = new FetchStub()
      .once('/models', { json: fixture.models })
      .on('/models', { status: 500, text: 'down' });
    const adapter = adapterWith(stub, { clock, catalogueTtlMs: 1_000, catalogue: seed });

    const first = await adapter.catalogue();
    clock.advance(millis(2_000));
    const second = await adapter.catalogue();

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (isOk(first) && isOk(second)) expect(second.value.fetchedAt).toBe(first.value.fetchedAt);
  });

  it('surfaces the failure when the cache is cold', async () => {
    const stub = new FetchStub().on('/models', { status: 500, text: 'down' });
    const outcome = await adapterWith(stub, { catalogue: seed }).catalogue();
    expect(isErr(outcome)).toBe(true);
  });
});
