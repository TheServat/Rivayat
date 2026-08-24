/**
 * The budget guard for a stage whose work is *several* model calls.
 *
 * `MeteredCallRunner` is the sanctioned path to a provider and its contract is precise:
 * guard, then call, then meter, in that order (non-negotiable #3). It is written around
 * one call to one named model, and the three LLM stages are not that shape - S2 makes
 * one call per parent node, S3 makes two or three per character, and which model serves
 * each is decided by the router at the moment of the call.
 *
 * So the *stage* is the metered unit, and this is the adapter:
 *
 * - **The estimate is the caller's, and it is a ceiling.** `MeteredCallSpec.estimate`
 *   is deliberately the caller's job, because only the caller knows how many calls it
 *   is about to make. A guard that estimated from nothing would wave through the one
 *   run that matters.
 * - **The model on the spec is the head of the route the stage will take.** Resolved
 *   before the closure runs, from the same `ModelRouter` the engine's `StageBackends`
 *   consults, so the ledger row names the model the work was actually routed to rather
 *   than a placeholder.
 * - **What is recorded is what the traces say, not the estimate.** Every story-engine
 *   use-case returns its `StructuredTrace`s, each carrying real token counts; they are
 *   summed and handed back as the actual usage. The estimate is only ever used to
 *   decide whether to start.
 *
 * The consequence worth stating: the guard runs once per stage, not once per call, so a
 * stage that blows its budget half way through finishes the stage. Metering per call
 * would need the engine to hand out a callback around every `runRoleCall`, which is a
 * change to a package this workstream does not own; the ceiling estimate below is what
 * stands in until it does.
 */

import type { PipelineStageKey, QualityTier, TaskKind } from '@rv/contracts';
import type { StructuredTrace } from '@rv/prompt-kit';
import { NO_IMAGES, type ResolvedRoute, type ProviderUsage } from '@rv/providers';
import { isErr, type AppError, type Result } from '@rv/shared-kernel';

import type { MeteredCallSpec, MeteredOutcome } from '../cost/metered-call';
import type { StageContext } from '../pipeline/stage';

/** Tokens one story-engine call is assumed to cost, before anything is known. */
export const ESTIMATED_TOKENS_PER_CALL = { input: 4_000, output: 2_000 } as const;

/**
 * The two capabilities a stage needs to spend money, and nothing else.
 *
 * Declared as the narrowest shape rather than as `ModelRouter` and `MeteredCallRunner`
 * themselves (CLAUDE.md §2: ports are narrow). Both concrete classes satisfy them
 * structurally, and a test can hand over an object with one method instead of standing
 * up a capability matrix and a cost service to assert that a stage refuses to start when
 * the guard says no.
 */
export interface StageRouter {
  route(request: {
    readonly task: TaskKind;
    readonly tier: QualityTier;
    readonly stage?: PipelineStageKey;
  }): Result<ResolvedRoute, AppError>;
}

export interface StageMeter {
  run<T>(
    spec: MeteredCallSpec,
    call: (signal: AbortSignal | undefined) => Promise<Result<MeteredOutcome<T>, AppError>>,
  ): Promise<Result<T, AppError>>;
}

export interface StageSpendDeps {
  readonly meter: StageMeter;
  readonly router: StageRouter;
}

export interface StageSpendSpec {
  readonly context: StageContext;
  readonly stage: PipelineStageKey;
  readonly task: TaskKind;
  readonly tier: QualityTier;
  /**
   * How many model calls the stage is about to make.
   *
   * Rounded up rather than down wherever it is uncertain: an estimate that is too low
   * defeats the guard, and an estimate that is too high only refuses a run the operator
   * would have wanted to see refused anyway.
   */
  readonly calls: number;
}

/** What the guarded closure hands back: the value, and every trace it produced. */
export interface StageWork<T> {
  readonly value: T;
  readonly traces: readonly StructuredTrace[];
}

/**
 * Runs a stage's model work behind the budget guard.
 *
 * The closure receives the run's cancellation signal - not the stage's own - because a
 * cancelled run must stop *between* calls rather than after the last one.
 */
export async function meteredStageWork<T>(
  deps: StageSpendDeps,
  spec: StageSpendSpec,
  work: (signal: AbortSignal | undefined) => Promise<Result<StageWork<T>, AppError>>,
): Promise<Result<T, AppError>> {
  const route = deps.router.route({ task: spec.task, tier: spec.tier, stage: spec.stage });
  if (isErr(route)) return route;

  const head = route.value.chain[0];
  if (head === undefined) {
    // `route` succeeding with an empty chain is not something the router does today,
    // and guessing a provider name to satisfy the spec would put a fiction in the
    // ledger. Re-routing without a stage is the only other question worth asking, and
    // it has the same answer.
    return route as unknown as Result<T, AppError>;
  }

  return deps.meter.run<T>(
    {
      projectId: spec.context.run.projectId,
      budget: {
        runId: spec.context.run.id,
        perRunNanoUsd: spec.context.run.budgetNanoUsd,
      },
      stage: spec.stage,
      task: spec.task,
      tier: spec.tier,
      provider: head.provider,
      model: head.model,
      estimate: estimateFor(spec.calls),
      signal: spec.context.signal,
    },
    async (signal) => {
      const outcome = await work(signal);
      if (isErr(outcome)) return outcome;
      return {
        ok: true,
        value: { value: outcome.value.value, usage: usageOf(outcome.value.traces) },
      };
    },
  );
}

/** The pre-flight ceiling: `calls` calls at the assumed size, and no images. */
export function estimateFor(calls: number): ProviderUsage {
  const count = Math.max(1, Math.ceil(calls));
  return {
    tokens: {
      input: ESTIMATED_TOKENS_PER_CALL.input * count,
      output: ESTIMATED_TOKENS_PER_CALL.output * count,
      cached: 0,
      reasoning: 0,
    },
    images: NO_IMAGES,
    latencyMs: 0,
  };
}

/**
 * What the calls actually consumed, from their traces.
 *
 * `StructuredTrace.usage` counts every attempt including repair turns, which is the
 * number that was billed rather than the number the successful turn used.
 */
export function usageOf(traces: readonly StructuredTrace[]): ProviderUsage {
  let input = 0;
  let output = 0;
  let latencyMs = 0;
  for (const trace of traces) {
    input += trace.usage.inputTokens;
    output += trace.usage.outputTokens;
    latencyMs += trace.totalLatencyMs;
  }
  return {
    tokens: { input, output, cached: 0, reasoning: 0 },
    images: NO_IMAGES,
    latencyMs,
  };
}

/** Total nano-dollars across a set of traces, for the artefact line a UI renders. */
export function spentNanoUsd(traces: readonly StructuredTrace[]): number {
  return traces.reduce((total, trace) => total + trace.costNanoUsd, 0);
}
