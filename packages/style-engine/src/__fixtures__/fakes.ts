/**
 * Test doubles.
 *
 * Every one of them is a hand-written fake rather than a mocking-library stub, for the
 * reason CLAUDE.md gives about tests: a fake that has to satisfy the real interface
 * fails to compile when the interface changes, and a mock silently keeps passing.
 *
 * There is no network here and no fixture recording. The provider contract suite in
 * `@rv/providers` is where real adapter behaviour is pinned; this package only needs
 * ports that behave.
 */

import { type ImageUsage, type ModelRef, ProviderKind, type TokenUsage } from '@rv/contracts';
import type {
  ImageCostQuote,
  ImageCostRequest,
  ImageGenerationPort,
  ImageGenerationRequest,
  ImagePayload,
  ImageResult,
  ProviderUsage,
  VisionScoringPort,
  VisionScoringRequest,
  VisionScoringResult,
} from '@rv/providers';
import { UNPRICED, pricingFor, quoteImageCall, toImageArtifact } from '@rv/providers';
import type { CompletionRequest, CompletionResponse, StructuredBackend } from '@rv/prompt-kit';
import {
  type AppError,
  FixedClock,
  IdGenerator,
  type Result,
  ProviderError,
  err,
  instant,
  isErr,
  ok,
} from '@rv/shared-kernel';
import { type StyleBible, Ids } from '@rv/contracts';
import { lock } from '@rv/core-domain';

import type { RasterPort, RgbaImage } from '../ports/raster';
import { materialiseStyleBible } from '../style-bible-factory';
import type { StylePreset } from '../presets/preset';

export const TEST_INSTANT = instant(1_756_000_000_000);

export function testClock(): FixedClock {
  return new FixedClock(TEST_INSTANT);
}

/** Deterministic ids, so a materialised bible is byte-stable across runs. */
export function testIds(startMs = 1_756_000_000_000): Ids {
  let counter = 0;
  return new Ids(
    new IdGenerator(new FixedClock(instant(startMs)), (size) => {
      counter += 1;
      return Uint8Array.from({ length: size }, (_, index) => (counter * 31 + index * 17) & 0xff);
    }),
  );
}

const NO_TOKEN_USAGE: TokenUsage = { input: 0, output: 0, cached: 0, reasoning: 0 };

function imageUsage(count: number, width: number, height: number): ImageUsage {
  return { count, resolution: { width, height } };
}

/** Bytes that differ per tag, so `sha256` gives each fake reference a distinct anchor hash. */
export function imagePayload(tag: string, mimeType = 'image/png'): ImagePayload {
  const bytes = Uint8Array.from(
    { length: 32 },
    (_, index) => (tag.charCodeAt(index % tag.length) + index) & 0xff,
  );
  return { mimeType, data: bytes };
}

/**
 * An RGBA buffer of vertical stripes.
 *
 * Stripes rather than a solid fill so that palette extraction has something to cluster
 * and adherence has a mix to average, and so the expected answer is arithmetic rather
 * than a golden file.
 */
export function stripedImage(
  colours: readonly (readonly [number, number, number])[],
  options: { width?: number; height?: number; alpha?: number } = {},
): RgbaImage {
  const width = options.width ?? 64;
  const height = options.height ?? 64;
  const alpha = options.alpha ?? 255;
  const data = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = Math.min(
        colours.length - 1,
        Math.floor((x / width) * Math.max(1, colours.length)),
      );
      const colour = colours[index] ?? ([0, 0, 0] as const);
      const offset = (y * width + x) * 4;
      data[offset] = colour[0];
      data[offset + 1] = colour[1];
      data[offset + 2] = colour[2];
      data[offset + 3] = alpha;
    }
  }
  return { width, height, data };
}

/** Replays decoded images in order; the last one repeats once the script runs out. */
export class FakeRaster implements RasterPort {
  readonly calls: ImagePayload[] = [];
  #index = 0;

  constructor(private readonly script: readonly Result<RgbaImage, AppError>[]) {}

  decode(image: ImagePayload): Promise<Result<RgbaImage, AppError>> {
    this.calls.push(image);
    const entry = this.script[Math.min(this.#index, this.script.length - 1)];
    this.#index += 1;
    return Promise.resolve(
      entry ?? err(new ProviderError({ provider: 'fake-raster', message: 'no script' })),
    );
  }
}

export interface FakeImagePortOptions {
  readonly modelRef?: ModelRef;
  /** Replayed per call; the last entry repeats. `null` produces an empty image list. */
  readonly script?: readonly (AppError | null | undefined)[];
  /**
   * Overrides the quote this port answers with.
   *
   * Omitted, the fake quotes from the real catalogue for its own `modelRef`, exactly as a
   * real adapter does - so a test that asserts on a projected cost is asserting against
   * the price the shipped table holds and not against a number invented here.
   */
  readonly quote?: ImageCostQuote;
}

/** Returns one deterministic tile per call and records exactly what it was asked for. */
export class FakeImagePort implements ImageGenerationPort {
  readonly requests: ImageGenerationRequest[] = [];
  /** Every quote asked for, in order. A guard is only real if it is consulted. */
  readonly quotes: ImageCostRequest[] = [];
  readonly #modelRef: ModelRef;
  readonly #script: readonly (AppError | null | undefined)[];
  readonly #quote: ImageCostQuote | undefined;
  #index = 0;

  constructor(options: FakeImagePortOptions = {}) {
    this.#modelRef = options.modelRef ?? 'comfyui:sd1.5-lcm';
    this.#script = options.script ?? [];
    this.#quote = options.quote;
  }

  /**
   * Priced from the shipped catalogue, like a real adapter.
   *
   * Deliberately not a stub returning zero: `quoteImage` exists so a budget guard can run
   * before the spend, and a fake that always says "free" would let every test pass while
   * the guard was handed a number that means nothing.
   */
  quoteImage(request: ImageCostRequest): ImageCostQuote {
    this.quotes.push(request);
    if (this.#quote !== undefined) return this.#quote;

    // `ModelRef` is `provider:model`; the catalogue is keyed on the two halves.
    const separator = this.#modelRef.indexOf(':');
    const provider = ProviderKind.safeParse(this.#modelRef.slice(0, separator));
    const pricing = provider.success
      ? pricingFor(provider.data, this.#modelRef.slice(separator + 1))
      : UNPRICED;
    return quoteImageCall(this.#modelRef, pricing, request);
  }

  generateImage(request: ImageGenerationRequest): Promise<Result<ImageResult, AppError>> {
    this.requests.push(request);
    const entry = this.#script[this.#index];
    this.#index += 1;

    if (entry instanceof Error) return Promise.resolve(err(entry));

    const width = request.size?.width ?? 512;
    const height = request.size?.height ?? 512;
    const usage: ProviderUsage = {
      tokens: NO_TOKEN_USAGE,
      images: imageUsage(1, width, height),
      latencyMs: 1420,
    };

    if (entry === null) {
      return Promise.resolve(ok({ modelRef: this.#modelRef, usage, images: [] }));
    }

    const bytes = Uint8Array.from(
      { length: 16 },
      (_, index) => (this.requests.length * 7 + index) & 0xff,
    );
    return Promise.resolve(
      ok({
        modelRef: this.#modelRef,
        usage,
        images: [
          toImageArtifact(
            { mimeType: 'image/png', data: bytes },
            { size: { width, height }, seed: request.seed ?? null },
          ),
        ],
      }),
    );
  }
}

export interface FakeVisionPortOptions {
  /** Score returned for every criterion the rubric asks about. */
  readonly score?: number;
  /** Criteria to leave unanswered, to exercise the "scorer did not answer" path. */
  readonly omit?: readonly string[];
  readonly failure?: AppError;
  readonly modelRef?: ModelRef;
}

export class FakeVisionPort implements VisionScoringPort {
  readonly requests: VisionScoringRequest[] = [];

  constructor(private readonly options: FakeVisionPortOptions = {}) {}

  score(request: VisionScoringRequest): Promise<Result<VisionScoringResult, AppError>> {
    this.requests.push(request);
    if (this.options.failure !== undefined) return Promise.resolve(err(this.options.failure));

    const value = this.options.score ?? 0.8;
    const omit = new Set(this.options.omit ?? []);
    const scores = request.rubric
      .filter((criterion) => !omit.has(criterion.key))
      .map((criterion) => ({
        key: criterion.key,
        score: value,
        reason: `stub answer for ${criterion.key}`,
      }));

    return Promise.resolve(
      ok({
        modelRef: this.options.modelRef ?? 'ollama:qwen3.5:latest',
        usage: {
          tokens: { input: 500, output: 80, cached: 0, reasoning: 0 },
          images: { count: 0, resolution: null },
          latencyMs: 900,
        },
        scores,
        overall: value,
      }),
    );
  }
}

/**
 * A structured backend that replays a fixed script of raw model text.
 *
 * Scripted rather than stubbed because the interesting behaviour of `StructuredCall` is
 * what it does across a *sequence* of bad responses - the repair path is the one worth
 * testing, and it only exists over more than one turn.
 */
export class ScriptedBackend implements StructuredBackend {
  readonly requests: CompletionRequest[] = [];
  #index = 0;

  constructor(
    readonly id: string,
    private readonly script: readonly (string | AppError)[],
    readonly enforcesSchema = false,
    readonly dialect: 'ollama' | 'gemini' | 'openai-strict' | 'plain' = 'ollama',
  ) {}

  complete(request: CompletionRequest): Promise<Result<CompletionResponse, AppError>> {
    this.requests.push(request);
    const entry = this.script[Math.min(this.#index, this.script.length - 1)];
    this.#index += 1;
    if (entry === undefined)
      return Promise.resolve(
        err(new ProviderError({ provider: this.id, message: 'empty script' })),
      );
    if (typeof entry !== 'string') return Promise.resolve(err(entry));
    return Promise.resolve(
      ok({
        text: entry,
        modelId: this.id,
        usage: { inputTokens: 900, outputTokens: 300 },
        costNanoUsd: 0,
      }),
    );
  }
}

/** A preset materialised into a bible and locked, ready for anything that generates. */
export function lockedBibleFrom(preset: StylePreset): StyleBible {
  const clock = testClock();
  const bible = materialiseStyleBible({
    draft: preset.draft,
    id: testIds().styleBible(),
    clock,
  });
  const locked = lock(bible, '2026-08-23T00:00:00.000Z');
  if (isErr(locked)) throw locked.error;
  return locked.value;
}

/** The same bible, left unlocked, for asserting that the generation guard bites. */
export function unlockedBibleFrom(preset: StylePreset): StyleBible {
  return materialiseStyleBible({
    draft: preset.draft,
    id: testIds().styleBible(),
    clock: testClock(),
  });
}
