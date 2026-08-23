/**
 * The queue that needs no infrastructure.
 *
 * A bounded-concurrency work loop over an array, with the same retry policy the BullMQ
 * driver configures on its worker. It is the default, not the fallback: `REDIS_URL`
 * empty is the documented local configuration, and the e2e suite runs entirely on this
 * driver so "works without Redis" is a tested property rather than a claim.
 *
 * Three details that are not obvious:
 *
 *  - **Backoff jitter comes from an injected `Rng`.** Non-negotiable #1 does not stop
 *    at the domain layer; a run whose retry schedule is unrepeatable is not replayable.
 *  - **`peakConcurrency` is recorded, not sampled.** RV-182 asks for an assertion that
 *    `RV_QUEUE_CONCURRENCY` is respected, and the only honest way to check a ceiling is
 *    to record the maximum as it happens.
 *  - **`drain` resolves through a promise, never a poll.** A test that polls a queue is
 *    a test that is flaky on a loaded machine.
 */

import {
  TimeoutError,
  type AppError,
  type Logger,
  type Result,
  type Rng,
  type Unit,
  UNIT,
  err,
  isErr,
  ok,
} from '@rv/shared-kernel';
import { computeBackoffMs } from '@rv/providers';

import type { JobHandler, JobQueue, QueuedJob } from './job-queue.port';

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly backoffMultiplier: number;
  readonly maxBackoffMs: number;
  readonly jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 100,
  backoffMultiplier: 2,
  maxBackoffMs: 5_000,
  jitter: 0.2,
};

export interface InProcessQueueOptions {
  readonly concurrency: number;
  readonly rng: Rng;
  readonly logger: Logger;
  readonly retry?: RetryPolicy;
  /** Injected so a retry test does not spend real seconds in backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class InProcessJobQueue implements JobQueue {
  readonly driver = 'in-process' as const;

  readonly #concurrency: number;
  readonly #rng: Rng;
  readonly #logger: Logger;
  readonly #retry: RetryPolicy;
  readonly #sleep: (ms: number) => Promise<void>;

  readonly #pending: QueuedJob[] = [];
  readonly #idleWaiters: (() => void)[] = [];
  #running = 0;
  #peak = 0;
  #closed = false;
  #handler: JobHandler | null = null;

  constructor(options: InProcessQueueOptions) {
    this.#concurrency = Math.max(1, options.concurrency);
    this.#rng = options.rng;
    this.#logger = options.logger.child({ component: 'queue', driver: 'in-process' });
    this.#retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  get peakConcurrency(): number {
    return this.#peak;
  }

  setHandler(handler: JobHandler): void {
    this.#handler = handler;
  }

  enqueue(job: QueuedJob): Promise<Result<Unit, AppError>> {
    if (this.#closed) {
      return Promise.resolve(err(new TimeoutError('enqueue after close', 0)));
    }
    this.#pending.push(job);
    this.#pump();
    return Promise.resolve(ok(UNIT));
  }

  /**
   * Resolves when the queue is empty and idle.
   *
   * The timeout is a guard against a handler that never settles, not a poll interval:
   * without it a hung stage turns a failing test into a hanging one, and a hanging
   * test is diagnosed hours later instead of seconds later.
   */
  async drain(timeoutMs = 15_000): Promise<Result<Unit, AppError>> {
    if (this.#isIdle()) return ok(UNIT);

    let timer: NodeJS.Timeout | undefined;
    const idle = new Promise<'idle'>((resolve) => {
      this.#idleWaiters.push(() => {
        resolve('idle');
      });
    });
    const expiry = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
    });

    const outcome = await Promise.race([idle, expiry]);
    if (timer !== undefined) clearTimeout(timer);

    return outcome === 'idle'
      ? ok(UNIT)
      : err(new TimeoutError(`queue drain (${String(this.#pending.length)} pending)`, timeoutMs));
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#pending.length = 0;
    this.#releaseIdleWaiters();
    return Promise.resolve();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #isIdle(): boolean {
    return this.#running === 0 && this.#pending.length === 0;
  }

  #releaseIdleWaiters(): void {
    if (!this.#isIdle()) return;
    const waiters = this.#idleWaiters.splice(0, this.#idleWaiters.length);
    for (const waiter of waiters) waiter();
  }

  /** Starts as many jobs as the ceiling allows. Never awaited by the caller. */
  #pump(): void {
    while (this.#running < this.#concurrency && this.#pending.length > 0) {
      const job = this.#pending.shift();
      if (job === undefined) break;

      this.#running += 1;
      this.#peak = Math.max(this.#peak, this.#running);

      void this.#run(job).finally(() => {
        this.#running -= 1;
        if (this.#pending.length > 0) this.#pump();
        this.#releaseIdleWaiters();
      });
    }
  }

  async #run(job: QueuedJob): Promise<void> {
    const handler = this.#handler;
    if (handler === null) {
      this.#logger.error('job dropped: no handler registered', { jobId: job.id, stage: job.stage });
      return;
    }

    for (let attempt = job.attempt + 1; attempt <= this.#retry.maxAttempts; attempt += 1) {
      const outcome = await handler({ ...job, attempt });
      if (!isErr(outcome)) return;

      // The taxonomy already decided this, at the boundary that produced the error.
      // Re-deriving retryability from a message here would give two answers.
      if (!outcome.error.retryable || attempt === this.#retry.maxAttempts) {
        this.#logger.warn('job failed', {
          jobId: job.id,
          stage: job.stage,
          attempt,
          code: outcome.error.code,
          retryable: outcome.error.retryable,
        });
        return;
      }

      const delay = computeBackoffMs(attempt, this.#retry, this.#rng);
      this.#logger.debug('job retrying', { jobId: job.id, attempt, delayMs: delay });
      await this.#sleep(delay);
    }
  }
}
