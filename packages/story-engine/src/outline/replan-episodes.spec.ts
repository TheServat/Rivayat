/**
 * DOME, and the line it must not cross.
 *
 * The interesting tests are the refusals. A planner that revises the future is only useful
 * if it provably cannot revise the past - non-negotiable #7 - so the aired episodes are
 * exercised from both directions: the caller asking for one, and the model returning one
 * that was never asked for.
 */

import { describe, expect, it } from 'vitest';
import type { EpisodeStatus } from '@rv/contracts';
import { isErr } from '@rv/shared-kernel';

import { FakeStructuredBackend, respondJson } from '../__fixtures__/fakes';
import { fixtureId, outlineContext, testDeps } from '../__fixtures__/builders';
import { type PlannedEpisode, ReplanEpisodesUseCase } from './replan-episodes';

function episode(ordinal: number, status: EpisodeStatus): PlannedEpisode {
  return {
    episodeId: fixtureId('ep', ordinal),
    ordinal,
    title: `Episode ${String(ordinal)}`,
    status,
    logline: `Mahtab loses a little more of the denial, part ${String(ordinal)}.`,
    plannedSummary: `Move her one step closer to saying the boat's name.`,
  };
}

const SEASON: readonly PlannedEpisode[] = [
  episode(1, 'aired'),
  episode(2, 'aired'),
  episode(3, 'aired'),
  episode(4, 'outlined'),
  episode(5, 'outlined'),
  episode(6, 'draft'),
];

function revision(ordinal: number): Record<string, unknown> {
  return {
    episodeOrdinal: ordinal,
    title: `Episode ${String(ordinal)}, revised`,
    plannedSummary: 'Bring the boat forward: she now has to explain the name to the harbourmaster.',
    logline: 'The harbourmaster asks where she heard it.',
    changeNote: 'Episode 3 made the name public a season earlier than the plan assumed.',
    paysOffLoops: [
      { loopSetup: 'The boat nobody will name', note: 'The harbourmaster says it out loud.' },
    ],
  };
}

function draft(...ordinals: readonly number[]): Record<string, unknown> {
  return {
    rationale: 'Episode 3 aired with the name already spoken, so the slow reveal is spent.',
    revisions: ordinals.map(revision),
  };
}

const UNAIRED = [SEASON[3]!.episodeId, SEASON[4]!.episodeId, SEASON[5]!.episodeId];

describe('ReplanEpisodesUseCase', () => {
  it('revises the unaired episodes and leaves the aired rows untouched', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(draft(4, 5, 6))] });
    const outcome = await new ReplanEpisodesUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      episodes: SEASON,
      targetEpisodeIds: UNAIRED,
      reason: 'Episode 3 aired with the name spoken.',
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.revisions.map((entry) => entry.episodeOrdinal)).toEqual([4, 5, 6]);
    expect(outcome.value.revisions.map((entry) => entry.episodeId)).toEqual(UNAIRED);
    // E01-E03 appear only as frozen canon, never as a revision.
    expect(outcome.value.frozenEpisodeIds).toEqual([
      SEASON[0]!.episodeId,
      SEASON[1]!.episodeId,
      SEASON[2]!.episodeId,
    ]);
    for (const frozen of outcome.value.frozenEpisodeIds) {
      expect(outcome.value.revisions.some((entry) => entry.episodeId === frozen)).toBe(false);
    }
  });

  it('keeps the previous plan alongside the new one, so the change is a diff', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(draft(4))] });
    const outcome = await new ReplanEpisodesUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      episodes: SEASON,
      targetEpisodeIds: [SEASON[3]!.episodeId],
      reason: 'new memory',
    });

    if (isErr(outcome)) throw new Error(outcome.error.message);
    const [first] = outcome.value.revisions;
    expect(first?.previousPlannedSummary).toBe(SEASON[3]!.plannedSummary);
    expect(first?.plannedSummary).not.toBe(first?.previousPlannedSummary);
  });

  it('refuses to re-plan an aired episode, and does not spend a call finding out', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(draft(1))] });
    const outcome = await new ReplanEpisodesUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      episodes: SEASON,
      targetEpisodeIds: [SEASON[0]!.episodeId, SEASON[3]!.episodeId],
      reason: 'the showrunner changed their mind about episode one',
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('conflict');
    expect(outcome.error.context).toMatchObject({ reason: 'canon-frozen', ordinals: [1] });
    expect(backend.callCount).toBe(0);
  });

  it('fails the whole batch rather than quietly revising the unaired half', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(draft(4, 5))] });
    const outcome = await new ReplanEpisodesUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      episodes: SEASON,
      targetEpisodeIds: [SEASON[2]!.episodeId, SEASON[3]!.episodeId, SEASON[4]!.episodeId],
      reason: 'sweep the season',
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'canon-frozen' });
  });

  it('refuses a revision the model aimed at an aired episode', async () => {
    // The caller asked only for E04. The model returned E02 as well.
    const backend = new FakeStructuredBackend({ script: [respondJson(draft(4, 2))] });
    const outcome = await new ReplanEpisodesUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      episodes: SEASON,
      targetEpisodeIds: [SEASON[3]!.episodeId],
      reason: 'new memory',
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('conflict');
    expect(outcome.error.context).toMatchObject({ reason: 'canon-frozen', ordinals: [2] });
  });

  it('refuses a revision for an episode that was not targeted', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(draft(4, 5))] });
    const outcome = await new ReplanEpisodesUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      episodes: SEASON,
      targetEpisodeIds: [SEASON[3]!.episodeId],
      reason: 'new memory',
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'episode-not-targeted', ordinal: 5 });
  });

  it('refuses a revision for an episode that is not in this season at all', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(draft(99))] });
    const outcome = await new ReplanEpisodesUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      episodes: SEASON,
      targetEpisodeIds: [SEASON[3]!.episodeId],
      reason: 'new memory',
    });

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'unknown-episode-ordinal', ordinal: 99 });
  });

  it('refuses an empty target list', async () => {
    const backend = new FakeStructuredBackend();
    const outcome = await new ReplanEpisodesUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      episodes: SEASON,
      targetEpisodeIds: [],
      reason: 'nothing in particular',
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'no-targets' });
  });

  it('reports a target that is not in the season as not found', async () => {
    const backend = new FakeStructuredBackend();
    const outcome = await new ReplanEpisodesUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      episodes: SEASON,
      targetEpisodeIds: [fixtureId('ep', 42)],
      reason: 'nothing in particular',
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('not-found');
  });

  it('shows the planner the aired episodes as canon, the memory, and the unpaid promises', async () => {
    const backend = new FakeStructuredBackend({ script: [respondJson(draft(4))] });
    await new ReplanEpisodesUseCase(testDeps(backend)).execute({
      context: outlineContext(),
      episodes: SEASON,
      targetEpisodeIds: [SEASON[3]!.episodeId],
      memory: [
        {
          episodeId: SEASON[2]!.episodeId,
          seasonId: fixtureId('sea', 1),
          seriesId: fixtureId('ser', 1),
          index: 2,
          title: 'The harbourmaster',
          logline: 'Someone else hears it.',
          synopsis: 'The harbourmaster repeats the boat name in front of the whole quay.',
          beats: [],
          storySpan: { from: null, until: null },
          entitiesIntroduced: [],
          relationsChanged: [],
          openLoopsPlanted: [],
          openLoopsPaid: [],
          canonFrozen: true,
        },
      ],
      openLoops: [
        {
          id: fixtureId('lop', 1),
          seriesId: fixtureId('ser', 1),
          setup: 'A boat nobody will name',
          promise: 'We will learn what happened to the Sahar',
          plantedAt: { ordinal: 20 },
          plantedIn: { episodeId: SEASON[1]!.episodeId },
          entities: [],
          relations: [],
          expectedPayoff: { from: null, until: null },
          urgency: 0.8,
          status: 'open',
          paidIn: null,
        },
      ],
      reason: 'the name is public a season early',
    });

    const prompt = backend.userPromptAt(0);
    expect(prompt).toContain('What has aired - fixed, and not yours to change');
    expect(prompt).toContain('Episode 1 "Episode 1" [aired]');
    expect(prompt).toContain('The harbourmaster repeats the boat name');
    expect(prompt).toContain('We will learn what happened to the Sahar');
    expect(prompt).toContain('Episode 4 "Episode 4" [outlined]');
  });
});
