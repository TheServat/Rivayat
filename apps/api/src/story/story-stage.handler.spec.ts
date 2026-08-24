/**
 * S2 as the pipeline runs it: intake, a loop of one-level expansions, then the critique.
 *
 * The assertions that matter are the ones a gutted implementation would fail: that the
 * budget guard is consulted *before* any model call, that the descent is one level at a
 * time whatever depth was asked for, and that the series card records the plan exists
 * once the plan exists.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ids, type SeriesId } from '@rv/contracts';
import { MemoryLogger, isErr, toIso } from '@rv/shared-kernel';

import { InMemorySeriesRepository } from '../infrastructure/persistence/in-memory.repositories';
import {
  FakeStructuredBackend,
  RecordingMeter,
  RefusingMeter,
  TEST_INSTANT,
  fakeEngine,
  fakeRouter,
  scratchWorkspace,
  stageContext,
  testClock,
  unroutableRouter,
} from './__fixtures__/story-fakes';
import { OutlineService } from './outline.service';
import { StoryStageHandler, levelsBelow, renderOutline } from './story-stage.handler';
import { StoryStore } from './story.store';
import type { StoryNode } from './story.contracts';

const SERIES = 'ser_01JQZK3M7X8YB4N2VTC6WPHRDF' as SeriesId;
const PROJECT = 'prj_01JQZK3M7X8YB4N2VTC6WPHRDE';

const BRIEF = {
  kind: 'idea',
  idea: 'A woman has guarded a well for forty years and will not say why.',
  language: 'fa',
  targetAudience: 'adults who grew up on hand-drawn animation',
  toneWords: ['wry', 'melancholy'],
  targetEpisodeDurationMs: 180_000,
  episodes: { seasons: 1, episodesPerSeason: 2 },
  constraints: {},
};

/** A `NormalisedBriefDraft` the schema accepts. */
const INTAKE = {
  workingTitle: 'The Keeper of the Well',
  premise:
    'A walled garden, a forbidden well, and three people who each hold one piece of why it is sealed.',
  logline:
    'A girl who climbs the wall at night learns what the keeper has been guarding, and cannot un-learn it.',
  themes: ['inheritance'],
  tone: ['wry', 'melancholy'],
  genre: ['folk drama'],
  castCandidates: [
    {
      name: 'Bibi Golab',
      role: 'protagonist',
      importance: 'lead',
      premiseRole: 'She has sealed the well and will not say why, which is the engine of the plot.',
      distinguishingTrait: 'She waters the pomegranates before she eats.',
    },
  ],
  settingNotes: ['The garden is walled on three sides and open to the salt flat on the fourth.'],
  openQuestions: ['The idea does not say who sealed the well first.'],
  scopeConcerns: [],
};

function expansion(boundTo: string, titles: readonly string[]): unknown {
  return {
    parentPlanEcho: boundTo,
    children: titles.map((title, index) => ({
      ordinal: index + 1,
      title,
      plannedSummary: `What "${title}" must accomplish for its parent, written at length.`,
      summary: `What "${title}" actually contains, described as events rather than themes.`,
      servesParentPlanBy: `It discharges the part about ${title}.`,
      movesEntityNames: ['Bibi Golab'],
    })),
  };
}

const SEASON_PLAN = 'What "The Thin Summer" must accomplish for its parent, written at length.';

const CRITIQUE = {
  scores: [
    {
      key: 'premise-clarity',
      score: 0.8,
      verdict: 'Legible.',
      evidence: ['The premise line.'],
      revisionNote: 'no change needed',
    },
    {
      key: 'stakes',
      score: 0.7,
      verdict: 'Present.',
      evidence: ['The well.'],
      revisionNote: 'no change needed',
    },
    {
      key: 'arc-movement',
      score: 0.7,
      verdict: 'Moves.',
      evidence: ['Episode two.'],
      revisionNote: 'no change needed',
    },
    {
      key: 'scene-causality',
      score: 0.7,
      verdict: 'Causal.',
      evidence: ['The rope.'],
      revisionNote: 'no change needed',
    },
    {
      key: 'style-fit',
      score: 0.7,
      verdict: 'Fits.',
      evidence: ['The palette.'],
      revisionNote: 'no change needed',
    },
  ],
  strongest: 'The premise is legible in one sentence.',
  weakest: 'The second episode leans on the first.',
};

describe('StoryStageHandler', () => {
  let workspace: ReturnType<typeof scratchWorkspace>;
  let store: StoryStore;
  let series: InMemorySeriesRepository;

  beforeEach(async () => {
    workspace = scratchWorkspace();
    store = new StoryStore({ workspaceDir: workspace.dir, logger: new MemoryLogger() });
    series = new InMemorySeriesRepository();
    await series.create({
      id: SERIES,
      projectId: PROJECT,
      title: 'The Keeper',
      premise: 'A woman guards a well.',
      hasBible: false,
      createdAt: toIso(TEST_INSTANT),
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  function handler(
    backend: FakeStructuredBackend,
    meter: RecordingMeter | RefusingMeter,
    router = fakeRouter,
  ): StoryStageHandler {
    const clock = testClock();
    return new StoryStageHandler({
      outline: new OutlineService({ store, clock, ids: new Ids() }),
      store,
      series,
      engine: () => fakeEngine(backend, clock),
      meter,
      router,
      clock,
      logger: new MemoryLogger(),
    });
  }

  it('turns a brief into a tree, one level per call, and records the plan on the card', async () => {
    const backend = new FakeStructuredBackend([
      INTAKE,
      expansion(INTAKE.premise, ['The Thin Summer']),
      expansion(SEASON_PLAN, ['The Measurer', 'What Is In The Water']),
      CRITIQUE,
    ]);
    const meter = new RecordingMeter();
    const { context } = stageContext({ seriesId: SERIES, payload: { brief: BRIEF } });

    const outcome = await handler(backend, meter).execute(context);

    expect(isErr(outcome)).toBe(false);
    if (isErr(outcome)) return;
    expect(outcome.value.artifacts).toContain('outline-level:season/1');
    expect(outcome.value.artifacts).toContain('outline-level:episode/2');
    expect(outcome.value.artifacts.some((a) => a.startsWith('story-critique:'))).toBe(true);

    const tree = await store.tree(SERIES);
    if (isErr(tree)) return;
    const levels = tree.value.nodes.map((node: StoryNode) => node.level);
    expect(levels.filter((level) => level === 'series')).toHaveLength(1);
    expect(levels.filter((level) => level === 'episode')).toHaveLength(2);
    // Nothing below `episode`: the default depth is what docs/01 §4 says S2 owns, and a
    // stage that quietly descended to beats would be two hundred calls nobody asked for.
    expect(levels).not.toContain('act');

    const card = await series.findById(SERIES);
    if (isErr(card)) return;
    expect(card.value?.hasBible).toBe(true);
    // The normalised premise replaces the one-line one the author typed.
    expect(card.value?.premise).toBe(INTAKE.premise);
  });

  it('asks the budget guard before it calls a model, with an estimate that is not zero', async () => {
    const backend = new FakeStructuredBackend([
      INTAKE,
      expansion(INTAKE.premise, ['The Thin Summer']),
      expansion(SEASON_PLAN, ['The Measurer']),
      CRITIQUE,
    ]);
    const meter = new RecordingMeter();
    const { context } = stageContext({ seriesId: SERIES, payload: { brief: BRIEF } });

    await handler(backend, meter).execute(context);

    expect(meter.specs).toHaveLength(1);
    const spec = meter.specs[0];
    expect(spec?.stage).toBe('story');
    expect(spec?.provider).toBe('ollama');
    expect(spec?.estimate.tokens.input).toBeGreaterThan(0);
    // And what was *recorded* is what the traces said, not the estimate.
    expect(meter.usages[0]?.tokens.input).toBe(backend.requests.length * 100);
  });

  it('spends nothing when the guard refuses', async () => {
    const backend = new FakeStructuredBackend([INTAKE]);
    const meter = new RefusingMeter();
    const { context } = stageContext({ seriesId: SERIES, payload: { brief: BRIEF } });

    const outcome = await handler(backend, meter).execute(context);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('budget');
    // The closure was never invoked. A test that only checked the error would pass on an
    // implementation that paid for the call and then reported the refusal.
    expect(backend.requests).toHaveLength(0);
  });

  it('refuses before routing when nothing can serve the stage', async () => {
    const backend = new FakeStructuredBackend([INTAKE]);
    const meter = new RecordingMeter();
    const { context } = stageContext({ seriesId: SERIES, payload: { brief: BRIEF } });

    const outcome = await handler(backend, meter, unroutableRouter).execute(context);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('unsupported');
    expect(meter.specs).toHaveLength(0);
    expect(backend.requests).toHaveLength(0);
  });

  it('refuses a run that names no series rather than writing an outline nobody can find', async () => {
    const backend = new FakeStructuredBackend([INTAKE]);
    const { context } = stageContext({ seriesId: null, payload: { brief: BRIEF } });

    const outcome = await handler(backend, new RecordingMeter()).execute(context);

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'run-has-no-series' });
  });

  it('refuses a payload with no brief, naming the field', async () => {
    const { context } = stageContext({ seriesId: SERIES, payload: {} });

    const outcome = await handler(new FakeStructuredBackend(), new RecordingMeter()).execute(
      context,
    );

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
    expect(outcome.error.context.where).toBe('run.payload.brief');
  });

  it('stores the cast shortlist so S3 does not have to re-read the source', async () => {
    const backend = new FakeStructuredBackend([
      INTAKE,
      expansion(INTAKE.premise, ['The Thin Summer']),
      expansion(SEASON_PLAN, ['The Measurer']),
      CRITIQUE,
    ]);
    const { context } = stageContext({ seriesId: SERIES, payload: { brief: BRIEF } });

    await handler(backend, new RecordingMeter()).execute(context);

    const document = await store.load(SERIES);
    if (isErr(document)) return;
    expect(document.value.castCandidates.map((candidate) => candidate.name)).toEqual([
      'Bibi Golab',
    ]);
  });

  it('stops the descent between levels when the run is cancelled', async () => {
    const controller = new AbortController();
    // Aborted after the season expansion has been served, which is the only moment that
    // distinguishes a stage checking its signal *between* units from one checking it on
    // entry. A stage that only looked at the top would go on to expand the episodes.
    const backend = new FakeStructuredBackend(
      [INTAKE, expansion(INTAKE.premise, ['The Thin Summer'])],
      (served) => {
        if (served === 2) controller.abort();
      },
    );
    const { context } = stageContext({
      seriesId: SERIES,
      payload: { brief: BRIEF, story: { critique: false } },
      signal: controller.signal,
    });

    const outcome = await handler(backend, new RecordingMeter()).execute(context);

    expect(isErr(outcome)).toBe(false);
    if (isErr(outcome)) return;
    expect(backend.requests).toHaveLength(2);
    expect(outcome.value.artifacts).toContain('outline-level:season/1');
    expect(outcome.value.artifacts.some((a) => a.startsWith('outline-level:episode'))).toBe(false);
  });
});

describe('the descent, as data', () => {
  it('lists every level below the series, up to the requested depth', () => {
    expect(levelsBelow('episode')).toEqual(['season', 'episode']);
    expect(levelsBelow('beat')).toEqual(['season', 'episode', 'act', 'sequence', 'scene', 'beat']);
    // `series` is planted, not expanded, so descending "to series" descends nowhere.
    expect(levelsBelow('series')).toEqual([]);
  });

  it('renders both the instruction and the content, because the gap is what is judged', () => {
    const rendered = renderOutline([
      {
        id: 'a',
        parentId: null,
        level: 'series',
        ordinal: 1,
        title: 'The Keeper',
        summary: 'What it contains.',
        plannedSummary: 'What it was asked to be.',
        status: 'expanded',
        roleId: null,
        spentNanoUsd: 0,
        history: [],
      },
    ]);

    expect(rendered).toContain('asked for: What it was asked to be.');
    expect(rendered).toContain('contains: What it contains.');
  });
});
