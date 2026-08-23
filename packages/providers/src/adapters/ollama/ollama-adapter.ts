/**
 * The free local lane.
 *
 * Two things about this adapter are load-bearing and both come from research §1:
 *
 *  1. **It uses the native `/api/chat` with `format: <jsonSchema>`, never the
 *     OpenAI-compatible endpoint.** Ollama issue #15540: the shim does not enforce
 *     JSON Schema for `qwen3.5` or `gemma4`. A test scans this whole package for the
 *     shim's path and fails if it ever appears.
 *  2. **It reports `enforcesSchema: false` anyway.** The native endpoint accepts the
 *     schema and the models still violate it, so the honest answer is "no". That value
 *     is what makes `StructuredCall` restate the schema in the prompt and keep its
 *     repair loop armed. Claiming enforcement would silently disarm both.
 *
 * ### A gap worth knowing about
 *
 * Because `enforcesSchema` is `false`, `StructuredCall` does not put `jsonSchema` on
 * the `CompletionRequest` at all (see its `#buildCompletionRequest`), so a call driven
 * through the sanctioned wrapper reaches Ollama *without* `format`. The schema still
 * gets to the model - restated in the system prompt - so both research mitigations
 * hold, but the grammar constraint is left on the table. This adapter sends `format`
 * whenever a caller does supply `jsonSchema`; closing the gap for `StructuredCall`
 * needs a one-line change in `@rv/prompt-kit`, which is outside this package.
 */

import type { Capability, ProviderKind } from '@rv/contracts';
import { modelRef, toLlmJsonSchema } from '@rv/contracts';
import type {
  CompletionRequest,
  CompletionResponse,
  StructuredBackend,
  TokenUsage as PromptTokenUsage,
} from '@rv/prompt-kit';
import type { SchemaDialect } from '@rv/contracts';
import {
  type AppError,
  type Clock,
  ProviderError,
  type Result,
  SystemClock,
  err,
  isErr,
  ok,
} from '@rv/shared-kernel';

import { type FetchLike, JsonHttpClient } from '../../http/json-http';
import type { ProviderAdapter } from '../../ports/provider-adapter';
import type {
  TextGenerationPort,
  TextGenerationRequest,
  TextGenerationResult,
} from '../../ports/text-generation';
import type { EmbeddingPort, EmbeddingRequest, EmbeddingResult } from '../../ports/embedding';
import {
  type VisionScoringPort,
  type VisionScoringRequest,
  type VisionScoringResult,
  VisionScoreSheet,
  buildRubricPrompt,
  parseScoreSheet,
} from '../../ports/vision-scoring';
import { usage } from '../../ports/common';
import { elapsedSince, numberOr, toBase64 } from '../shared';
import {
  type OllamaChatMessage,
  type OllamaChatRequest,
  type OllamaEmbedRequest,
  OllamaChatResponse,
  OllamaEmbedResponse,
} from './wire';

/** Ollama's default bind address. Overridden by `OLLAMA_HOST` in the app layer, not here. */
export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

/**
 * What an Ollama-hosted model can do, at most.
 *
 * "At most" because vision and embedding are model-dependent - `qwen3.5` has no vision
 * head. Wiring narrows this per model rather than the adapter guessing from the id,
 * which would break the first time a name changes.
 */
export const OLLAMA_CAPABILITIES: readonly Capability[] = [
  'text-generation',
  'structured-generation',
  'embedding',
  'vision-scoring',
];

export interface OllamaAdapterOptions {
  /** Provider-native model id, verbatim, e.g. `qwen3.5:latest`. */
  readonly model: string;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
  /** Narrows `OLLAMA_CAPABILITIES` for a model that cannot do all of them. */
  readonly capabilities?: readonly Capability[];
}

export class OllamaAdapter
  implements
    ProviderAdapter,
    StructuredBackend,
    TextGenerationPort,
    EmbeddingPort,
    VisionScoringPort
{
  readonly kind: ProviderKind = 'ollama';
  readonly modelRef: string;
  readonly capabilities: readonly Capability[];

  /** `StructuredBackend.id`. Same value as `modelRef`; two names, one identity. */
  readonly id: string;
  /** See the file header: honest, not optimistic. */
  readonly enforcesSchema = false;
  readonly dialect: SchemaDialect = 'ollama';

  readonly #model: string;
  readonly #http: JsonHttpClient;
  readonly #clock: Clock;

  constructor(options: OllamaAdapterOptions) {
    this.#model = options.model;
    this.modelRef = modelRef('ollama', options.model);
    this.id = this.modelRef;
    this.capabilities = options.capabilities ?? OLLAMA_CAPABILITIES;
    this.#clock = options.clock ?? new SystemClock();
    this.#http = new JsonHttpClient({
      baseUrl: options.baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
      provider: 'ollama',
      clock: this.#clock,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  // ── structured-generation ─────────────────────────────────────────────────

  async complete(request: CompletionRequest): Promise<Result<CompletionResponse, AppError>> {
    const body = this.#chatBody(
      request.messages.map((message) => ({ role: message.role, content: message.content })),
      {
        ...(request.jsonSchema === undefined ? {} : { format: request.jsonSchema }),
        temperature: request.temperature ?? 0,
        think: request.think ?? false,
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
      },
    );

    const chat = await this.#chat(body, request.signal);
    if (isErr(chat)) return chat;

    const tokens = tokensOf(chat.value);
    return ok({
      text: chat.value.message.content,
      usage: tokens,
      modelId: this.id,
      // Local inference. Recorded explicitly so the ledger shows the free lane
      // being used rather than showing nothing at all.
      costNanoUsd: 0,
    });
  }

  // ── text-generation ───────────────────────────────────────────────────────

  async generateText(
    request: TextGenerationRequest,
  ): Promise<Result<TextGenerationResult, AppError>> {
    const startedAt = this.#clock.now();
    const chat = await this.#chat(
      this.#chatBody(
        request.messages.map((message) => ({ role: message.role, content: message.content })),
        {
          temperature: request.temperature ?? 0,
          think: request.think ?? false,
          ...(request.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: request.maxOutputTokens }),
          ...(request.seed === undefined ? {} : { seed: request.seed }),
          ...(request.stopSequences === undefined ? {} : { stop: request.stopSequences }),
        },
      ),
      request.signal,
    );
    if (isErr(chat)) return chat;

    const tokens = tokensOf(chat.value);
    return ok({
      text: chat.value.message.content,
      modelRef: this.modelRef,
      finishReason: chat.value.done_reason ?? null,
      usage: usage(elapsedSince(this.#clock, startedAt), {
        tokens: { input: tokens.inputTokens, output: tokens.outputTokens },
      }),
    });
  }

  // ── embedding ─────────────────────────────────────────────────────────────

  async embed(request: EmbeddingRequest): Promise<Result<EmbeddingResult, AppError>> {
    const startedAt = this.#clock.now();
    const body: OllamaEmbedRequest = { model: this.#model, input: request.texts };

    const response = await this.#http.postJson('/api/embed', body, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (isErr(response)) return response;

    const parsed = OllamaEmbedResponse.safeParse(response.value);
    if (!parsed.success) return err(this.#malformed('/api/embed', parsed.error.issues.length));

    const first = parsed.data.embeddings[0];
    if (first === undefined || first.length === 0) {
      return err(
        new ProviderError({
          message: 'Ollama returned no embedding vectors',
          provider: 'ollama',
          retryable: false,
          context: { model: this.#model, requested: request.texts.length },
        }),
      );
    }

    return ok({
      vectors: parsed.data.embeddings,
      dimensions: first.length,
      modelRef: this.modelRef,
      usage: usage(elapsedSince(this.#clock, startedAt), {
        tokens: { input: numberOr(parsed.data.prompt_eval_count, 0) },
      }),
    });
  }

  // ── vision-scoring ────────────────────────────────────────────────────────

  async score(request: VisionScoringRequest): Promise<Result<VisionScoringResult, AppError>> {
    const startedAt = this.#clock.now();
    const images = [request.image, ...(request.references ?? [])].map((payload) =>
      toBase64(payload.data),
    );

    const chat = await this.#chat(
      this.#chatBody([{ role: 'user', content: buildRubricPrompt(request.rubric), images }], {
        format: toLlmJsonSchema(VisionScoreSheet, { dialect: this.dialect }),
        temperature: 0,
        think: false,
      }),
      request.signal,
    );
    if (isErr(chat)) return chat;

    const sheet = parseScoreSheet(chat.value.message.content, request.rubric);
    if (isErr(sheet)) return sheet;

    const tokens = tokensOf(chat.value);
    return ok({
      scores: sheet.value.scores,
      overall: sheet.value.overall,
      modelRef: this.modelRef,
      usage: usage(elapsedSince(this.#clock, startedAt), {
        tokens: { input: tokens.inputTokens, output: tokens.outputTokens },
        images: { count: images.length },
      }),
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #chatBody(
    messages: readonly OllamaChatMessage[],
    options: {
      readonly format?: Record<string, unknown>;
      readonly temperature: number;
      readonly think: boolean;
      readonly maxOutputTokens?: number;
      readonly seed?: number;
      readonly stop?: readonly string[];
    },
  ): OllamaChatRequest {
    return {
      model: this.#model,
      messages,
      stream: false,
      think: options.think,
      ...(options.format === undefined ? {} : { format: options.format }),
      options: {
        temperature: options.temperature,
        ...(options.maxOutputTokens === undefined ? {} : { num_predict: options.maxOutputTokens }),
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.stop === undefined ? {} : { stop: options.stop }),
      },
    };
  }

  async #chat(
    body: OllamaChatRequest,
    signal: AbortSignal | undefined,
  ): Promise<Result<OllamaChatResponse, AppError>> {
    const response = await this.#http.postJson('/api/chat', body, {
      ...(signal === undefined ? {} : { signal }),
    });
    if (isErr(response)) return response;

    const parsed = OllamaChatResponse.safeParse(response.value);
    if (!parsed.success) return err(this.#malformed('/api/chat', parsed.error.issues.length));
    return ok(parsed.data);
  }

  /**
   * A 200 whose body is not the documented shape.
   *
   * Retryable: in practice this is a truncated or partially-streamed body rather than
   * a permanent contract change, and one more attempt costs nothing locally.
   */
  #malformed(path: string, issueCount: number): AppError {
    return new ProviderError({
      message: `Ollama ${path} returned an unexpected body (${String(issueCount)} schema issue(s))`,
      provider: 'ollama',
      retryable: true,
      context: { path, model: this.#model },
    });
  }
}

function tokensOf(response: OllamaChatResponse): PromptTokenUsage {
  return {
    inputTokens: numberOr(response.prompt_eval_count, 0),
    outputTokens: numberOr(response.eval_count, 0),
  };
}
