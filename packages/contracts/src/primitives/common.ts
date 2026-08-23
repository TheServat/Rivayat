/**
 * Shared value schemas.
 *
 * These are the vocabulary the rest of the contracts are written in. Keeping them
 * here means a colour, an angle or a duration is validated the same way everywhere,
 * and means the JSON Schema handed to an LLM describes them consistently too.
 */

import { z } from 'zod';

// ── text ────────────────────────────────────────────────────────────────────

export const NonEmptyString = z.string().trim().min(1);
export type NonEmptyString = z.infer<typeof NonEmptyString>;

/** Lowercase, hyphen-separated. Used wherever a name has to be machine-safe. */
export const Slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'expected a lowercase hyphenated slug');
export type Slug = z.infer<typeof Slug>;

/**
 * The library-wide address of a *kind of thing*, e.g. `flora/oak-tree/mature`.
 *
 * This is the stable half of the asset dedup key: two requests for the same
 * semantic key in the same style are the same asset, no matter which episode asked.
 */
export const SemanticKey = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){1,4}$/,
    'expected a `category/name[/qualifier]` path of lowercase slugs',
  )
  .describe('Library address of an asset kind, e.g. "flora/oak-tree/mature"');
export type SemanticKey = z.infer<typeof SemanticKey>;

/** A short human label. Long enough for a name, short enough for a UI chip. */
export const Label = z.string().trim().min(1).max(120);
export type Label = z.infer<typeof Label>;

/** Free prose written for a human or an LLM. */
export const Prose = z.string().trim().min(1).max(20_000);
export type Prose = z.infer<typeof Prose>;

export const Tag = Slug;
export const Tags = z.array(Tag).max(64).default([]);

// ── numbers ─────────────────────────────────────────────────────────────────

/** Normalised 0..1. Opacity, weights, probabilities, intensities. */
export const Unit01 = z.number().min(0).max(1);
export type Unit01 = z.infer<typeof Unit01>;

/** Normalised -1..1. Signed strengths - relationship valence, offsets, bias. */
export const SignedUnit = z.number().min(-1).max(1);
export type SignedUnit = z.infer<typeof SignedUnit>;

export const Degrees = z.number().min(-3600).max(3600);
export type Degrees = z.infer<typeof Degrees>;

export const PositiveInt = z.number().int().positive();
export type PositiveInt = z.infer<typeof PositiveInt>;

export const NonNegativeInt = z.number().int().nonnegative();
export type NonNegativeInt = z.infer<typeof NonNegativeInt>;

/**
 * Integer nano-dollars; 1_000_000_000 = $1.00.
 *
 * A named alias rather than a bare `NonNegativeInt` so that a field holding money is
 * recognisable at the call site, and so a future move to a branded money type has one
 * place to change. See `@rv/shared-kernel/money` for why nano and not micro: at
 * $0.00000025 per token, micro-dollars round a real charge to zero and the ledger
 * quietly reports $0.00 for a run that spent money.
 *
 * It lives here rather than beside the cost ledger because money is not a provider
 * concept - `Provenance` records what an artefact cost, an `AssetResolution` records
 * what a cache miss will cost, and `IntakeOptions` records the ceiling for a whole run.
 * Every one of those was a bare integer until they were counted, which is exactly the
 * drift a named alias exists to prevent.
 */
export const NanoUsdAmount = NonNegativeInt.describe('integer nano-dollars; 1_000_000_000 = $1.00');
export type NanoUsdAmount = z.infer<typeof NanoUsdAmount>;

/** Milliseconds. Every duration and offset in the system is integer milliseconds. */
export const Millis = z.number().int().nonnegative().describe('milliseconds');
export type Millis = z.infer<typeof Millis>;

/**
 * Frames per second.
 *
 * Capped at 120: above that we are not making a film, we are making a mistake, and
 * the frame count would blow up the render budget silently.
 */
export const Fps = z.number().int().min(1).max(120);
export type Fps = z.infer<typeof Fps>;

/** Pixels. Integer, because a half-pixel asset boundary is always a bug. */
export const Pixels = z.number().int();
export type Pixels = z.infer<typeof Pixels>;

export const PositivePixels = z.number().int().positive().max(16_384);
export type PositivePixels = z.infer<typeof PositivePixels>;

// ── geometry ────────────────────────────────────────────────────────────────

export const Vec2 = z.object({ x: z.number(), y: z.number() });
export type Vec2 = z.infer<typeof Vec2>;

export const Size = z.object({ width: PositivePixels, height: PositivePixels });
export type Size = z.infer<typeof Size>;

export const Rect = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type Rect = z.infer<typeof Rect>;

/** A rectangle expressed as fractions of the frame, so it survives any resolution. */
export const NormRect = z.object({
  x: Unit01,
  y: Unit01,
  width: Unit01,
  height: Unit01,
});
export type NormRect = z.infer<typeof NormRect>;

export const Transform2D = z.object({
  position: Vec2.default({ x: 0, y: 0 }),
  rotation: Degrees.default(0),
  scale: Vec2.default({ x: 1, y: 1 }),
  skew: Vec2.default({ x: 0, y: 0 }),
  /** Normalised pivot within the node's own bounds; (0.5, 0.5) is the centre. */
  anchor: z.object({ x: Unit01, y: Unit01 }).default({ x: 0.5, y: 0.5 }),
  opacity: Unit01.default(1),
});
export type Transform2D = z.infer<typeof Transform2D>;

// ── colour ──────────────────────────────────────────────────────────────────

/** `#rgb`, `#rrggbb` or `#rrggbbaa`. */
export const HexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'expected a hex colour');
export type HexColor = z.infer<typeof HexColor>;

export const NamedColor = z.object({
  name: Label,
  hex: HexColor,
  /** What this colour is *for* - the style engine reasons about roles, not swatches. */
  role: z
    .enum(['primary', 'secondary', 'accent', 'neutral', 'highlight', 'shadow', 'background'])
    .optional(),
});
export type NamedColor = z.infer<typeof NamedColor>;

// ── hashes and time ─────────────────────────────────────────────────────────

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha256 hex');
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** Authoring time: a real instant, ISO-8601 with a timezone. */
export const IsoInstant = z.iso.datetime({ offset: true });
export type IsoInstant = z.infer<typeof IsoInstant>;

/**
 * Story time - *when something happened inside the fiction*.
 *
 * Deliberately not a real date. Fiction has its own calendar, or none, and what the
 * continuity engine actually needs is a **total order** so it can ask "was this true
 * at that point". `ordinal` provides that; `label` is for humans only and is never
 * compared.
 *
 * Gaps in `ordinal` are expected and useful - leave room to insert a flashback
 * between two existing beats without renumbering the series.
 */
export const StoryTime = z.object({
  /** Monotonic position on the series timeline. Larger is later. */
  ordinal: z.number().int(),
  /** Display only, e.g. "Year 1204, first thaw". Never parsed, never compared. */
  label: Label.optional(),
});
export type StoryTime = z.infer<typeof StoryTime>;

/**
 * A half-open story-time interval. `null` on either end means unbounded:
 * `from: null` = "since before the story began", `until: null` = "still true".
 */
export const StoryInterval = z.object({
  from: StoryTime.nullable(),
  until: StoryTime.nullable(),
});
export type StoryInterval = z.infer<typeof StoryInterval>;

// ── provenance ──────────────────────────────────────────────────────────────

/**
 * How a piece of data came to exist.
 *
 * Attached to everything generated. It is what makes a run reproducible, a cost
 * auditable, and a bad output traceable to the prompt and model that produced it.
 */
export const Provenance = z.object({
  source: z.enum(['author', 'llm', 'image-model', 'derived', 'imported', 'inferred']),
  /** Provider + model, e.g. `openrouter:google/gemini-3.1-flash-lite-image`. */
  model: z.string().optional(),
  promptHash: Sha256Hex.optional(),
  seed: z.number().int().optional(),
  /** Ids of the artefacts this was derived from. */
  parents: z.array(z.string()).default([]),
  createdAt: IsoInstant,
  /** Cost of producing this artefact, in nano-dollars. */
  costNanoUsd: NanoUsdAmount.default(0),
});
export type Provenance = z.infer<typeof Provenance>;

/** Confidence in an inferred fact. 1 for anything an author stated directly. */
export const Confidence = Unit01;

// ── the semantic index ──────────────────────────────────────────────────────

/**
 * Which model produced a vector, in the `provider:model` form `Provenance.model` uses.
 *
 * Recorded next to every embedding because **vectors from different models are not
 * comparable**. Cosine distance between a `nomic-embed-text` vector and a
 * `mxbai-embed-large` vector is a number, it is just not a similarity - so mixing them
 * in one index does not fail, it silently degrades recall, and the symptom is "the
 * registry stopped finding the oak tree" months after the model was swapped.
 */
export const EmbeddingModel = NonEmptyString.max(200).describe(
  'Provider and model that produced the vector, e.g. "ollama:nomic-embed-text".',
);
export type EmbeddingModel = z.infer<typeof EmbeddingModel>;

/**
 * The vector and its model, as one shape fragment.
 *
 * Spread into anything that is semantically searchable. A fragment rather than a nested
 * object because storage wants two flat columns (`embedding`, `embedding_model`) and a
 * nested document would have to be shredded on every write.
 *
 * Both are optional, and absent is the honest encoding of "never indexed": an asset or
 * a fact exists the moment it is written and is embedded afterwards, by a separate pass
 * that may not have run, may have failed, or may be waiting on a local model to load.
 * An empty array would say "indexed, and the vector is empty", which is a different and
 * much worse claim.
 */
export const embeddingShape = {
  embedding: z
    .array(z.number())
    .max(4096)
    .optional()
    .describe(
      'Machine-populated semantic vector. Leave it out; the indexing pass fills it. Never author one by hand.',
    ),
  embeddingModel: EmbeddingModel.optional().describe(
    'The model that produced `embedding`. Present exactly when `embedding` is - a vector nobody can attribute cannot be compared against anything.',
  ),
} as const;

export const Embedded = z.strictObject(embeddingShape);
export type Embedded = z.infer<typeof Embedded>;

/**
 * "Present exactly when the other is", enforced rather than described.
 *
 * The pair is the unit: a vector with no model is unusable, because the reader cannot
 * tell whether comparing it to the next vector is meaningful, and a model with no
 * vector is a row that claims to be indexed and is not. Neither half of that survives
 * into the JSON Schema, and neither is caught by anything downstream - an unattributable
 * vector ranks perfectly happily, just wrongly.
 *
 * One function rather than a copy per carrier, for the same reason
 * `checkBiTemporalOrder` is one function: the second copy is where the two halves of
 * the condition get swapped.
 */
export function checkEmbeddingPair(value: Embedded, ctx: z.RefinementCtx): void {
  if (value.embedding !== undefined && value.embeddingModel === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['embeddingModel'],
      message: 'an embedding must name the model that produced it',
    });
  }
  if (value.embedding === undefined && value.embeddingModel !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['embedding'],
      message: 'an embedding model without a vector claims an index entry that does not exist',
    });
  }
}

// ── i18n ────────────────────────────────────────────────────────────────────

export const Locale = z.enum(['fa', 'en']);
export type Locale = z.infer<typeof Locale>;

/**
 * Text in both supported locales.
 *
 * Persian is required because it is the default UI locale; English is optional so a
 * Persian-only project is not forced to produce filler translations.
 */
export const LocalisedText = z.object({
  fa: NonEmptyString,
  en: NonEmptyString.optional(),
});
export type LocalisedText = z.infer<typeof LocalisedText>;
