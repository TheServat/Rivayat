/**
 * The repositories, against a real SQLite with the real migrations applied.
 *
 * `:memory:` is a supported URL in `@rv/persistence`, not a test affordance, and it is
 * used here for the reason that package gives: a mocked database cannot fail a unique
 * index or reject a bad enum, so a repository tested against a stub proves only that
 * the stub agrees with itself.
 *
 * The run repository has the most to prove, because it maps a six-state lifecycle onto
 * a five-state column and a stage *list* onto a single stage column. Those two mappings
 * are the ones a schema change upstream will break, and they are what these assert.
 */

import { Ids, type IsoInstant, type ProjectId, type RunId, type SeriesId } from '@rv/contracts';
import { createDatabase, episodes, runs, type DatabaseHandle } from '@rv/persistence';
import { isErr, toIso, instant } from '@rv/shared-kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunSummary, type RunStatus } from '../../application/resources';
import { DrizzleEpisodeRepository } from './drizzle-episode.repository';
import { DrizzleRunRepository } from './drizzle-run.repository';
import { InMemoryProjectRepository, InMemorySeriesRepository } from './in-memory.repositories';

const NOW: IsoInstant = toIso(instant(1_700_000_000_000));
const PROJECT = 'prj_01J0000000000000000000000A' as ProjectId;
const SERIES = 'ser_01J0000000000000000000000A' as SeriesId;

function runFor(id: RunId, status: RunStatus = 'queued'): RunSummary {
  return RunSummary.parse({
    id,
    projectId: PROJECT,
    seriesId: SERIES,
    status,
    requestedStages: ['intake', 'resolve', 'render'],
    currentStage: null,
    stages: [],
    seed: 42,
    budgetNanoUsd: 5_000_000_000,
    spentNanoUsd: 0,
    errorCode: null,
    startedAt: NOW,
    finishedAt: status === 'queued' ? null : NOW,
  });
}

describe('DrizzleRunRepository', () => {
  let handle: DatabaseHandle;
  let repository: DrizzleRunRepository;
  let ids: Ids;

  beforeEach(() => {
    const opened = createDatabase(':memory:');
    if (isErr(opened)) throw opened.error;
    handle = opened.value;
    repository = new DrizzleRunRepository(handle);
    ids = new Ids();
  });

  afterEach(() => {
    handle.close();
  });

  it('round-trips a run, including the stage list a single column cannot hold', async () => {
    const id = ids.run();
    const created = await repository.create(runFor(id));
    expect(isErr(created)).toBe(false);

    const found = await repository.findById(id);
    expect(isErr(found)).toBe(false);
    if (isErr(found) || found.value === null) throw new Error('not found');

    expect(found.value.requestedStages).toEqual(['intake', 'resolve', 'render']);
    expect(found.value.seed).toBe(42);
    expect(found.value.budgetNanoUsd).toBe(5_000_000_000);
    expect(found.value.seriesId).toBe(SERIES);
  });

  it('answers null for a run that was never written, rather than failing', async () => {
    const found = await repository.findById('run_01J0000000000000000000000Z');
    expect(isErr(found)).toBe(false);
    if (isErr(found)) return;
    expect(found.value).toBeNull();
  });

  it('keeps `cancelled` distinct from `failed` even though the column cannot', async () => {
    const id = ids.run();
    await repository.create(runFor(id));

    const cancelled = await repository.setStatus(id, 'cancelled', NOW, 'CANCELLED');
    expect(isErr(cancelled)).toBe(false);

    const reread = await repository.findById(id);
    if (isErr(reread) || reread.value === null) throw new Error('not found');
    // The column stores `failed`; `metadata.status` keeps the truth. Losing this is
    // the difference between "I stopped it" and "it broke" in the UI.
    expect(reread.value.status).toBe('cancelled');
    expect(reread.value.finishedAt).toBe(NOW);
  });

  it('records the finish time with the terminal status, never separately', async () => {
    const id = ids.run();
    await repository.create(runFor(id));

    const running = await repository.setStatus(id, 'running', NOW);
    if (isErr(running)) throw running.error;
    expect(running.value.finishedAt).toBeNull();

    const done = await repository.setStatus(id, 'succeeded', NOW);
    if (isErr(done)) throw done.error;
    expect(done.value.finishedAt).toBe(NOW);
  });

  it('replaces a stage result rather than appending a second one', async () => {
    const id = ids.run();
    await repository.create(runFor(id));

    await repository.recordStage(id, {
      stage: 'intake',
      status: 'failed',
      costNanoUsd: 0,
      durationMs: 1,
      artifacts: [],
      errorCode: 'VALIDATION_FAILED',
    });
    await repository.recordStage(id, {
      stage: 'intake',
      status: 'succeeded',
      costNanoUsd: 0,
      durationMs: 2,
      artifacts: ['brief:idea'],
      errorCode: null,
    });

    const found = await repository.findById(id);
    if (isErr(found) || found.value === null) throw new Error('not found');
    // Two entries for one stage would double it in the cost breakdown.
    expect(found.value.stages).toHaveLength(1);
    expect(found.value.stages[0]).toMatchObject({ status: 'succeeded', artifacts: ['brief:idea'] });
  });

  it('tracks the current stage and clears it', async () => {
    const id = ids.run();
    await repository.create(runFor(id));

    await repository.setCurrentStage(id, 'resolve');
    let found = await repository.findById(id);
    if (isErr(found) || found.value === null) throw new Error('not found');
    expect(found.value.currentStage).toBe('resolve');

    await repository.setCurrentStage(id, null);
    found = await repository.findById(id);
    if (isErr(found) || found.value === null) throw new Error('not found');
    expect(found.value.currentStage).toBeNull();
  });

  it('appends a ledger row and bumps the denormalised total', async () => {
    const id = ids.run();
    await repository.create(runFor(id));

    const appended = await repository.appendUsage({
      id: ids.usage(),
      runId: id,
      jobId: null,
      stage: 'produce',
      provider: 'openrouter',
      model: 'openai/gpt-5-image-mini',
      task: 'image-final',
      tier: 'final',
      tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
      images: { count: 1, resolution: { width: 1024, height: 1024 } },
      latencyMs: 900,
      costNanoUsd: 10_000_000,
      outcome: 'success',
      errorCode: null,
      cacheHit: false,
      at: NOW,
    });
    expect(isErr(appended)).toBe(false);

    const ledger = await repository.usage(id);
    if (isErr(ledger)) throw ledger.error;
    expect(ledger.value).toHaveLength(1);
    expect(ledger.value[0]?.images).toEqual({
      count: 1,
      resolution: { width: 1024, height: 1024 },
    });

    const run = await repository.findById(id);
    if (isErr(run) || run.value === null) throw new Error('not found');
    // Denormalised so the budget guard is one read rather than an aggregate.
    expect(run.value.spentNanoUsd).toBe(10_000_000);
  });

  it('refuses a ledger row for a run that does not exist', async () => {
    // The foreign key on `usage_records.run_id` is real, and `foreign_keys = ON` is
    // set by `createDatabase` - without the pragma the reference is documentation.
    const orphan = await repository.appendUsage({
      id: ids.usage(),
      runId: 'run_01J0000000000000000000000Z',
      jobId: null,
      stage: 'produce',
      provider: 'comfyui',
      model: 'sdxl-turbo',
      task: 'image-draft',
      tier: 'draft',
      tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
      images: { count: 1, resolution: null },
      latencyMs: 1,
      costNanoUsd: 0,
      outcome: 'success',
      errorCode: null,
      cacheHit: false,
      at: NOW,
    });
    expect(isErr(orphan)).toBe(true);
  });

  it('lists a project’s runs and nobody else’s', async () => {
    const mine = ids.run();
    await repository.create(runFor(mine));
    const theirs = ids.run();
    await repository.create({
      ...runFor(theirs),
      projectId: 'prj_01J0000000000000000000000B',
    });

    const listed = await repository.listByProject(PROJECT);
    if (isErr(listed)) throw listed.error;
    expect(listed.value.map((run) => run.id)).toEqual([mine]);
  });

  it('reads a row whose metadata predates it, falling back to the columns', async () => {
    // The forward-compatibility case: a row written before `metadata` carried the
    // stage list. Everything the columns *can* answer must still be answered, because
    // the alternative is a run that becomes unreadable after a deploy.
    const id = 'run_01J0000000000000000000000A' as RunId;
    handle.db
      .insert(runs)
      .values({
        id,
        projectId: PROJECT,
        stage: 'story',
        state: 'done',
        budgetNanoUsd: null,
        spentNanoUsd: 0,
        seed: 3,
        errorCode: null,
        metadata: {},
        startedAt: NOW,
        finishedAt: NOW,
      })
      .run();

    const found = await repository.findById(id);
    if (isErr(found) || found.value === null) throw new Error('not found');

    // `done` is the column's spelling of `succeeded`.
    expect(found.value.status).toBe('succeeded');
    expect(found.value.requestedStages).toEqual(['story']);
    expect(found.value.seriesId).toBeNull();
    expect(found.value.stages).toEqual([]);
  });

  it('maps a paused run onto the column without losing it', async () => {
    const id = ids.run();
    await repository.create(runFor(id));
    const paused = await repository.setStatus(id, 'paused', NOW);
    if (isErr(paused)) throw paused.error;

    expect(paused.value.status).toBe('paused');
    // Not terminal, so no finish time: `BudgetPolicy.onExceed: 'pause'` stops a run to
    // ask a human, and a stopped-to-ask run has not stopped.
    expect(paused.value.finishedAt).toBeNull();
  });

  it('reports a not-found rather than silently creating one on update', async () => {
    const missing = await repository.setStatus('run_01J0000000000000000000000Z', 'running', NOW);
    expect(isErr(missing)).toBe(true);
    if (!isErr(missing)) return;
    expect(missing.error.kind).toBe('not-found');
  });
});

describe('DrizzleEpisodeRepository', () => {
  let handle: DatabaseHandle;
  let repository: DrizzleEpisodeRepository;

  beforeEach(() => {
    const opened = createDatabase(':memory:');
    if (isErr(opened)) throw opened.error;
    handle = opened.value;
    repository = new DrizzleEpisodeRepository(handle);
  });

  afterEach(() => {
    handle.close();
  });

  /** One act holding one sequence holding one scene id - the smallest valid outline. */
  const OUTLINE = [
    {
      id: 'act_01J0000000000000000000000A',
      ordinal: 1,
      title: 'Act One',
      summary: 'The fox notices the street has moved.',
      plannedSummary: null,
      turningPoint: 'She can no longer pretend she imagined it.',
      sequences: [
        {
          id: 'seq_01J0000000000000000000000A',
          ordinal: 1,
          title: 'The wrong corner',
          summary: 'She walks the block twice.',
          plannedSummary: null,
          dramaticQuestion: 'Will she admit the street moved?',
          sceneIds: ['scn_01J0000000000000000000000A'],
        },
      ],
    },
  ];

  function insert(id: string, ordinal: number, structure: unknown = OUTLINE): void {
    const row: typeof episodes.$inferInsert = {
      id: id,
      seriesId: SERIES,
      seasonId: null,
      ordinal,
      title: `Episode ${String(ordinal)}`,
      summary: 'The fox notices the street has moved again.',
      plannedSummary: null,
      status: 'draft',
      logline: 'A fox tries to prove a town is moving.',
      coldOpen: null,
      cliffhanger: null,
      opensLoops: [],
      closesLoops: [],
      airedAt: null,
      structure: structure as typeof episodes.$inferInsert.structure,
    };
    handle.db.insert(episodes).values(row).run();
  }

  it('returns null for an absent episode', async () => {
    const found = await repository.findById('ep_01J0000000000000000000000Z');
    expect(isErr(found)).toBe(false);
    if (isErr(found)) return;
    expect(found.value).toBeNull();
  });

  it('reads a stored row back as an EpisodeOutline, scenes still as ids', async () => {
    insert('ep_01J0000000000000000000000A', 1);
    const found = await repository.findById('ep_01J0000000000000000000000A');
    if (isErr(found) || found.value === null) throw new Error('not found');

    expect(found.value.ordinal).toBe(1);
    // The projection, not the authoring document: a list view must not pull every
    // scene body across the wire.
    expect(found.value.acts[0]?.sequences[0]?.sceneIds).toEqual(['scn_01J0000000000000000000000A']);
    // Nullable columns become absent optional fields, not `undefined` values.
    expect('coldOpen' in found.value).toBe(false);
  });

  it('reports a stored row that no longer satisfies the contract, by field', async () => {
    // The failure this guards: `@rv/contracts` tightens a field and rows written by an
    // older build stop parsing. A generic error would leave an operator reading JSON.
    insert('ep_01J0000000000000000000000B', 2, []);
    const found = await repository.findById('ep_01J0000000000000000000000B');

    expect(isErr(found)).toBe(true);
    if (!isErr(found)) return;
    expect(found.error.kind).toBe('validation');
    const issues = found.error.context.issues as { path: string }[];
    expect(issues.map((issue) => issue.path)).toContain('acts');
  });

  it('lists a series in airing order', async () => {
    insert('ep_01J0000000000000000000000C', 2);
    insert('ep_01J0000000000000000000000D', 1);

    const listed = await repository.listBySeries(SERIES);
    if (isErr(listed)) throw listed.error;
    // Airing order, from the unique (series_id, ordinal) index - not insertion order.
    expect(listed.value.map((episode) => episode.ordinal)).toEqual([1, 2]);
  });

  it('surfaces one bad row rather than silently dropping it from the list', async () => {
    insert('ep_01J0000000000000000000000E', 1);
    insert('ep_01J0000000000000000000000F', 2, []);

    const listed = await repository.listBySeries(SERIES);
    // Returning the readable half would present a series with a missing episode as
    // complete, which is worse than an error nobody can ignore.
    expect(isErr(listed)).toBe(true);
  });

  it('lists an empty series as an empty list, not an error', async () => {
    const listed = await repository.listBySeries(SERIES);
    expect(isErr(listed)).toBe(false);
    if (isErr(listed)) return;
    expect(listed.value).toEqual([]);
  });
});

describe('the in-memory repositories, pending their tables', () => {
  it('refuses to create a project twice under the same id', async () => {
    const repository = new InMemoryProjectRepository();
    const project = {
      id: PROJECT,
      name: 'A',
      description: 'B',
      styleBibleId: null,
      budgetNanoUsd: null,
      createdAt: NOW,
      updatedAt: NOW,
    };

    expect(isErr(await repository.create(project))).toBe(false);
    const again = await repository.create(project);
    expect(isErr(again)).toBe(true);
    if (!isErr(again)) return;
    expect(again.error.kind).toBe('conflict');
  });

  it('patches only the fields a caller named', async () => {
    const repository = new InMemoryProjectRepository();
    await repository.create({
      id: PROJECT,
      name: 'A',
      description: 'B',
      styleBibleId: null,
      budgetNanoUsd: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const later = toIso(instant(1_700_000_060_000));
    const updated = await repository.update(PROJECT, { name: 'C', description: undefined }, later);
    if (isErr(updated)) throw updated.error;

    expect(updated.value.name).toBe('C');
    // `description: undefined` means "do not change it", not "blank it".
    expect(updated.value.description).toBe('B');
    expect(updated.value.createdAt).toBe(NOW);
    expect(updated.value.updatedAt).toBe(later);
  });

  it('reports a patch to a project that does not exist', async () => {
    const repository = new InMemoryProjectRepository();
    const missing = await repository.update(PROJECT, { name: 'C' }, NOW);
    expect(isErr(missing)).toBe(true);
  });

  it('scopes series to their project', async () => {
    const repository = new InMemorySeriesRepository();
    await repository.create({
      id: SERIES,
      projectId: PROJECT,
      title: 'T',
      premise: 'P',
      hasBible: false,
      createdAt: NOW,
    });

    const mine = await repository.listByProject(PROJECT);
    if (isErr(mine)) throw mine.error;
    expect(mine.value).toHaveLength(1);

    const other = await repository.listByProject('prj_01J0000000000000000000000B');
    if (isErr(other)) throw other.error;
    expect(other.value).toEqual([]);
  });

  it('refuses a duplicate series id', async () => {
    const repository = new InMemorySeriesRepository();
    const card = {
      id: SERIES,
      projectId: PROJECT,
      title: 'T',
      premise: 'P',
      hasBible: false,
      createdAt: NOW,
    };
    await repository.create(card);
    expect(isErr(await repository.create(card))).toBe(true);
  });
});
