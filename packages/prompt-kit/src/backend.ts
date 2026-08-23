/**
 * The narrow port `StructuredCall` needs.
 *
 * Declared here, in the layer that *uses* it, rather than in `@rv/providers` - that is
 * the dependency-inversion half of the architecture, and it means `prompt-kit` can be
 * tested with a hand-written fake and never imports a vendor SDK.
 *
 * It is deliberately smaller than a general chat interface: no streaming, no tools, no
 * multi-turn state. Anything wider would tempt callers to bypass the repair loop.
 */

import type { AppError, Result } from '@rv/shared-kernel';
import type { SchemaDialect } from '@rv/contracts';

export type PromptRole = 'system' | 'user' | 'assistant';

/**
 * An image attached to a prompt turn.
 *
 * Either inline bytes or a reference the provider can fetch. Inline is the default -
 * a URL the model must fetch makes the call non-reproducible.
 */
export interface ImagePayload {
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Base64, without a data-URI prefix. */
  readonly base64: string;
  /** Content hash, for the response-cache key and for provenance. */
  readonly hash?: string;
}

export interface PromptMessage {
  readonly role: PromptRole;
  readonly content: string;
  /**
   * Images the model should look at.
   *
   * Present so vision scoring is an ordinary `StructuredCall` rather than a parallel
   * one-shot implementation of the same parse/validate/repair loop. A backend without
   * an image input modality must reject a message carrying these rather than silently
   * dropping them.
   */
  readonly images?: readonly ImagePayload[];
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
}

export interface CompletionRequest {
  readonly messages: readonly PromptMessage[];
  /**
   * The provider-dialect JSON Schema, when the backend can enforce one.
   *
   * Present even for backends that only *claim* to enforce it - `qwen3.5` via Ollama
   * accepts the schema and then ignores it, which is exactly why validation happens
   * downstream regardless.
   */
  readonly jsonSchema?: Record<string, unknown>;
  /** 0 for extraction work. Schema adherence collapses as this rises. */
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Disable a reasoning model's thinking phase; it wastes tokens on extraction. */
  readonly think?: boolean;
  readonly signal?: AbortSignal;
}

export interface CompletionResponse {
  readonly text: string;
  readonly usage?: TokenUsage;
  /** `provider:model`, for the ledger and for diagnosing which model misbehaved. */
  readonly modelId: string;
  readonly costNanoUsd?: number;
}

export interface StructuredBackend {
  /** `provider:model`, e.g. `ollama:qwen3.5` or `openrouter:z-ai/glm-5.2:free`. */
  readonly id: string;
  /**
   * Whether the provider constrains generation to the schema at the token level.
   *
   * Advisory, not a guarantee - see the Ollama caveat above. It only decides whether
   * we bother sending the schema and how loudly we restate it in the prompt.
   */
  readonly enforcesSchema: boolean;
  /** Which JSON Schema subset this provider accepts. */
  readonly dialect: SchemaDialect;

  complete(request: CompletionRequest): Promise<Result<CompletionResponse, AppError>>;
}
