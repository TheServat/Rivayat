/**
 * The same port, over BullMQ, for when `REDIS_URL` is set.
 *
 * This file is the only place `bullmq` and `ioredis` are named, for the same reason
 * `@rv/providers` is the only place a model SDK is named: the runner above it has to be
 * substitutable onto the in-process driver, and an import here is a coupling there.
 *
 * Retries are configured on the job rather than implemented in the handler, because
 * BullMQ owns redelivery: a handler that retried internally would hold a Redis lock for
 * the whole backoff and then be re-delivered by the queue as well, doubling every
 * attempt. So the handler fails once and BullMQ schedules the next attempt.
 */

import type { Clock, Logger, Result, Unit, AppError } from '@rv/shared-kernel';
import { TimeoutError, UNIT, isErr, ok, err, toAppError } from '@rv/shared-kernel';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';

import type { JobHandler, JobQueue, QueuedJob } from './job-queue.port';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './in-process.queue';

const QUEUE_NAME = 'rivayat-pipeline';

export interface BullMqQueueOptions {
  readonly redisUrl: string;
  readonly concurrency: number;
  readonly logger: Logger;
  /**
   * Injected, not read from the wall clock.
   *
   * `drain` is the only place in this driver that measures elapsed time, and
   * non-negotiable #1 has no infrastructure exemption. It also makes the deadline
   * assertable: a `FixedClock` turns "does drain give up after 30 s" from a
   * thirty-second test into an instant one.
   */
  readonly clock: Clock;
  readonly retry?: RetryPolicy;
}

/** The payload as it travels through Redis. `attempt` comes back off the job itself. */
type JobData = Omit<QueuedJob, 'attempt'>;

export class BullMqJobQueue implements JobQueue {
  readonly driver = 'bullmq' as const;

  readonly #connection: Redis;
  readonly #queue: Queue<JobData>;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #concurrency: number;
  readonly #retry: RetryPolicy;

  #worker: Worker<JobData> | null = null;
  #peak = 0;
  #running = 0;

  constructor(options: BullMqQueueOptions) {
    this.#logger = options.logger.child({ component: 'queue', driver: 'bullmq' });
    this.#clock = options.clock;
    this.#concurrency = Math.max(1, options.concurrency);
    this.#retry = options.retry ?? DEFAULT_RETRY_POLICY;

    // `maxRetriesPerRequest: null` is BullMQ's documented requirement for a blocking
    // worker connection; without it ioredis aborts the long BRPOPLPUSH the worker
    // lives on and the worker silently stops consuming.
    this.#connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
    this.#queue = new Queue<JobData>(QUEUE_NAME, { connection: this.#connection });
  }

  get peakConcurrency(): number {
    return this.#peak;
  }

  setHandler(handler: JobHandler): void {
    void this.#worker?.close();

    this.#worker = new Worker<JobData>(
      QUEUE_NAME,
      async (job: Job<JobData>): Promise<void> => {
        this.#running += 1;
        this.#peak = Math.max(this.#peak, this.#running);
        try {
          const outcome = await handler({ ...job.data, attempt: job.attemptsMade + 1 });
          if (isErr(outcome)) {
            // Thrown, because that is how a BullMQ worker reports failure and triggers
            // the configured backoff. The taxonomy still decides: `UnrecoverableError`
            // is BullMQ's own "do not retry this", so a `retryable: false` failure -
            // a budget refusal, a validation error - is not re-attempted three times
            // on a schedule that cannot change the answer.
            if (!outcome.error.retryable) {
              throw new UnrecoverableError(`${outcome.error.code}: ${outcome.error.message}`);
            }
            throw outcome.error;
          }
        } finally {
          this.#running -= 1;
        }
      },
      { connection: this.#connection, concurrency: this.#concurrency },
    );

    this.#worker.on('failed', (job, error) => {
      this.#logger.warn('job failed', { jobId: job?.id, error: error.message });
    });
  }

  async enqueue(job: QueuedJob): Promise<Result<Unit, AppError>> {
    const { attempt: _attempt, ...data } = job;
    try {
      await this.#queue.add(job.stage, data, {
        jobId: job.id,
        attempts: this.#retry.maxAttempts,
        backoff: { type: 'exponential', delay: this.#retry.initialBackoffMs },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400 },
      });
      return ok(UNIT);
    } catch (caught) {
      return err(toAppError(caught, `Could not enqueue ${job.stage} for run ${job.runId}`));
    }
  }

  /**
   * Waits for the queue to report nothing waiting, active or delayed.
   *
   * Unlike the in-process driver there is no in-memory idle signal to await - the work
   * may be on another process entirely - so this is the one place a poll is the honest
   * implementation rather than a shortcut.
   */
  async drain(timeoutMs = 30_000): Promise<Result<Unit, AppError>> {
    const deadline = this.#clock.now() + timeoutMs;
    for (;;) {
      const counts = await this.#queue.getJobCounts('waiting', 'active', 'delayed');
      const outstanding = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
      if (outstanding === 0) return ok(UNIT);
      if (this.#clock.now() >= deadline) {
        return err(new TimeoutError(`queue drain (${String(outstanding)} outstanding)`, timeoutMs));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async close(): Promise<void> {
    await this.#worker?.close();
    await this.#queue.close();
    this.#connection.disconnect();
  }
}
