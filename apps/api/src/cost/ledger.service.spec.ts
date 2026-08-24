/**
 * The read side of the ledger, and the alarm it raises when the two sides disagree.
 *
 * `ledger.e2e-spec.ts` proves the happy path over a real run and a real table. What that
 * cannot produce on purpose is the failure this service exists to notice: `appendUsage`
 * silently failing, so the durable rows and the in-process meter drift apart.
 * `MeteredCallRunner` deliberately does not fail a provider call over a persistence
 * error - the call succeeded and the caller should get its answer - which means the
 * divergence has no other place to surface.
 */

import { Ids, type ProjectId, type RunId, type UsageRecord } from '@rv/contracts';
import type { RecordCallInput } from '@rv/providers';
import {
  FixedClock,
  InternalError,
  MemoryLogger,
  instant,
  isErr,
  ok,
  type Result,
} from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import type { RunRepository } from '../application/ports/repository.ports';
import { RunSummary, type RunStatus } from '../application/resources';
import { CostService } from './cost.service';
import { LedgerService } from './ledger.service';

const PROJECT = 'prj_01J0000000000000000000000A' as ProjectId;
const RUN_A = 'run_01J0000000000000000000000A' as RunId;
const RUN_B = 'run_01J0000000000000000000000B' as RunId;
const CLOCK = new FixedClock(instant(1_700_000_000_000));

function paidCall(runId: RunId, stage: 'story' | 'render'): RecordCallInput {
  return {
    runId,
    stage,
    provider: 'openrouter',
    model: 'openai/gpt-5-image-mini',
    task: 'image-final',
    tier: 'final',
    usage: {
      tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
      images: { count: 1, resolution: { width: 1024, height: 1024 } },
      latencyMs: 10,
    },
    outcome: 'success',
  };
}

function run(id: RunId, deliveredMs: number | null, seriesId: string | null): RunSummary {
  return RunSummary.parse({
    id,
    projectId: PROJECT,
    seriesId,
    status: 'succeeded' satisfies RunStatus,
    requestedStages: ['story', 'render'],
    currentStage: null,
    stages: [
      {
        stage: 'story',
        status: 'succeeded',
        costNanoUsd: 0,
        durationMs: 1,
        artifacts: [],
        errorCode: null,
        inputHash: null,
        deliveredMs: null,
      },
      {
        stage: 'render',
        status: 'succeeded',
        costNanoUsd: 0,
        durationMs: 1,
        artifacts: [],
        errorCode: null,
        inputHash: null,
        deliveredMs,
      },
    ],
    seed: 1,
    budgetNanoUsd: null,
    spentNanoUsd: 0,
    errorCode: null,
    startedAt: '2026-08-24T00:00:00.000Z',
    finishedAt: '2026-08-24T00:01:00.000Z',
  });
}

/** A repository that answers from what the test put in it, and can be made to fail. */
class StubRunRepository implements Partial<RunRepository> {
  readonly runs: RunSummary[] = [];
  readonly rows = new Map<RunId, UsageRecord[]>();
  failUsage = false;
  failList = false;

  listByProject(): Promise<Result<readonly RunSummary[]>> {
    return Promise.resolve(
      this.failList
        ? { ok: false, error: new InternalError({ message: 'no database' }) }
        : ok(this.runs),
    );
  }

  usage(id: RunId): Promise<Result<readonly UsageRecord[]>> {
    return Promise.resolve(
      this.failUsage
        ? { ok: false, error: new InternalError({ message: 'no database' }) }
        : ok(this.rows.get(id) ?? []),
    );
  }
}

interface Fixture {
  readonly ledger: LedgerService;
  readonly repository: StubRunRepository;
  readonly cost: CostService;
  readonly logger: MemoryLogger;
}

function build(): Fixture {
  const logger = new MemoryLogger();
  const cost = new CostService({
    clock: CLOCK,
    logger,
    ids: new Ids(),
    policy: {
      perRunNanoUsd: null,
      perDayNanoUsd: null,
      perProjectNanoUsd: null,
      confirmAboveNanoUsd: null,
      onExceed: 'abort',
    },
  });
  const repository = new StubRunRepository();
  const ledger = new LedgerService({
    runs: repository as unknown as RunRepository,
    cost,
    clock: CLOCK,
    logger,
  });
  return { ledger, repository, cost, logger };
}

/** Records the calls in the meter *and* in the repository, the way a healthy run does. */
function spend(fixture: Fixture, runId: RunId, stages: readonly ('story' | 'render')[]): void {
  const rows: UsageRecord[] = [];
  for (const stage of stages) rows.push(fixture.cost.record(PROJECT, paidCall(runId, stage)));
  fixture.repository.rows.set(runId, rows);
}

describe('LedgerService.forRun', () => {
  it('reads the durable rows and summarises them', async () => {
    const fixture = build();
    spend(fixture, RUN_A, ['story', 'render', 'render']);

    const ledger = await fixture.ledger.forRun(PROJECT, RUN_A);
    if (isErr(ledger)) throw ledger.error;

    expect(ledger.value.runId).toBe(RUN_A);
    expect(ledger.value.records).toHaveLength(3);
    expect(Object.keys(ledger.value.summary.byStage).sort()).toEqual(['render', 'story']);
    expect(ledger.value.summary.total.costNanoUsd).toBe(
      ledger.value.records.reduce((total, row) => total + row.costNanoUsd, 0),
    );
  });

  it('says nothing about a mismatch when the rows agree', async () => {
    const fixture = build();
    spend(fixture, RUN_A, ['story']);
    await fixture.ledger.forRun(PROJECT, RUN_A);
    expect(fixture.logger.records.filter((record) => record.level === 'error')).toEqual([]);
  });

  it('reports an error when a row this process wrote never reached the database', async () => {
    const fixture = build();
    spend(fixture, RUN_A, ['story', 'render']);
    // `appendUsage` failed for the second call: the meter has two rows, the table has
    // one. The budget guard and the invoice are now working from different numbers, and
    // this is the only place that difference can be seen.
    fixture.repository.rows.set(
      RUN_A,
      [fixture.repository.rows.get(RUN_A)?.[0]].flatMap((row) => (row === undefined ? [] : [row])),
    );

    await fixture.ledger.forRun(PROJECT, RUN_A);

    const errors = fixture.logger.records.filter((record) => record.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields).toMatchObject({ durableRows: 1, meteredRows: 2 });
  });

  it('does not cry mismatch when this process simply made no calls', async () => {
    // The normal case for a resumed run, or any read from a process that did not spend.
    const fixture = build();
    const rows = [fixture.cost.record(PROJECT, paidCall(RUN_B, 'story'))];
    fixture.repository.rows.set(RUN_A, rows);

    await fixture.ledger.forRun(PROJECT, RUN_A);
    expect(fixture.logger.records.filter((record) => record.level === 'error')).toEqual([]);
  });

  it('passes a storage failure through rather than reporting an empty bill', async () => {
    const fixture = build();
    fixture.repository.failUsage = true;
    const ledger = await fixture.ledger.forRun(PROJECT, RUN_A);
    // An empty ledger and an unreadable one look identical to a client, and only one of
    // them means "you spent nothing".
    expect(isErr(ledger)).toBe(true);
  });
});

describe('LedgerService.forProject', () => {
  it('prices every run and the project by its delivered minutes', async () => {
    const fixture = build();
    fixture.repository.runs.push(run(RUN_A, 60_000, null), run(RUN_B, 60_000, null));
    spend(fixture, RUN_A, ['story']);
    spend(fixture, RUN_B, ['render']);

    const report = await fixture.ledger.forProject(PROJECT);
    if (isErr(report)) throw report.error;

    expect(report.value.runs).toHaveLength(2);
    expect(report.value.deliveredMs).toBe(120_000);
    expect(report.value.nanoUsdPerDeliveredMinute).toBe(
      Math.round((report.value.summary.total.costNanoUsd * 60_000) / 120_000),
    );
  });

  it('narrows to one series and leaves the other runs out of the total', async () => {
    const fixture = build();
    const series = 'ser_01J0000000000000000000000A';
    fixture.repository.runs.push(run(RUN_A, 60_000, series), run(RUN_B, 60_000, null));
    spend(fixture, RUN_A, ['story']);
    spend(fixture, RUN_B, ['render', 'render']);

    const report = await fixture.ledger.forProject(PROJECT, series);
    if (isErr(report)) throw report.error;

    expect(report.value.seriesId).toBe(series);
    expect(report.value.runs.map((row) => row.runId)).toEqual([RUN_A]);
    expect(report.value.deliveredMs).toBe(60_000);
  });

  it('passes a storage failure through, from either read', async () => {
    const fixture = build();
    fixture.repository.failList = true;
    expect(isErr(await fixture.ledger.forProject(PROJECT))).toBe(true);

    fixture.repository.failList = false;
    fixture.repository.runs.push(run(RUN_A, null, null));
    fixture.repository.failUsage = true;
    expect(isErr(await fixture.ledger.forProject(PROJECT))).toBe(true);
  });
});
