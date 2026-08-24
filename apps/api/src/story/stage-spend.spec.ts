/**
 * The metering adapter, on its own.
 *
 * The properties asserted here are the two halves of non-negotiable #3 that are easy to
 * half-implement: the estimate that reaches the guard is a *ceiling over the calls the
 * stage is about to make*, and the usage that reaches the ledger is what the traces
 * said - not the estimate, which would bill every stage the same amount whatever it did.
 */

import { describe, expect, it } from 'vitest';
import type { StructuredTrace } from '@rv/prompt-kit';
import { ValidationError, err, isErr, ok } from '@rv/shared-kernel';

import {
  RecordingMeter,
  fakeRouter,
  stageContext,
  unroutableRouter,
} from './__fixtures__/story-fakes';
import {
  ESTIMATED_TOKENS_PER_CALL,
  estimateFor,
  meteredStageWork,
  spentNanoUsd,
  usageOf,
} from './stage-spend';

function trace(costNanoUsd: number, input: number, output: number): StructuredTrace {
  return {
    schemaName: 'Whatever',
    resolution: 'clean',
    modelId: 'ollama:qwen3.5:latest',
    attempts: 1,
    repairTurns: 0,
    fenceStripped: false,
    usedNativeSchemaEnforcement: false,
    escalatedTo: null,
    failedPaths: [],
    errorCode: null,
    totalLatencyMs: 12,
    costNanoUsd,
    usage: { inputTokens: input, outputTokens: output },
    extractionSteps: [],
  };
}

describe('estimateFor', () => {
  it('scales with the number of calls, and never estimates nothing', () => {
    expect(estimateFor(3).tokens.input).toBe(ESTIMATED_TOKENS_PER_CALL.input * 3);
    // A guard handed zero would wave through the one run that matters, so a stage that
    // has not worked out its fan-out is still charged for one call.
    expect(estimateFor(0).tokens.input).toBe(ESTIMATED_TOKENS_PER_CALL.input);
    expect(estimateFor(1.2).tokens.output).toBe(ESTIMATED_TOKENS_PER_CALL.output * 2);
    expect(estimateFor(1).images.count).toBe(0);
  });
});

describe('usageOf and spentNanoUsd', () => {
  it('sums every trace, including the repair turns that were billed', () => {
    const traces = [trace(1_000, 100, 50), trace(2_500, 40, 10)];

    expect(usageOf(traces).tokens.input).toBe(140);
    expect(usageOf(traces).tokens.output).toBe(60);
    expect(usageOf(traces).latencyMs).toBe(24);
    expect(spentNanoUsd(traces)).toBe(3_500);
  });

  it('answers zero for a stage that made no call at all', () => {
    expect(usageOf([]).tokens.input).toBe(0);
    expect(spentNanoUsd([])).toBe(0);
  });
});

describe('meteredStageWork', () => {
  it('records what the traces said rather than what was estimated', async () => {
    const meter = new RecordingMeter();
    const { context } = stageContext({ budgetNanoUsd: 5_000_000 });

    const outcome = await meteredStageWork(
      { meter, router: fakeRouter },
      { context, stage: 'story', task: 'story-outline', tier: 'draft', calls: 4 },
      () => Promise.resolve(ok({ value: 'done', traces: [trace(900, 11, 7)] })),
    );

    expect(isErr(outcome)).toBe(false);
    if (isErr(outcome)) return;
    expect(outcome.value).toBe('done');
    expect(meter.specs[0]?.estimate.tokens.input).toBe(ESTIMATED_TOKENS_PER_CALL.input * 4);
    expect(meter.specs[0]?.budget.perRunNanoUsd).toBe(5_000_000);
    expect(meter.usages[0]?.tokens.input).toBe(11);
  });

  it('names the model the work was routed to, not a placeholder', async () => {
    const meter = new RecordingMeter();
    const { context } = stageContext();

    await meteredStageWork(
      { meter, router: fakeRouter },
      { context, stage: 'cast', task: 'prompt-compose', tier: 'final', calls: 1 },
      () => Promise.resolve(ok({ value: 1, traces: [] })),
    );

    expect(meter.specs[0]).toMatchObject({
      provider: 'ollama',
      model: 'qwen3.5:latest',
      stage: 'cast',
      task: 'prompt-compose',
    });
  });

  it('refuses before the guard when nothing can serve the stage', async () => {
    const meter = new RecordingMeter();
    const { context } = stageContext();
    let invoked = false;

    const outcome = await meteredStageWork(
      { meter, router: unroutableRouter },
      { context, stage: 'world', task: 'continuity-check', tier: 'preview', calls: 1 },
      () => {
        invoked = true;
        return Promise.resolve(ok({ value: 1, traces: [] }));
      },
    );

    expect(isErr(outcome)).toBe(true);
    expect(meter.specs).toHaveLength(0);
    expect(invoked).toBe(false);
  });

  it('carries a failure out of the closure without recording a success', async () => {
    const meter = new RecordingMeter();
    const { context } = stageContext();

    const outcome = await meteredStageWork(
      { meter, router: fakeRouter },
      { context, stage: 'story', task: 'story-outline', tier: 'draft', calls: 1 },
      () => Promise.resolve(err(new ValidationError({ message: 'the work refused' }))),
    );

    expect(isErr(outcome)).toBe(true);
    expect(meter.usages).toHaveLength(0);
  });
});
