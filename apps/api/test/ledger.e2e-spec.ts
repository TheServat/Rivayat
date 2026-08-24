/**
 * The bill, end to end, and the reconciliation that makes it worth reading.
 *
 * `cost-report.spec.ts` proves the arithmetic and proves that it is the *same* fold
 * `CostMeter` uses. This proves the plumbing between them: that a run which really goes
 * through `MeteredCallRunner` leaves rows in `usage_records`, that
 * `GET /api/runs/:id/ledger` reads those rows rather than the in-process meter, that the
 * two agree to the nano-dollar, and that `GET /api/projects/:id/cost` can answer the two
 * questions the CLI and the cost screen actually ask:
 *
 *   - "what did this episode cost me, broken down"  → per run, per stage, per provider
 *   - "what does a minute of this show cost"        → `nanoUsdPerDeliveredMinute`
 *
 * The stage is a fake installed over `STAGE_REGISTRY`, and that is the point rather than
 * a shortcut: no real stage in this build spends money yet, so a test that waited for
 * one would be testing nothing. What is *not* faked is everything the claim is about -
 * the real `MeteredCallRunner`, the real `CostMeter` and its pricing table from
 * `@rv/contracts`, the real `usage_records` table, the real aggregation. The fake is a
 * provider that returns token counts, which is what "fake providers only, `$0`" means:
 * no socket is opened and nothing is charged to anyone.
 */

import type { PipelineStageKey } from '@rv/contracts';
import type { ProviderUsage } from '@rv/providers';
import { ok, type AppError, type Result } from '@rv/shared-kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunSummary } from '../src/application/resources';
import type { CostReport } from '../src/cost/cost-report';
import type { MeteredCallRunner } from '../src/cost/metered-call';
import type { StageContext, StageHandler, StageOutput } from '../src/pipeline/stage';
import { buildStageRegistry, type StageRegistry } from '../src/pipeline/stage';
import { METERED_CALL_RUNNER } from '../src/tokens';
import { STAGE_REGISTRY } from '../src/tokens';
import { CREATE_PROJECT, IDEA_BRIEF } from './fixtures';
import { bootHarness, type Harness } from './harness';

/** A paid image call. `openai/gpt-5-image-mini` bills image-output tokens, so this costs. */
const PAID_IMAGE: ProviderUsage = {
  tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
  images: { count: 1, resolution: { width: 1024, height: 1024 } },
  latencyMs: 40,
};

/** The same work on the free local lane: recorded, and priced at nothing. */
const FREE_IMAGE: ProviderUsage = {
  tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
  images: { count: 1, resolution: { width: 512, height: 512 } },
  latencyMs: 60,
};

/**
 * A stage that spends, through the one path a stage is allowed to spend through.
 *
 * Three calls: two on the paid lane - one of which fails after burning its input - and
 * one on the free lane. Those are the three rows an aggregation gets wrong if it is
 * going to.
 */
class SpendingStage implements StageHandler {
  readonly stage: PipelineStageKey;
  readonly implemented = true;
  readonly #metered: MeteredCallRunner;
  readonly #deliveredMs: number | null;

  /** `deliveredMs: null` is a stage that ships no video, which is nine of the twelve. */
  constructor(stage: PipelineStageKey, metered: MeteredCallRunner, deliveredMs: number | null) {
    this.stage = stage;
    this.#metered = metered;
    this.#deliveredMs = deliveredMs;
  }

  async execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    const budget = { runId: context.run.id, perRunNanoUsd: context.run.budgetNanoUsd };
    const base = {
      projectId: context.run.projectId,
      budget,
      stage: this.stage,
      signal: context.signal,
    } as const;

    await this.#metered.run(
      {
        ...base,
        task: 'image-final',
        tier: 'final',
        provider: 'openrouter',
        model: 'openai/gpt-5-image-mini',
        estimate: PAID_IMAGE,
      },
      () => Promise.resolve(ok({ value: 'one', usage: PAID_IMAGE })),
    );

    await this.#metered.run(
      {
        ...base,
        task: 'image-final',
        tier: 'final',
        provider: 'openrouter',
        model: 'openai/gpt-5-image-mini',
        estimate: PAID_IMAGE,
      },
      () =>
        Promise.resolve({
          ok: false as const,
          // A call that burned its input and then returned a 500. Still billed, and a
          // ledger that only recorded successes would under-report exactly the runs
          // worth understanding.
          error: { code: 'PROVIDER_ERROR', kind: 'provider', retryable: true } as AppError,
        }),
    );

    await this.#metered.run(
      {
        ...base,
        task: 'image-draft',
        tier: 'draft',
        provider: 'comfyui',
        model: 'sdxl-turbo',
        estimate: FREE_IMAGE,
      },
      () => Promise.resolve(ok({ value: 'three', usage: FREE_IMAGE })),
    );

    context.reportProgress({ progress: 1, detail: 'spent' });
    // Built conditionally rather than assigning `undefined`: `exactOptionalPropertyTypes`
    // makes "absent" and "present and undefined" different types, and absent is the
    // honest one for a stage that delivered nothing.
    return ok({
      artifacts: ['fake:one'],
      ...(this.#deliveredMs === null ? {} : { deliveredMs: this.#deliveredMs }),
    });
  }
}

describe('the cost ledger', () => {
  let harness: Harness;
  let projectId: string;

  beforeAll(async () => {
    harness = await bootHarness({
      override: (builder) =>
        builder.overrideProvider(STAGE_REGISTRY).useFactory({
          inject: [METERED_CALL_RUNNER],
          factory: (metered: MeteredCallRunner): StageRegistry =>
            buildStageRegistry([
              // Two stages, so `byStage` has something to distinguish and the run has a
              // stage that delivered and a stage that did not.
              new SpendingStage('intake', metered, null),
              new SpendingStage('render', metered, 120_000),
            ]),
        }),
    });

    const created = await request(harness.server)
      .post('/api/projects')
      .send(CREATE_PROJECT)
      .expect(201);
    projectId = (created.body as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  async function settled(stages: readonly string[]): Promise<RunSummary> {
    const started = await request(harness.server)
      .post('/api/runs')
      .send({ projectId, stages, seed: 3, payload: { brief: IDEA_BRIEF } })
      .expect(202);
    const runId = (started.body as RunSummary).id;

    for (let attempt = 0; attempt < 400; attempt += 1) {
      const run = (await request(harness.server).get(`/api/runs/${runId}`).expect(200))
        .body as RunSummary;
      if (run.status === 'succeeded' || run.status === 'failed') return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the run never settled');
  }

  it('records every provider call, and the ledger totals reconcile against them', async () => {
    const run = await settled(['intake', 'render']);
    expect(run.status).toBe('succeeded');

    const ledger = (await request(harness.server).get(`/api/runs/${run.id}/ledger`).expect(200))
      .body as {
      projectId: string;
      runId: string;
      records: {
        stage: string;
        provider: string;
        costNanoUsd: number;
        outcome: string;
        cacheHit: boolean;
      }[];
      summary: {
        total: { calls: number; failures: number; costNanoUsd: number };
        byStage: Record<string, { calls: number; costNanoUsd: number }>;
        byProvider: Record<string, { calls: number; costNanoUsd: number }>;
      };
    };

    // Three calls per stage, two stages, and every one of them on the record - including
    // the failure and including the free one.
    expect(ledger.records).toHaveLength(6);
    expect(ledger.runId).toBe(run.id);
    expect(ledger.projectId).toBe(projectId);
    expect(ledger.summary.total.calls).toBe(6);
    expect(ledger.summary.total.failures).toBe(2);

    // **The reconciliation.** The summary is not allowed to be a second opinion: it must
    // be the sum of the rows it claims to summarise, and the run's denormalised
    // `spentNanoUsd` - the number the budget guard reads - must be the same figure.
    const fromRows = ledger.records.reduce((total, row) => total + row.costNanoUsd, 0);
    expect(ledger.summary.total.costNanoUsd).toBe(fromRows);
    expect(run.spentNanoUsd).toBe(fromRows);
    expect(fromRows).toBeGreaterThan(0);

    // Per stage and per provider, and both must add back up to the same total.
    expect(Object.keys(ledger.summary.byStage).sort()).toEqual(['intake', 'render']);
    const byStage = Object.values(ledger.summary.byStage).reduce(
      (total, bucket) => total + bucket.costNanoUsd,
      0,
    );
    const byProvider = Object.values(ledger.summary.byProvider).reduce(
      (total, bucket) => total + bucket.costNanoUsd,
      0,
    );
    expect(byStage).toBe(fromRows);
    expect(byProvider).toBe(fromRows);

    // The free lane is recorded and free, which is a different fact from being absent.
    expect(ledger.summary.byProvider.comfyui?.calls).toBe(2);
    expect(ledger.summary.byProvider.comfyui?.costNanoUsd).toBe(0);
  });

  it('reports the same per-stage cost on the stage result the client already has', async () => {
    const run = await settled(['intake', 'render']);
    const ledger = (await request(harness.server).get(`/api/runs/${run.id}/ledger`).expect(200))
      .body as { summary: { byStage: Record<string, { costNanoUsd: number }> } };

    // The stage result used to carry a hard-coded zero, so a UI reading the run and a UI
    // reading the ledger disagreed about the same stage.
    for (const stage of run.stages) {
      expect(stage.costNanoUsd).toBe(ledger.summary.byStage[stage.stage]?.costNanoUsd);
      expect(stage.costNanoUsd).toBeGreaterThan(0);
    }
    expect(run.stages.reduce((total, stage) => total + stage.costNanoUsd, 0)).toBe(
      run.spentNanoUsd,
    );
  });

  it('prices a project by its delivered minute, per run and in total', async () => {
    const report = (
      await request(harness.server).get(`/api/projects/${projectId}/cost`).expect(200)
    ).body as CostReport;

    expect(report.projectId).toBe(projectId);
    expect(report.runs.length).toBeGreaterThan(0);

    // Every run here delivered two minutes through its `render` stage.
    const perMinute = report.nanoUsdPerDeliveredMinute;
    expect(report.deliveredMs).toBe(report.runs.length * 120_000);
    expect(perMinute).not.toBeNull();
    expect(perMinute).toBe(
      Math.round((report.summary.total.costNanoUsd * 60_000) / report.deliveredMs),
    );

    // The headline is the sum of the rows beneath it, or the screen argues with itself.
    const perRun = report.runs.reduce((total, row) => total + row.costNanoUsd, 0);
    expect(report.summary.total.costNanoUsd).toBe(perRun);

    const row = report.runs[0];
    if (row === undefined) throw new Error('the report listed no runs');
    expect(row.deliveredMs).toBe(120_000);
    expect(row.nanoUsdPerDeliveredMinute).toBe(Math.round((row.costNanoUsd * 60_000) / 120_000));
    expect(Object.keys(row.byStage).sort()).toEqual(['intake', 'render']);
  });

  it('reports no price per minute for a run that delivered nothing', async () => {
    const run = await settled(['intake']);
    const report = (
      await request(harness.server).get(`/api/projects/${projectId}/cost`).expect(200)
    ).body as CostReport;

    const row = report.runs.find((entry) => entry.runId === run.id);
    expect(row?.deliveredMs).toBeNull();
    // Not zero: money was spent and no minutes came out, which is the opposite of free.
    expect(row?.nanoUsdPerDeliveredMinute).toBeNull();
    expect(row?.costNanoUsd).toBeGreaterThan(0);
  });

  it('narrows the report to one series, and to none when the series has no runs', async () => {
    const empty = (
      await request(harness.server)
        .get(`/api/projects/${projectId}/cost`)
        .query({ seriesId: 'ser_01J0000000000000000000000Z' })
        .expect(200)
    ).body as CostReport;

    expect(empty.seriesId).toBe('ser_01J0000000000000000000000Z');
    expect(empty.runs).toEqual([]);
    expect(empty.summary.total.costNanoUsd).toBe(0);
    expect(empty.nanoUsdPerDeliveredMinute).toBeNull();
  });

  it('rejects a series filter that is not a series id, rather than ignoring it', async () => {
    // A typo must not silently widen the report to the whole project - that is a bill
    // for the wrong thing, reported as though it were the right thing.
    await request(harness.server)
      .get(`/api/projects/${projectId}/cost`)
      .query({ seriesId: 'not-an-id' })
      .expect(400);
  });
});
