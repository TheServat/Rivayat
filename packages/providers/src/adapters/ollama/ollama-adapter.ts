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
  mergeChatChunk,
  type OllamaChatChunks,
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
/**
 * The vision model that fits beside ComfyUI on a 6 GB card, benchmarked 2026-08-23.
 *
 * Not a preference. `tools/scripts/vision-gate-bench.mjs` scored four candidates on the
 * *same* rejected take - the 2x2 contact sheet of photographs that the splitter, the
 * assigner and the rigger all accepted - using the real rubric from the real locked
 * paper-cutout StyleBible, with ComfyUI resident and holding 3.4 GB:
 *
 * | model             | s/image (unseen) | caught the contact sheet |
 * | ----------------- | ---------------- | ------------------------ |
 * | **`qwen3-vl:4b`** | **1.1 - 10**     | **yes** (style-match 0)  |
 * | `qwen3.5:latest`  | 13.8 - 21.6      | yes (style-match 0)      |
 * | `qwen3-vl:2b`     | 1.8              | **no** (style-match 1)   |
 * | `minicpm-v4.6:1b` | 1.1              | **no** (style-match 1)   |
 * | `gemma4:26b`      | -                | will not load            |
 *
 * Two findings the table understates. `gemma4:26b` - the previous `.env` default - does
 * not merely run slowly: Ollama refuses it outright with *"llama-server reported
 * out-of-memory during startup: CUDA error: out of memory"*. And the two models that
 * miss the defect are not blind: asked directly, `minicpm-v4.6:1b` counts the four
 * photographs correctly and then rates them a perfect paper-cutout match. Seeing an
 * image and judging it against a style rubric are different abilities, and only the
 * second one is a gate. A fast gate that misses the defect is worse than no gate.
 */
export const OLLAMA_RECOMMENDED_VISION_MODEL = 'qwen3-vl:4b';

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
      text:
        request.jsonSchema === undefined
          ? chat.value.message.content
          : schemaConstrainedText(chat.value),
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

    const sheet = parseScoreSheet(schemaConstrainedText(chat.value), request.rubric);
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
      stream: true,
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
    const response = await this.#http.postNdjson<OllamaChatChunks>(
      '/api/chat',
      body,
      mergeChatChunk,
      { ...(signal === undefined ? {} : { signal }) },
    );
    if (isErr(response)) return response;

    const parsed = OllamaChatResponse.safeParse(response.value);
    if (!parsed.success) return err(this.#malformed('/api/chat', parsed.error.issues.length));
    // A stream that never said `done` is a truncated one. This check exists because
    // streaming took the old one away: reassembly fills `content` with the empty string
    // it accumulated, so a body that was never a chat response at all now satisfies the
    // schema. The terminal flag is the thing only a complete response has.
    if (parsed.data.done !== true) return err(this.#malformed('/api/chat', 0));
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

/**
 * The model's answer to a `format`-constrained call, whichever channel it arrived on.
 *
 * Ollama 0.32.15 puts a grammar-constrained response in `message.thinking` and leaves
 * `message.content` empty on every thinking-capable vision model measured here
 * (`qwen3-vl:2b`, `qwen3-vl:4b`), regardless of `think: false`. The JSON in `thinking`
 * is complete and valid - it is the same bytes, on the other field.
 *
 * Only applied where a schema was requested. On a plain text call the two channels mean
 * what they say, and preferring `thinking` there would return the model's reasoning to a
 * caller that asked for prose. Downstream, both `extractJson` and `parseScoreSheet`
 * strip a `<think>` block anyway, so a model that mixes the two is still handled.
 */
function schemaConstrainedText(response: OllamaChatResponse): string {
  const content = response.message.content;
  if (content.trim() !== '') return content;
  return response.message.thinking ?? content;
}

function tokensOf(response: OllamaChatResponse): PromptTokenUsage {
  return {
    inputTokens: numberOr(response.prompt_eval_count, 0),
    outputTokens: numberOr(response.eval_count, 0),
  };
}
