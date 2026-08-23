/**
 * What each provider can do, what it costs, and which model gets a given job.
 *
 * Three concerns share this file on purpose, because they are the three inputs to a
 * single decision:
 *
 *  - **Capabilities** exist so the router can refuse a route *before* an adapter
 *    throws `UnsupportedCapabilityError`. If the matrix and an adapter ever disagree,
 *    that error firing is the alarm.
 *  - **Pricing** exists so the budget guard can run before the call rather than after
 *    the invoice (CLAUDE.md non-negotiable #3). Rates are kept as the provider quoted
 *    them - strings - because parsing to a float on the way in throws away digits the
 *    ledger later needs.
 *  - **Routing** exists so the owner can pin any pipeline stage to any model without a
 *    code change. That is the "story model is user-selectable" requirement from
 *    research 1, generalised to every stage by architecture 5.
 *
 * `KNOWN_MODELS` at the bottom is *seed* data, not the catalogue. OpenRouter's
 * `/api/v1/models` is synced live at runtime; this table is what the app knows while
 * offline, what the tests pin against drift, and the record of which prices research
 * 1-2 actually verified on 2026-08-23.
 */

import { z } from 'zod';

import {
  Label,
  Millis,
  NanoUsdAmount,
  NonEmptyString,
  PositiveInt,
  Prose,
  Size,
  Unit01,
} from '../primitives/common';
import { ProjectId } from '../primitives/ids';

// ── providers and capabilities ──────────────────────────────────────────────

/**
 * The provider families we have adapters for (architecture 5).
 *
 * `openai-compatible` is the escape hatch for a self-hosted or third-party endpoint
 * that speaks the OpenAI wire format. It is deliberately separate from `ollama`:
 * Ollama *has* an OpenAI shim, and research 1 records that the shim is exactly what
 * breaks structured output. Reaching Ollama through `openai-compatible` would
 * re-introduce the defect.
 */
export const ProviderKind = z.enum([
  'ollama',
  'gemini',
  'openrouter',
  'comfyui',
  'pollinations',
  'openai-compatible',
]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/**
 * One member per narrow port in architecture 5.
 *
 * The one-to-one correspondence is the point: an adapter declares the subset of ports
 * it implements and the router routes around the rest. Adding a port means adding a
 * member here first, which is what stops the capability matrix and the port set from
 * drifting apart.
 */
export const Capability = z.enum([
  'text-generation',
  'structured-generation',
  'image-generation',
  'image-edit',
  'vision-scoring',
  'embedding',
]);
export type Capability = z.infer<typeof Capability>;

/**
 * What a model accepts and what it emits.
 *
 * Tracked separately from `Capability` because the two answer different questions:
 * Gemini image models are `text+image -> text+image` (research 2), which is what makes
 * them editors rather than only generators.
 */
export const Modality = z.enum(['text', 'image', 'audio']);
export type Modality = z.infer<typeof Modality>;

/** Provider-native model id, verbatim - `qwen3.5:latest`, `google/gemini-3-pro-image`. */
export const ProviderModelId = NonEmptyString.max(200).describe(
  'Provider-native model id, exactly as the provider spells it',
);
export type ProviderModelId = z.infer<typeof ProviderModelId>;

/**
 * `provider:model`, the form that lands in `Provenance.model`.
 *
 * A bare model id is ambiguous once the same slug is reachable through two providers -
 * `google/gemini-2.5-flash-image` via OpenRouter and via Gemini direct bill
 * differently - and a cost ledger that cannot tell them apart cannot be audited.
 */
export const ModelRef = z
  .string()
  .regex(/^[a-z][a-z0-9-]*:.+$/, 'expected a `provider:model` reference')
  .describe('Fully qualified model reference, e.g. "openrouter:google/gemini-3-pro-image"');
export type ModelRef = z.infer<typeof ModelRef>;

/** Builds the canonical `provider:model` reference. The only sanctioned way to spell one. */
export function modelRef(provider: ProviderKind, model: ProviderModelId): ModelRef {
  return `${provider}:${model}`;
}

// ── pricing ─────────────────────────────────────────────────────────────────

/**
 * A price kept as the provider quoted it.
 *
 * OpenRouter's `/api/v1/models` returns rates as decimal strings, some with more
 * significant digits than a readable numeric literal holds. Parsing at the boundary of
 * a *calculation* (see `priceFor` in `@rv/shared-kernel/money`) is fine; parsing on the
 * way into storage is not, because the stored value is then a rounded copy of the
 * source of truth and nothing downstream can tell.
 */
export const PriceString = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/, 'expected a non-negative decimal price string');
export type PriceString = z.infer<typeof PriceString>;

/**
 * What one model costs, in the units its provider bills in.
 *
 * Token rates are per **million** tokens because that is how every vendor page and the
 * OpenRouter catalogue quote them. Converting to per-token here would mean the table
 * no longer reads like the source it was copied from, which is how a transcription
 * error survives review.
 */
export const Pricing = z.strictObject({
  /** USD per 1M input tokens. `null` when the provider does not publish one. */
  inputPerMTokensUsd: PriceString.nullable(),
  /** USD per 1M output tokens. `null` when the provider does not publish one. */
  outputPerMTokensUsd: PriceString.nullable(),
  /**
   * USD per 1M **image-output** tokens - the unit Google and OpenRouter actually bill
   * generated images in. `null` for a model that cannot emit an image.
   */
  imageOutputPerMTokensUsd: PriceString.nullable(),
  /**
   * Worked example: USD for one ~1024px image at the rate above.
   *
   * Set only where research 2 quotes a single figure. Models whose cost moves with
   * output resolution carry the range in `note` instead - a single number there would
   * read as a guarantee and be wrong at 4K.
   */
  approxPerImageUsd: PriceString.nullable(),
  /** True only when the call costs nothing: local inference, or a genuine free tier. */
  free: z.boolean(),
  /** Verbatim caveat from the source, e.g. a price range across output resolutions. */
  note: Label.optional(),
});
export type Pricing = z.infer<typeof Pricing>;

/**
 * One-line price summary for a model picker or a spend-confirmation screen.
 *
 * Exists so no UI has to decide for itself how to render a missing rate. "Not
 * published" and "free" mean very different things to someone about to approve a run,
 * and rendering both as `$0.00` is how a bill goes unnoticed.
 */
export function describePricing(pricing: Pricing): string {
  if (pricing.free) return 'free';

  const parts: string[] = [];
  if (pricing.inputPerMTokensUsd !== null) parts.push(`$${pricing.inputPerMTokensUsd}/1M in`);
  if (pricing.outputPerMTokensUsd !== null) parts.push(`$${pricing.outputPerMTokensUsd}/1M out`);
  if (pricing.imageOutputPerMTokensUsd !== null) {
    parts.push(`$${pricing.imageOutputPerMTokensUsd}/1M image-output tokens`);
  }
  if (pricing.approxPerImageUsd !== null) parts.push(`~$${pricing.approxPerImageUsd}/image`);
  if (pricing.note !== undefined) parts.push(pricing.note);

  return parts.length > 0 ? parts.join(' - ') : 'price not published';
}

// ── tasks, tiers and stages ─────────────────────────────────────────────────

/**
 * The unit of work a model is asked to do.
 *
 * Deliberately finer-grained than the pipeline stage: one stage issues several kinds
 * of call - S3 Cast writes prose *and* composes image prompts - and they do not want
 * the same model. Routing keys off the task; budgeting reports on both.
 */
export const TaskKind = z.enum([
  'story-outline',
  'scene-write',
  'character-sheet',
  'style-derive',
  'asset-spec',
  'prompt-compose',
  'continuity-check',
  'image-draft',
  'image-final',
  'image-edit',
  'vision-score',
  'embed',
]);
export type TaskKind = z.infer<typeof TaskKind>;

/**
 * How good the output has to be *this time*.
 *
 * The tier is what makes the free local lane usable: research 0 concludes
 * "local = free draft lane, cloud = paid final lane", and the tier is where that
 * decision is expressed instead of being hard-coded at each call site.
 *
 * The same three words as `QualityTarget` in `asset/asset-spec.ts`, which is the
 * fidelity an *artefact* was made at rather than the standard *one call* is held to -
 * see that type for why they are not merged, and `asset.spec.ts` for the assertion that
 * keeps their option lists identical.
 */
export const QualityTier = z.enum(['draft', 'preview', 'final']);
export type QualityTier = z.infer<typeof QualityTier>;

/** How to break a tie between candidate models that all satisfy the tier. */
export const RoutingPolicy = z.enum(['cheapest', 'balanced', 'best']);
export type RoutingPolicy = z.infer<typeof RoutingPolicy>;

/**
 * The pipeline stages of architecture 4, in order (S0 Intake .. S11 Deliver).
 *
 * Named here rather than beside the pipeline because routing and cost accounting both
 * key off it, and both sit below the pipeline in the dependency graph.
 */
export const PipelineStageKey = z.enum([
  'intake',
  'style',
  'story',
  'cast',
  'world',
  'resolve',
  'produce',
  'sequence',
  'choreograph',
  'preview',
  'render',
  'deliver',
]);
export type PipelineStageKey = z.infer<typeof PipelineStageKey>;

// ── model descriptors ───────────────────────────────────────────────────────

/**
 * The knobs a call is made with.
 *
 * Every field is optional because the meaningful default differs per provider, and a
 * schema that invented one would silently override an adapter that knew better.
 */
export const CallParams = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  topP: Unit01.optional(),
  maxOutputTokens: PositiveInt.optional(),
  /** Fixed seed. Determinism is non-negotiable (CLAUDE.md #1); an unseeded call is a bug. */
  seed: z.number().int().nonnegative().optional(),
  stopSequences: z.array(NonEmptyString).max(8).optional(),
  /** Ollama's `think` flag. Research 1: `false` for extraction, or reasoning leaks into the JSON. */
  think: z.boolean().optional(),
  timeoutMs: Millis.optional(),
  /** Image jobs only. */
  imageSize: Size.optional(),
  /** Image jobs only. */
  imageCount: PositiveInt.max(8).optional(),
});
export type CallParams = z.infer<typeof CallParams>;

/**
 * Everything the router needs to know about one model.
 *
 * The checks at the bottom are not belt-and-braces. They encode the two findings from
 * research 2 that keep being re-derived incorrectly - that no OpenRouter `:free` model
 * emits images, and that a free model therefore cannot carry an image price. As
 * validation, a future catalogue sync claiming otherwise fails loudly instead of
 * quietly routing the final render to a model that returns text.
 */
export const ModelDescriptor = z
  .strictObject({
    provider: ProviderKind,
    id: ProviderModelId,
    label: Label,
    capabilities: z.array(Capability).min(1),
    /**
     * Maximum input tokens, or `null` when the provider does not publish it.
     *
     * `null` is a real answer, not a placeholder: the router must then be conservative
     * rather than assume a number nobody verified. The OpenRouter catalogue sync fills
     * these in at runtime.
     */
    contextWindow: PositiveInt.nullable(),
    maxOutputTokens: PositiveInt.nullable(),
    /**
     * Whether the provider enforces a JSON Schema server-side.
     *
     * `false` means "we do not trust it", and that is the safe default: research 1
     * documents Ollama returning fenced or schema-violating JSON for `qwen3.5` and
     * `gemma4`. Either way the call goes through `StructuredCall` (CLAUDE.md #6); this
     * flag only predicts whether the repair loop will have to earn its keep.
     */
    enforcesJsonSchema: z.boolean(),
    /**
     * Whether the model accepts reference images alongside the prompt.
     *
     * This is what buys character consistency without training a LoRA (research 3), so
     * it is a hard routing input for every `image-final` call, not a nice-to-have.
     */
    acceptsReferenceImages: z.boolean(),
    inputModalities: z.array(Modality).min(1),
    outputModalities: z.array(Modality).min(1),
    pricing: Pricing,
    notes: Prose.optional(),
  })
  .superRefine((model, ctx) => {
    const emitsImages =
      model.capabilities.includes('image-generation') || model.capabilities.includes('image-edit');

    if (emitsImages && !model.outputModalities.includes('image')) {
      ctx.addIssue({
        code: 'custom',
        message: 'a model with an image capability must declare `image` output',
        path: ['outputModalities'],
      });
    }

    if (emitsImages && model.pricing.imageOutputPerMTokensUsd === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a model that emits images must carry an image-output price',
        path: ['pricing', 'imageOutputPerMTokensUsd'],
      });
    }

    // research 2 [live]: zero OpenRouter models with the `:free` suffix produce images.
    if (model.id.endsWith(':free')) {
      if (!model.pricing.free) {
        ctx.addIssue({
          code: 'custom',
          message: 'a `:free` model must be priced as free',
          path: ['pricing', 'free'],
        });
      }
      if (emitsImages || model.outputModalities.includes('image')) {
        ctx.addIssue({
          code: 'custom',
          message: 'no OpenRouter `:free` model produces image output (research 2)',
          path: ['capabilities'],
        });
      }
    }

    // A free tier quoting a nonzero rate is a contradiction. This is also what keeps
    // "Gemini image models have no free tier" (research 2) from being re-asserted.
    if (model.pricing.free) {
      const rates = [
        model.pricing.inputPerMTokensUsd,
        model.pricing.outputPerMTokensUsd,
        model.pricing.imageOutputPerMTokensUsd,
      ];
      if (rates.some((rate) => rate !== null && Number.parseFloat(rate) !== 0)) {
        ctx.addIssue({
          code: 'custom',
          message: 'a model priced as free cannot quote a nonzero rate',
          path: ['pricing'],
        });
      }
    }
  });
export type ModelDescriptor = z.infer<typeof ModelDescriptor>;

// ── routing ─────────────────────────────────────────────────────────────────

/** A resolved choice: this task, at this tier, goes to this model with these params. */
export const ModelBinding = z.strictObject({
  task: TaskKind,
  tier: QualityTier,
  provider: ProviderKind,
  model: ProviderModelId,
  params: CallParams.default({}),
});
export type ModelBinding = z.infer<typeof ModelBinding>;

/**
 * When to give up on a model rather than keep paying for the same failure.
 *
 * Whether a retry could work at all is decided by the error's `retryable` flag
 * (`@rv/shared-kernel/errors`), never by string-matching a provider message.
 * `failoverOn` decides which error *kinds* skip straight to the next link in the chain
 * instead of backing off in place.
 */
export const FailoverPolicy = z.strictObject({
  maxAttemptsPerModel: PositiveInt.max(10).default(3),
  initialBackoffMs: Millis.default(500),
  backoffMultiplier: z.number().min(1).max(10).default(2),
  maxBackoffMs: Millis.default(30_000),
  /** Fraction of the delay to randomise, so parallel jobs do not retry in lockstep. */
  jitter: Unit01.default(0.2),
  /** Mirrors the relevant members of `ErrorKind`. `unsupported` can never be retried in place. */
  failoverOn: z
    .array(z.enum(['rate-limit', 'timeout', 'provider', 'unsupported']))
    .default(['rate-limit', 'timeout', 'provider', 'unsupported']),
});
export type FailoverPolicy = z.infer<typeof FailoverPolicy>;

/**
 * How one `(task, tier, policy)` triple resolves.
 *
 * The chain is ordered and non-empty. Non-empty because a rule that resolves to
 * nothing is a routing hole, and the only escape from one at runtime is for the router
 * to invent a model - precisely the behaviour the capability matrix exists to prevent.
 */
export const RoutingRule = z.strictObject({
  task: TaskKind,
  tier: QualityTier,
  policy: RoutingPolicy,
  /** `chain[0]` is preferred; each subsequent entry is the next fallback. */
  chain: z.array(ModelBinding).min(1).max(8),
  /** Refuse any candidate whose pre-call estimate exceeds this, in nano-dollars. */
  maxCostPerCallNanoUsd: NanoUsdAmount.nullable().default(null),
});
export type RoutingRule = z.infer<typeof RoutingRule>;

/**
 * A user's pin for one pipeline stage.
 *
 * The owner's stated requirement is that the story model is selectable; architecture 5
 * generalises it to every stage, because "cheap local model for bulk extraction,
 * strong cloud model for the creative beats" (research 1) is a per-stage judgement
 * only the author can make.
 */
export const StageOverride = z.strictObject({
  stage: PipelineStageKey,
  provider: ProviderKind,
  model: ProviderModelId,
  tier: QualityTier.optional(),
  params: CallParams.optional(),
  /**
   * `true` pins absolutely - the stage fails rather than silently running on a model
   * the author did not choose. `false` lets the rule's failover chain take over, which
   * is what a cost preference wants and what a creative preference does not.
   */
  pinned: z.boolean().default(true),
});
export type StageOverride = z.infer<typeof StageOverride>;

/** The whole routing brain, serialisable so a run can record exactly how it was routed. */
export const RouterConfig = z.strictObject({
  /** `null` is the workspace-wide default a project inherits until it overrides it. */
  projectId: ProjectId.nullable(),
  defaultPolicy: RoutingPolicy.default('balanced'),
  rules: z.array(RoutingRule).default([]),
  /** Per-stage user pins. Wins over `rules`. */
  stageOverrides: z.partialRecord(PipelineStageKey, StageOverride).default({}),
  /** Per-task pins, for the stages that issue more than one kind of call. */
  taskOverrides: z.partialRecord(TaskKind, ModelBinding).default({}),
  failover: FailoverPolicy.default({
    maxAttemptsPerModel: 3,
    initialBackoffMs: 500,
    backoffMultiplier: 2,
    maxBackoffMs: 30_000,
    jitter: 0.2,
    failoverOn: ['rate-limit', 'timeout', 'provider', 'unsupported'],
  }),
});
export type RouterConfig = z.infer<typeof RouterConfig>;

// ── verified catalogue ──────────────────────────────────────────────────────

/**
 * The three facts from research 1-2 that get re-derived wrongly most often.
 *
 * They live as data rather than prose so a test can assert them and `KNOWN_MODELS` can
 * be checked against them. All three were verified live on 2026-08-23.
 */
export const FREE_TIER_FACTS = {
  /** OpenRouter models carrying the `:free` suffix [live]. Research 1 names only four of them. */
  openRouterFreeModelCount: 18,
  /** Zero of them emit images - the free pool is text/vision only. */
  openRouterFreeModelsProduceImages: false,
  /** Google's image models are not on the Gemini free tier; only the *text* Flash models are. */
  geminiImageModelsHaveFreeTier: false,
} as const;

/**
 * Seed catalogue: the models research 1-2 actually verified, with their real prices.
 *
 * Four deliberate omissions, each because filling the gap would mean inventing:
 *
 *  - Only four of the eighteen OpenRouter `:free` models appear, because research 1
 *    names only four. The rest arrive through the live `/api/v1/models` sync.
 *  - No Pollinations entry: research names the provider as a keyless lowest-tier
 *    fallback but names no model, and a made-up id is worse than an absent one.
 *  - `contextWindow` and `maxOutputTokens` are `null` wherever research is silent.
 *  - `Imagen 4` is absent on purpose - deprecated, shut down 2026-08-17 (research 2).
 */
export const KNOWN_MODELS: readonly ModelDescriptor[] = [
  // ── Ollama, local: the free draft lane (research 0) ──────────────────────
  {
    provider: 'ollama',
    id: 'qwen3.5:latest',
    label: 'Qwen 3.5 (local)',
    capabilities: ['text-generation', 'structured-generation'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
    pricing: {
      inputPerMTokensUsd: '0',
      outputPerMTokensUsd: '0',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: true,
    },
    notes:
      'Ollama issue #15540: the OpenAI-compatible endpoint does not enforce JSON Schema for this model. Use the native /api/chat with `format`, and never outside StructuredCall.',
  },
  {
    provider: 'ollama',
    id: 'gemma4:26b',
    label: 'Gemma 4 26B (local)',
    capabilities: ['text-generation', 'structured-generation'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
    pricing: {
      inputPerMTokensUsd: '0',
      outputPerMTokensUsd: '0',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: true,
    },
    notes: 'Same schema-enforcement defect as qwen3.5 (research 1). 17 GB on disk.',
  },
  {
    provider: 'ollama',
    id: 'qwen2.5:7b',
    label: 'Qwen 2.5 7B (local)',
    capabilities: ['text-generation', 'structured-generation', 'embedding'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
    pricing: {
      inputPerMTokensUsd: '0',
      outputPerMTokensUsd: '0',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: true,
    },
  },
  {
    provider: 'ollama',
    id: 'qwen3:1.7b',
    label: 'Qwen 3 1.7B (local)',
    capabilities: ['text-generation', 'structured-generation', 'embedding'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
    pricing: {
      inputPerMTokensUsd: '0',
      outputPerMTokensUsd: '0',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: true,
    },
    notes:
      "Ollama's /api/embed accepts any resident model; the smallest one is the sane default for the asset registry's semantic index.",
  },
  {
    provider: 'ollama',
    id: 'aya-expanse:8b',
    label: 'Aya Expanse 8B (local)',
    capabilities: ['text-generation', 'structured-generation'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
    pricing: {
      inputPerMTokensUsd: '0',
      outputPerMTokensUsd: '0',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: true,
    },
    notes: 'Multilingual - the local candidate for Persian-language drafting.',
  },
  {
    provider: 'ollama',
    id: 'llama3.2:latest',
    label: 'Llama 3.2 (local)',
    capabilities: ['text-generation', 'structured-generation'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
    pricing: {
      inputPerMTokensUsd: '0',
      outputPerMTokensUsd: '0',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: true,
    },
  },

  // ── Gemini: free *text* tiers only (research 1, 2) ───────────────────────
  {
    provider: 'gemini',
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    capabilities: ['text-generation', 'structured-generation', 'vision-scoring'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: true,
    acceptsReferenceImages: false,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    pricing: {
      inputPerMTokensUsd: '0',
      outputPerMTokensUsd: '0',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: true,
      note: 'Free of charge on the Gemini free tier (text only)',
    },
  },
  {
    provider: 'gemini',
    id: 'gemini-3-flash',
    label: 'Gemini 3 Flash',
    capabilities: ['text-generation', 'structured-generation', 'vision-scoring'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: true,
    acceptsReferenceImages: false,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    pricing: {
      inputPerMTokensUsd: '0',
      outputPerMTokensUsd: '0',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: true,
      note: 'Free of charge on the Gemini free tier (text only)',
    },
  },

  // ── OpenRouter free pool: text/vision, never image (research 1, 2) ───────
  {
    provider: 'openrouter',
    id: 'z-ai/glm-5.2:free',
    label: 'GLM 5.2 (free)',
    capabilities: ['text-generation', 'structured-generation'],
    contextWindow: 256_000,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
    pricing: {
      inputPerMTokensUsd: '0',
      outputPerMTokensUsd: '0',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: true,
    },
    notes:
      'Research 1 quotes "256k ctx"; the live catalogue sync replaces this with the provider figure.',
  },
  {
    provider: 'openrouter',
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    label: 'Nemotron 3 Ultra 550B A55B (free)',
    capabilities: ['text-generation', 'structured-generation'],
    contextWindow: 1_000_000,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
    pricing: {
      inputPerMTokensUsd: '0',
      outputPerMTokensUsd: '0',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: true,
    },
    notes: 'Research 1 quotes "1M ctx" - the long-context candidate for continuity checks.',
  },
  {
    provider: 'openrouter',
    id: 'google/gemma-4-31b-it:free',
    label: 'Gemma 4 31B IT (free, vision)',
    capabilities: ['text-generation', 'structured-generation', 'vision-scoring'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: false,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    pricing: {
      inputPerMTokensUsd: '0',
      outputPerMTokensUsd: '0',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: true,
    },
  },
  {
    provider: 'openrouter',
    id: 'nvidia/nemotron-nano-12b-v2-vl:free',
    label: 'Nemotron Nano 12B V2 VL (free, vision)',
    capabilities: ['text-generation', 'structured-generation', 'vision-scoring'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: false,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    pricing: {
      inputPerMTokensUsd: '0',
      outputPerMTokensUsd: '0',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: true,
    },
    notes: 'Free vision model - the default quality-gate scorer while iterating.',
  },

  // ── The paid image lane. No free tier exists for any of these (research 2)
  {
    provider: 'openrouter',
    id: 'google/gemini-3.1-flash-lite-image',
    label: 'Gemini 3.1 Flash Lite Image',
    capabilities: ['image-generation', 'image-edit'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: true,
    inputModalities: ['text', 'image'],
    outputModalities: ['text', 'image'],
    pricing: {
      inputPerMTokensUsd: null,
      outputPerMTokensUsd: null,
      imageOutputPerMTokensUsd: '30',
      approxPerImageUsd: '0.0336',
      free: false,
    },
    notes: 'Cheapest credible image model in research 2. Default for the paid final lane.',
  },
  {
    provider: 'openrouter',
    id: 'google/gemini-2.5-flash-image',
    label: 'Gemini 2.5 Flash Image',
    capabilities: ['image-generation', 'image-edit'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: true,
    inputModalities: ['text', 'image'],
    outputModalities: ['text', 'image'],
    pricing: {
      inputPerMTokensUsd: null,
      outputPerMTokensUsd: null,
      imageOutputPerMTokensUsd: '30',
      approxPerImageUsd: '0.039',
      free: false,
    },
  },
  {
    provider: 'openrouter',
    id: 'google/gemini-3.1-flash-image',
    label: 'Gemini 3.1 Flash Image',
    capabilities: ['image-generation', 'image-edit'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: true,
    inputModalities: ['text', 'image'],
    outputModalities: ['text', 'image'],
    pricing: {
      inputPerMTokensUsd: null,
      outputPerMTokensUsd: null,
      imageOutputPerMTokensUsd: '60',
      approxPerImageUsd: null,
      free: false,
      note: '$0.045 (0.5K) - $0.151 (4K) per image',
    },
  },
  {
    provider: 'openrouter',
    id: 'google/gemini-3-pro-image',
    label: 'Gemini 3 Pro Image',
    capabilities: ['image-generation', 'image-edit'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: true,
    inputModalities: ['text', 'image'],
    outputModalities: ['text', 'image'],
    pricing: {
      inputPerMTokensUsd: null,
      outputPerMTokensUsd: null,
      imageOutputPerMTokensUsd: '120',
      approxPerImageUsd: null,
      free: false,
      note: '$0.134 (1-2K) / $0.24 (4K) per image',
    },
  },
  {
    provider: 'openrouter',
    id: 'openai/gpt-5-image-mini',
    label: 'GPT-5 Image Mini',
    capabilities: ['image-generation'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: false,
    inputModalities: ['text'],
    outputModalities: ['image'],
    pricing: {
      inputPerMTokensUsd: null,
      outputPerMTokensUsd: null,
      imageOutputPerMTokensUsd: '8',
      approxPerImageUsd: null,
      free: false,
      note: '~$0.002 (low) - $0.01 (med) per image',
    },
    notes:
      'Research 2 records no multi-reference conditioning for this model, so it is not a candidate for character-consistency work.',
  },

  // ── ComfyUI, local: free unlimited drafts on 6 GB VRAM (research 0, 2) ───
  {
    provider: 'comfyui',
    id: 'sdxl-turbo',
    label: 'SDXL-Turbo (local ComfyUI)',
    capabilities: ['image-generation', 'image-edit'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: true,
    inputModalities: ['text', 'image'],
    outputModalities: ['image'],
    pricing: {
      inputPerMTokensUsd: null,
      outputPerMTokensUsd: null,
      imageOutputPerMTokensUsd: '0',
      approxPerImageUsd: '0',
      free: true,
      note: 'Local inference - seconds per image at 512-1024px on 6 GB VRAM',
    },
  },
  {
    provider: 'comfyui',
    id: 'sd1.5-lcm',
    label: 'SD 1.5 + LCM (local ComfyUI)',
    capabilities: ['image-generation'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: false,
    inputModalities: ['text'],
    outputModalities: ['image'],
    pricing: {
      inputPerMTokensUsd: null,
      outputPerMTokensUsd: null,
      imageOutputPerMTokensUsd: '0',
      approxPerImageUsd: '0',
      free: true,
      note: 'Local inference - the fastest blocking and composition lane',
    },
  },
];
