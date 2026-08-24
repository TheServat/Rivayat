/**
 * The distinction the whole report exists to draw: `not-reached` is not `failed`.
 *
 * An asset that stopped at `matte` did not fail at `rig`; it never got there. A screen
 * that painted both red would send the user to look at the rig, which is the one place
 * the problem is not.
 */

import type { ProduceProgress } from '@rv/asset-engine';
import { describe, expect, it } from 'vitest';

import { ProduceProgressLog, buildProduceReport } from './produce-report';

const KEY = 'f'.repeat(64) as never;
const SEMANTIC = 'prop/wick-key/brass';

function tick(overrides: Partial<ProduceProgress>): ProduceProgress {
  return {
    semanticKey: SEMANTIC,
    step: 'generate',
    attempt: 0,
    phase: 'ran',
    durationMs: 10,
    detail: undefined,
    ...overrides,
  };
}

describe('the produce step log', () => {
  it('names every step that never ran, rather than omitting it', () => {
    const log = new ProduceProgressLog();
    log.record(tick({ step: 'generate' }));
    log.record(tick({ step: 'matte', phase: 'failed', detail: 'MATTE_REMOVED_NOTHING' }));

    const steps = log.stepsFor(SEMANTIC);

    // Eight, always. A trail that shrank to the steps that happened would make "where did
    // it stop" a question about the length of an array.
    expect(steps).toHaveLength(8);
    expect(steps.map((step) => step.outcome)).toEqual([
      'ran',
      'failed',
      'not-reached',
      'not-reached',
      'not-reached',
      'not-reached',
      'not-reached',
      'not-reached',
    ]);
  });

  it('keeps a resumed step distinct from one that ran', () => {
    const log = new ProduceProgressLog();
    log.record(tick({ step: 'generate', phase: 'resumed', durationMs: 0 }));

    // "Skipped because a checkpoint already covered these inputs" is a different fact
    // from "ran", and it is the fact that explains a two-second run of a forty-second job.
    expect(log.stepsFor(SEMANTIC)[0]?.outcome).toBe('resumed');
  });

  it('lets a repair attempt supersede the attempt it repaired', () => {
    const log = new ProduceProgressLog();
    log.record(tick({ step: 'split', phase: 'failed', attempt: 0 }));
    log.record(tick({ step: 'split', phase: 'ran', attempt: 1 }));

    const split = log.stepsFor(SEMANTIC).find((step) => step.step === 'split');
    // What a reader wants is where the take *finally* got to; the earlier attempt is
    // visible in `attempt` on the record that survived.
    expect(split?.outcome).toBe('ran');
    expect(split?.attempt).toBe(1);
  });

  it('reports nothing for an asset it never saw, without inventing a trail', () => {
    const steps = new ProduceProgressLog().stepsFor('prop/never-touched/x');
    expect(steps.every((step) => step.outcome === 'not-reached')).toBe(true);
  });
});

describe('building a report', () => {
  it('carries no version id for a take that stopped before the registry', () => {
    const log = new ProduceProgressLog();
    log.record(tick({ step: 'generate' }));
    log.record(tick({ step: 'matte', phase: 'failed' }));

    const report = buildProduceReport(
      {
        key: KEY,
        semanticKey: SEMANTIC,
        label: 'Brass wick key',
        failedStep: 'matte',
        spentNanoUsd: 1234,
      },
      log.stepsFor(SEMANTIC),
    );

    expect(report).not.toBeNull();
    // The registry is written at step eight, so a take that stopped at step two is
    // addressed by its dedup key and its semantic key and by nothing else.
    expect(report?.versionId).toBeUndefined();
    expect(report?.assetId).toBeUndefined();
    expect(report?.failedStep).toBe('matte');
    expect(report?.spentNanoUsd).toBe(1234);
  });

  it('refuses a report whose step list is not the eight steps', () => {
    // Parsed rather than assembled, because the store this feeds is what a regeneration
    // reads its spec from - a malformed document has to fail on the way in.
    const report = buildProduceReport(
      { key: KEY, semanticKey: SEMANTIC, label: 'Brass wick key', spentNanoUsd: 0 },
      [{ step: 'generate', outcome: 'ran', attempt: 0, durationMs: 0, costNanoUsd: 0 }],
    );
    expect(report).toBeNull();
  });
});
