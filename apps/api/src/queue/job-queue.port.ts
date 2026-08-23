/**
 * One queue interface, two drivers, and the reason there are two.
 *
 * "Local-first, zero-ops" (architecture §8) means the whole pipeline has to run with no
 * Redis installed. "Resumable across a restart, with bounded retries and observable
 * concurrency" (RV-182) means it also has to run with Redis when there is one. Those
 * are the same *shape* of work and different *infrastructure*, which is exactly what a
 * port is for: `PipelineRunner` never learns which one it got.
 *
 * The interface is small on purpose. Everything BullMQ offers beyond this - repeatable
 * jobs, flows, priorities - would have to be reimplemented in the in-process driver to
 * keep the two substitutable, and an in-process reimplementation of BullMQ is not a
 * fallback, it is a second queue library.
 */

import type { JobId, PipelineStageKey, RunId } from '@rv/contracts';
import type { AppError, Result, Unit } from '@rv/shared-kernel';

export type QueueDriver = 'bullmq' | 'in-process';

/** One unit of work: a stage of a run, with whatever that stage needs to start. */
export interface QueuedJob {
  readonly id: JobId;
  readonly runId: RunId;
  readonly stage: PipelineStageKey;
  readonly payload: Record<string, unknown>;
  /** Attempts already made. Starts at 0; the driver increments it. */
  readonly attempt: number;
}

/**
 * What the runner gives the queue.
 *
 * Returns a `Result` rather than throwing so a stage failure is data the driver can
 * inspect for `retryable` - a thrown error would force the driver to guess.
 */
export type JobHandler = (job: QueuedJob) => Promise<Result<Unit, AppError>>;

export interface JobQueue {
  readonly driver: QueueDriver;
  /** Peak simultaneous jobs since the queue was created. Asserted by RV-182. */
  readonly peakConcurrency: number;

  /** Registered once, at wiring time. A second call replaces the first. */
  setHandler(handler: JobHandler): void;

  enqueue(job: QueuedJob): Promise<Result<Unit, AppError>>;

  /**
   * Resolves once nothing is queued and nothing is in flight.
   *
   * Present on the port rather than only on the in-process driver because an e2e suite
   * has to be able to say "the pipeline has finished" without polling, and a test that
   * polls a queue is a test that is flaky on a loaded CI box.
   */
  drain(timeoutMs?: number): Promise<Result<Unit, AppError>>;

  close(): Promise<void>;
}
