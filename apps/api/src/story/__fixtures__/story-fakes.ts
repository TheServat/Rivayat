/**
 * Fakes for the three LLM stages. No socket is opened by any test that uses them.
 *
 * The backend records every `CompletionRequest` it is handed, which is what makes the
 * useful assertions possible: a test that only counted calls would still pass if every
 * expansion had been sent the same parent, and "bound to its parent" is the one property
 * the outliner exists to guarantee.
 *
 * Scripting is a queue and the fallback is an error, so a test that makes one more call
 * than it scripted fails loudly instead of quietly reusing the last answer.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ids, type ProjectId, type RunId, type SeriesId } from '@rv/contracts';
import type { ResolvedRoute } from '@rv/providers';
import type { CompletionRequest, CompletionResponse, StructuredBackend } from '@rv/prompt-kit';
import { StructuredCall } from '@rv/prompt-kit';
import { FixedStageBackends, type StoryEngineDeps } from '@rv/story-engine';
import type { ProviderUsage } from '@rv/providers';
import {
  BudgetExceededError,
  FixedClock,
  MemoryLogger,
  ProviderError,
  UnsupportedCapabilityError,
  err,
  instant,
  isErr,
  ok,
  toIso,
  type AppError,
  type Clock,
  type Result,
} from '@rv/shared-kernel';

import type { RunSummary } from '../../application/resources';
import type { MeteredCallSpec, MeteredOutcome } from '../../cost/metered-call';
import type { StageMeter, StageRouter } from '../stage-spend';
import type { StageContext, StageProgress } from '../../pipeline/stage';
import type { QueuedJob } from '../../queue/job-queue.port';

/** A fixed point on the wall clock. Every `createdAt` in a test derives from it. */
export const TEST_INSTANT = instant(1_767_225_600_000);

export function testClock(): Clock {
  return new FixedClock(TEST_INSTANT);
}

export class FakeStructuredBackend implements StructuredBackend {
  readonly id = 'fake:qwen';
  readonly enforcesSchema = false;
  readonly dialect = 'plain' as const;
  /** Every request, in order. The assertion surface. */
  readonly requests: CompletionRequest[] = [];

  readonly #script: unknown[];
  readonly #onCall: ((served: number) => void) | undefined;

  /**
   * @param onCall invoked with the number of responses served so far, *after* each one.
   *   The hook a cancellation test needs: it aborts the run between two calls, which is
   *   the only place a stage that checks its signal between units can be caught out.
   */
  constructor(script: readonly unknown[] = [], onCall?: (served: number) => void) {
    this.#script = [...script];
    this.#onCall = onCall;
  }

  complete(request: CompletionRequest): Promise<Result<CompletionResponse, AppError>> {
    this.requests.push(request);
    if (this.#script.length === 0) {
      return Promise.resolve(
        err(
          new ProviderError({
            provider: 'fake',
            message: 'the fake backend ran out of script',
          }),
        ),
      );
    }
    const next = this.#script.shift();
    this.#onCall?.(this.requests.length);
    return Promise.resolve(
      ok({
        text: JSON.stringify(next),
        modelId: this.id,
        usage: { inputTokens: 100, outputTokens: 50 },
        costNanoUsd: 1_000,
        latencyMs: 1,
      }),
    );
  }

  /** The user turn of the nth call, for asserting what a role was actually told. */
  userTurn(index: number): string {
    const request = this.requests[index];
    if (request === undefined) return '';
    return request.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n');
  }
}

/** `StoryEngineDeps` over one scripted backend, with no router and no matrix. */
export function fakeEngine(
  backend: StructuredBackend,
  clock: Clock = testClock(),
): StoryEngineDeps {
  return {
    structured: new StructuredCall({ clock, logger: new MemoryLogger() }),
    backends: new FixedStageBackends([backend]),
    clock,
    ids: new Ids(),
    logger: new MemoryLogger(),
  };
}

/** A temp workspace that cleans itself up. */
export function scratchWorkspace(): { readonly dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rivayat-story-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface StageContextOptions {
  readonly seriesId?: SeriesId | null;
  readonly payload?: Record<string, unknown>;
  readonly budgetNanoUsd?: number | null;
  readonly signal?: AbortSignal;
}

const PROJECT_ID = 'prj_01JQZK3M7X8YB4N2VTC6WPHRDE' as ProjectId;
const RUN_ID = 'run_01JQZK3M7X8YB4N2VTC6WPHRDA' as RunId;

/** A stage context whose progress reports are collected rather than published. */
export function stageContext(options: StageContextOptions = {}): {
  readonly context: StageContext;
  readonly progress: StageProgress[];
} {
  const progress: StageProgress[] = [];
  const run: RunSummary = {
    id: RUN_ID,
    projectId: PROJECT_ID,
    seriesId: options.seriesId === undefined ? null : options.seriesId,
    status: 'running',
    requestedStages: ['story'],
    currentStage: 'story',
    stages: [],
    seed: 7,
    budgetNanoUsd: options.budgetNanoUsd === undefined ? null : options.budgetNanoUsd,
    spentNanoUsd: 0,
    errorCode: null,
    startedAt: toIso(TEST_INSTANT),
    finishedAt: null,
  };
  const job: QueuedJob = {
    id: 'job_01JQZK3M7X8YB4N2VTC6WPHRDB',
    runId: RUN_ID,
    stage: 'story',
    payload: options.payload ?? {},
    attempt: 1,
  };

  return {
    progress,
    context: {
      run,
      job,
      reportProgress: (update) => progress.push(update),
      signal: options.signal ?? new AbortController().signal,
    },
  };
}

export { PROJECT_ID, RUN_ID };

// ── the two things a stage needs in order to spend ──────────────────────────

/**
 * A router that always resolves to one local model.
 *
 * Enough to satisfy `StageRouter`, which is all a stage asks of it. Standing up a real
 * `ModelRouter` would need a capability matrix with registered adapters, and none of the
 * assertions in these tests are about routing.
 */
export const fakeRouter: StageRouter = {
  route: () =>
    ok({
      chain: [
        {
          task: 'story-outline',
          tier: 'draft',
          provider: 'ollama',
          model: 'qwen3.5:latest',
          params: {},
        },
      ],
      source: 'catalogue',
      task: 'story-outline',
      tier: 'draft',
      policy: 'local-first',
    } as unknown as ResolvedRoute),
};

/** A router that cannot serve the stage at all. */
export const unroutableRouter: StageRouter = {
  route: () => err(new UnsupportedCapabilityError('fake', 'nothing is registered')),
};

/**
 * A meter that records what it was asked to allow, and lets it through.
 *
 * The recorded spec is the assertion surface for non-negotiable #3: it is how a test
 * proves the guard was consulted *before* the closure ran, with an estimate that is not
 * zero.
 */
export class RecordingMeter implements StageMeter {
  readonly specs: MeteredCallSpec[] = [];
  readonly usages: ProviderUsage[] = [];

  async run<T>(
    spec: MeteredCallSpec,
    call: (signal: AbortSignal | undefined) => Promise<Result<MeteredOutcome<T>, AppError>>,
  ): Promise<Result<T, AppError>> {
    this.specs.push(spec);
    const outcome = await call(spec.signal);
    if (isErr(outcome)) return outcome;
    this.usages.push(outcome.value.usage);
    return ok(outcome.value.value);
  }
}

/**
 * A meter that refuses, with the closure un-invoked.
 *
 * The e2e suite asserts the same property by counting calls on a fake provider: a budget
 * test that only checked the status code would pass on an implementation that pays for
 * the call and then reports 402.
 */
export class RefusingMeter implements StageMeter {
  calls = 0;

  run<T>(
    _spec: MeteredCallSpec,
    _call: (signal: AbortSignal | undefined) => Promise<Result<MeteredOutcome<T>, AppError>>,
  ): Promise<Result<T, AppError>> {
    this.calls += 1;
    return Promise.resolve(err(new BudgetExceededError('run', 0.01, 0.5)));
  }
}
