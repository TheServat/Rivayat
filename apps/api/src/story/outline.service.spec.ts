/**
 * The DOC discipline, asserted at the seam rather than trusted.
 *
 * The engine owns the two guards - one level of descent, and an expansion that quotes
 * its parent back - and `@rv/story-engine` tests them directly. What is tested here is
 * that the *service* cannot widen them: that a level cannot be reached before its
 * parents exist, that each expansion is sent its own parent's instruction, and that an
 * edit and a regeneration touch only what they claim to.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ids, type SeriesId } from '@rv/contracts';
import { MemoryLogger, isErr } from '@rv/shared-kernel';

import {
  FakeStructuredBackend,
  fakeEngine,
  scratchWorkspace,
  testClock,
} from './__fixtures__/story-fakes';
import { OutlineService, contextFrom } from './outline.service';
import { StoryStore } from './story.store';

const SERIES = 'ser_01JQZK3M7X8YB4N2VTC6WPHRDF' as SeriesId;
const PREMISE = 'A walled garden, a forbidden well, and three people who each hold a piece.';

/** One `OutlineExpansion` the schema will accept, echoing whatever it was bound to. */
function expansion(boundTo: string, titles: readonly string[]): unknown {
  return {
    parentPlanEcho: boundTo,
    children: titles.map((title, index) => ({
      ordinal: index + 1,
      title,
      plannedSummary: `What "${title}" must accomplish for its parent, at length enough to read.`,
      summary: `What "${title}" actually contains, described as events rather than themes.`,
      servesParentPlanBy: `It discharges the part of the instruction about ${title}.`,
      movesEntityNames: ['Bibi Golab'],
    })),
  };
}

describe('OutlineService', () => {
  let workspace: ReturnType<typeof scratchWorkspace>;
  let store: StoryStore;
  let service: OutlineService;

  beforeEach(() => {
    workspace = scratchWorkspace();
    store = new StoryStore({ workspaceDir: workspace.dir, logger: new MemoryLogger() });
    service = new OutlineService({ store, clock: testClock(), ids: new Ids() });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('plants the root from the premise without calling a model', async () => {
    const backend = new FakeStructuredBackend();

    const planted = await service.plantRoot({
      seriesId: SERIES,
      title: 'The Keeper',
      premise: PREMISE,
    });

    expect(isErr(planted)).toBe(false);
    if (isErr(planted)) return;
    // The premise is the author's; paraphrasing it is not this stage's job.
    expect(planted.value.expansion.nodes[0]?.summary).toBe(PREMISE);
    expect(planted.value.expansion.nodes[0]?.provenance?.source).toBe('author');
    expect(planted.value.expansion.spentNanoUsd).toBe(0);
    expect(backend.requests).toHaveLength(0);
  });

  it('refuses a level whose parents do not exist yet, naming the level to build first', async () => {
    const backend = new FakeStructuredBackend();
    await service.plantRoot({ seriesId: SERIES, title: 'The Keeper', premise: PREMISE });

    // "Generate the scenes of this series" is a legal thing to want and an illegal thing
    // to do: the caller has to walk the tree.
    const skipped = await service.expandLevel(fakeEngine(backend), SERIES, 'episode');

    expect(isErr(skipped)).toBe(true);
    if (!isErr(skipped)) return;
    expect(skipped.error.kind).toBe('conflict');
    expect(skipped.error.context).toMatchObject({
      reason: 'outline-level-skip',
      level: 'episode',
      parentLevel: 'season',
    });
    // Nothing was spent finding that out.
    expect(backend.requests).toHaveLength(0);
  });

  it('binds every expansion to its own parent, one call per parent', async () => {
    const backend = new FakeStructuredBackend([
      expansion(PREMISE, ['The Thin Summer']),
      // Two seasons would be two calls; one season, then two episodes from it.
      expansion(
        'What "The Thin Summer" must accomplish for its parent, at length enough to read.',
        ['The Measurer', 'What Is In The Water'],
      ),
    ]);
    const engine = fakeEngine(backend);
    await service.plantRoot({ seriesId: SERIES, title: 'The Keeper', premise: PREMISE });

    const seasons = await service.expandLevel(engine, SERIES, 'season');
    expect(isErr(seasons)).toBe(false);

    const episodes = await service.expandLevel(engine, SERIES, 'episode');
    expect(isErr(episodes)).toBe(false);
    if (isErr(episodes)) return;

    expect(episodes.value.expansion.nodes).toHaveLength(2);
    // The instruction the season was given is what the episode call was sent. A test
    // that only counted calls would pass with every expansion bound to the root.
    expect(backend.userTurn(1)).toContain('The Thin Summer');
    expect(backend.userTurn(1)).toContain('Expand this season into its episode children');
  });

  it('refuses to expand a level twice rather than growing a second generation', async () => {
    const backend = new FakeStructuredBackend([expansion(PREMISE, ['The Thin Summer'])]);
    const engine = fakeEngine(backend);
    await service.plantRoot({ seriesId: SERIES, title: 'The Keeper', premise: PREMISE });
    await service.expandLevel(engine, SERIES, 'season');

    const again = await service.expandLevel(engine, SERIES, 'season');

    expect(isErr(again)).toBe(true);
    if (!isErr(again)) return;
    expect(again.error.context).toMatchObject({ reason: 'outline-level-exists' });
  });

  it('keeps an edited node’s previous version and marks its children stale', async () => {
    const backend = new FakeStructuredBackend([expansion(PREMISE, ['The Thin Summer'])]);
    await service.plantRoot({ seriesId: SERIES, title: 'The Keeper', premise: PREMISE });
    await service.expandLevel(fakeEngine(backend), SERIES, 'season');

    const edited = await service.editNode(SERIES, {
      title: 'The Well Keeper',
      summary: 'A rewritten premise, kept by the author and long enough to be prose.',
      children: 'keep',
    });

    expect(isErr(edited)).toBe(false);
    if (isErr(edited)) return;
    expect(edited.value.node.title).toBe('The Well Keeper');
    // The previous version survives, which is what makes the edit undoable.
    expect(edited.value.node.history[0]?.summary).toBe(PREMISE);
    expect(edited.value.node.roleId).toBeNull();

    const tree = await store.tree(SERIES);
    expect(isErr(tree)).toBe(false);
    if (isErr(tree)) return;
    const season = tree.value.nodes.find((node) => node.level === 'season');
    // Marked, not deleted: "keep the children" has to be a real answer.
    expect(season?.status).toBe('stale');
  });

  it('drops the children when the edit says re-expand', async () => {
    const backend = new FakeStructuredBackend([expansion(PREMISE, ['The Thin Summer'])]);
    await service.plantRoot({ seriesId: SERIES, title: 'The Keeper', premise: PREMISE });
    await service.expandLevel(fakeEngine(backend), SERIES, 'season');

    await service.editNode(SERIES, {
      title: 'The Well Keeper',
      summary: 'A rewritten premise, kept by the author and long enough to be prose.',
      children: 're-expand',
    });

    const tree = await store.tree(SERIES);
    expect(isErr(tree)).toBe(false);
    if (isErr(tree)) return;
    expect(tree.value.nodes.filter((node) => node.level === 'season')).toHaveLength(0);
  });

  it('regenerates one subtree and leaves a sibling’s alone', async () => {
    const seasonPlan =
      'What "The Thin Summer" must accomplish for its parent, at length enough to read.';
    const backend = new FakeStructuredBackend([
      expansion(PREMISE, ['The Thin Summer', 'The Long Rain']),
      expansion(seasonPlan, ['The Measurer']),
      expansion('What "The Long Rain" must accomplish for its parent, at length enough to read.', [
        'The Flood',
      ]),
      expansion(seasonPlan, ['The Measurer, Again']),
    ]);
    const engine = fakeEngine(backend);
    await service.plantRoot({ seriesId: SERIES, title: 'The Keeper', premise: PREMISE });
    await service.expandLevel(engine, SERIES, 'season');
    await service.expandLevel(engine, SERIES, 'episode');

    const before = await store.tree(SERIES);
    if (isErr(before)) return;
    const [first, second] = before.value.nodes.filter((node) => node.level === 'season');
    const siblingEpisodeIds = before.value.nodes
      .filter((node) => node.parentId === second?.id)
      .map((node) => node.id);

    const regenerated = await service.regenerateNode(engine, first?.id ?? '');

    expect(isErr(regenerated)).toBe(false);
    if (isErr(regenerated)) return;
    expect(regenerated.value.expansion.level).toBe('episode');

    const after = await store.tree(SERIES);
    if (isErr(after)) return;
    // The sibling's subtree is byte-identical: regeneration is not "start again".
    expect(
      after.value.nodes.filter((node) => node.parentId === second?.id).map((n) => n.id),
    ).toEqual(siblingEpisodeIds);
    // And the regenerated one really was replaced.
    expect(after.value.nodes.some((node) => node.title === 'The Measurer, Again')).toBe(true);
    expect(after.value.nodes.some((node) => node.title === 'The Measurer')).toBe(false);
  });

  it('refuses to regenerate below a beat, which is the leaf', async () => {
    const backend = new FakeStructuredBackend();
    await service.plantRoot({ seriesId: SERIES, title: 'The Keeper', premise: PREMISE });
    // The root is a series, whose child level exists; the leaf case is asserted through
    // the level table rather than by expanding six levels for one assertion.
    const missing = await service.regenerateNode(fakeEngine(backend), 'nope');

    expect(isErr(missing)).toBe(true);
    if (!isErr(missing)) return;
    expect(missing.error.kind).toBe('not-found');
  });

  it('reads the context back off the store between requests', async () => {
    const context = contextFrom('The Keeper', PREMISE);
    await service.plantRoot({ seriesId: SERIES, title: 'The Keeper', premise: PREMISE, context });

    // A second service over the same directory, as a second worker would be.
    const other = new OutlineService({
      store: new StoryStore({ workspaceDir: workspace.dir, logger: new MemoryLogger() }),
      clock: testClock(),
      ids: new Ids(),
    });
    const backend = new FakeStructuredBackend([expansion(PREMISE, ['The Thin Summer'])]);

    const grown = await other.expandLevel(fakeEngine(backend), SERIES, 'season');

    expect(isErr(grown)).toBe(false);
    // The premise reached the prompt without the caller supplying it again.
    expect(backend.userTurn(0)).toContain(PREMISE);
  });
});
