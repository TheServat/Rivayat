/**
 * One suite, every adapter. This is the LSP guard.
 *
 * The router reasons about adapters purely through the capability matrix and
 * `AppError.retryable`. That only works if every adapter agrees on what those mean, so
 * the agreement is asserted here rather than being assumed - and it is asserted once,
 * parameterised over the registry below, so a new provider cannot join with subtly
 * different failure semantics.
 *
 * What every adapter must do:
 *
 *  1. Declare capabilities that match the methods it really has.
 *  2. Return `UnsupportedCapabilityError` (through the matrix) for anything it does not.
 *  3. Turn an HTTP 429 into a retryable `RateLimitError`, carrying `retryAfterMs` when
 *     the header was present.
 *  4. Treat 5xx as retryable and 4xx as permanent.
 *  5. Turn a network failure into a retryable `ProviderError`.
 *  6. Turn an already-aborted signal into `CancelledError` with **zero** requests sent.
 *  7. Never throw. Every failure arrives as a `Result`.
 *  8. Produce identical output from identical fixtures.
 *
 * No socket is opened: `fetch` is stubbed for the HTTP adapters and the global is
 * stubbed for Gemini, whose SDK calls bare `fetch`. An unmatched request throws.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capability } from '@rv/contracts';
import type { AppError, RateLimitError, Result } from '@rv/shared-kernel';
import { isErr, isOk } from '@rv/shared-kernel';

import { FetchStub, type StubResponse } from '../__fixtures__/fetch-stub';
import {
  comfy,
  gemini as geminiFixture,
  ollama as ollamaFixture,
  openrouter as openrouterFixture,
  pngBytes,
} from '../__fixtures__/responses';
import { fixedClock } from '../__fixtures__/support';
import { readWorkflow } from '../adapters/comfyui/__fixtures__/workflows';
import { ComfyUiAdapter } from '../adapters/comfyui/comfyui-adapter';
import { COMFY_WORKFLOW_FILES } from '../adapters/comfyui/load-workflows';
import { GeminiAdapter } from '../adapters/gemini/gemini-adapter';
import { OllamaAdapter } from '../adapters/ollama/ollama-adapter';
import { OpenRouterAdapter } from '../adapters/openrouter/openrouter-adapter';
import { CAPABILITY_METHOD, CapabilityMatrix } from '../ports/capability-matrix';
import type { ProviderAdapter } from '../ports/provider-adapter';

const workflows = {
  txt2img: readWorkflow(COMFY_WORKFLOW_FILES.txt2img),
  img2img: readWorkflow(COMFY_WORKFLOW_FILES.img2img),
};

interface Case {
  readonly name: string;
  /** URL fragment every request of this adapter matches. */
  readonly route: string | RegExp;
  /** A response that lets one happy-path call through. */
  readonly happy: (stub: FetchStub) => void;
  /** Builds the adapter against the stub. */
  readonly build: (stub: FetchStub) => ProviderAdapter;
  /** Whether the SDK reaches for the global `fetch` rather than the injected one. */
  readonly stubsGlobalFetch?: boolean;
  /** Exercises one real call, whatever this adapter's cheapest capability is. */
  readonly invoke: (adapter: ProviderAdapter) => Promise<Result<unknown, AppError>>;
  /** A capability this adapter deliberately does not serve. */
  readonly unsupported: Capability;
  /**
   * Whether a 429 can carry `retryAfterMs` through to the error.
   *
   * `false` for Gemini and only for Gemini: `@google/genai`'s `ApiError` keeps the
   * status and the message and **discards the response headers**
   * (`dist/node/index.mjs`, `class ApiError`), so `Retry-After` is gone before the
   * adapter ever sees it. The backoff then falls back to its own exponential schedule,
   * which is correct but ignores the window Google actually stated. Recorded as a flag
   * rather than skipped, so the test below still pins the current behaviour and starts
   * failing the day the SDK begins preserving headers.
   */
  readonly exposesRetryAfter: boolean;
}

const CASES: readonly Case[] = [
  {
    name: 'OllamaAdapter',
    route: '/api/chat',
    happy: (stub) => stub.on('/api/chat', { json: ollamaFixture.chat('hello') }),
    build: (stub) =>
      new OllamaAdapter({
        model: 'qwen3.5:latest',
        fetch: stub.fetch,
        clock: fixedClock(),
        capabilities: ['text-generation', 'structured-generation', 'embedding'],
      }),
    invoke: async (adapter) =>
      (adapter as unknown as OllamaAdapter).generateText({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    unsupported: 'image-generation',
    exposesRetryAfter: true,
  },
  {
    name: 'GeminiAdapter',
    route: 'generateContent',
    happy: (stub) => stub.on('generateContent', { json: geminiFixture.text('hello') }),
    stubsGlobalFetch: true,
    build: () =>
      new GeminiAdapter({ apiKey: 'test-key', model: 'gemini-2.5-flash', clock: fixedClock() }),
    invoke: async (adapter) =>
      (adapter as unknown as GeminiAdapter).generateText({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    unsupported: 'embedding',
    // See `exposesRetryAfter`: the SDK throws away the headers.
    exposesRetryAfter: false,
  },
  {
    name: 'OpenRouterAdapter',
    route: '/chat/completions',
    happy: (stub) => stub.on('/chat/completions', { json: openrouterFixture.chat('hello') }),
    build: (stub) =>
      new OpenRouterAdapter({
        apiKey: 'sk-or-test',
        model: 'google/gemma-4-31b-it:free',
        fetch: stub.fetch,
        clock: fixedClock(),
      }),
    invoke: async (adapter) =>
      (adapter as unknown as OpenRouterAdapter).generateText({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    unsupported: 'embedding',
    exposesRetryAfter: true,
  },
  {
    name: 'ComfyUiAdapter',
    route: '/prompt',
    happy: (stub) =>
      stub
        .on('/prompt', { json: comfy.queued })
        .on('/history/', { json: comfy.completed() })
        .on('/view', { bytes: pngBytes(1) }),
    build: (stub) =>
      new ComfyUiAdapter({
        workflows,
        fetch: stub.fetch,
        clock: fixedClock(),
        sleep: () => Promise.resolve(),
      }),
    invoke: async (adapter) =>
      (adapter as unknown as ComfyUiAdapter).generateImage({
        prompt: 'a brass pocket watch',
        seed: 1,
      }),
    unsupported: 'text-generation',
    exposesRetryAfter: true,
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Builds an adapter whose only route answers with `response`. */
function against(
  testCase: Case,
  response: StubResponse,
): { adapter: ProviderAdapter; stub: FetchStub } {
  const stub = new FetchStub().on(testCase.route, response);
  if (testCase.stubsGlobalFetch === true) vi.stubGlobal('fetch', stub.fetch);
  return { adapter: testCase.build(stub), stub };
}

describe.each(CASES)('provider contract: $name', (testCase) => {
  it('declares only capabilities it can actually serve', () => {
    const stub = new FetchStub();
    if (testCase.stubsGlobalFetch === true) vi.stubGlobal('fetch', stub.fetch);
    const adapter = testCase.build(stub);

    expect(adapter.capabilities.length).toBeGreaterThan(0);
    for (const capability of adapter.capabilities) {
      const method = CAPABILITY_METHOD[capability];
      expect(typeof (adapter as unknown as Record<string, unknown>)[method]).toBe('function');
    }
    // Registration is where the declaration and the implementation are compared.
    expect(() => {
      new CapabilityMatrix().register(adapter);
    }).not.toThrow();
  });

  it('names a valid ProviderKind and a `provider:model` reference', () => {
    const stub = new FetchStub();
    if (testCase.stubsGlobalFetch === true) vi.stubGlobal('fetch', stub.fetch);
    const adapter = testCase.build(stub);

    expect(adapter.modelRef).toMatch(/^[a-z][a-z0-9-]*:.+$/);
    expect(adapter.modelRef.startsWith(`${adapter.kind}:`)).toBe(true);
  });

  it('returns UnsupportedCapabilityError for a capability it does not declare', () => {
    const stub = new FetchStub();
    if (testCase.stubsGlobalFetch === true) vi.stubGlobal('fetch', stub.fetch);
    const adapter = testCase.build(stub);
    const matrix = new CapabilityMatrix();
    matrix.register(adapter);

    expect(adapter.capabilities).not.toContain(testCase.unsupported);
    const resolved = matrix.resolve(adapter.modelRef, testCase.unsupported);

    expect(isErr(resolved)).toBe(true);
    if (isErr(resolved)) {
      expect(resolved.error.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(resolved.error.retryable).toBe(false);
    }
    // The refusal happens before anything is sent.
    expect(stub.requests).toHaveLength(0);
  });

  it('succeeds against the recorded fixture', async () => {
    const stub = new FetchStub();
    testCase.happy(stub);
    if (testCase.stubsGlobalFetch === true) vi.stubGlobal('fetch', stub.fetch);

    const outcome = await testCase.invoke(testCase.build(stub));
    expect(isOk(outcome)).toBe(true);
  });

  it('is deterministic: identical fixtures give identical output', async () => {
    const run = async (): Promise<unknown> => {
      const stub = new FetchStub();
      testCase.happy(stub);
      if (testCase.stubsGlobalFetch === true) vi.stubGlobal('fetch', stub.fetch);
      const outcome = await testCase.invoke(testCase.build(stub));
      vi.unstubAllGlobals();
      return isOk(outcome) ? outcome.value : outcome;
    };

    expect(await run()).toEqual(await run());
  });

  it('maps 429 to a retryable RateLimitError, carrying retryAfterMs where the transport allows', async () => {
    const { adapter } = against(testCase, {
      status: 429,
      headers: { 'retry-after': '11' },
      json: { error: 'slow down' },
    });

    const outcome = await testCase.invoke(adapter);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('rate-limit');
    expect(outcome.error.retryable).toBe(true);

    const retryAfterMs = (outcome.error as RateLimitError).retryAfterMs;
    if (testCase.exposesRetryAfter) {
      expect(retryAfterMs).toBe(11_000);
    } else {
      // Pinned, not skipped: when the SDK starts preserving headers this fails and
      // the flag gets flipped, rather than the gap silently persisting.
      expect(retryAfterMs).toBeUndefined();
    }
  });

  it('maps 429 without the header to a RateLimitError with no stated delay', async () => {
    const { adapter } = against(testCase, { status: 429, json: { error: 'slow down' } });

    const outcome = await testCase.invoke(adapter);
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.kind).toBe('rate-limit');
      expect((outcome.error as RateLimitError).retryAfterMs).toBeUndefined();
    }
  });

  it.each([500, 502, 503])('treats %i as retryable', async (status) => {
    const { adapter } = against(testCase, { status, json: { error: 'upstream' } });
    const outcome = await testCase.invoke(adapter);

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.retryable).toBe(true);
  });

  it.each([400, 401, 403, 404])('treats %i as permanent', async (status) => {
    const { adapter } = against(testCase, { status, json: { error: 'nope' } });
    const outcome = await testCase.invoke(adapter);

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.retryable).toBe(false);
  });

  it('maps a network failure to a retryable ProviderError', async () => {
    const { adapter } = against(testCase, { throws: new TypeError('fetch failed') });
    const outcome = await testCase.invoke(adapter);

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.kind).toBe('provider');
      expect(outcome.error.retryable).toBe(true);
    }
  });

  it('maps an already-aborted signal to CancelledError with zero requests sent', async () => {
    const stub = new FetchStub();
    testCase.happy(stub);
    if (testCase.stubsGlobalFetch === true) vi.stubGlobal('fetch', stub.fetch);
    const adapter = testCase.build(stub);

    const controller = new AbortController();
    controller.abort();
    const outcome = await invokeWithSignal(testCase, adapter, controller.signal);

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) {
      expect(outcome.error.kind).toBe('cancelled');
      expect(outcome.error.retryable).toBe(false);
    }
    expect(stub.requests).toHaveLength(0);
  });

  it('maps a signal aborted mid-flight to CancelledError without waiting out a backoff', async () => {
    const stub = new FetchStub().on(testCase.route, { hang: true });
    if (testCase.stubsGlobalFetch === true) vi.stubGlobal('fetch', stub.fetch);
    const adapter = testCase.build(stub);

    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => {
      controller.abort();
    }, 5);

    const outcome = await invokeWithSignal(testCase, adapter, controller.signal);

    // 400 ms, not a tight 100 ms. The property under test is "the abort is noticed
    // immediately rather than after a retry wait", and the shortest such wait is
    // `initialBackoffMs`, which defaults to 500 ms and only grows - jitter here is
    // additive. So 400 ms still fails any adapter that sleeps before checking the
    // signal, while leaving room for a loaded machine: at four vitest workers this
    // assertion was the one flake in the suite.
    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('cancelled');
  });

  it('never throws - every failure is returned', async () => {
    const { adapter } = against(testCase, { status: 500, text: 'not json at all' });
    await expect(testCase.invoke(adapter)).resolves.toBeDefined();
  });
});

/** Re-invokes the case's cheapest capability, this time with a signal attached. */
async function invokeWithSignal(
  testCase: Case,
  adapter: ProviderAdapter,
  signal: AbortSignal,
): Promise<Result<unknown, AppError>> {
  switch (testCase.name) {
    case 'ComfyUiAdapter':
      return (adapter as unknown as ComfyUiAdapter).generateImage({
        prompt: 'a brass pocket watch',
        seed: 1,
        signal,
      });
    default:
      return (
        adapter as unknown as {
          generateText: (request: unknown) => Promise<Result<unknown, AppError>>;
        }
      ).generateText({ messages: [{ role: 'user', content: 'hi' }], signal });
  }
}

describe('the contract suite itself', () => {
  it('covers every adapter this package ships', () => {
    expect(CASES.map((testCase) => testCase.name).sort()).toEqual([
      'ComfyUiAdapter',
      'GeminiAdapter',
      'OllamaAdapter',
      'OpenRouterAdapter',
    ]);
  });

  it('records exactly one adapter whose transport loses Retry-After', () => {
    // If this number grows, a second SDK has started throwing headers away and the
    // router's backoff has quietly stopped honouring a provider's stated window.
    const lossy = CASES.filter((testCase) => !testCase.exposesRetryAfter).map((c) => c.name);
    expect(lossy).toEqual(['GeminiAdapter']);
  });

  it('names an unsupported capability that is a real member of the contract', () => {
    for (const testCase of CASES) {
      expect(Capability.options).toContain(testCase.unsupported);
    }
  });

  it('fails a test rather than opening a socket for an unrouted request', async () => {
    const stub = new FetchStub();
    await expect(stub.fetch('http://127.0.0.1:1/nowhere')).rejects.toThrow(/no route/);
  });
});
