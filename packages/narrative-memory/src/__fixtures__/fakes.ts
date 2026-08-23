/**
 * Hand-written doubles for the two things this package cannot own.
 *
 * No live network, ever: CI has no Ollama and a test that needs one is a test that gets
 * deleted. Both fakes are **deterministic by construction**, because the properties
 * under test - "the same graph produces the same fact list, in the same order" - would
 * be untestable against a stub that answered differently on Tuesday.
 *
 * {@link FakeStructuredBackend} records every request it is handed, which is how "the
 * semantic pass only sees what the rules could not decide" and "the rule pass makes zero
 * provider calls" are asserted rather than assumed.
 */

import { type AppError, type Result, ProviderError, err, ok } from '@rv/shared-kernel';
import type { CompletionRequest, CompletionResponse, StructuredBackend } from '@rv/prompt-kit';
import type { EmbeddingPort, EmbeddingRequest, EmbeddingResult } from '@rv/providers';

export class FakeStructuredBackend implements StructuredBackend {
  readonly id = 'fake:extractor';
  readonly enforcesSchema = true;
  readonly dialect = 'plain' as const;

  /** Every request, in order. The assertion surface for "what was the model shown?". */
  readonly requests: CompletionRequest[] = [];
  #replies: string[];
  #failure: AppError | null = null;

  constructor(replies: readonly unknown[] = []) {
    this.#replies = replies.map((reply) =>
      typeof reply === 'string' ? reply : JSON.stringify(reply),
    );
  }

  /** Queues one more answer. The backend replays them in order and repeats the last. */
  reply(value: unknown): void {
    this.#replies.push(typeof value === 'string' ? value : JSON.stringify(value));
  }

  failWith(error: AppError): void {
    this.#failure = error;
  }

  get callCount(): number {
    return this.requests.length;
  }

  /** Everything the model was actually shown, concatenated. */
  get lastPrompt(): string {
    const last = this.requests.at(-1);
    if (last === undefined) return '';
    return last.messages.map((message) => message.content).join('\n');
  }

  complete(request: CompletionRequest): Promise<Result<CompletionResponse, AppError>> {
    this.requests.push(request);
    if (this.#failure !== null) return Promise.resolve(err(this.#failure));
    const text = this.#replies.at(Math.min(this.requests.length - 1, this.#replies.length - 1));
    if (text === undefined) {
      return Promise.resolve(
        err(
          new ProviderError({
            message: 'FakeStructuredBackend has no reply queued',
            provider: this.id,
          }),
        ),
      );
    }
    return Promise.resolve(
      ok({
        text,
        modelId: this.id,
        usage: { inputTokens: 100, outputTokens: 50 },
        costNanoUsd: 0,
      }),
    );
  }
}

/**
 * A presence-of-term embedder over a fixed vocabulary.
 *
 * Crude on purpose. Canned vectors would let a ranking test pass without the ranking
 * being right; a bag-of-words vector makes cosine similarity a number a reader can
 * verify by eye, so a test can assert an actual order rather than "the stub returned
 * what I told it to".
 */
export const TEST_VOCABULARY = [
  'mother',
  'parent',
  'fire',
  'secret',
  'sword',
  'vale',
  'keep',
  'dead',
  'letter',
  'winter',
  'kael',
  'aria',
] as const;

export class KeywordEmbeddingPort implements EmbeddingPort {
  readonly model = 'test:keyword-v1';
  readonly dimensions = TEST_VOCABULARY.length;

  /** Every batch it was asked for, so a test can prove one call and not N. */
  readonly batches: (readonly string[])[] = [];
  #failure: AppError | null = null;

  failWith(error: AppError): void {
    this.#failure = error;
  }

  embed(request: EmbeddingRequest): Promise<Result<EmbeddingResult, AppError>> {
    this.batches.push([...request.texts]);
    if (this.#failure !== null) return Promise.resolve(err(this.#failure));
    const vectors = request.texts.map((text) => {
      const lowered = text.toLowerCase();
      return TEST_VOCABULARY.map((term) => (lowered.includes(term) ? 1 : 0));
    });
    return Promise.resolve(
      ok({
        vectors,
        dimensions: this.dimensions,
        modelRef: this.model,
        usage: {
          tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
          images: { count: 0, resolution: null },
          latencyMs: 0,
        },
      }),
    );
  }
}

/** A backend nothing may call. Injected where a test asserts the pass is provider-free. */
export class ForbiddenStructuredBackend implements StructuredBackend {
  readonly id = 'fake:forbidden';
  readonly enforcesSchema = true;
  readonly dialect = 'plain' as const;

  complete(): Promise<Result<CompletionResponse, AppError>> {
    throw new Error('this pass must not call a provider');
  }
}
