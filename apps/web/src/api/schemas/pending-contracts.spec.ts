import { describe, expect, it } from 'vitest';

import { ProjectSummary, RunProgressEvent } from './pending-contracts';

describe('ProjectSummary', () => {
  it('rejects an id that is not a prefixed ULID', () => {
    const result = ProjectSummary.safeParse({
      id: 'project-1',
      name: 'x',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('defaults a brand-new project to Persian with no style and no spend', () => {
    const parsed = ProjectSummary.parse({
      id: 'prj_01JQZK3M7X8YB4N2VTC6WPHRDE',
      name: 'تازه',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(parsed.locale).toBe('fa');
    expect(parsed.styleBibleId).toBeNull();
    expect(parsed.spentNanoUsd).toBe(0);
  });
});

describe('RunProgressEvent', () => {
  const base = {
    runId: 'run_01JQZK3M7X8YB4N2VTC6WPHRDE',
    stage: 'story',
    status: 'running',
    fraction: 0.5,
    at: '2026-08-23T10:00:00Z',
  };

  it('accepts a tick composed from the contract’s own enums', () => {
    const parsed = RunProgressEvent.parse(base);
    expect(parsed.jobId).toBeNull();
    expect(parsed.spentNanoUsd).toBe(0);
  });

  it('rejects a stage the pipeline does not have', () => {
    expect(RunProgressEvent.safeParse({ ...base, stage: 'colouring' }).success).toBe(false);
  });

  it('rejects a completion fraction outside 0..1', () => {
    expect(RunProgressEvent.safeParse({ ...base, fraction: 1.5 }).success).toBe(false);
  });
});
