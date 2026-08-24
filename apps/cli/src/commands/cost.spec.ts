import { mkdir } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CostSummary, RunId, UsageRecord } from '@rv/contracts';

import { parseArgs } from '../cli/args';
import { EXIT } from '../cli/exit';
import { jsonOut, makeHarness, type Harness } from '../__fixtures__/harness';
import { DOCUMENT_VERSION, LedgerDocument } from '../store/documents';
import { writeJson } from '../store/json-file';
import { runPaths } from '../store/layout';
import { listProjects } from '../store/project';
import { costReportCommand, seriesCostCommand, summariseRecords } from './cost';
import { projectNewCommand } from './project';

const RUN_ID = 'run_01J8ZQ4E7K9M2N4P6R8T0V0001' as RunId;

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'usg_01J8ZQ4E7K9M2N4P6R8T0V0001',
    runId: RUN_ID,
    jobId: null,
    stage: 'story',
    provider: 'ollama',
    model: 'qwen3.5:latest',
    task: 'story-outline',
    tier: 'draft',
    tokens: { input: 1200, output: 800, cached: 0, reasoning: 0 },
    images: { count: 0, resolution: null },
    latencyMs: 4200,
    costNanoUsd: 0,
    outcome: 'success',
    errorCode: null,
    cacheHit: false,
    at: '2026-08-23T18:00:00.000Z',
    ...overrides,
  };
}

async function seedLedger(harness: Harness, records: readonly UsageRecord[]): Promise<void> {
  const all = await listProjects(harness.workspaceRoot);
  if (!all.ok || all.value[0] === undefined) throw new Error('no project');
  const project = all.value[0];
  const written = await writeJson(runPaths(project.paths, RUN_ID).ledger, LedgerDocument, {
    version: DOCUMENT_VERSION,
    runId: RUN_ID,
    projectId: project.record.id,
    records: [...records],
    updatedAt: '2026-08-23T18:00:00.000Z',
  });
  if (!written.ok) throw written.error;
}

describe('summariseRecords', () => {
  const clock = { now: () => 0 as never };

  it('is zero on an empty ledger', () => {
    const summary: CostSummary = summariseRecords([], 'prj_x', clock);
    expect(summary.total.calls).toBe(0);
    expect(summary.total.costNanoUsd).toBe(0);
  });

  /**
   * The audit property. `CostMeter` would otherwise re-price each row from today's
   * catalogue, so an old ledger would move whenever a provider changed its price list.
   */
  it('keeps the price that was charged rather than re-pricing from the catalogue', () => {
    const summary = summariseRecords(
      [record({ provider: 'gemini', model: 'gemini-3-flash', costNanoUsd: 4_242 })],
      'prj_x',
      clock,
    );
    expect(summary.total.costNanoUsd).toBe(4_242);
  });

  it('slices by provider, stage, model and task', () => {
    const summary = summariseRecords(
      [
        record({ costNanoUsd: 100 }),
        record({ stage: 'produce', provider: 'comfyui', model: 'dreamshaper_8', costNanoUsd: 0 }),
      ],
      'prj_x',
      clock,
    );
    expect(Object.keys(summary.byProvider).sort()).toEqual(['comfyui', 'ollama']);
    expect(Object.keys(summary.byStage).sort()).toEqual(['produce', 'story']);
    expect(summary.total.calls).toBe(2);
  });

  it('counts a failed call, because a failure that burned tokens still cost money', () => {
    const summary = summariseRecords(
      [record({ outcome: 'failure', errorCode: 'TIMEOUT', costNanoUsd: 55 })],
      'prj_x',
      clock,
    );
    expect(summary.total.failures).toBe(1);
    expect(summary.total.costNanoUsd).toBe(55);
  });
});

describe('rv cost report', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
    await projectNewCommand.run(harness.context, parseArgs(['demo']));
    harness.io.stdout.length = 0;
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('reports the per-provider and per-stage breakdown for one run', async () => {
    await seedLedger(harness, [record({ costNanoUsd: 0 }), record({ costNanoUsd: 12_000 })]);
    const code = await costReportCommand.run(
      harness.context,
      parseArgs(['--run', RUN_ID, '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.ok);
    const data = jsonOut(harness.io).data as { summary: CostSummary; recordCount: number };
    expect(data.recordCount).toBe(2);
    expect(data.summary.byStage.story?.costNanoUsd).toBe(12_000);
  });

  it('exits 1 for a run with no ledger', async () => {
    const code = await costReportCommand.run(
      harness.context,
      parseArgs(['--run', 'run_01J8ZQ4E7K9M2N4P6R8T0V0002', '--json'], { booleans: ['json'] }),
    );
    expect(code).toBe(EXIT.failed);
    expect(jsonOut(harness.io).code).toBe('NOT_FOUND');
  });

  it('exits 2 without --run', async () => {
    expect(await costReportCommand.run(harness.context, parseArgs([]))).toBe(EXIT.usage);
  });
});

describe('rv series cost', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
    await projectNewCommand.run(harness.context, parseArgs(['demo']));
    harness.io.stdout.length = 0;
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('totals nothing, and says so, before any run exists', async () => {
    const code = await seriesCostCommand.run(harness.context, parseArgs([]));
    expect(code).toBe(EXIT.ok);
    expect(harness.io.outText).toContain('No runs');
  });

  /**
   * A render and a delivery call no paid provider, so they write no ledger. Counting
   * only ledgered runs reported `runs: 0` straight after a successful free-lane run,
   * which reads as "nothing happened" - the opposite of the $0 proof this command is
   * for. An unmetered run is listed at zero and flagged, never omitted.
   */
  it('lists a run that spent nothing rather than omitting it', async () => {
    const all = await listProjects(harness.workspaceRoot);
    if (!all.ok || all.value[0] === undefined) throw new Error('no project');
    const project = all.value[0];
    // A run directory with a record but no ledger - exactly what `rv render` leaves.
    await mkdir(runPaths(project.paths, RUN_ID).root, { recursive: true });

    await seriesCostCommand.run(harness.context, parseArgs(['--json'], { booleans: ['json'] }));
    const data = jsonOut(harness.io).data as {
      runs: number;
      totalNanoUsd: number;
      byRun: { runId: string; metered: boolean; costNanoUsd: number }[];
    };
    expect(data.runs).toBe(1);
    expect(data.totalNanoUsd).toBe(0);
    expect(data.byRun[0]).toMatchObject({ runId: RUN_ID, metered: false, costNanoUsd: 0 });
  });

  /** The M8 proof is "$0 on the free lane"; this is the number that would show it. */
  it('reports a free-lane run as exactly zero', async () => {
    await seedLedger(harness, [record({ costNanoUsd: 0 }), record({ costNanoUsd: 0 })]);
    await seriesCostCommand.run(harness.context, parseArgs(['--json'], { booleans: ['json'] }));
    const data = jsonOut(harness.io).data as {
      totalNanoUsd: number;
      runs: number;
      byRun: { metered: boolean }[];
    };
    expect(data.runs).toBe(1);
    expect(data.totalNanoUsd).toBe(0);
    // Zero *and* metered: the free lane really was measured, not merely unrecorded.
    expect(data.byRun[0]?.metered).toBe(true);
  });

  it('sums across runs in integer nano-dollars, so the totals reconcile exactly', async () => {
    await seedLedger(harness, [record({ costNanoUsd: 3 }), record({ costNanoUsd: 4 })]);
    await seriesCostCommand.run(harness.context, parseArgs(['--json'], { booleans: ['json'] }));
    const data = jsonOut(harness.io).data as { totalNanoUsd: number };
    expect(data.totalNanoUsd).toBe(7);
  });
});
