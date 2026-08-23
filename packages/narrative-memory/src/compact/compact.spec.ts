import { describe, expect, it } from 'vitest';
import { FixedClock, contentHash, instant, isErr, isOk } from '@rv/shared-kernel';
import { EpisodeSummary, SeasonSummary, SeriesSummary, StateDelta } from '@rv/contracts';

import { ARIA, KAEL, episodeOrdinal, valeGraph } from '../__fixtures__/vale';
import {
  SERIES_ID,
  episodeId,
  episodeSummary,
  loopId,
  sceneId,
  seasonId,
  storyTime,
} from '../__fixtures__/builders';
import { FakeStructuredBackend, ForbiddenStructuredBackend } from '../__fixtures__/fakes';
import {
  CompactEpisodeUseCase,
  episodeSummaryTokens,
  type SceneForCompaction,
} from './compact-episode';
import { CompactSeasonUseCase, carriedLoops, spanOf } from './compact-season';
import { CompactSeriesUseCase } from './compact-series';

const CLOCK = new FixedClock(instant(Date.parse('2026-08-01T00:00:00.000Z')));
const EPISODE = episodeId('e05');
const SEASON = seasonId('s01');

const EPISODE_DRAFT = {
  title: 'The Torn Page',
  logline: 'A boy asks the only question nobody will answer.',
  synopsis: 'Kael finds the ledger, Aria refuses him, and the Vale closes its gates.',
  beats: ['Kael finds the ledger.', 'Aria refuses him.', 'The gates close.'],
};

function scenes(count = 3): readonly SceneForCompaction[] {
  return Array.from({ length: count }, (_, index) => ({
    sceneId: sceneId(`e05s${String(index)}`),
    at: storyTime(episodeOrdinal(5) + index),
    text: `Scene ${String(index)}: a long stretch of prose that will not survive compaction. `.repeat(
      8,
    ),
  }));
}

function deltas(): readonly StateDelta[] {
  return [
    StateDelta.parse({
      sceneId: sceneId('e05s0'),
      episodeId: EPISODE,
      seriesId: SERIES_ID,
      at: storyTime(episodeOrdinal(5)),
      entitiesIntroduced: [KAEL],
      relationsAsserted: ['rel_00000000000000000000000001'],
      openLoopsPlanted: [loopId('page')],
    }),
    StateDelta.parse({
      sceneId: sceneId('e05s2'),
      episodeId: EPISODE,
      seriesId: SERIES_ID,
      at: storyTime(episodeOrdinal(5) + 2),
      relationsRetracted: ['rel_00000000000000000000000002'],
      openLoopsPaid: [loopId('older')],
    }),
  ];
}

function episodeInput(
  overrides: Record<string, unknown> = {},
): Parameters<CompactEpisodeUseCase['execute']>[0] {
  return {
    graph: valeGraph(),
    episodeId: EPISODE,
    seasonId: SEASON,
    index: 4,
    scenes: scenes(),
    deltas: deltas(),
    ...overrides,
  };
}

describe('CompactEpisodeUseCase', () => {
  it('lets the model write the prose and computes the bookkeeping itself', async () => {
    const backend = new FakeStructuredBackend([EPISODE_DRAFT]);
    const result = await new CompactEpisodeUseCase({ backends: [backend], clock: CLOCK }).execute(
      episodeInput(),
    );

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const { summary } = result.value;

    expect(EpisodeSummary.safeParse(summary).success).toBe(true);
    expect(summary.title).toBe('The Torn Page');
    // None of these came from the model.
    expect(summary.entitiesIntroduced).toEqual([KAEL]);
    expect(summary.relationsChanged).toHaveLength(2);
    expect(summary.openLoopsPlanted).toEqual([loopId('page')]);
    expect(summary.openLoopsPaid).toEqual([loopId('older')]);
    expect(summary.storySpan.from?.ordinal).toBe(episodeOrdinal(5));
    // Half-open, so the last scene is inside the span rather than on its edge.
    expect(summary.storySpan.until?.ordinal).toBe(episodeOrdinal(5) + 3);
    expect(summary.canonFrozen).toBe(false);
  });

  it('marks the summary frozen once the episode has aired', async () => {
    const backend = new FakeStructuredBackend([EPISODE_DRAFT]);
    const result = await new CompactEpisodeUseCase({ backends: [backend], clock: CLOCK }).execute(
      episodeInput({ graph: valeGraph({ airedEpisodes: [EPISODE] }) }),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.summary.canonFrozen).toBe(true);
  });

  it('says what it kept and what it threw away', async () => {
    const backend = new FakeStructuredBackend([EPISODE_DRAFT]);
    const result = await new CompactEpisodeUseCase({ backends: [backend], clock: CLOCK }).execute(
      episodeInput(),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const { manifest } = result.value;
    expect(manifest.preserved).toEqual({
      entitiesIntroduced: 1,
      relationsChanged: 2,
      openLoopsPlanted: 1,
      openLoopsPaid: 1,
      storySpanOrdinals: 3,
    });
    expect(manifest.dropped.scenes).toBe(3);
    expect(manifest.dropped.proseCharacters).toBeGreaterThan(manifest.summaryTokens);
    expect(manifest.summaryTokens).toBe(episodeSummaryTokens(result.value.summary));
  });

  it('reuses a stored summary and spends nothing when the material has not changed', async () => {
    const backend = new FakeStructuredBackend([EPISODE_DRAFT]);
    const useCase = new CompactEpisodeUseCase({ backends: [backend], clock: CLOCK });

    const first = await useCase.execute(episodeInput());
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;
    expect(backend.callCount).toBe(1);

    const forbidden = new CompactEpisodeUseCase({
      backends: [new ForbiddenStructuredBackend()],
      clock: CLOCK,
    });
    const second = await forbidden.execute(
      episodeInput({
        previous: { summary: first.value.summary, inputHash: first.value.manifest.inputHash },
      }),
    );

    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(second.value.reused).toBe(true);
    expect(second.value.trace).toBeNull();
    expect(second.value.summary).toStrictEqual(first.value.summary);
  });

  it('recomputes when a scene was edited', async () => {
    const backend = new FakeStructuredBackend([EPISODE_DRAFT]);
    const useCase = new CompactEpisodeUseCase({ backends: [backend], clock: CLOCK });
    const first = await useCase.execute(episodeInput());
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;

    const edited = [...scenes()];
    edited[0] = { ...edited[0], text: 'A different scene entirely.' } as SceneForCompaction;
    const second = await useCase.execute(
      episodeInput({
        scenes: edited,
        previous: { summary: first.value.summary, inputHash: first.value.manifest.inputHash },
      }),
    );

    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(second.value.reused).toBe(false);
    expect(backend.callCount).toBe(2);
    expect(second.value.manifest.inputHash).not.toBe(first.value.manifest.inputHash);
  });

  it('hashes the material rather than the moment', async () => {
    const backend = new FakeStructuredBackend([EPISODE_DRAFT]);
    const useCase = new CompactEpisodeUseCase({ backends: [backend], clock: CLOCK });
    const first = await useCase.execute(episodeInput());
    const second = await useCase.execute(episodeInput());
    expect(isOk(first) && isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(second.value.manifest.inputHash).toBe(first.value.manifest.inputHash);
    expect(first.value.manifest.inputHash).not.toBe(contentHash('something else'));
  });

  it('refuses a summary that overruns its ceiling instead of letting it through', async () => {
    const backend = new FakeStructuredBackend([
      { ...EPISODE_DRAFT, synopsis: 'A very long paragraph. '.repeat(400) },
    ]);
    const result = await new CompactEpisodeUseCase({ backends: [backend], clock: CLOCK }).execute(
      episodeInput({ maxTokens: 50 }),
    );
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.context).toMatchObject({ reason: 'summary-over-ceiling' });
  });

  it('refuses an episode with no scenes', async () => {
    const result = await new CompactEpisodeUseCase({
      backends: [new ForbiddenStructuredBackend()],
      clock: CLOCK,
    }).execute(episodeInput({ scenes: [] }));
    expect(isErr(result)).toBe(true);
  });

  it('handles an episode with scenes but no deltas', async () => {
    const backend = new FakeStructuredBackend([EPISODE_DRAFT]);
    const result = await new CompactEpisodeUseCase({ backends: [backend], clock: CLOCK }).execute(
      episodeInput({ deltas: [] }),
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.summary.storySpan).toEqual({ from: null, until: null });
  });

  it('propagates a backend failure', async () => {
    const result = await new CompactEpisodeUseCase({
      backends: [new FakeStructuredBackend()],
      clock: CLOCK,
    }).execute(episodeInput());
    expect(isErr(result)).toBe(true);
  });
});

const SEASON_DRAFT = {
  title: 'The Vale',
  throughline: 'Can a house survive the truth it was built on?',
  synopsis: 'Eight episodes of a lie coming apart.',
  arcs: [
    { character: 'Kael', from: 'an orphan', to: 'a son', moved: true },
    { character: 'Aria', from: 'a steward', to: 'a steward', moved: false },
    { character: 'Somebody Else', from: 'x', to: 'y', moved: true },
  ],
};

describe('CompactSeasonUseCase', () => {
  const episodes = [
    episodeSummary('e01', {
      index: 0,
      storySpan: { from: storyTime(100), until: storyTime(200) },
      openLoopsPlanted: [loopId('page'), loopId('sword')],
    }),
    episodeSummary('e02', {
      index: 1,
      storySpan: { from: storyTime(200), until: storyTime(300) },
      openLoopsPaid: [loopId('page')],
    }),
  ];

  it('reads summaries, not scenes, and resolves arc names to ids', async () => {
    const backend = new FakeStructuredBackend([SEASON_DRAFT]);
    const result = await new CompactSeasonUseCase({ backends: [backend], clock: CLOCK }).execute({
      graph: valeGraph(),
      seasonId: SEASON,
      index: 0,
      episodes,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const { summary } = result.value;

    expect(SeasonSummary.safeParse(summary).success).toBe(true);
    expect(summary.episodes).toEqual(episodes.map((episode) => episode.episodeId));
    expect(summary.storySpan).toEqual({ from: storyTime(100), until: storyTime(300) });
    expect(summary.arcsAdvanced.map((arc) => arc.entityId).sort()).toEqual([ARIA, KAEL].sort());
    // The lead who did not move is recorded rather than omitted.
    expect(summary.arcsAdvanced.find((arc) => arc.entityId === ARIA)?.moved).toBe(false);
    expect(result.value.unresolvedCharacters).toEqual(['Somebody Else']);
    expect(backend.lastPrompt).toContain('What happens in e01.');
  });

  it('carries the debt the season did not pay', async () => {
    const backend = new FakeStructuredBackend([SEASON_DRAFT]);
    const result = await new CompactSeasonUseCase({ backends: [backend], clock: CLOCK }).execute({
      graph: valeGraph(),
      seasonId: SEASON,
      index: 0,
      episodes,
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.summary.openLoopsCarried).toEqual([loopId('sword')]);
  });

  it('refuses a season with nothing in it, and one that overruns its ceiling', async () => {
    const empty = await new CompactSeasonUseCase({
      backends: [new ForbiddenStructuredBackend()],
      clock: CLOCK,
    }).execute({ graph: valeGraph(), seasonId: SEASON, index: 0, episodes: [] });
    expect(isErr(empty)).toBe(true);

    const long = await new CompactSeasonUseCase({
      backends: [new FakeStructuredBackend([{ ...SEASON_DRAFT, synopsis: 'long. '.repeat(2000) }])],
      clock: CLOCK,
    }).execute({ graph: valeGraph(), seasonId: SEASON, index: 0, episodes, maxTokens: 40 });
    expect(isErr(long)).toBe(true);
  });

  it('propagates a backend failure', async () => {
    const result = await new CompactSeasonUseCase({
      backends: [new FakeStructuredBackend()],
      clock: CLOCK,
    }).execute({ graph: valeGraph(), seasonId: SEASON, index: 0, episodes });
    expect(isErr(result)).toBe(true);
  });
});

describe('spanOf and carriedLoops', () => {
  it('leaves an unbounded end unbounded rather than guessing at one', () => {
    expect(
      spanOf([
        { storySpan: { from: storyTime(10), until: null } },
        { storySpan: { from: storyTime(20), until: storyTime(30) } },
      ]),
    ).toEqual({ from: storyTime(10), until: null });

    expect(
      spanOf([
        { storySpan: { from: null, until: storyTime(30) } },
        { storySpan: { from: storyTime(20), until: storyTime(40) } },
      ]),
    ).toEqual({ from: null, until: storyTime(40) });
  });

  it('is unbounded at both ends for nothing at all', () => {
    expect(spanOf([])).toEqual({ from: null, until: null });
  });

  it('counts only what was never paid', () => {
    expect(carriedLoops([])).toEqual([]);
  });
});

const SERIES_DRAFT = {
  premise: 'A boy raised on a lie walks back into the house that told it.',
  synopsis: 'One season so far.',
  themes: ['inheritance'],
  toneNote: 'Cold, patient, never cruel for its own sake.',
  rulesOfTheWorld: ['The dead do not come back.'],
};

describe('CompactSeriesUseCase', () => {
  const seasons = [
    {
      seasonId: SEASON,
      seriesId: SERIES_ID,
      index: 0,
      title: 'The Vale',
      throughline: 'Can a house survive its own truth?',
      synopsis: 'It cannot.',
      episodes: [episodeId('e01')],
      storySpan: { from: storyTime(100), until: storyTime(900) },
      arcsAdvanced: [],
      openLoopsCarried: [],
    },
  ];

  it('computes the cast, the loops and the frozen boundary itself', async () => {
    const backend = new FakeStructuredBackend([SERIES_DRAFT]);
    const graph = valeGraph({ airedEpisodes: [episodeId('e01'), episodeId('e03')] });
    const result = await new CompactSeriesUseCase({ backends: [backend], clock: CLOCK }).execute({
      graph,
      seasons,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const { summary } = result.value;

    expect(SeriesSummary.safeParse(summary).success).toBe(true);
    expect(summary.principalCast.sort()).toEqual([ARIA, KAEL].sort());
    // The last aired episode in broadcast order, not the last one in the set.
    expect(summary.canonThroughEpisode).toBe(episodeId('e03'));
    expect(summary.seasons).toEqual([SEASON]);
  });

  it('has no frozen boundary before anything has aired', async () => {
    const backend = new FakeStructuredBackend([SERIES_DRAFT]);
    const result = await new CompactSeriesUseCase({ backends: [backend], clock: CLOCK }).execute({
      graph: valeGraph(),
      seasons,
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.summary.canonThroughEpisode).toBeNull();
  });

  it('refuses a series with no seasons, and one that overruns the tightest ceiling', async () => {
    const empty = await new CompactSeriesUseCase({
      backends: [new ForbiddenStructuredBackend()],
      clock: CLOCK,
    }).execute({ graph: valeGraph(), seasons: [] });
    expect(isErr(empty)).toBe(true);

    const long = await new CompactSeriesUseCase({
      backends: [new FakeStructuredBackend([{ ...SERIES_DRAFT, synopsis: 'long. '.repeat(2000) }])],
      clock: CLOCK,
    }).execute({ graph: valeGraph(), seasons, maxTokens: 30 });
    expect(isErr(long)).toBe(true);
    if (!isErr(long)) return;
    expect(long.error.context).toMatchObject({ reason: 'summary-over-ceiling' });
  });

  it('propagates a backend failure', async () => {
    const result = await new CompactSeriesUseCase({
      backends: [new FakeStructuredBackend()],
      clock: CLOCK,
    }).execute({ graph: valeGraph(), seasons });
    expect(isErr(result)).toBe(true);
  });
});
