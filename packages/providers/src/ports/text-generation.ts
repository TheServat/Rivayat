/**
 * Free-form text out of a language model.
 *
 * Deliberately *not* the JSON path. Anything that needs a shape goes through
 * `StructuredCall` (CLAUDE.md #6); this port exists for prose - a scene draft, a
 * logline, a prompt fragment - where there is nothing to validate against.
 */

import type { AppError, Result } from '@rv/shared-kernel';
import type { PromptMessage } from '@rv/prompt-kit';

import type { ProviderCallResult } from './common';

export interface TextGenerationRequest {
  readonly messages: readonly PromptMessage[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly stopSequences?: readonly string[];
  /** Determinism is non-negotiable (CLAUDE.md #1); an unseeded creative call is a bug. */
  readonly seed?: number;
  /** Suppress a reasoning model's thinking phase. */
  readonly think?: boolean;
  readonly signal?: AbortSignal;
}

export interface TextGenerationResult extends ProviderCallResult {
  readonly text: string;
  /** Provider-native stop reason, verbatim. `null` when none was reported. */
  readonly finishReason: string | null;
}

export interface TextGenerationPort {
  generateText(request: TextGenerationRequest): Promise<Result<TextGenerationResult, AppError>>;
}
