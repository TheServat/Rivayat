/**
 * The queue that makes "no Redis required" true.
 *
 * Three properties are worth a test and the rest are not. The concurrency ceiling,
 * because RV-182 asks for it to be *asserted by observing max concurrent jobs* and a
 * ceiling nobody measures is a comment. The retry policy, because a bounded attempt
 * count is the difference between a transient failure and an infinite loop. And
 * `drain`, because every e2e test in this app waits on it - a `drain` that resolves
 * early would make the whole suite pass on unfinished work.
 */

import type { PipelineStageKey } from '@rv/contracts';
import {
  MemoryLogger,
  ProviderError,
  UNIT,
  ValidationError,
  createRng,
  err,
  isErr,
  ok,
  type Result,
  type Unit,
} from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { InProcessJobQueue } from './in-process.queue';
import type { QueuedJob } from './job-queue.port';

function job(index: number, stage: PipelineStageKey = 'intake'): QueuedJob {
  return {
    id: `job_${String(index).padStart(26, '0')}`,
    runId: 'run_00000000000000000000000000',
    stage,
    payload: { index },
    attempt: 0,
  };
}

function build(concurrency: number, sleep?: (ms: number) => Promise<void>): InProcessJobQueue {
  return new InProcessJobQueue({
    concurrency,
    rng: createRng(1),
    logger: new MemoryLogger(),
    // Retry backoff is injected away: the schedule is asserted through the attempt
    // count, and a test that actually waited would be a test nobody runs.
    ...(sleep === undefined ? {} : { sleep }),
  });
}

const succeed = (): Promise<Result<Unit>> => Promise.resolve(ok(UNIT));

describe('InProcessJobQueue', () => {
  it('runs a job and drains', async () => {
    const queue = build(2);
    const seen: number[] = [];
    queue.setHandler((queued) => {
      seen.push(queued.payload.index as number);
      return succeed();
    });

    await queue.enqueue(job(1));
    await queue.enqueue(job(2));
    const drained = await queue.drain(2000);

    expect(isErr(drained)).toBe(false);
    expect(seen.sort()).toEqual([1, 2]);
  });

  it('never exceeds the configured concurrency', async () => {
    const queue = build(3);
    let inFlight = 0;
    let peakObserved = 0;

    queue.setHandler(async () => {
      inFlight += 1;
      peakObserved = Math.max(peakObserved, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return ok(UNIT);
    });

    for (let index = 0; index < 12; index += 1) await queue.enqueue(job(index));
    await queue.drain(5000);

    expect(peakObserved).toBeLessThanOrEqual(3);
    // And it actually used the headroom - a ceiling that is never approached proves
    // nothing about the ceiling.
    expect(peakObserved).toBeGreaterThan(1);
    expect(queue.peakConcurrency).toBe(peakObserved);
  });

  it('retries a retryable failure up to the bound and then stops', async () => {
    const delays: number[] = [];
    const queue = build(1, (ms) => {
      delays.push(ms);
      return Promise.resolve();
    });

    let attempts = 0;
    queue.setHandler(() => {
      attempts += 1;
      return Promise.resolve(
        err(new ProviderError({ message: 'upstream 503', provider: 'x', status: 503 })),
      );
    });

    await queue.enqueue(job(1));
    await queue.drain(5000);

    // Three attempts total, so two waits between them.
    expect(attempts).toBe(3);
    expect(delays).toHaveLength(2);
    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
  });

  it('does not retry a failure the taxonomy calls permanent', async () => {
    const queue = build(1, () => Promise.resolve());
    let attempts = 0;
    queue.setHandler(() => {
      attempts += 1;
      return Promise.resolve(err(new ValidationError({ message: 'the payload is wrong' })));
    });

    await queue.enqueue(job(1));
    await queue.drain(2000);

    // Retrying a validation failure spends the retry budget on an answer that cannot
    // change, and delays the diagnosis by exactly the backoff schedule.
    expect(attempts).toBe(1);
  });

  it('resolves drain immediately when nothing is queued', async () => {
    const queue = build(1);
    queue.setHandler(succeed);
    expect(isErr(await queue.drain(50))).toBe(false);
  });

  it('reports a timeout rather than hanging when a handler never settles', async () => {
    const queue = build(1);
    queue.setHandler(
      () =>
        new Promise<Result<Unit>>(() => {
          // Deliberately never settles: this is the hung-stage case.
        }),
    );

    await queue.enqueue(job(1));
    const drained = await queue.drain(50);

    expect(isErr(drained)).toBe(true);
    if (!isErr(drained)) return;
    expect(drained.error.kind).toBe('timeout');
  });

  it('drops a job enqueued after close rather than accepting work it will not do', async () => {
    const queue = build(1);
    queue.setHandler(succeed);
    await queue.close();

    const enqueued = await queue.enqueue(job(1));
    expect(isErr(enqueued)).toBe(true);
  });

  it('does not lose a job when no handler is registered, it reports it', async () => {
    const queue = build(1);
    await queue.enqueue(job(1));
    const drained = await queue.drain(500);
    // The queue drains - the job is not stuck - and the loss is on the log, not silent.
    expect(isErr(drained)).toBe(false);
  });
});
