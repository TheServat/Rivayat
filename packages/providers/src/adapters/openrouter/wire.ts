/**
 * OpenRouter's wire shapes.
 *
 * Every schema is `looseObject`: OpenRouter adds fields continuously and a strict
 * schema would turn a harmless addition into an outage. Only fields the adapter
 * actually reads are declared, and every one of them appears in OpenRouter's published
 * API reference - nothing here is inferred from a blog post or guessed at.
 */

import { z } from 'zod';

// ── chat completions ────────────────────────────────────────────────────────

/** An image OpenRouter returned, as a data URL in `image_url.url`. */
export const OpenRouterImageOut = z.looseObject({
  type: z.string().optional(),
  image_url: z.looseObject({ url: z.string() }),
});

export const OpenRouterChoice = z.looseObject({
  index: z.number().optional(),
  finish_reason: z.string().nullable().optional(),
  message: z.looseObject({
    role: z.string().optional(),
    content: z.string().nullable().optional(),
    images: z.array(OpenRouterImageOut).optional(),
  }),
});

export const OpenRouterUsage = z.looseObject({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
});

export const OpenRouterChatResponse = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(OpenRouterChoice),
  usage: OpenRouterUsage.optional(),
  /** OpenRouter reports upstream failures inside a 200 body as well as by status. */
  error: z
    .looseObject({ message: z.string(), code: z.union([z.number(), z.string()]).optional() })
    .optional(),
});
export type OpenRouterChatResponse = z.infer<typeof OpenRouterChatResponse>;

/** A content part. Plain string content is also legal; the adapter uses parts only for vision. */
export type OpenRouterContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

export interface OpenRouterMessage {
  readonly role: string;
  readonly content: string | readonly OpenRouterContentPart[];
}

export interface OpenRouterChatRequest {
  readonly model: string;
  readonly messages: readonly OpenRouterMessage[];
  readonly stream: false;
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly seed?: number;
  readonly stop?: readonly string[];
  /**
   * OpenAI-strict structured output.
   *
   * `strict: true` is what makes the schema binding rather than advisory, which is the
   * whole reason the `openai-strict` dialect closes every object and requires every
   * property (see `toLlmJsonSchema`).
   */
  readonly response_format?: {
    readonly type: 'json_schema';
    readonly json_schema: {
      readonly name: string;
      readonly strict: true;
      readonly schema: Record<string, unknown>;
    };
  };
  /** `['image', 'text']` asks a multimodal model for pixels rather than a description. */
  readonly modalities?: readonly string[];
}

// ── model catalogue ─────────────────────────────────────────────────────────

/**
 * Rates as OpenRouter quotes them: **per token**, as decimal strings.
 *
 * Note the unit difference from `@rv/contracts`, which stores per *million* tokens
 * because that is how the vendor pages read. Reconciliation multiplies by 1e6, and
 * that conversion is the single most likely place for an off-by-1e6 to hide, which is
 * why it has its own test.
 */
export const OpenRouterPricing = z.looseObject({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  request: z.string().optional(),
  /** Per *input* image. Not the image-output rate; see `catalogue.ts` for why. */
  image: z.string().optional(),
});

export const OpenRouterModel = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  context_length: z.number().nullable().optional(),
  architecture: z
    .looseObject({
      input_modalities: z.array(z.string()).optional(),
      output_modalities: z.array(z.string()).optional(),
      modality: z.string().optional(),
    })
    .optional(),
  pricing: OpenRouterPricing.optional(),
  top_provider: z
    .looseObject({
      context_length: z.number().nullable().optional(),
      max_completion_tokens: z.number().nullable().optional(),
    })
    .optional(),
});
export type OpenRouterModel = z.infer<typeof OpenRouterModel>;

export const OpenRouterModelsResponse = z.looseObject({
  data: z.array(OpenRouterModel),
});
export type OpenRouterModelsResponse = z.infer<typeof OpenRouterModelsResponse>;
