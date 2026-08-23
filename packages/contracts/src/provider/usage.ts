/**
 * Metering: what a call actually cost, what a run is allowed to cost, and what the
 * `StructuredCall` wrapper had to do to get usable JSON out of a model.
 *
 * "Cost is metered before it is spent" is a non-negotiable (CLAUDE.md #3), and that
 * splits into three shapes that must not be conflated:
 *
 *  - `CostEstimate` is a *prediction*, shown to the user at S5 Resolve before any
 *    money moves. It is allowed to be wrong, so it carries its assumptions.
 *  - `UsageRecord` is a *fact*, written after the call returned. One row per provider
 *    call, success or failure - a failed call that burned input tokens still cost
 *    money, and a ledger that only records successes under-reports every bad run.
 *  - `BudgetPolicy` is a *limit*, consulted between the two.
 *
 * Every amount is `NanoUsdAmount` (`primitives/common.ts`) - integer nano-dollars.
 * See `@rv/shared-kernel/money` for why: at $0.00000025 per token, micro-dollars round
 * a real charge to zero and the ledger quietly reports $0.00 for a run that spent
 * money. Every field anywhere in the package that holds money uses that alias, so
 * `grep NanoUsdAmount` is the complete list of places a currency change has to reach.
 *
 * `StructuredCallOutcome` sits here rather than with the prompt kit because it is a
 * measurement, not a mechanism. Research 1 says Ollama does not enforce schemas for
 * `qwen3.5`/`gemma4`; the only way to know whether a given local model is usable for
 * structured output *at all* is to record how hard every call had to work.
 */

import { z } from 'zod';

import {
  IsoInstant,
  Label,
  Millis,
  NanoUsdAmount,
  NonEmptyString,
  NonNegativeInt,
  PositiveInt,
  Prose,
  Size,
} from '../primitives/common';
import { JobId, ProjectId, RunId, UsageId } from '../primitives/ids';
import {
  PipelineStageKey,
  ProviderKind,
  ProviderModelId,
  QualityTier,
  TaskKind,
} from './capability';

// ── what a call actually consumed ───────────────────────────────────────────

/**
 * Token counts as the provider reported them.
 *
 * `cached` and `reasoning` are separate because they are billed differently and
 * because they are the two numbers that explain a surprising invoice: cached input is
 * cheaper than fresh input, and reasoning tokens are output the user never sees.
 */
export const TokenUsage = z.strictObject({
  input: NonNegativeInt.default(0),
  output: NonNegativeInt.default(0),
  /** Input tokens served from the provider's prompt cache. A subset of `input`. */
  cached: NonNegativeInt.default(0),
  /** Output tokens spent on hidden reasoning. Billed, never rendered. */
  reasoning: NonNegativeInt.default(0),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/**
 * Images produced by one call.
 *
 * Resolution is recorded because image models bill per *image-output token*, and the
 * token count scales with the pixels - so a ledger without the resolution cannot
 * explain its own numbers.
 */
export const ImageUsage = z.strictObject({
  count: NonNegativeInt.default(0),
  /** `null` when the call produced no image. */
  resolution: Size.nullable().default(null),
});
export type ImageUsage = z.infer<typeof ImageUsage>;

/** Whether the provider call returned something usable. */
export const CallOutcome = z.enum(['success', 'failure']);
export type CallOutcome = z.infer<typeof CallOutcome>;

/**
 * One provider call, after the fact. The atom of the cost ledger.
 *
 * Both the `runId` and the `stage` are recorded even though the stage could be derived
 * from the run: the derivation needs the run's history, and the whole point of the
 * ledger is to answer "where did the money go" from a single table.
 */
export const UsageRecord = z.strictObject({
  id: UsageId,
  runId: RunId,
  /** `null` for a call made outside a queued job, e.g. an interactive retry from the UI. */
  jobId: JobId.nullable(),
  stage: PipelineStageKey,
  provider: ProviderKind,
  model: ProviderModelId,
  task: TaskKind,
  tier: QualityTier,
  tokens: TokenUsage,
  images: ImageUsage,
  latencyMs: Millis,
  costNanoUsd: NanoUsdAmount,
  outcome: CallOutcome,
  /** `AppError.code` when the call failed, `null` when it succeeded. */
  errorCode: NonEmptyString.max(80).nullable(),
  /** True when the response came from the response cache and therefore cost nothing. */
  cacheHit: z.boolean().default(false),
  at: IsoInstant,
});
export type UsageRecord = z.infer<typeof UsageRecord>;

// ── aggregation ─────────────────────────────────────────────────────────────

/** One row of a cost breakdown. Same shape whatever it is grouped by. */
export const CostBucket = z.strictObject({
  calls: NonNegativeInt.default(0),
  failures: NonNegativeInt.default(0),
  inputTokens: NonNegativeInt.default(0),
  outputTokens: NonNegativeInt.default(0),
  images: NonNegativeInt.default(0),
  costNanoUsd: NanoUsdAmount.default(0),
});
export type CostBucket = z.infer<typeof CostBucket>;

/**
 * Totals, sliced four ways.
 *
 * Four groupings rather than one because they answer four different questions that
 * come up in practice: *which provider* is billing us, *which model* is expensive,
 * *which kind of work* is expensive, and *which stage of the pipeline* to attack
 * first. Partial records throughout - a slice with no calls has no row, and a table of
 * zeroes is noise.
 */
export const CostSummary = z.strictObject({
  total: CostBucket,
  byProvider: z.partialRecord(ProviderKind, CostBucket).default({}),
  /** Keyed by provider-native model id, which is free-form, so this is a plain record. */
  byModel: z.record(ProviderModelId, CostBucket).default({}),
  byTask: z.partialRecord(TaskKind, CostBucket).default({}),
  byStage: z.partialRecord(PipelineStageKey, CostBucket).default({}),
});
export type CostSummary = z.infer<typeof CostSummary>;

/**
 * The ledger for one project, optionally narrowed to one run.
 *
 * Carries the raw records as well as the summary because the summary is lossy and an
 * audit needs the rows. Callers that only want the headline read `summary` and never
 * touch `records`.
 */
export const CostLedger = z.strictObject({
  projectId: ProjectId,
  /** `null` for the project-lifetime ledger; set when the ledger is scoped to one run. */
  runId: RunId.nullable(),
  records: z.array(UsageRecord).default([]),
  summary: CostSummary,
  /** Inclusive lower bound of the window these totals cover. `null` = since the beginning. */
  from: IsoInstant.nullable().default(null),
  updatedAt: IsoInstant,
});
export type CostLedger = z.infer<typeof CostLedger>;

// ── limits ──────────────────────────────────────────────────────────────────

/** What the guard does when a ceiling would be crossed. */
export const BudgetAction = z.enum(['abort', 'pause', 'downgrade']);
export type BudgetAction = z.infer<typeof BudgetAction>;

/**
 * Spending ceilings, in nano-dollars. `null` means "no ceiling at this scope".
 *
 * Three scopes because they fail differently: a per-run ceiling stops one bad prompt
 * loop, a per-day ceiling stops a runaway scheduler, and a per-project ceiling is the
 * number the person paying actually agreed to.
 *
 * `confirmAboveNanoUsd` is not a ceiling - it is the point at which the run stops and
 * asks. It exists because the failure mode we care about is not "spent too much", it
 * is "spent anything at all without being asked".
 */
export const BudgetPolicy = z.strictObject({
  perRunNanoUsd: NanoUsdAmount.nullable().default(null),
  perDayNanoUsd: NanoUsdAmount.nullable().default(null),
  perProjectNanoUsd: NanoUsdAmount.nullable().default(null),
  /** Above this projected spend, the pipeline pauses for an explicit human yes. */
  confirmAboveNanoUsd: NanoUsdAmount.nullable().default(null),
  onExceed: BudgetAction.default('abort'),
});
export type BudgetPolicy = z.infer<typeof BudgetPolicy>;

/** One line of the estimate: a group of identical calls with their unit price. */
export const CostEstimateLine = z.strictObject({
  task: TaskKind,
  tier: QualityTier,
  provider: ProviderKind,
  model: ProviderModelId,
  count: NonNegativeInt,
  unitCostNanoUsd: NanoUsdAmount,
  subtotalNanoUsd: NanoUsdAmount,
});
export type CostEstimateLine = z.infer<typeof CostEstimateLine>;

/**
 * What S5 Resolve shows the user before anything is spent.
 *
 * `cacheHits` is the headline number, not a footnote: the whole architecture is built
 * so that the second run of a project costs nothing (CLAUDE.md #2), and the estimate
 * is where the user gets to see that working.
 *
 * `assumptions` is required and must not be empty. An estimate whose basis is not
 * stated cannot be judged, and the basis here is genuinely shaky - image token counts
 * move with output resolution, and several models in `KNOWN_MODELS` quote a range
 * rather than a price.
 */
export const CostEstimate = z
  .strictObject({
    /** Total work items considered - assets to resolve, calls to make. */
    items: NonNegativeInt,
    /** Items already in the registry or the response cache. These cost nothing. */
    cacheHits: NonNegativeInt,
    /** Items that will need a real provider call. */
    cacheMisses: NonNegativeInt,
    lines: z.array(CostEstimateLine).default([]),
    projectedNanoUsd: NanoUsdAmount,
    /** Lower bound of the projection - the cheapest plausible outcome. */
    lowNanoUsd: NanoUsdAmount,
    /** Upper bound. This is the number to show next to a confirm button. */
    highNanoUsd: NanoUsdAmount,
    /** Plain-language basis for the numbers above. Never empty. */
    assumptions: z.array(Prose).min(1),
    /** True when `BudgetPolicy.confirmAboveNanoUsd` is crossed and a human must say yes. */
    requiresConfirmation: z.boolean(),
    computedAt: IsoInstant,
  })
  .superRefine((estimate, ctx) => {
    if (estimate.cacheHits + estimate.cacheMisses !== estimate.items) {
      ctx.addIssue({
        code: 'custom',
        message: 'cacheHits + cacheMisses must equal items',
        path: ['items'],
      });
    }
    if (estimate.lowNanoUsd > estimate.highNanoUsd) {
      ctx.addIssue({
        code: 'custom',
        message: 'lowNanoUsd must not exceed highNanoUsd',
        path: ['lowNanoUsd'],
      });
    }
    if (
      estimate.projectedNanoUsd < estimate.lowNanoUsd ||
      estimate.projectedNanoUsd > estimate.highNanoUsd
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'projectedNanoUsd must lie within [lowNanoUsd, highNanoUsd]',
        path: ['projectedNanoUsd'],
      });
    }
  });
export type CostEstimate = z.infer<typeof CostEstimate>;

// ── structured-output telemetry ─────────────────────────────────────────────

/**
 * How much work it took to get valid JSON back.
 *
 * Ordered by escalating cost. `clean` is what a model that honours its schema does;
 * anything past `repaired` means the model is being carried by the wrapper, and
 * `escalated` means we paid twice for one answer.
 */
export const StructuredCallResolution = z.enum([
  /** Parsed and validated on the first attempt, no intervention. */
  'clean',
  /** Valid JSON, but wrapped in a markdown fence - the exact research 1 symptom. */
  'fence-stripped',
  /** Needed at least one repair turn with the Zod error fed back. */
  'repaired',
  /** The repair budget ran out and a stronger model finished the job. */
  'escalated',
  /** No valid instance was obtained. */
  'failed',
]);
export type StructuredCallResolution = z.infer<typeof StructuredCallResolution>;

/**
 * One trip through the `StructuredCall` wrapper, recorded.
 *
 * This is the evidence base for a decision we cannot make from documentation: whether
 * a given local model is usable for structured output at all. Research 1 says
 * `qwen3.5` and `gemma4` are not, and that `gemma3`/`gpt-oss` behave - but the models
 * change faster than the issue tracker, so the answer has to come from our own data.
 *
 * Kept flat rather than as a discriminated union because the point of the record is to
 * be aggregated: "what fraction of `qwen3.5` extraction calls needed a repair turn" is
 * a `GROUP BY`, and a union would make it a case analysis.
 */
export const StructuredCallOutcome = z
  .strictObject({
    provider: ProviderKind,
    model: ProviderModelId,
    task: TaskKind,
    /** The schema asked for, so failures can be attributed to a shape and not just a model. */
    schemaName: Label,
    resolution: StructuredCallResolution,
    /** Total model round-trips, including the first. */
    attempts: PositiveInt,
    /** Round-trips spent feeding a Zod error back. `attempts - 1` when no escalation happened. */
    repairTurns: NonNegativeInt,
    /** The response arrived inside a markdown fence and had to be unwrapped. */
    fenceStripped: z.boolean(),
    /**
     * Whether the provider was asked to enforce the schema natively.
     *
     * `false` for anything reached through Ollama's OpenAI shim, which research 1
     * identifies as the actual defect - so this field distinguishes "the model cannot
     * do it" from "we asked it the wrong way".
     */
    usedNativeSchemaEnforcement: z.boolean(),
    /** Model the call escalated to. `null` unless `resolution` is `escalated`. */
    escalatedTo: ProviderModelId.nullable(),
    /**
     * Dotted paths of the Zod issues from the last failed validation.
     *
     * Paths, not messages: a path tells you which field the model keeps getting wrong,
     * which is actionable on the prompt. Message wording is not.
     */
    failedPaths: z.array(NonEmptyString).max(32).default([]),
    /** `AppError.code`. `null` unless `resolution` is `failed`. */
    errorCode: NonEmptyString.max(80).nullable(),
    totalLatencyMs: Millis,
    /** Cost of every attempt combined, including the ones that were thrown away. */
    costNanoUsd: NanoUsdAmount,
    at: IsoInstant,
  })
  .superRefine((outcome, ctx) => {
    if (outcome.resolution === 'escalated' && outcome.escalatedTo === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'an escalated call must name the model it escalated to',
        path: ['escalatedTo'],
      });
    }
    if (outcome.resolution === 'failed' && outcome.errorCode === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a failed call must carry an error code',
        path: ['errorCode'],
      });
    }
    if (outcome.resolution === 'clean' && outcome.repairTurns > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'a clean call cannot have needed a repair turn',
        path: ['repairTurns'],
      });
    }
    if (outcome.repairTurns >= outcome.attempts) {
      ctx.addIssue({
        code: 'custom',
        message: 'repairTurns must be fewer than attempts',
        path: ['repairTurns'],
      });
    }
  });
export type StructuredCallOutcome = z.infer<typeof StructuredCallOutcome>;
