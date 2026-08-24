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
import type { ProgressItem } from '../events/run-event';
import type { QueuedJob } from '../queue/job-queue.port';

/** What a stage produced, as `kind:ref` pointers rather than embedded documents. */
export interface StageOutput {
  readonly artifacts: readonly string[];
  /**
   * Milliseconds of finished video this stage put on disk. Omitted by every stage that
   * produces none, which is nine of the twelve.
   */
  readonly deliveredMs?: number;
}

/** What a stage tells the world while it is still working. */
export interface StageProgress {
  /** 0..1. A stage that cannot estimate reports 0 rather than inventing a fraction. */
  readonly progress: number;
  /** One line for a human. Prose, and therefore not something a UI can key off. */
  readonly detail?: string;
  /** The unit of work in flight, structured, for a UI that renders a list. */
  readonly item?: ProgressItem;
}

export interface StageContext {
  readonly run: RunSummary;
  readonly job: QueuedJob;
  /**
   * Reports progress on the run's event stream.
   *
   * Fire-and-forget on purpose: a stage that had to await its own progress reporting
   * would be slowed by the number of people watching it.
   */
  readonly reportProgress: (update: StageProgress) => void;
  /**
   * Aborted when the run is cancelled.
   *
   * Passed all the way into the provider call, because "cancel" that only stops the
   * *next* stage still spends the money the current one is spending (RV-187). A stage
   * whose work is a loop checks it **between units**, never only at the top: a stage
   * that notices at the end of its 40-second batch was not cancelled, it was delayed.
   */
  readonly signal: AbortSignal;
}

export interface StageHandler {
  readonly stage: PipelineStageKey;
  /**
   * Whether this handler does the stage's work, or refuses it with a 501.
   *
   * Declared by the adapter rather than inferred by the caller, which is the same rule
   * the provider layer follows: "an adapter that cannot implement a capability declares
   * it, and the router routes around it" (CLAUDE.md section 2). The alternative - a list
   * of stub stage ids kept somewhere else - is a list someone has to remember to update,
   * and the failure is silent in the direction that flatters us.
   *
   * It is not cosmetic. `/api/health` used to report all twelve registered stages as
   * implemented, and `docs/05-remaining-work.md` was written from that endpoint: "All
   * twelve stages report as implemented" went into a document other agents work from,
   * about a build where nine of them return 501.
   */
  readonly implemented: boolean;
  execute(context: StageContext): Promise<Result<StageOutput, AppError>>;
}

/** Stage id to its handler. Every requested stage must be in here to run. */
export type StageRegistry = ReadonlyMap<PipelineStageKey, StageHandler>;

export function buildStageRegistry(handlers: readonly StageHandler[]): StageRegistry {
  return new Map(handlers.map((handler) => [handler.stage, handler]));
}
