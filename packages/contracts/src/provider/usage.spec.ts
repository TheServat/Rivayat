import { describe, expect, it } from 'vitest';

import { NanoUsdAmount } from '../primitives/common';
import { z } from 'zod';

import {
  BudgetPolicy,
  CostBucket,
  CostEstimate,
  CostLedger,
  CostSummary,
  ImageUsage,
  StructuredCallOutcome,
  StructuredCallResolution,
  TokenUsage,
  UsageRecord,
} from './usage';

/** ULID bodies are 26 Crockford base32 chars; these are the shortest legal stand-ins. */
const body = (tail: string): string => tail.padStart(26, '0');
const USAGE_ID = `usg_${body('A1')}`;
const RUN_ID = `run_${body('A2')}`;
const JOB_ID = `job_${body('A3')}`;
const PROJECT_ID = `prj_${body('A4')}`;
const AT = '2026-08-23T10:00:00+03:30';

const usageRecord = (overrides: Record<string, unknown> = {}): unknown => ({
  id: USAGE_ID,
  runId: RUN_ID,
  jobId: JOB_ID,
  stage: 'produce',
  provider: 'openrouter',
  model: 'google/gemini-3.1-flash-lite-image',
  task: 'image-final',
  tier: 'final',
  tokens: { input: 1200, output: 0, cached: 400, reasoning: 0 },
  images: { count: 1, resolution: { width: 1024, height: 1024 } },
  latencyMs: 4200,
  costNanoUsd: 33_600_000,
  outcome: 'success',
  errorCode: null,
  at: AT,
  ...overrides,
});

const estimate = (overrides: Record<string, unknown> = {}): unknown => ({
  items: 10,
  cacheHits: 7,
  cacheMisses: 3,
  lines: [
    {
      task: 'image-final',
      tier: 'final',
      provider: 'openrouter',
      model: 'google/gemini-3.1-flash-lite-image',
      count: 3,
      unitCostNanoUsd: 33_600_000,
      subtotalNanoUsd: 100_800_000,
    },
  ],
  projectedNanoUsd: 100_800_000,
  lowNanoUsd: 90_000_000,
  highNanoUsd: 151_000_000,
  assumptions: ['1024px output, ~1290 image tokens per image'],
  requiresConfirmation: false,
  computedAt: AT,
  ...overrides,
});

const outcome = (overrides: Record<string, unknown> = {}): unknown => ({
  provider: 'ollama',
  model: 'qwen3.5:latest',
  task: 'asset-spec',
  schemaName: 'AssetSpec',
  resolution: 'clean',
  attempts: 1,
  repairTurns: 0,
  fenceStripped: false,
  usedNativeSchemaEnforcement: true,
  escalatedTo: null,
  failedPaths: [],
  errorCode: null,
  totalLatencyMs: 1800,
  costNanoUsd: 0,
  at: AT,
  ...overrides,
});

describe('nano-dollar amounts', () => {
  it('accepts zero and whole nano-dollars', () => {
    expect(NanoUsdAmount.parse(0)).toBe(0);
    expect(NanoUsdAmount.parse(33_600_000)).toBe(33_600_000);
  });

  it('rejects a negative amount', () => {
    expect(NanoUsdAmount.safeParse(-1).success).toBe(false);
  });

  it('rejects a fractional amount, which is how float dollars leak in', () => {
    expect(NanoUsdAmount.safeParse(0.5).success).toBe(false);
    expect(NanoUsdAmount.safeParse(33_600_000.4).success).toBe(false);
  });
});

describe('UsageRecord', () => {
  it('records a successful metered call', () => {
    const record = UsageRecord.parse(usageRecord());
    expect(record.costNanoUsd).toBe(33_600_000);
    expect(record.images.resolution).toEqual({ width: 1024, height: 1024 });
    expect(record.cacheHit).toBe(false);
  });

  it('records a failed call too - a failure that burned input tokens still cost money', () => {
    const record = UsageRecord.parse(
      usageRecord({
        outcome: 'failure',
        errorCode: 'RATE_LIMITED',
        costNanoUsd: 250,
        images: { count: 0, resolution: null },
      }),
    );
    expect(record.outcome).toBe('failure');
    expect(record.errorCode).toBe('RATE_LIMITED');
    expect(record.images.count).toBe(0);
  });

  it('allows a call made outside a queued job', () => {
    expect(UsageRecord.parse(usageRecord({ jobId: null })).jobId).toBeNull();
  });

  it('rejects a negative cost', () => {
    expect(UsageRecord.safeParse(usageRecord({ costNanoUsd: -1 })).success).toBe(false);
  });

  it('rejects a fractional cost', () => {
    expect(UsageRecord.safeParse(usageRecord({ costNanoUsd: 1.5 })).success).toBe(false);
  });

  it('rejects a float dollar amount masquerading as a cost', () => {
    // $0.0336 written in dollars instead of nano-dollars.
    expect(UsageRecord.safeParse(usageRecord({ costNanoUsd: 0.0336 })).success).toBe(false);
  });

  it('rejects a timestamp without an offset, which cannot be ordered across machines', () => {
    expect(UsageRecord.safeParse(usageRecord({ at: '2026-08-23T10:00:00' })).success).toBe(false);
  });

  it('rejects a stage or task outside the pipeline vocabulary', () => {
    expect(UsageRecord.safeParse(usageRecord({ stage: 'storyboard' })).success).toBe(false);
    expect(UsageRecord.safeParse(usageRecord({ task: 'vibe-check' })).success).toBe(false);
  });

  it('defaults token and image counts to zero rather than to undefined', () => {
    expect(TokenUsage.parse({})).toEqual({ input: 0, output: 0, cached: 0, reasoning: 0 });
    expect(ImageUsage.parse({})).toEqual({ count: 0, resolution: null });
  });

  it('rejects negative token counts', () => {
    expect(TokenUsage.safeParse({ input: -1 }).success).toBe(false);
    expect(TokenUsage.safeParse({ reasoning: 2.5 }).success).toBe(false);
  });
});

describe('CostSummary and CostLedger', () => {
  it('starts every bucket at zero', () => {
    expect(CostBucket.parse({})).toEqual({
      calls: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      images: 0,
      costNanoUsd: 0,
    });
  });

  it('groups by provider, model, task and stage without demanding every key', () => {
    const summary = CostSummary.parse({
      total: { calls: 2, costNanoUsd: 33_600_250 },
      byProvider: { openrouter: { calls: 1, costNanoUsd: 33_600_000 } },
      byModel: { 'google/gemini-3.1-flash-lite-image': { calls: 1, costNanoUsd: 33_600_000 } },
      byTask: { 'image-final': { calls: 1, costNanoUsd: 33_600_000 } },
      byStage: { produce: { calls: 1, costNanoUsd: 33_600_000 } },
    });
    expect(summary.byProvider.openrouter?.costNanoUsd).toBe(33_600_000);
    expect(summary.byStage.produce?.calls).toBe(1);
    expect(summary.byProvider.ollama).toBeUndefined();
  });

  it('rejects a grouping key that is not a known provider or stage', () => {
    const base = { total: {} };
    expect(CostSummary.safeParse({ ...base, byProvider: { midjourney: {} } }).success).toBe(false);
    expect(CostSummary.safeParse({ ...base, byStage: { storyboard: {} } }).success).toBe(false);
  });

  it('rejects a negative total, which would net off a real charge', () => {
    expect(CostSummary.safeParse({ total: { costNanoUsd: -1 } }).success).toBe(false);
  });

  it('keeps the raw records beside the summary so the totals can be audited', () => {
    const ledger = CostLedger.parse({
      projectId: PROJECT_ID,
      runId: RUN_ID,
      records: [usageRecord()],
      summary: { total: { calls: 1, costNanoUsd: 33_600_000 } },
      updatedAt: AT,
    });
    expect(ledger.records).toHaveLength(1);
    expect(ledger.from).toBeNull();
    expect(ledger.summary.total.costNanoUsd).toBe(33_600_000);
  });
});

describe('BudgetPolicy', () => {
  it('defaults to no ceilings and an abort, so an unconfigured project cannot overspend quietly', () => {
    expect(BudgetPolicy.parse({})).toEqual({
      perRunNanoUsd: null,
      perDayNanoUsd: null,
      perProjectNanoUsd: null,
      confirmAboveNanoUsd: null,
      onExceed: 'abort',
    });
  });

  it('carries all three scopes plus the confirm threshold', () => {
    const policy = BudgetPolicy.parse({
      perRunNanoUsd: 5_000_000_000,
      perDayNanoUsd: 20_000_000_000,
      perProjectNanoUsd: 100_000_000_000,
      confirmAboveNanoUsd: 1_000_000_000,
      onExceed: 'pause',
    });
    expect(policy.perRunNanoUsd).toBe(5_000_000_000);
    expect(policy.confirmAboveNanoUsd).toBe(1_000_000_000);
    expect(policy.onExceed).toBe('pause');
  });

  it('rejects a negative or fractional ceiling', () => {
    expect(BudgetPolicy.safeParse({ perRunNanoUsd: -1 }).success).toBe(false);
    expect(BudgetPolicy.safeParse({ confirmAboveNanoUsd: 1.5 }).success).toBe(false);
  });
});

describe('CostEstimate', () => {
  it('accepts a coherent estimate', () => {
    const parsed = CostEstimate.parse(estimate());
    expect(parsed.cacheHits + parsed.cacheMisses).toBe(parsed.items);
    expect(parsed.lines).toHaveLength(1);
  });

  it('refuses an estimate whose hits and misses do not account for every item', () => {
    const result = CostEstimate.safeParse(estimate({ cacheHits: 6 }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('items');
  });

  it('refuses an inverted bracket', () => {
    const result = CostEstimate.safeParse(
      estimate({ lowNanoUsd: 200_000_000, highNanoUsd: 100_000_000 }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('lowNanoUsd');
  });

  it('refuses a projection outside its own bracket', () => {
    const result = CostEstimate.safeParse(estimate({ projectedNanoUsd: 500_000_000 }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('projectedNanoUsd');
  });

  it('refuses an estimate with no stated assumptions', () => {
    expect(CostEstimate.safeParse(estimate({ assumptions: [] })).success).toBe(false);
  });

  it('represents the all-cached run that the dedup architecture is built to produce', () => {
    const parsed = CostEstimate.parse(
      estimate({
        items: 42,
        cacheHits: 42,
        cacheMisses: 0,
        lines: [],
        projectedNanoUsd: 0,
        lowNanoUsd: 0,
        highNanoUsd: 0,
        assumptions: ['every asset already in the registry at this style checksum'],
      }),
    );
    expect(parsed.projectedNanoUsd).toBe(0);
    expect(parsed.requiresConfirmation).toBe(false);
  });

  it('rejects a fractional projected cost', () => {
    expect(CostEstimate.safeParse(estimate({ projectedNanoUsd: 100_800_000.5 })).success).toBe(
      false,
    );
  });
});

describe('StructuredCallOutcome', () => {
  it('names the five escalating resolutions', () => {
    expect(StructuredCallResolution.options).toEqual([
      'clean',
      'fence-stripped',
      'repaired',
      'escalated',
      'failed',
    ]);
  });

  it('records a clean first-try parse', () => {
    const parsed = StructuredCallOutcome.parse(outcome());
    expect(parsed.resolution).toBe('clean');
    expect(parsed.failedPaths).toEqual([]);
  });

  it('records the fenced-JSON symptom research 1 documents for Ollama', () => {
    const parsed = StructuredCallOutcome.parse(
      outcome({
        resolution: 'fence-stripped',
        fenceStripped: true,
        usedNativeSchemaEnforcement: false,
      }),
    );
    expect(parsed.fenceStripped).toBe(true);
    expect(parsed.usedNativeSchemaEnforcement).toBe(false);
  });

  it('records how many repair turns a model needed and which fields it kept getting wrong', () => {
    const parsed = StructuredCallOutcome.parse(
      outcome({
        resolution: 'repaired',
        attempts: 3,
        repairTurns: 2,
        failedPaths: ['parts.0.anchor', 'palette.1.hex'],
      }),
    );
    expect(parsed.repairTurns).toBe(2);
    expect(parsed.failedPaths).toEqual(['parts.0.anchor', 'palette.1.hex']);
  });

  it('records an escalation, including what it escalated to', () => {
    const parsed = StructuredCallOutcome.parse(
      outcome({
        resolution: 'escalated',
        attempts: 4,
        repairTurns: 2,
        escalatedTo: 'gemini-3-flash',
        costNanoUsd: 1_250_000,
      }),
    );
    expect(parsed.escalatedTo).toBe('gemini-3-flash');
    expect(parsed.costNanoUsd).toBe(1_250_000);
  });

  it('refuses an escalation that does not say where it went', () => {
    const result = StructuredCallOutcome.safeParse(
      outcome({ resolution: 'escalated', attempts: 2, repairTurns: 1 }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('escalatedTo');
  });

  it('refuses a failure without an error code', () => {
    const result = StructuredCallOutcome.safeParse(
      outcome({ resolution: 'failed', attempts: 3, repairTurns: 2 }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('errorCode');
  });

  it('records a genuine failure', () => {
    const parsed = StructuredCallOutcome.parse(
      outcome({
        resolution: 'failed',
        attempts: 3,
        repairTurns: 2,
        errorCode: 'VALIDATION_FAILED',
        failedPaths: ['beats'],
      }),
    );
    expect(parsed.errorCode).toBe('VALIDATION_FAILED');
  });

  it('refuses a "clean" parse that needed a repair turn', () => {
    const result = StructuredCallOutcome.safeParse(
      outcome({ resolution: 'clean', attempts: 2, repairTurns: 1 }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('repairTurns');
  });

  it('refuses more repair turns than round-trips', () => {
    const result = StructuredCallOutcome.safeParse(
      outcome({ resolution: 'repaired', attempts: 2, repairTurns: 2 }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('repairTurns');
  });

  it('requires at least one attempt', () => {
    expect(StructuredCallOutcome.safeParse(outcome({ attempts: 0 })).success).toBe(false);
  });
});

describe('JSON Schema emission', () => {
  it('emits for every cost and telemetry schema', () => {
    for (const schema of [
      UsageRecord,
      CostSummary,
      CostLedger,
      BudgetPolicy,
      CostEstimate,
      StructuredCallOutcome,
    ]) {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
    }
  });
});
