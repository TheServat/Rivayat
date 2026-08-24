import { describe, expect, it } from 'vitest';

import { flush, mountStudio, resetStudio } from '../../test/harness';

import StoryView from './StoryView.vue';
import { OUTLINE_LEVELS, editImpactOf, type StoryTree } from './api/story-tree';
import { useStoryStore } from './story.store';

/**
 * Behaviour, not shape.
 *
 * Every assertion here is about something the Story screen promises: that the outliner
 * cannot skip a level, that an edit states its consequences before it is committed,
 * that keeping the children keeps them, and that a build that fails part-way leaves
 * what it already produced on screen. A test that would still pass with the component
 * gutted is not in this file.
 */

const PROJECT_ID = 'prj_01JQZK3M7X8YB4N2VTC6WPHRDE';

/** Loads the fixture-backed store the way the screen does. */
async function loadStore(): Promise<ReturnType<typeof useStoryStore>> {
  resetStudio('fa');
  const store = useStoryStore();
  // The id is the Persian project in the shared project fixtures.
  await store.load(PROJECT_ID);
  return store;
}

describe('the outliner descends one level at a time', () => {
  it('offers exactly one next level, and it is the child of the deepest built one', async () => {
    const store = await loadStore();
    expect(store.nextLevel).toBe('series');

    await store.buildNextLevel();
    expect(store.builtLevels).toEqual(['series']);
    expect(store.nextLevel).toBe('season');

    await store.buildNextLevel();
    expect(store.nextLevel).toBe('episode');
  });

  it('refuses to expand a level whose parent does not exist', async () => {
    const store = await loadStore();

    // Straight to acts, with no series, season or episodes under it. The gateway is the
    // thing that must refuse: a UI that only *hides* the illegal action is one bug away
    // from allowing it.
    await store.buildNextLevel();
    const before = store.nodes.length;
    // `chooseSeries` reset nothing, so ask for a level three below the deepest.
    await expect(
      (async () => {
        const gateway = await import('./api/story-gateway');
        const { useStudioApi } = await import('../../api/client');
        return gateway
          .storyGatewayFor(useStudioApi().transport)
          .expandLevel(store.seriesId ?? '', 'act');
      })(),
    ).rejects.toMatchObject({ code: 'outline-level-skip' });
    expect(store.nodes.length).toBe(before);
  });

  it('reaches every one of the seven levels and then stops offering to build', async () => {
    const store = await loadStore();
    await store.buildRemaining();

    expect(store.builtLevels).toEqual([...OUTLINE_LEVELS]);
    expect(store.nextLevel).toBeNull();
  });

  it('publishes each level as it lands rather than at the end', async () => {
    const store = await loadStore();
    const seen: number[] = [];

    await store.buildNextLevel();
    seen.push(store.nodes.length);
    await store.buildNextLevel();
    seen.push(store.nodes.length);
    await store.buildNextLevel();
    seen.push(store.nodes.length);

    // Strictly growing: the tree on screen is bigger after every level, which is the
    // whole difference between streaming and a forty-second spinner.
    expect(seen[1]).toBeGreaterThan(seen[0] ?? 0);
    expect(seen[2]).toBeGreaterThan(seen[1] ?? 0);
  });
});

describe('an edit says what it affects before it happens', () => {
  it('counts every descendant, not just the immediate children', async () => {
    const store = await loadStore();
    await store.buildRemaining();

    const episode = store.nodes.find((node) => node.level === 'episode');
    expect(episode).toBeDefined();
    const impact = store.impactOf(episode?.id ?? '');

    expect(impact.childCount).toBeGreaterThan(0);
    // An episode sits above acts, sequences, scenes and beats: all four levels are in
    // the blast radius, and a count of "the acts" would understate it.
    expect(impact.levels).toEqual(['act', 'sequence', 'scene', 'beat']);
  });

  it('names the stages the edit invalidates, in pipeline order', () => {
    const tree: StoryTree = {
      seriesId: 'ser_01JQZK3M7X8YB4N2VTC6WPHRDF',
      nodes: [
        {
          id: 'a',
          parentId: null,
          level: 'beat',
          ordinal: 1,
          title: 'x',
          summary: 'y',
          plannedSummary: null,
          status: 'expanded',
          roleId: null,
          spentNanoUsd: 0,
          history: [],
        },
      ],
    };

    // RV-091 fixes this case exactly: an edited beat marks S7-S11 stale and leaves
    // S0-S6 complete.
    expect(editImpactOf(tree, 'a').staleStages).toEqual([
      'sequence',
      'choreograph',
      'preview',
      'render',
      'deliver',
    ]);
  });

  it('keeps the children when asked, marking them stale rather than deleting them', async () => {
    const store = await loadStore();
    await store.buildRemaining();

    const act = store.nodes.find((node) => node.level === 'act');
    const actId = act?.id ?? '';
    const descendantsBefore = store.impactOf(actId).childCount;
    expect(descendantsBefore).toBeGreaterThan(0);

    await store.saveEdit(actId, {
      title: 'عنوان تازه',
      summary: 'متن تازه‌ای که نویسنده خودش نوشته است.',
      children: 'keep',
    });

    expect(store.impactOf(actId).childCount).toBe(descendantsBefore);
    const children = store.childrenOf(actId);
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((child) => child.status === 'stale')).toBe(true);
    expect(store.nodes.find((node) => node.id === actId)?.title).toBe('عنوان تازه');
  });

  it('replaces the subtree when asked to rebuild it, and keeps the old version', async () => {
    const store = await loadStore();
    await store.buildRemaining();

    const act = store.nodes.find((node) => node.level === 'act');
    const actId = act?.id ?? '';
    const originalTitle = act?.title ?? '';

    await store.saveEdit(actId, {
      title: 'عنوان تازه',
      summary: 'متن تازه‌ای که نویسنده خودش نوشته است.',
      children: 're-expand',
    });

    const edited = store.nodes.find((node) => node.id === actId);
    expect(edited?.history.at(0)?.title).toBe(originalTitle);
    // The subtree is gone, not silently kept under a new parent.
    expect(store.impactOf(actId).childCount).toBe(0);
  });

  it('marks an edited node as the author, not as the model that wrote it', async () => {
    const store = await loadStore();
    await store.buildRemaining();
    const act = store.nodes.find((node) => node.level === 'act');
    const actId = act?.id ?? '';
    expect(act?.roleId).not.toBeNull();

    await store.saveEdit(actId, {
      title: 'دست‌نویس',
      summary: 'این بند را نویسنده نوشت.',
      children: 'keep',
    });

    const edited = store.nodes.find((node) => node.id === actId);
    expect(edited?.roleId).toBeNull();
    expect(edited?.provenance?.source).toBe('author');
  });
});

describe('regeneration is per node, never per tree', () => {
  it('rebuilds one subtree and leaves its siblings untouched', async () => {
    const store = await loadStore();
    await store.buildRemaining();

    const episodes = store.nodes.filter((node) => node.level === 'episode');
    expect(episodes.length).toBeGreaterThan(1);
    const [first, second] = episodes;
    const siblingSubtreeBefore = store.impactOf(second?.id ?? '').childCount;

    await store.regenerate(first?.id ?? '');

    expect(store.impactOf(second?.id ?? '').childCount).toBe(siblingSubtreeBefore);
  });

  it('exposes no way to rewrite the whole tree in one call', () => {
    resetStudio('fa');
    const store = useStoryStore();
    const surface = Object.keys(store);
    // The trap this screen is written against: a prominent "regenerate everything".
    // There is no such method, so no component can grow such a button by accident.
    expect(surface.filter((name) => /^regenerateAll|^rebuildTree|^resetTree/.test(name))).toEqual(
      [],
    );
  });
});

describe('the screen', () => {
  it('invites a first build when the tree is empty, and shows the idea', async () => {
    const wrapper = await mountStudio(StoryView, { locale: 'fa', path: '/story' });
    await flush(30);

    expect(wrapper.text()).toContain('هنوز درخت داستانی ساخته نشده است.');
    // The premise is the idea, and it is on screen next to the one action that uses it.
    expect(wrapper.text()).toContain('بی‌بی گلاب');
  });

  it('shows which model wrote a node and what it cost', async () => {
    const wrapper = await mountStudio(StoryView, { locale: 'en', path: '/story' });
    await flush(30);

    const store = useStoryStore();
    await store.buildRemaining();
    await wrapper.vm.$nextTick();

    // The model binding and the cost are on the node itself, per RV-205.
    expect(wrapper.text()).toContain('openrouter:z-ai/glm-5.2:free');
    expect(wrapper.html()).toContain('rv-branch__cost');
  });

  it('renders the same structure in both directions', async () => {
    const structure = async (locale: 'fa' | 'en'): Promise<string[]> => {
      const wrapper = await mountStudio(StoryView, { locale, path: '/story' });
      await flush(30);
      const store = useStoryStore();
      await store.buildNextLevel();
      await store.buildNextLevel();
      await wrapper.vm.$nextTick();
      return [...(wrapper.element as Element).querySelectorAll('[class]')].map(
        (node) => node.getAttribute('class') ?? '',
      );
    };

    // Direction is carried by `<html dir>` and logical properties. If any of this
    // screen ever mirrors itself by swapping markup, it shows up here.
    expect(await structure('fa')).toEqual(await structure('en'));
  });
});
