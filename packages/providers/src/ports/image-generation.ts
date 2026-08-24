/**
 * Text (plus optional reference images) to pixels, and what that will cost.
 *
 * `references` is not decoration: multi-reference conditioning is what buys character
 * consistency without training a LoRA (research §3), so it is part of the port rather
 * than a provider-specific extra.
 *
 * ## Why the port has two methods
 *
 * CLAUDE.md's third non-negotiable is that **the budget guard runs before the call**,
 * and `BudgetGuard`'s own docstring puts the failure precisely: "a check that runs after
 * the provider returned is not a guard, it is a receipt." A port whose only member
 * spends money and reports `modelRef` on the way *out* cannot satisfy that: nothing
 * upstream can compute a projected cost, so the composition root has to hand every
 * use-case a price it looked up separately - and one that forgets is unguardable with
 * no compile error. `GenerateStyleProbeUseCase` looped four billable calls that way.
 *
 * So {@link ImageGenerationPort.quoteImage} is a **required** member, not a sibling port
 * behind a capability flag. Three reasons it belongs here rather than beside:
 *
 *  1. It is not a second capability, it is the precondition of this one. The narrowness
 *     rule in CLAUDE.md §2 forbids adding a method "because it is convenient"; a call
 *     that cannot be priced before it is made is not a convenience gap, it is a hole in
 *     an invariant.
 *  2. **Every adapter can answer**, because "free" and "unpriced" are both real answers.
 *     A local ComfyUI or Ollama call is genuinely `free` - a fact, not a missing number -
 *     and `UNPRICED` is what the catalogue already returns for a model nobody has priced.
 *  3. Whether a price exists depends on the **model id, not the adapter class**: the same
 *     OpenRouter adapter can quote `google/gemini-3-pro-image` and not quote a slug that
 *     appeared this morning. A per-adapter capability flag cannot express that, and a
 *     per-request answer can. That is where "declares it, and the router routes around
 *     it" lands for pricing: the `unpriced` arm is the declaration, and the caller's
 *     budget policy decides whether an unpriced call may proceed.
 *
 * The quote is **synchronous and pure**. It reads the same `Pricing` record the adapter
 * later prices the real call with, so the estimate and the invoice cannot come from two
 * different tables; and a guard that had to await a network round trip would be one more
 * thing that can fail open.
 */

import type { ModelRef, Size } from '@rv/contracts';
import type { AppError, NanoUsd, Result } from '@rv/shared-kernel';

import type { ImageArtifact, ImagePayload, ProviderCallResult } from './common';

export interface ImageGenerationRequest {
  readonly prompt: string;
  /** Ignored by providers that have no negative-prompt channel. */
  readonly negativePrompt?: string;
  readonly size?: Size;
  readonly count?: number;
  readonly seed?: number;
  /** Style anchors and character turnarounds, in priority order. */
  readonly references?: readonly ImagePayload[];
  readonly signal?: AbortSignal;
}

export interface ImageResult extends ProviderCallResult {
  readonly images: readonly ImageArtifact[];
}

/**
 * Everything a quote depends on, and nothing else.
 *
 * Only the size and the count move an image price - the prompt does not, because image
 * output is billed by pixels rather than by tokens (research §2). Keeping the quote
 * request to this subset means one method quotes a plain generation, an edit and a parts
 * sheet alike: `ImageGenerationRequest`, `ImageEditRequest` and `PartsSheetRequest` all
 * satisfy it structurally, so there is no third place for the pricing rule to drift to.
 */
export interface ImageCostRequest {
  readonly size?: Size;
  /** Defaults to 1. A batch is priced per image. */
  readonly count?: number;
}

/**
 * What one image call is expected to cost, answered before it is made.
 *
 * Three arms, and the third is the point. Collapsing `unpriced` into a zero would make
 * every unknown model look free to the budget guard, which is the most expensive
 * possible way to be wrong.
 */
export type ImageCostQuote =
  | {
      readonly kind: 'free';
      readonly modelRef: ModelRef;
      /** Always `ZERO_USD`. Present so callers can add quotes without branching. */
      readonly nanoUsd: NanoUsd;
      /** Why it is free - "local inference", not an empty price list. */
      readonly reason: string;
    }
  | {
      readonly kind: 'estimated';
      readonly modelRef: ModelRef;
      readonly nanoUsd: NanoUsd;
      /** How the number was arrived at, for the ledger's audit trail. */
      readonly basis: string;
    }
  | {
      readonly kind: 'unpriced';
      readonly modelRef: ModelRef;
      readonly reason: string;
    };

export interface ImageGenerationPort {
  generateImage(request: ImageGenerationRequest): Promise<Result<ImageResult, AppError>>;
  /**
   * What `generateImage` (or an edit, or a parts sheet) will cost on this model.
   *
   * Pure and synchronous: no clock, no network, no state. Two calls with the same
   * request return the same quote, which is what lets a run's projected spend be part
   * of a replayable plan rather than a reading taken at a moment.
   */
  quoteImage(request: ImageCostRequest): ImageCostQuote;
}

/**
 * The number to give a budget guard, or `null` when there is none.
 *
 * `null` rather than `0` on purpose, and callers are expected to branch on it: the whole
 * value of the `unpriced` arm is destroyed by a helper that quietly returns zero.
 */
export function projectedNanoUsd(quote: ImageCostQuote): NanoUsd | null {
  return quote.kind === 'unpriced' ? null : quote.nanoUsd;
}
