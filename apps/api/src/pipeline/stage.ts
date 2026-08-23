/**
 * What a pipeline stage is, from the runner's point of view.
 *
 * The state machine lives in the domain and the transport is the queue; this is the
 * third piece - the thing a stage actually implements. It is deliberately tiny, because
 * every stage's real work belongs in an engine package and none of it belongs here.
 *
 * Stages are held in a **registry keyed by stage id**, never a `switch` (CLAUDE.md §2).
 * That is not style: a `switch` in the runner would have to be edited to add a stage,
 * and the whole point of S9 Preview being a first-class stage is that stages are
 * pluggable. A map also makes "which stages are implemented" a value the health
 * endpoint can report, rather than something you learn by running one.
 */

import type { PipelineStageKey } from '@rv/contracts';
import type { AppError, Result } from '@rv/shared-kernel';

import type { RunSummary } from '../application/resources';
import type { QueuedJob } from '../queue/job-queue.port';

/** What a stage produced, as `kind:ref` pointers rather than embedded documents. */
export interface StageOutput {
  readonly artifacts: readonly string[];
}

export interface StageContext {
  readonly run: RunSummary;
  readonly job: QueuedJob;
  /**
   * Reports fractional progress on the run's event stream.
   *
   * Fire-and-forget on purpose: a stage that had to await its own progress reporting
   * would be slowed by the number of people watching it.
   */
  readonly reportProgress: (progress: number, detail?: string) => void;
  /**
   * Aborted when the run is cancelled.
   *
   * Passed all the way into the provider call, because "cancel" that only stops the
   * *next* stage still spends the money the current one is spending (RV-187).
   */
  readonly signal: AbortSignal;
}

export interface StageHandler {
  readonly stage: PipelineStageKey;
  execute(context: StageContext): Promise<Result<StageOutput, AppError>>;
}

/** Stage id to its handler. Every requested stage must be in here to run. */
export type StageRegistry = ReadonlyMap<PipelineStageKey, StageHandler>;

export function buildStageRegistry(handlers: readonly StageHandler[]): StageRegistry {
  return new Map(handlers.map((handler) => [handler.stage, handler]));
}
