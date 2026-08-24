import { describe, expect, it } from 'vitest';
import type { RunId } from '@rv/contracts';
import { millis, type NanoUsd } from '@rv/shared-kernel';

import { deterministicIds, fixedClock, testProjectId, testRunId } from '../__fixtures__/support';
import type { ProviderUsage } from '../ports/common';
import { CostMeter, type RecordCallInput } from './cost-meter';

function usageOf(parts: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    images: { count: 0, resolution: null },
    latencyMs: 120,
    ...parts,
  };
}

function meterUnderTest(): {
  meter: CostMeter;
  runId: RunId;
  clock: ReturnType<typeof fixedClock>;
} {
  const clock = fixedClock();
  const ids = deterministicIds(clock);
  const meter = new CostMeter({ clock, projectId: testProjectId(ids), ids });
  return { meter, runId: testRunId(ids), clock };
}

function callOn(runId: RunId, overrides: Partial<RecordCallInput> = {}): RecordCallInput {
  return {
    runId,
    stage: 'story',
    provider: 'ollama',
    model: 'qwen3.5:latest',
    task: 'story-outline',
    tier: 'draft',
    usage: usageOf(),
    outcome: 'success',
    ...overrides,
  };
}

describe('CostMeter.record', () => {
  it('writes a row for a failed call too', () => {
    // A call that burned input tokens and then 500'd still cost money. A ledger that
    // only records successes under-reports exactly the runs worth understanding.
    const { meter, runId } = meterUnderTest();
    const row = meter.record(
      callOn(runId, {
        outcome: 'failure',
        errorCode: 'PROVIDER_ERROR',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
      }),
    );

    expect(row.outcome).toBe('failure');
    expect(row.errorCode).toBe('PROVIDER_ERROR');
    expect(meter.records()).toHaveLength(1);
  });

  it('prices from the catalogue when the caller does not supply a cost', () => {
    const { meter, runId } = meterUnderTest();
    const row = meter.record(
      callOn(runId, {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-image',
        task: 'image-final',
        tier: 'final',
        usage: usageOf({
          images: { count: 1, resolution: { width: 1024, height: 1024 } },
          imageOutputTokens: 1290,
        }),
      }),
    );

    expect(row.costNanoUsd).toBe(38_700_000);
  });

  it('prices a local call to exactly zero', () => {
    const { meter, runId } = meterUnderTest();
    const row = meter.record(
      callOn(runId, {
        usage: usageOf({ tokens: { input: 900, output: 400, cached: 0, reasoning: 0 } }),
      }),
    );
    expect(row.costNanoUsd).toBe(0);
  });

  it('records a cache hit as free even when the model is paid', () => {
    const { meter, runId } = meterUnderTest();
    const row = meter.record(
      callOn(runId, {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-image',
        cacheHit: true,
        usage: usageOf({ images: { count: 1, resolution: { width: 1024, height: 1024 } } }),
      }),
    );

    expect(row.cacheHit).toBe(true);
    expect(row.costNanoUsd).toBe(0);
  });

  it('honours an explicit cost so an old run can be re-priced at the rates of its day', () => {
    const { meter, runId } = meterUnderTest();
    const row = meter.record(callOn(runId, { costNanoUsd: 1_234 as NanoUsd }));
    expect(row.costNanoUsd).toBe(1_234);
  });

  it('carries the fields the ledger is queried by', () => {
    const { meter, runId } = meterUnderTest();
    const row = meter.record(callOn(runId, { usage: usageOf({ latencyMs: millis(87) }) }));

    expect(row).toMatchObject({
      runId,
      jobId: null,
      stage: 'story',
      provider: 'ollama',
      model: 'qwen3.5:latest',
      task: 'story-outline',
      tier: 'draft',
      latencyMs: 87,
      cacheHit: false,
      errorCode: null,
    });
    expect(row.at).toBe('2026-08-23T12:00:00.000Z');
  });
});

describe('CostMeter totals', () => {
  it('sums ten thousand tiny paid calls exactly', () => {
    const { meter, runId } = meterUnderTest();
    for (let i = 0; i < 10_000; i += 1) {
      meter.record(callOn(runId, { costNanoUsd: 300 as NanoUsd }));
    }
    // Integers all the way: a float ledger drifts and the budget guard inherits it.
    expect(meter.totalNanoUsd()).toBe(3_000_000);
    expect(meter.totalForRun(runId)).toBe(3_000_000);
    expect(meter.summary().total.costNanoUsd).toBe(3_000_000);
  });

  it('separates spend by run', () => {
    const ids = deterministicIds();
    const clock = fixedClock();
    const meter = new CostMeter({ clock, projectId: testProjectId(ids), ids });
    const runA = ids.run();
    const runB = ids.run();

    meter.record(callOn(runA, { costNanoUsd: 100 as NanoUsd }));
    meter.record(callOn(runB, { costNanoUsd: 250 as NanoUsd }));

    expect(meter.totalForRun(runA)).toBe(100);
    expect(meter.totalForRun(runB)).toBe(250);
    expect(meter.totalNanoUsd()).toBe(350);
    expect(meter.records(runB)).toHaveLength(1);
  });

  it('windows spend by time for the per-day ceiling', () => {
    const clock = fixedClock();
    const ids = deterministicIds(clock);
    const meter = new CostMeter({ clock, projectId: testProjectId(ids), ids });
    const runId = ids.run();

    meter.record(callOn(runId, { costNanoUsd: 100 as NanoUsd }));
    const later = clock.advance(millis(60_000));
    meter.record(callOn(runId, { costNanoUsd: 400 as NanoUsd }));

    expect(meter.totalSince(later)).toBe(400);
    expect(meter.totalSince(0)).toBe(500);
  });
});

describe('CostMeter.summary', () => {
  it('slices four ways and every slice reconciles with the total', () => {
    const { meter, runId } = meterUnderTest();
    meter.record(callOn(runId, { costNanoUsd: 100 as NanoUsd }));
    meter.record(
      callOn(runId, {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        stage: 'cast',
        task: 'character-sheet',
        costNanoUsd: 900 as NanoUsd,
        outcome: 'failure',
        errorCode: 'RATE_LIMITED',
        usage: usageOf({ tokens: { input: 10, output: 5, cached: 0, reasoning: 0 } }),
      }),
    );

    const summary = meter.summary();
    expect(summary.total.calls).toBe(2);
    expect(summary.total.failures).toBe(1);
    expect(summary.total.costNanoUsd).toBe(1_000);
    expect(summary.byProvider.ollama?.costNanoUsd).toBe(100);
    expect(summary.byProvider.gemini?.costNanoUsd).toBe(900);
    expect(summary.byModel['gemini-2.5-flash']?.inputTokens).toBe(10);
    expect(summary.byTask['character-sheet']?.calls).toBe(1);
    expect(summary.byStage.cast?.calls).toBe(1);

    const perProvider = Object.values(summary.byProvider).reduce(
      (total, bucket) => total + bucket.costNanoUsd,
      0,
    );
    expect(perProvider).toBe(summary.total.costNanoUsd);
  });
});

describe('CostMeter.ledger', () => {
  it('carries the rows as well as the summary, because an audit needs the rows', () => {
    const { meter, runId, clock } = meterUnderTest();
    meter.record(callOn(runId, { costNanoUsd: 42 as NanoUsd }));
    clock.advance(millis(5));

    const ledger = meter.ledger(runId);
    expect(ledger.runId).toBe(runId);
    expect(ledger.records).toHaveLength(1);
    expect(ledger.summary.total.costNanoUsd).toBe(42);
    expect(ledger.from).toBe('2026-08-23T12:00:00.000Z');
    expect(ledger.updatedAt).toBe('2026-08-23T12:00:00.005Z');
  });

  it('reports a null window when nothing has been recorded', () => {
    const { meter } = meterUnderTest();
    expect(meter.ledger().from).toBeNull();
    expect(meter.ledger().records).toEqual([]);
  });
});

describe('CostMeter.price', () => {
  it('prices without recording, so the budget guard can run before the call', () => {
    const { meter } = meterUnderTest();
    const estimate = meter.price(
      'openrouter',
      'google/gemini-3.1-flash-lite-image',
      usageOf({
        images: { count: 1, resolution: { width: 1024, height: 1024 } },
        imageOutputTokens: 1120,
      }),
    );

    expect(estimate).toBe(33_600_000);
    expect(meter.records()).toHaveLength(0);
  });
});

/**
 * Speech reaches the ledger, and a free voice still leaves a row.
 *
 * Added with the audio layer. The failure being guarded against is the quiet one: before
 * `ProviderUsage.speech` existed, a paid ElevenLabs call would have been priced through
 * `KNOWN_MODELS`, found nothing, and been written into the ledger at $0.00 - a real
 * charge, invisible, with a receipt saying it was free.
 */
describe('CostMeter prices a voice call', () => {
  it('charges an ElevenLabs line at the catalogue character rate', () => {
    const meter = new CostMeter({ clock: fixedClock(), projectId: testProjectId() });
    const cost = meter.price('elevenlabs', 'eleven_v3', {
      tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
      images: { count: 0, resolution: null },
      latencyMs: 900,
      speech: { characters: 1000, audioMs: 4200 },
    });
    // $0.10 per 1K characters.
    expect(cost).toBe(100_000_000);
  });

  it('charges nothing for a local voice, and still writes the row', () => {
    const meter = new CostMeter({ clock: fixedClock(), projectId: testProjectId() });
    const record = meter.record({
      runId: testRunId(),
      stage: 'render',
      provider: 'chatterbox',
      model: 'ResembleAI/chatterbox-multilingual',
      task: 'speech-line',
      tier: 'final',
      usage: {
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: 0, resolution: null },
        latencyMs: 4600,
        speech: { characters: 68, audioMs: 3160 },
      },
      outcome: 'success',
    });

    expect(record.costNanoUsd).toBe(0);
    expect(record.task).toBe('speech-line');
    expect(meter.ledger().summary.total.calls).toBe(1);
  });

  it('leaves a text call priced exactly as it was before speech existed', () => {
    const meter = new CostMeter({ clock: fixedClock(), projectId: testProjectId() });
    const consumed = {
      tokens: { input: 1000, output: 500, cached: 0, reasoning: 0 },
      images: { count: 0, resolution: null },
      latencyMs: 100,
    };
    expect(meter.price('openrouter', 'google/gemma-4-31b-it:free', consumed)).toBe(
      meter.price('openrouter', 'google/gemma-4-31b-it:free', { ...consumed }),
    );
  });
});
