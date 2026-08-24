/**
 * The vocabulary every provider port is written in.
 *
 * Nothing here names a vendor. That is the whole point of the layer: `asset-engine`
 * asks for an image and gets bytes plus a content hash, and never learns whether they
 * came from a 6 GB local GPU or a paid Gemini call. Architecture §5 calls this the
 * narrow-port rule; `pnpm arch:check` turns it into a build failure.
 */

import type { ImageUsage, ModelRef, Size, SpeechUsage, TokenUsage } from '@rv/contracts';
import { type Sha256, sha256 } from '@rv/shared-kernel';

/** Raw bytes with their media type. The only image shape that crosses a port. */
export interface ImagePayload {
  /** e.g. `image/png`. Providers disagree about defaults, so it is never inferred. */
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/**
 * An image a provider produced, addressed by content.
 *
 * The hash is computed here rather than by the caller because "no asset is generated
 * twice" (CLAUDE.md #2) depends on every byte stream entering the system already
 * addressed - a caller that forgets to hash silently defeats the registry.
 */
export interface ImageArtifact extends ImagePayload {
  readonly sha256: Sha256;
  /** Pixel dimensions when the provider reported them; `null` when it did not. */
  readonly size: Size | null;
  /** Seed that produced these bytes, when the provider accepts one. */
  readonly seed: number | null;
}

/** Builds an `ImageArtifact`, hashing the bytes exactly once. */
export function toImageArtifact(
  payload: ImagePayload,
  extras: { readonly size?: Size | null; readonly seed?: number | null } = {},
): ImageArtifact {
  return {
    mimeType: payload.mimeType,
    data: payload.data,
    sha256: sha256(payload.data),
    size: extras.size ?? null,
    seed: extras.seed ?? null,
  };
}

/** Raw audio bytes with their media type. The only audio shape that crosses a port. */
export interface AudioPayload {
  /** e.g. `audio/wav`. Engines disagree about defaults, so it is never inferred. */
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/**
 * Audio a provider produced, addressed by content.
 *
 * The hash is what makes a non-deterministic engine safe to depend on. ADR-0008 §1 says
 * providers author and the artefact replays; for speech that is literal - the engine is
 * free to produce something slightly different every time, and the moment it has, the
 * bytes are addressed and a second identical request is a cache hit that spends nothing.
 *
 * `durationMs` is `null` when nobody has measured it. That is deliberately awkward: a
 * cue whose length is guessed mistimes every cue after it on the track, so the type
 * refuses to supply a plausible number. WAV can be measured from its header for free
 * (see `wavDurationMs`); MP3 cannot, and an engine that returns alignment gives the
 * answer another way.
 */
export interface AudioArtifact extends AudioPayload {
  readonly sha256: Sha256;
  readonly durationMs: number | null;
  readonly sampleRateHz: number | null;
}

/** Builds an `AudioArtifact`, hashing the bytes exactly once. */
export function toAudioArtifact(
  payload: AudioPayload,
  extras: { readonly durationMs?: number | null; readonly sampleRateHz?: number | null } = {},
): AudioArtifact {
  return {
    mimeType: payload.mimeType,
    data: payload.data,
    sha256: sha256(payload.data),
    durationMs: extras.durationMs ?? null,
    sampleRateHz: extras.sampleRateHz ?? null,
  };
}

/**
 * What one call consumed, in the units the `CostMeter` prices.
 *
 * Present on every port result, including free ones. A local ComfyUI call reports
 * `images.count = 1` and costs nothing - and the ledger still gets a row, because a
 * ledger that only records paid calls cannot show that the free lane is being used.
 */
export interface ProviderUsage {
  readonly tokens: TokenUsage;
  readonly images: ImageUsage;
  readonly latencyMs: number;
  /**
   * Image-output tokens the provider actually billed, when it reported them.
   *
   * Kept apart from `tokens.output` because the catalogue prices them apart: an image
   * model in `KNOWN_MODELS` carries only `imageOutputPerMTokensUsd`, so folding the
   * two together would charge nothing or charge twice depending on which rate happened
   * to be set. Absent means "the provider did not say", and the meter estimates.
   */
  readonly imageOutputTokens?: number;
  /**
   * Characters sent and audio produced, for a speech call.
   *
   * Optional in the same way `imageOutputTokens` is: absent means this was not a speech
   * call, and the meter must not invent a zero-character charge for every text call in
   * the ledger.
   */
  readonly speech?: SpeechUsage;
}

/** Fields every port result carries, so the meter never has to special-case a port. */
export interface ProviderCallResult {
  readonly modelRef: ModelRef;
  readonly usage: ProviderUsage;
}

export const NO_TOKENS: TokenUsage = { input: 0, output: 0, cached: 0, reasoning: 0 };
export const NO_IMAGES: ImageUsage = { count: 0, resolution: null };

/** Convenience constructor so adapters do not each re-spell the zero case. */
export function usage(
  latencyMs: number,
  parts: { readonly tokens?: Partial<TokenUsage>; readonly images?: Partial<ImageUsage> } = {},
): ProviderUsage {
  return {
    tokens: { ...NO_TOKENS, ...parts.tokens },
    images: { ...NO_IMAGES, ...parts.images },
    latencyMs,
  };
}
