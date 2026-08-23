/**
 * The routing facades, over a real `ModelRouter` and a real `CapabilityMatrix`.
 *
 * The thing worth testing here is not that a method call is forwarded - it is that a
 * port bound to the router *stays* bound to the router: that a capability nothing can
 * serve fails before any adapter is touched, that the failure is
 * `UnsupportedCapabilityError` rather than a crash, and that the chain is walked rather
 * than the first adapter being hard-wired at boot.
 *
 * Only the adapter is a fake. Substituting the router would leave nothing under test.
 */

import type { Capability, ProviderKind, RouterConfig } from '@rv/contracts';
import { KNOWN_MODELS } from '@rv/contracts';
import {
  CapabilityMatrix,
  ModelRouter,
  type EmbeddingRequest,
  type EmbeddingResult,
  type ProviderAdapter,
  type TextGenerationRequest,
  type TextGenerationResult,
} from '@rv/providers';
import type { CompletionRequest, CompletionResponse } from '@rv/prompt-kit';
import {
  MemoryLogger,
  ProviderError,
  createRng,
  isErr,
  ok,
  type AppError,
  type Result,
} from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { RegistryEmbeddingAdapter } from './registry-embedding.adapter';
import { RoutedStructuredBackend } from './routed-structured.backend';
import {
  RoutedEmbeddingPort,
  RoutedImageEditPort,
  RoutedImageGenerationPort,
  RoutedTextGenerationPort,
  RoutedVisionScoringPort,
} from './routed.ports';

/**
 * Catalogued models, so the router can build a chain from `KNOWN_MODELS`.
 *
 * A model the catalogue does not price is not a route - the router refuses it before
 * the matrix is consulted - so a fake registered under an invented id would test the
 * refusal path and nothing else.
 */
const MODEL = 'qwen3.5:latest';
const REF = `ollama:${MODEL}`;
const EMBED_MODEL = 'qwen2.5:7b';

const ROUTER_CONFIG = {
  projectId: null,
  defaultPolicy: 'balanced' as const,
  rules: [],
  stageOverrides: {},
  taskOverrides: {},
  failover: {
    maxAttemptsPerModel: 2,
    initialBackoffMs: 1,
    backoffMultiplier: 2,
    maxBackoffMs: 4,
    jitter: 0,
    failoverOn: ['rate-limit', 'timeout', 'provider', 'unsupported'],
  },
} satisfies RouterConfig;

/**
 * Serves text, structured and embedding, and counts what it was asked for.
 *
 * `embedding` is not in the catalogue entry for this model, so an embedding route must
 * fail *before* reaching here - which is the capability filter doing its job, and the
 * call count is how the test knows.
 */
class FakeOllamaAdapter implements ProviderAdapter {
  readonly kind: ProviderKind = 'ollama';
  readonly modelRef = REF;
  readonly capabilities: readonly Capability[] = ['text-generation', 'structured-generation'];

  readonly id = REF;
  readonly enforcesSchema = false;
  readonly dialect = 'ollama' as const;

  textCalls = 0;
  structuredCalls = 0;
  failNextText = false;

  generateText(_request: TextGenerationRequest): Promise<Result<TextGenerationResult, AppError>> {
    this.textCalls += 1;
    if (this.failNextText) {
      return Promise.resolve({
        ok: false,
        error: new ProviderError({ message: 'down', provider: 'ollama', status: 503 }),
      });
    }
    return Promise.resolve(
      ok({
        text: 'once upon a time',
        finishReason: 'stop',
        modelRef: REF,
        usage: {
          tokens: { input: 10, output: 4, cached: 0, reasoning: 0 },
          images: { count: 0, resolution: null },
          latencyMs: 3,
        },
      }),
    );
  }

  complete(_request: CompletionRequest): Promise<Result<CompletionResponse, AppError>> {
    this.structuredCalls += 1;
    return Promise.resolve(ok({ text: '{"ok":true}', modelId: REF }));
  }
}

/** Declares embedding and can serve it, for the adapter-level tests. */
class FakeEmbeddingAdapter implements ProviderAdapter {
  readonly kind: ProviderKind = 'ollama';
  readonly modelRef = `ollama:${EMBED_MODEL}`;
  readonly capabilities: readonly Capability[] = ['embedding'];

  calls = 0;

  embed(request: EmbeddingRequest): Promise<Result<EmbeddingResult, AppError>> {
    this.calls += 1;
    return Promise.resolve(
      ok({
        vectors: request.texts.map(() => [0.1, 0.2, 0.3]),
        dimensions: 3,
        modelRef: this.modelRef,
        usage: {
          tokens: { input: 4, output: 0, cached: 0, reasoning: 0 },
          images: { count: 0, resolution: null },
          latencyMs: 1,
        },
      }),
    );
  }
}

function wire(adapters: readonly ProviderAdapter[]): {
  router: ModelRouter;
  matrix: CapabilityMatrix;
} {
  const matrix = new CapabilityMatrix();
  matrix.registerAll(adapters);
  const router = new ModelRouter({
    config: ROUTER_CONFIG,
    matrix,
    rng: createRng(1),
    logger: new MemoryLogger(),
    catalogue: KNOWN_MODELS,
  });
  return { router, matrix };
}

describe('the routed provider ports', () => {
  it('routes a text call to the registered adapter', async () => {
    const adapter = new FakeOllamaAdapter();
    const port = new RoutedTextGenerationPort(wire([adapter]));

    const outcome = await port.generateText({ messages: [{ role: 'user', content: 'hi' }] });

    expect(isErr(outcome)).toBe(false);
    expect(adapter.textCalls).toBe(1);
    if (isErr(outcome)) return;
    expect(outcome.value.text).toBe('once upon a time');
  });

  it('refuses before any adapter when nothing serves the capability', async () => {
    // No adapter at all: the router must decide this, not the (absent) adapter.
    const port = new RoutedImageGenerationPort(wire([]));
    const outcome = await port.generateImage({ prompt: 'a fox' });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('unsupported');
  });

  it('refuses an image call even when a text adapter is registered', async () => {
    const adapter = new FakeOllamaAdapter();
    const port = new RoutedImageGenerationPort(wire([adapter]));

    const outcome = await port.generateImage({ prompt: 'a fox' });

    expect(isErr(outcome)).toBe(true);
    // The capability filter, not the adapter, is what said no.
    expect(adapter.textCalls).toBe(0);
  });

  it('retries a retryable provider failure within the configured bound', async () => {
    const adapter = new FakeOllamaAdapter();
    adapter.failNextText = true;
    const port = new RoutedTextGenerationPort(wire([adapter]));

    const outcome = await port.generateText({ messages: [{ role: 'user', content: 'hi' }] });

    expect(isErr(outcome)).toBe(true);
    expect(adapter.textCalls).toBe(ROUTER_CONFIG.failover.maxAttemptsPerModel);
  });

  it('refuses an image edit when nothing serves it, before any adapter', async () => {
    const adapter = new FakeOllamaAdapter();
    const port = new RoutedImageEditPort(wire([adapter]));

    const outcome = await port.editImage({
      base: { mimeType: 'image/png', data: new Uint8Array([1]) },
      instruction: 'make it winter',
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('unsupported');
  });

  it('refuses a vision score when nothing serves it', async () => {
    const port = new RoutedVisionScoringPort(wire([new FakeOllamaAdapter()]));

    const outcome = await port.score({
      image: { mimeType: 'image/png', data: new Uint8Array([1]) },
      rubric: [{ key: 'style-match', question: 'Does it match the style bible?', weight: 1 }],
    });

    expect(isErr(outcome)).toBe(true);
  });

  it('routes an embedding call to an adapter that declares embedding', async () => {
    const adapter = new FakeEmbeddingAdapter();
    const port = new RoutedEmbeddingPort(wire([adapter]));

    const outcome = await port.embed({ texts: ['a gnarled old tree'] });

    expect(isErr(outcome)).toBe(false);
    expect(adapter.calls).toBe(1);
  });
});

describe('RoutedStructuredBackend', () => {
  it('reports the head of the current chain as its id', () => {
    const backend = new RoutedStructuredBackend(wire([new FakeOllamaAdapter()]));
    expect(backend.id).toBe(REF);
    expect(backend.dialect).toBe('ollama');
  });

  it('never claims to enforce a schema', () => {
    // Advisory at best (research §1: Ollama accepts the schema and ignores it), and
    // meaningless across a failover. `StructuredCall` validates and repairs regardless.
    expect(new RoutedStructuredBackend(wire([new FakeOllamaAdapter()])).enforcesSchema).toBe(false);
  });

  it('says so plainly when no model can serve a structured call', () => {
    const backend = new RoutedStructuredBackend(wire([]));
    expect(backend.id).toBe('router:none');
    expect(backend.dialect).toBe('plain');
  });

  it('completes through the chain', async () => {
    const adapter = new FakeOllamaAdapter();
    const backend = new RoutedStructuredBackend(wire([adapter]));

    const outcome = await backend.complete({
      messages: [{ role: 'user', content: 'json please' }],
    });

    expect(isErr(outcome)).toBe(false);
    expect(adapter.structuredCalls).toBe(1);
  });

  it('fails with the router error when nothing is registered', async () => {
    const outcome = await new RoutedStructuredBackend(wire([])).complete({ messages: [] });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('unsupported');
  });
});

describe('RegistryEmbeddingAdapter', () => {
  it('re-attributes vectors to the model that actually produced them', async () => {
    const adapter = new FakeEmbeddingAdapter();
    const registryPort = new RegistryEmbeddingAdapter({
      port: new RoutedEmbeddingPort(wire([adapter])),
      model: 'ollama:whatever-was-configured',
      dimensions: 768,
    });

    expect(registryPort.model).toBe('ollama:whatever-was-configured');
    const outcome = await registryPort.embed(['a gnarled old tree']);

    expect(isErr(outcome)).toBe(false);
    // The router may fail over to a different model than the configured one. Storing
    // the configured name would attribute the vector to a model that never saw it,
    // and vectors from two models are not comparable.
    expect(registryPort.model).toBe(`ollama:${EMBED_MODEL}`);
    expect(registryPort.dimensions).toBe(3);
  });

  it('propagates a failure rather than returning an empty vector list', async () => {
    const registryPort = new RegistryEmbeddingAdapter({
      port: new RoutedEmbeddingPort(wire([])),
      model: 'ollama:none',
      dimensions: 768,
    });

    const outcome = await registryPort.embed(['anything']);
    expect(isErr(outcome)).toBe(true);
  });
});
