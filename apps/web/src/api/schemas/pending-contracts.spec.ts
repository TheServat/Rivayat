import { describe, expect, it } from 'vitest';

import { RUN_EVENT_NAMES, RunEvent, ProjectSummary } from './pending-contracts';

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

describe('RunEvent', () => {
  /**
   * Frames captured from a live run against `apps/api` on 2026-08-23, byte for byte.
   *
   * Copied from the wire rather than built from the schema's own defaults, because the
   * schema this replaced was self-consistent and wrong: it was written from a design
   * document, it validated its own fixtures happily, and it rejected every frame the
   * server actually sends. A schema tested only against payloads derived from itself
   * proves nothing about the thing on the other end of the socket.
   */
  const captured = [
    {
      type: 'stage-started',
      runId: 'run_01M0QZHAN8BCTP6WMZNQP587ZK',
      stage: 'render',
      seq: 1,
      at: '2026-08-23T18:53:40.941Z',
    },
    {
      type: 'run-completed',
      runId: 'run_01M0QZHAN8BCTP6WMZNQP587ZK',
      status: 'failed',
      totalNanoUsd: 0,
      errorKind: 'validation',
      errorCode: 'VALIDATION_FAILED',
      seq: 2,
      at: '2026-08-23T18:53:40.950Z',
    },
  ];

  it('accepts the frames the running API emits', () => {
    for (const frame of captured) {
      const result = RunEvent.safeParse(frame);
      expect(result.success, JSON.stringify(frame)).toBe(true);
    }
  });

  it('discriminates on type, so a client switch stays exhaustive', () => {
    const parsed = RunEvent.parse(captured[1]);
    expect(parsed.type).toBe('run-completed');
    if (parsed.type === 'run-completed') expect(parsed.errorKind).toBe('validation');
  });

  it('fills the optional halves of a progress frame rather than leaving them undefined', () => {
    const parsed = RunEvent.parse({
      type: 'stage-progress',
      runId: 'run_01M0QZHAN8BCTP6WMZNQP587ZK',
      stage: 'render',
      progress: 0.4,
      seq: 3,
      at: '2026-08-23T18:54:00.000Z',
    });
    if (parsed.type !== 'stage-progress') throw new Error('wrong member');
    expect(parsed.detail).toBeNull();
    expect(parsed.item).toBeNull();
  });

  it('refuses a progress fraction outside 0..1', () => {
    expect(
      RunEvent.safeParse({ ...captured[0], type: 'stage-progress', progress: 1.5 }).success,
    ).toBe(false);
  });

  it('refuses a stage the pipeline does not have', () => {
    expect(RunEvent.safeParse({ ...captured[0], stage: 'colouring' }).success).toBe(false);
  });

  it('refuses a frame with no discriminant, which is what a silent drop looks like', () => {
    expect(RunEvent.safeParse({ runId: 'run_01M0QZHAN8BCTP6WMZNQP587ZK', seq: 1 }).success).toBe(
      false,
    );
  });

  it('names every member, because a name nobody subscribes to is a silent frame', () => {
    // `EventSource` routes a named frame to `addEventListener(name)` and never to
    // `onmessage`, so this list *is* what a client can hear. Derived from the union so
    // a seventh event kind cannot be added without appearing here.
    expect([...RUN_EVENT_NAMES].toSorted()).toEqual([
      'cost-updated',
      'issue-raised',
      'run-completed',
      'stage-completed',
      'stage-progress',
      'stage-started',
    ]);
  });
});
