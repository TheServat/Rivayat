import { describe, expect, it } from 'vitest';
import { FixedClock, instant, isErr, isOk } from '@rv/shared-kernel';
import type { ContinuityIssue, ContinuityRule, ContinuitySeverity } from '@rv/contracts';

import { KAEL, valeGraph } from '../__fixtures__/vale';
import { episodeId, factId } from '../__fixtures__/builders';
import { deriveIssueId } from '../graph/derive-id';
import { AirEpisodeUseCase } from './air-episode';

const CLOCK = new FixedClock(instant(Date.parse('2026-08-01T00:00:00.000Z')));
const EPISODE = episodeId('e05');

function issue(severity: ContinuitySeverity, rule: ContinuityRule): ContinuityIssue {
  return {
    id: deriveIssueId(`${severity}:${rule}`),
    seriesId: valeGraph().seriesId,
    episodeId: EPISODE,
    severity,
    rule,
    detectedBy: 'rule',
    entities: [KAEL],
    conflictingFacts: [factId(`${rule}-a`), factId(`${rule}-b`)],
    explanation: `A ${severity} about ${rule}.`,
    confidence: 1,
  };
}

function airing(): AirEpisodeUseCase {
  return new AirEpisodeUseCase({ clock: CLOCK });
}

describe('AirEpisodeUseCase', () => {
  it('blocks the transition on an error, and leaves the episode where it was', () => {
    const result = airing().execute({
      episodeId: EPISODE,
      status: 'rendered',
      issues: [issue('error', 'dead-character-acting'), issue('warning', 'tone-drift')],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('CONFLICT');
    expect(result.error.context).toMatchObject({
      reason: 'continuity-blocked',
      rules: ['dead-character-acting'],
    });
  });

  it('airs on warnings alone, and keeps them', () => {
    const warnings = [issue('warning', 'tone-drift'), issue('info', 'unpaid-open-loop')];
    const result = airing().execute({
      episodeId: EPISODE,
      status: 'rendered',
      issues: warnings,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.status).toBe('aired');
    expect(result.value.airedAt).toBe('2026-08-01T00:00:00.000Z');
    // Not discarded: a note about drift is still worth having beside the aired episode.
    expect(result.value.warnings).toEqual(warnings);
  });

  it('airs a clean episode', () => {
    const result = airing().execute({ episodeId: EPISODE, status: 'rendered', issues: [] });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.warnings).toEqual([]);
  });

  it('refuses an illegal lifecycle jump even with no findings at all', () => {
    const result = airing().execute({ episodeId: EPISODE, status: 'draft', issues: [] });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.context).toMatchObject({ from: 'draft', to: 'aired' });
  });

  it('refuses to air an episode that already aired', () => {
    expect(isErr(airing().execute({ episodeId: EPISODE, status: 'aired', issues: [] }))).toBe(true);
  });
});
