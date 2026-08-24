/**
 * Google Gemini: the strong creative lane and the paid image lane.
 *
 * Two facts from research §2 shape this adapter and neither is negotiable from memory:
 * Gemini's **text** Flash models are free of charge on the free tier, its **image**
 * models are not, and image models are `text+image -> text+image`, which is what makes
 * them editors as well as generators (and therefore what buys character consistency
 * from multi-reference conditioning, research §3).
 *
 * The SDK's own retry is switched off (`retryOptions: { attempts: 1 }`) for two
 * reasons. It jitters with `Math.random()`, which CLAUDE.md #1 forbids anywhere near a
 * reproducible run; and it would retry underneath the router, hiding the rate limit
 * that the router needs to see in order to fail over to another provider.
 */

import { GoogleGenAI } from '@google/genai';
import type { Content, GenerateContentConfig, GenerateContentResponse, Part } from '@google/genai';
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

import { errorFromSdk } from '../../http/errors';
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
import { priceCall, pricingFor, quoteImageCall } from '../../cost/pricing';
import { elapsedSince, fromBase64, numberOr } from '../shared';

/** Everything a Gemini model can do. Text-only models are narrowed at wiring time. */
export const GEMINI_CAPABILITIES: readonly Capability[] = [
  'text-generation',
  'structured-generation',
  'image-generation',
  'image-edit',
  'vision-scoring',
];

/** The subset a free-tier text model actually serves (research §2: no free image tier). */
export const GEMINI_TEXT_CAPABILITIES: readonly Capability[] = [
  'text-generation',
  'structured-generation',
  'vision-scoring',
];

/**
 * The narrow slice of `@google/genai` this adapter uses.
 *
 * Declared structurally so a test can supply a double without constructing a real
 * client, and so the compile fails loudly if a future SDK version moves the method.
 */
export interface GeminiModelsApi {
  generateContent(params: {
    model: string;
    contents: Content[];
    config?: GenerateContentConfig;
  }): Promise<GenerateContentResponse>;
}

export interface GeminiClient {
  readonly models: GeminiModelsApi;
}

export interface GeminiAdapterOptions {
  readonly apiKey: string;
  /** Provider-native id, e.g. `gemini-2.5-flash` or `gemini-3-pro-image`. */
  readonly model: string;
  /** Overrides the endpoint - a regional host or a recording proxy. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly clock?: Clock;
  readonly capabilities?: readonly Capability[];
  /** Price list override. Defaults to the `KNOWN_MODELS` entry for this model. */
  readonly pricing?: Pricing;
  readonly catalogue?: readonly ModelDescriptor[];
  /** Test seam. Defaults to a real `GoogleGenAI`, which uses global `fetch`. */
  readonly client?: GeminiClient;
}

export class GeminiAdapter
  implements
    ProviderAdapter,
    StructuredBackend,
    TextGenerationPort,
    ImageGenerationPort,
    ImageEditPort,
    VisionScoringPort
{
  readonly kind: ProviderKind = 'gemini';
  readonly modelRef: string;
  readonly capabilities: readonly Capability[];

  readonly id: string;
  /** Gemini constrains generation server-side via `responseSchema`. */
  readonly enforcesSchema = true;
  readonly dialect: SchemaDialect = 'gemini';

  readonly #model: string;
  readonly #client: GeminiClient;
  readonly #clock: Clock;
  readonly #pricing: Pricing;

  constructor(options: GeminiAdapterOptions) {
    this.#model = options.model;
    this.modelRef = modelRef('gemini', options.model);
    this.id = this.modelRef;
    this.capabilities = options.capabilities ?? GEMINI_CAPABILITIES;
    this.#clock = options.clock ?? new SystemClock();
    this.#pricing =
      options.pricing ?? pricingFor('gemini', options.model, options.catalogue ?? undefined);
    this.#client =
      options.client ??
      new GoogleGenAI({
        apiKey: options.apiKey,
        httpOptions: {
          // See the file header: the SDK's retry is disabled, not merely tuned.
          retryOptions: { attempts: 1 },
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        },
      });
  }

  // ── structured-generation ─────────────────────────────────────────────────

  async complete(request: CompletionRequest): Promise<Result<CompletionResponse, AppError>> {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map<Content>((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));

    const config: GenerateContentConfig = {
      temperature: request.temperature ?? 0,
      ...(system === '' ? {} : { systemInstruction: system }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.jsonSchema === undefined
        ? {}
        : { responseMimeType: 'application/json', responseSchema: request.jsonSchema }),
      ...(request.signal === undefined ? {} : { abortSignal: request.signal }),
    };

    const response = await this.#generate(contents, config, request.signal, 'generateContent');
    if (isErr(response)) return response;

    const tokens = tokensOf(response.value);
    return ok({
      text: textOf(response.value),
      usage: { inputTokens: tokens.input, outputTokens: tokens.output },
      modelId: this.id,
      costNanoUsd: priceCall(this.#pricing, {
        tokens: {
          input: tokens.input,
          output: tokens.output,
          cached: tokens.cached,
          reasoning: tokens.reasoning,
        },
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
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map<Content>((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));

    const config: GenerateContentConfig = {
      temperature: request.temperature ?? 0,
      ...(system === '' ? {} : { systemInstruction: system }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      ...(request.stopSequences === undefined ? {} : { stopSequences: [...request.stopSequences] }),
      ...(request.signal === undefined ? {} : { abortSignal: request.signal }),
    };

    const response = await this.#generate(contents, config, request.signal, 'generateContent');
    if (isErr(response)) return response;

    const tokens = tokensOf(response.value);
    return ok({
      text: textOf(response.value),
      modelRef: this.modelRef,
      finishReason: response.value.candidates?.[0]?.finishReason ?? null,
      usage: usage(elapsedSince(this.#clock, startedAt), { tokens }),
    });
  }

  // ── image-generation ──────────────────────────────────────────────────────

  async generateImage(request: ImageGenerationRequest): Promise<Result<ImageResult, AppError>> {
    const parts: Part[] = [{ text: buildImagePrompt(request.prompt, request.negativePrompt) }];
    for (const reference of request.references ?? []) parts.push(inlinePart(reference));

    return this.#imageCall(parts, request.size ?? null, request.seed, request.signal);
  }

  /**
   * Priced from the same `Pricing` record `priceCall` later bills against.
   *
   * Research §2's numbers are per *image-output token*, so the estimate scales with
   * area - which is also how the published price ranges behave.
   */
  quoteImage(request: ImageCostRequest): ImageCostQuote {
    return quoteImageCall(this.modelRef, this.#pricing, request);
  }

  // ── image-edit ────────────────────────────────────────────────────────────

  async editImage(request: ImageEditRequest): Promise<Result<ImageResult, AppError>> {
    // Order matters to the model: the base first, then whatever it should look like,
    // then the instruction. Research §3 - multi-reference conditioning is positional.
    const parts: Part[] = [inlinePart(request.base)];
    if (request.mask !== undefined) parts.push(inlinePart(request.mask));
    for (const reference of request.references ?? []) parts.push(inlinePart(reference));
    parts.push({ text: request.instruction });

    return this.#imageCall(parts, request.size ?? null, request.seed, request.signal);
  }

  // ── vision-scoring ────────────────────────────────────────────────────────

  async score(request: VisionScoringRequest): Promise<Result<VisionScoringResult, AppError>> {
    const startedAt = this.#clock.now();
    const parts: Part[] = [inlinePart(request.image)];
    for (const reference of request.references ?? []) parts.push(inlinePart(reference));
    parts.push({ text: buildRubricPrompt(request.rubric) });

    const config: GenerateContentConfig = {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: toLlmJsonSchema(VisionScoreSheet, { dialect: this.dialect }),
      ...(request.signal === undefined ? {} : { abortSignal: request.signal }),
    };

    const response = await this.#generate(
      [{ role: 'user', parts }],
      config,
      request.signal,
      'generateContent(vision)',
    );
    if (isErr(response)) return response;

    const sheet = parseScoreSheet(textOf(response.value), request.rubric);
    if (isErr(sheet)) return sheet;

    const tokens = tokensOf(response.value);
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
    parts: readonly Part[],
    size: Size | null,
    seed: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Result<ImageResult, AppError>> {
    const startedAt = this.#clock.now();
    const config: GenerateContentConfig = {
      // `text+image -> text+image` (research §2): both modalities must be requested or
      // the model answers with a description of the picture instead of the picture.
      responseModalities: ['TEXT', 'IMAGE'],
      ...(seed === undefined ? {} : { seed }),
      ...(signal === undefined ? {} : { abortSignal: signal }),
    };

    const response = await this.#generate(
      [{ role: 'user', parts: [...parts] }],
      config,
      signal,
      'generateContent(image)',
    );
    if (isErr(response)) return response;

    const images = imagesOf(response.value, size, seed ?? null);
    if (images.length === 0) {
      return err(
        new ProviderError({
          message: 'Gemini returned no image part',
          provider: 'gemini',
          // A refusal or a safety block: the identical request will be refused again.
          retryable: false,
          context: {
            model: this.#model,
            finishReason: response.value.candidates?.[0]?.finishReason,
          },
        }),
      );
    }

    const tokens = tokensOf(response.value);
    const billedImageTokens = imageOutputTokensOf(response.value);
    return ok({
      images,
      modelRef: this.modelRef,
      usage: {
        tokens,
        images: { count: images.length, resolution: size },
        latencyMs: elapsedSince(this.#clock, startedAt),
        ...(billedImageTokens === undefined ? {} : { imageOutputTokens: billedImageTokens }),
      },
    });
  }

  async #generate(
    contents: Content[],
    config: GenerateContentConfig,
    signal: AbortSignal | undefined,
    operation: string,
  ): Promise<Result<GenerateContentResponse, AppError>> {
    // Checked before the call so a cancelled request provably reaches no socket.
    if (signal?.aborted === true) {
      return err(
        errorFromSdk({
          provider: 'gemini',
          operation,
          caught: new DOMException('aborted', 'AbortError'),
          signal,
          nowMs: this.#clock.now(),
        }),
      );
    }

    try {
      const response = await this.#client.models.generateContent({
        model: this.#model,
        contents,
        config,
      });
      return ok(response);
    } catch (caught) {
      return err(
        errorFromSdk({
          provider: 'gemini',
          operation,
          caught,
          nowMs: this.#clock.now(),
          ...(signal === undefined ? {} : { signal }),
        }),
      );
    }
  }
}

function inlinePart(payload: ImagePayload): Part {
  return {
    inlineData: { mimeType: payload.mimeType, data: Buffer.from(payload.data).toString('base64') },
  };
}

/**
 * Gemini has no negative-prompt channel, so it is folded into the prompt.
 *
 * Stated rather than silently dropped: an asset spec that says "no text in the image"
 * and gets text anyway is a bug the user should be able to see the cause of.
 */
function buildImagePrompt(prompt: string, negative: string | undefined): string {
  return negative === undefined || negative.trim() === ''
    ? prompt
    : `${prompt}\n\nAvoid: ${negative}`;
}

function textOf(response: GenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part.text ?? '')
    .join('')
    .trim();
}

function imagesOf(
  response: GenerateContentResponse,
  size: Size | null,
  seed: number | null,
): readonly ImageArtifact[] {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const images: ImageArtifact[] = [];
  for (const part of parts) {
    const inline = part.inlineData;
    if (inline?.data === undefined) continue;
    images.push(
      toImageArtifact(
        { mimeType: inline.mimeType ?? 'image/png', data: fromBase64(inline.data) },
        { size, seed },
      ),
    );
  }
  return images;
}

/**
 * Image-output tokens, read from the modality breakdown rather than estimated.
 *
 * `undefined` when Gemini did not break the count down, which is the signal the meter
 * needs to fall back to the research §2 approximation instead of billing zero.
 */
function imageOutputTokensOf(response: GenerateContentResponse): number | undefined {
  const details = response.usageMetadata?.candidatesTokensDetails;
  if (details === undefined) return undefined;
  let total = 0;
  let sawImage = false;
  for (const detail of details) {
    if (String(detail.modality ?? '').toUpperCase() !== 'IMAGE') continue;
    sawImage = true;
    total += numberOr(detail.tokenCount, 0);
  }
  return sawImage ? total : undefined;
}

function tokensOf(response: GenerateContentResponse): {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
} {
  const metadata = response.usageMetadata;
  return {
    input: numberOr(metadata?.promptTokenCount, 0),
    output: numberOr(metadata?.candidatesTokenCount, 0),
    cached: numberOr(metadata?.cachedContentTokenCount, 0),
    reasoning: numberOr(metadata?.thoughtsTokenCount, 0),
  };
}
