/**
 * One function through which every model call in this package passes.
 *
 * Three rules are enforced here so that no use-case has to remember them:
 *
 *  1. **`StructuredCall` only** (CLAUDE.md #6). There is no other entry point in this
 *     package, and nothing here holds a provider adapter.
 *  2. **The role decides the route.** `stage`, `task` and `tier` come off the
 *     {@link AgentRole}, so pinning a stage to a model in the router config changes what
 *     that role runs on with no change at any call site - which is the whole of the
 *     "model is selectable per stage" requirement.
 *  3. **The role's system prompt is the system prompt.** A use-case supplies the *user*
 *     turn and nothing else, so a role cannot be quietly re-characterised by whoever
 *     happens to be calling it.
 */

import type { z } from 'zod';
import type { Ids } from '@rv/contracts';
import type { PromptMessage, StructuredCall, StructuredTrace } from '@rv/prompt-kit';
import {
  type AppError,
  type Clock,
  type Logger,
  NoopLogger,
  type Result,
  err,
  isErr,
  ok,
} from '@rv/shared-kernel';

import type { AgentRole } from '../roles/role';
import type { StageBackends } from '../routing/stage-backends';

/**
 * What every use-case in this package needs.
 *
 * `clock` and `ids` are here rather than reached for globally because a replayed
 * pipeline run has to mint the same ids it did the first time (CLAUDE.md #1), and that is
 * only possible if both are injected all the way down.
 */
export interface StoryEngineDeps {
  readonly structured: StructuredCall;
  readonly backends: StageBackends;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly logger?: Logger;
}

export interface StageCallOutcome<T> {
  readonly value: T;
  readonly trace: StructuredTrace;
}

export interface RoleCallArgs<T> {
  readonly role: AgentRole;
  /** Names the shape in the ledger. Use the schema's own name. */
  readonly schemaName: string;
  readonly schema: z.ZodType<T>;
  /** The user turn. Compose it from `PromptTemplate`s, never from a template literal. */
  readonly user: string;
  /** Prior turns - few-shot examples, or a rejected draft being revised. */
  readonly context?: readonly PromptMessage[];
  readonly maxRepairs?: number;
  /** Overrides `role.temperature`. Only a caller with a specific reason should pass it. */
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

/**
 * Routes for the role, calls, and returns the validated value with its trace.
 *
 * A failure comes back as a plain `AppError` rather than as `StructuredFailure`, because
 * every caller composes it with other `Result`s that carry `AppError`. The trace of a
 * failed call is not thrown away - it goes to the logger, which is where the ledger reads
 * "which model needed three repair turns on this schema" from.
 */
export async function runRoleCall<T>(
  deps: StoryEngineDeps,
  args: RoleCallArgs<T>,
): Promise<Result<StageCallOutcome<T>, AppError>> {
  const logger: Logger = deps.logger ?? new NoopLogger();

  const backends = deps.backends.resolve({
    stage: args.role.stage,
    task: args.role.task,
    tier: args.role.tier,
  });
  if (isErr(backends)) return backends;

  const outcome = await deps.structured.run<T>({
    schemaName: args.schemaName,
    schema: args.schema,
    backends: backends.value,
    system: args.role.systemPrompt,
    user: args.user,
    temperature: args.temperature ?? args.role.temperature,
    ...(args.context === undefined ? {} : { context: args.context }),
    ...(args.maxRepairs === undefined ? {} : { maxRepairs: args.maxRepairs }),
    ...(args.maxOutputTokens === undefined ? {} : { maxOutputTokens: args.maxOutputTokens }),
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });

  if (isErr(outcome)) {
    logger.warn('story-engine: role call failed', {
      role: args.role.id,
      stage: args.role.stage,
      schema: args.schemaName,
      model: outcome.error.trace.modelId,
      resolution: outcome.error.trace.resolution,
      failedPaths: outcome.error.trace.failedPaths,
    });
    return err(outcome.error.error);
  }

  return ok({ value: outcome.value.value, trace: outcome.value.trace });
}

/**
 * Collects the traces of a multi-call use-case.
 *
 * A use-case that makes four calls has four traces, and returning only the last one loses
 * exactly the information the cost ledger wants. A tiny class rather than an array
 * threaded through every method, so the accumulation cannot be forgotten halfway.
 */
export class TraceLog {
  readonly #traces: StructuredTrace[] = [];

  add(trace: StructuredTrace): void {
    this.#traces.push(trace);
  }

  addAll(traces: readonly StructuredTrace[]): void {
    this.#traces.push(...traces);
  }

  get traces(): readonly StructuredTrace[] {
    return [...this.#traces];
  }

  /** Total spend across every call this use-case made, in nano-dollars. */
  get costNanoUsd(): number {
    return this.#traces.reduce((total, trace) => total + trace.costNanoUsd, 0);
  }
}
