/**
 * OpenRouter: one key, many models, and the only place the `:free` pool is reachable.
 *
 * Speaks the OpenAI wire format, so the schema dialect is `openai-strict` - every
 * object closed and every property required, which is what `strict: true` demands.
 *
 * `HTTP-Referer` and `X-Title` are sent on every request. OpenRouter asks for them so
 * a client shows up in its rankings; omitting them is not an error, it just makes the
 * traffic anonymous, which is worse for us than for them when a rate limit needs
 * explaining.
 */

import type { Capability, ModelDescriptor, Pricing, ProviderKind, Size } from '@rv/contracts';
import { modelRef, toLlmJsonSchema } from '@rv/contracts';
import type { SchemaDialect } from '@rv/contracts';
import type { CompletionRequest, CompletionResponse, StructuredBackend } from '@rv/prompt-kit';
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
import { priceCall, pricingFor, quoteImageCall } from '../../cost/pricing';
import { type ImageArtifact, type ImagePayload, toImageArtifact, usage } from '../../ports/common';
import type { ImageEditPort, ImageEditRequest } from '../../ports/image-edit';
import type {
  ImageCostQuote,
  ImageCostRequest,
  ImageGenerationPort,
  ImageGenerationRequest,
  ImageResult,
} from '../../ports/image-generation';
import type { ProviderAdapter } from '../../ports/provider-adapter';
import type {
  TextGenerationPort,
  TextGenerationRequest,
  TextGenerationResult,
} from '../../ports/text-generation';
import {
  type VisionScoringPort,
  type VisionScoringRequest,
  type VisionScoringResult,
  VisionScoreSheet,
  buildRubricPrompt,
  parseScoreSheet,
} from '../../ports/vision-scoring';
import { elapsedSince, fromBase64, numberOr, toBase64 } from '../shared';
import { type CatalogueEntry, type CatalogueSnapshot, buildSnapshot } from './catalogue';
import {
  type OpenRouterChatRequest,
  type OpenRouterContentPart,
  type OpenRouterMessage,
  OpenRouterChatResponse,
  OpenRouterModelsResponse,
} from './wire';

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * What an OpenRouter model serves by default.
 *
 * `image-edit` is implemented but **not** declared here, and that is deliberate. Only
 * some OpenRouter image models accept an image alongside the prompt - research §2
 * records `openai/gpt-5-image-mini` as having no multi-reference conditioning at all -
 * so declaring edit for every model would create exactly the routing hole the
 * capability matrix exists to close. Wiring opts a model in with
 * `capabilities: [...OPENROUTER_CAPABILITIES, 'image-edit']`.
 */
export const OPENROUTER_CAPABILITIES: readonly Capability[] = [
  'text-generation',
  'structured-generation',
  'image-generation',
  'vision-scoring',
];

/** One hour. The catalogue moves daily at most, and a refresh costs a round trip. */
const DEFAULT_CATALOGUE_TTL_MS = 60 * 60 * 1000;

export interface OpenRouterAdapterOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
  readonly capabilities?: readonly Capability[];
  readonly pricing?: Pricing;
  readonly catalogue?: readonly ModelDescriptor[];
  /** Sent as `HTTP-Referer`. OpenRouter attributes traffic by it. */
  readonly referer?: string;
  /** Sent as `X-Title`. Shown next to the traffic in OpenRouter's dashboard. */
  readonly title?: string;
  readonly catalogueTtlMs?: number;
}

export class OpenRouterAdapter
  implements
    ProviderAdapter,
    StructuredBackend,
    TextGenerationPort,
    ImageGenerationPort,
    ImageEditPort,
    VisionScoringPort
{
  readonly kind: ProviderKind = 'openrouter';
  readonly modelRef: string;
  readonly capabilities: readonly Capability[];

  readonly id: string;
  /** `strict: true` on `response_format` binds the model to the schema server-side. */
  readonly enforcesSchema = true;
  readonly dialect: SchemaDialect = 'openai-strict';

  readonly #model: string;
  readonly #http: JsonHttpClient;
  readonly #clock: Clock;
  readonly #pricing: Pricing;
  readonly #seedCatalogue: readonly ModelDescriptor[] | undefined;
  readonly #ttlMs: number;
  #snapshot: CatalogueSnapshot | undefined;

  constructor(options: OpenRouterAdapterOptions) {
    this.#model = options.model;
    this.modelRef = modelRef('openrouter', options.model);
    this.id = this.modelRef;
    this.capabilities = options.capabilities ?? OPENROUTER_CAPABILITIES;
    this.#clock = options.clock ?? new SystemClock();
    this.#pricing =
      options.pricing ?? pricingFor('openrouter', options.model, options.catalogue ?? undefined);
    this.#seedCatalogue = options.catalogue;
    this.#ttlMs = options.catalogueTtlMs ?? DEFAULT_CATALOGUE_TTL_MS;
    this.#http = new JsonHttpClient({
      baseUrl: options.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL,
      provider: 'openrouter',
      clock: this.#clock,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        // The two headers OpenRouter asks every client to send.
        'HTTP-Referer': options.referer ?? 'https://github.com/rivayat',
        'X-Title': options.title ?? 'Rivayat',
      },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  // ── catalogue ─────────────────────────────────────────────────────────────

  /**
   * Fetches `/models` and reconciles it against `KNOWN_MODELS`.
   *
   * Always hits the network. `catalogue()` is the TTL-aware entry point; this one
   * exists so a maintenance command can force a check.
   */
  async syncCatalogue(signal?: AbortSignal): Promise<Result<CatalogueSnapshot, AppError>> {
    const response = await this.#http.getJson('/models', {
      ...(signal === undefined ? {} : { signal }),
    });
    if (isErr(response)) return response;

    const parsed = OpenRouterModelsResponse.safeParse(response.value);
    if (!parsed.success) {
      return err(
        new ProviderError({
          message: `OpenRouter /models returned an unexpected body (${String(parsed.error.issues.length)} schema issue(s))`,
          provider: 'openrouter',
          retryable: true,
        }),
      );
    }

    const snapshot = buildSnapshot(parsed.data, this.#clock.now(), this.#seedCatalogue);
    this.#snapshot = snapshot;
    return ok(snapshot);
  }

  /**
   * The catalogue, refreshed at most once per TTL.
   *
   * A failed refresh returns the cached snapshot rather than the error: a stale
   * catalogue still routes correctly, and failing a whole run because a *metadata*
   * endpoint blipped would be the tail wagging the dog. Only a cold cache surfaces
   * the failure.
   */
  async catalogue(signal?: AbortSignal): Promise<Result<CatalogueSnapshot, AppError>> {
    const cached = this.#snapshot;
    if (cached !== undefined && this.#clock.now() - cached.fetchedAt < this.#ttlMs) {
      return ok(cached);
    }

    const refreshed = await this.syncCatalogue(signal);
    if (refreshed.ok) return refreshed;
    return cached === undefined ? refreshed : ok(cached);
  }

  /**
   * Image-capable models, optionally narrowed to the free pool.
   *
   * The free-pool answer is expected to be empty, and a test pins it: research §2
   * measured zero `:free` models with image output, and that is exactly the sort of
   * fact that gets "corrected" from memory into a routing bug.
   */
  listImageCapable(options: { readonly free?: boolean } = {}): readonly CatalogueEntry[] {
    const snapshot = this.#snapshot;
    if (snapshot === undefined) return [];
    return [...snapshot.models.values()].filter((entry) => {
      if (!entry.outputModalities.includes('image')) return false;
      return options.free === true ? entry.id.endsWith(':free') : true;
    });
  }

  // ── structured-generation ─────────────────────────────────────────────────

  async complete(request: CompletionRequest): Promise<Result<CompletionResponse, AppError>> {
    const body: OpenRouterChatRequest = {
      model: this.#model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: false,
      temperature: request.temperature ?? 0,
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      ...(request.jsonSchema === undefined
        ? {}
        : {
            response_format: {
              type: 'json_schema' as const,
              json_schema: {
                name: 'structured_output',
                strict: true as const,
                schema: request.jsonSchema,
              },
            },
          }),
    };

    const chat = await this.#chat(body, request.signal);
    if (isErr(chat)) return chat;

    const tokens = tokensOf(chat.value);
    return ok({
      text: contentOf(chat.value),
      usage: { inputTokens: tokens.input, outputTokens: tokens.output },
      modelId: this.id,
      costNanoUsd: priceCall(this.#pricing, {
        tokens,
        images: { count: 0, resolution: null },
        latencyMs: 0,
      }),
    });
  }

  // ── text-generation ───────────────────────────────────────────────────────

  async generateText(
    request: TextGenerationRequest,
  ): Promise<Result<TextGenerationResult, AppError>> {
    const startedAt = this.#clock.now();
    const body: OpenRouterChatRequest = {
      model: this.#model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: false,
      temperature: request.temperature ?? 0,
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      ...(request.stopSequences === undefined ? {} : { stop: request.stopSequences }),
    };

    const chat = await this.#chat(body, request.signal);
    if (isErr(chat)) return chat;

    const tokens = tokensOf(chat.value);
    return ok({
      text: contentOf(chat.value),
      modelRef: this.modelRef,
      finishReason: chat.value.choices[0]?.finish_reason ?? null,
      usage: usage(elapsedSince(this.#clock, startedAt), { tokens }),
    });
  }

  // ── image-generation ──────────────────────────────────────────────────────

  async generateImage(request: ImageGenerationRequest): Promise<Result<ImageResult, AppError>> {
    const parts: OpenRouterContentPart[] = [
      { type: 'text', text: withNegative(request.prompt, request.negativePrompt) },
    ];
    for (const reference of request.references ?? []) parts.push(imagePart(reference));

    return this.#imageCall(parts, request.size ?? null, request.seed, request.signal);
  }

  /**
   * Priced from the catalogue entry this adapter was constructed with.
   *
   * Note what it does *not* do: a live `catalogue()` refresh does not feed back into
   * the quote, because a guard that awaits a network call fails open when the network
   * is down. A model whose price changed between construction and the call is quoted at
   * the old rate and billed at the new one - which is why `CostMeter` prices the real
   * usage afterwards rather than trusting this number.
   */
  quoteImage(request: ImageCostRequest): ImageCostQuote {
    return quoteImageCall(this.modelRef, this.#pricing, request);
  }

  // ── image-edit ────────────────────────────────────────────────────────────

  async editImage(request: ImageEditRequest): Promise<Result<ImageResult, AppError>> {
    const parts: OpenRouterContentPart[] = [imagePart(request.base)];
    if (request.mask !== undefined) parts.push(imagePart(request.mask));
    for (const reference of request.references ?? []) parts.push(imagePart(reference));
    parts.push({ type: 'text', text: request.instruction });

    return this.#imageCall(parts, request.size ?? null, request.seed, request.signal);
  }

  // ── vision-scoring ────────────────────────────────────────────────────────

  async score(request: VisionScoringRequest): Promise<Result<VisionScoringResult, AppError>> {
    const startedAt = this.#clock.now();
    const parts: OpenRouterContentPart[] = [imagePart(request.image)];
    for (const reference of request.references ?? []) parts.push(imagePart(reference));
    parts.push({ type: 'text', text: buildRubricPrompt(request.rubric) });

    const chat = await this.#chat(
      {
        model: this.#model,
        messages: [{ role: 'user', content: parts }],
        stream: false,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'vision_score_sheet',
            strict: true,
            schema: toLlmJsonSchema(VisionScoreSheet, { dialect: this.dialect }),
          },
        },
      },
      request.signal,
    );
    if (isErr(chat)) return chat;

    const sheet = parseScoreSheet(contentOf(chat.value), request.rubric);
    if (isErr(sheet)) return sheet;

    const tokens = tokensOf(chat.value);
    return ok({
      scores: sheet.value.scores,
      overall: sheet.value.overall,
      modelRef: this.modelRef,
      usage: usage(elapsedSince(this.#clock, startedAt), {
        tokens,
        images: { count: parts.length - 1 },
      }),
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  async #imageCall(
    parts: readonly OpenRouterContentPart[],
    size: Size | null,
    seed: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Result<ImageResult, AppError>> {
    const startedAt = this.#clock.now();
    const messages: readonly OpenRouterMessage[] = [{ role: 'user', content: parts }];

    const chat = await this.#chat(
      {
        model: this.#model,
        messages,
        stream: false,
        // Without this the multimodal model answers with a description of the picture.
        modalities: ['image', 'text'],
        ...(seed === undefined ? {} : { seed }),
      },
      signal,
    );
    if (isErr(chat)) return chat;

    const images = imagesOf(chat.value, size, seed ?? null);
    if (images.length === 0) {
      return err(
        new ProviderError({
          message: 'OpenRouter returned no image in the completion',
          provider: 'openrouter',
          // A refusal or a text-only model: the same request will fail the same way.
          retryable: false,
          context: { model: this.#model, finishReason: chat.value.choices[0]?.finish_reason },
        }),
      );
    }

    const tokens = tokensOf(chat.value);
    return ok({
      images,
      modelRef: this.modelRef,
      usage: {
        tokens,
        images: { count: images.length, resolution: size },
        latencyMs: elapsedSince(this.#clock, startedAt),
      },
    });
  }

  async #chat(
    body: OpenRouterChatRequest,
    signal: AbortSignal | undefined,
  ): Promise<Result<OpenRouterChatResponse, AppError>> {
    const response = await this.#http.postJson('/chat/completions', body, {
      ...(signal === undefined ? {} : { signal }),
    });
    if (isErr(response)) return response;

    const parsed = OpenRouterChatResponse.safeParse(response.value);
    if (!parsed.success) {
      return err(
        new ProviderError({
          message: `OpenRouter /chat/completions returned an unexpected body (${String(parsed.error.issues.length)} schema issue(s))`,
          provider: 'openrouter',
          retryable: true,
          context: { model: this.#model },
        }),
      );
    }

    // OpenRouter reports upstream failures in a 200 body as well as by status code, so
    // a happy status is not proof of a happy call.
    const embedded = parsed.data.error;
    if (embedded !== undefined) {
      const status = typeof embedded.code === 'number' ? embedded.code : undefined;
      return err(
        new ProviderError({
          message: `OpenRouter upstream error: ${embedded.message}`,
          provider: 'openrouter',
          ...(status === undefined ? { retryable: true } : { status }),
          context: { model: this.#model },
        }),
      );
    }

    return ok(parsed.data);
  }
}

function withNegative(prompt: string, negative: string | undefined): string {
  return negative === undefined || negative.trim() === ''
    ? prompt
    : `${prompt}\n\nAvoid: ${negative}`;
}

function imagePart(payload: ImagePayload): OpenRouterContentPart {
  return {
    type: 'image_url',
    image_url: { url: `data:${payload.mimeType};base64,${toBase64(payload.data)}` },
  };
}

function contentOf(response: OpenRouterChatResponse): string {
  return response.choices[0]?.message.content ?? '';
}

const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;

function imagesOf(
  response: OpenRouterChatResponse,
  size: Size | null,
  seed: number | null,
): readonly ImageArtifact[] {
  const out: ImageArtifact[] = [];
  for (const image of response.choices[0]?.message.images ?? []) {
    const match = DATA_URL.exec(image.image_url.url);
    if (match === null) continue;
    const mimeType = match[1];
    const encoded = match[2];
    if (mimeType === undefined || encoded === undefined) continue;
    out.push(toImageArtifact({ mimeType, data: fromBase64(encoded) }, { size, seed }));
  }
  return out;
}

function tokensOf(response: OpenRouterChatResponse): {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
} {
  return {
    input: numberOr(response.usage?.prompt_tokens, 0),
    output: numberOr(response.usage?.completion_tokens, 0),
    cached: 0,
    reasoning: 0,
  };
}
