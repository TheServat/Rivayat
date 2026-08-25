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

/**
 * A project with no series, which is where every project starts.
 *
 * This branch used to render one sentence - "this project has no series yet" - and no
 * control. Every screen after this one needs a series id, so a project the studio had
 * not been seeded with was a dead end from the moment someone created it: the Projects
 * screen could make projects and nothing could make them usable.
 */
describe('starting a series', () => {
  /** A project the story fixture has no series for - which is every project but one. */
  const EMPTY_PROJECT = '/story?project=prj_01JQZM5P9R7S2T4V6W8X0Y1Z3A';

  /** Fills every field the S0 brief requires. Intake binds every later stage to them. */
  async function fillBrief(wrapper: Awaited<ReturnType<typeof mountStudio>>): Promise<void> {
    const text = wrapper.findAll('input[type="text"]');
    await text[0]?.setValue('The Cartographer’s Apprentice');
    await text[1]?.setValue('Adults who like quiet, strange things');
    await text[2]?.setValue('melancholy, wry');
    await wrapper
      .find('textarea')
      .setValue('A mapmaker inherits a map of a place that is not there.');
    await wrapper.vm.$nextTick();
  }

  it('offers a form rather than stating the problem', async () => {
    const wrapper = await mountStudio(StoryView, { locale: 'en', path: EMPTY_PROJECT });
    await flush(30);

    expect(wrapper.text()).toContain('Start the series');
    expect(wrapper.find('textarea').exists()).toBe(true);
  });

  it('will not start on a blank premise', async () => {
    const wrapper = await mountStudio(StoryView, { locale: 'en', path: EMPTY_PROJECT });
    await flush(30);

    const button = wrapper.findAll('button').find((b) => b.text().includes('Start the series'));
    expect(button?.attributes('disabled')).toBeDefined();

    // A title alone is not enough: the premise is what the outliner writes from, and a
    // series started without one produces an outline about nothing. Neither is a title
    // and a premise, because S0 binds every later stage to the audience and the tone.
    await wrapper.findAll('input[type="text"]')[0]?.setValue('The Cartographer');
    await wrapper.vm.$nextTick();
    expect(button?.attributes('disabled')).toBeDefined();

    await wrapper.find('textarea').setValue('A mapmaker inherits an impossible map.');
    await wrapper.vm.$nextTick();
    expect(button?.attributes('disabled')).toBeDefined();
  });

  it('creates the series and opens it, rather than leaving a picker to use', async () => {
    const wrapper = await mountStudio(StoryView, { locale: 'en', path: EMPTY_PROJECT });
    await flush(30);
    await fillBrief(wrapper);

    const button = wrapper.findAll('button').find((b) => b.text().includes('Start the series'));
    await button?.trigger('click');
    await flush(20);
    await wrapper.vm.$nextTick();

    const store = useStoryStore();
    expect(store.seriesId).not.toBeNull();
    expect(store.series?.title).toBe('The Cartographer’s Apprentice');
    // Opened, not merely created: the form is gone and the screen is the story screen.
    expect(wrapper.text()).not.toContain('Start the series');
  });

  it('runs S0 and produces the shortlist S3 refuses to work without', async () => {
    const wrapper = await mountStudio(StoryView, { locale: 'en', path: EMPTY_PROJECT });
    await flush(30);
    await fillBrief(wrapper);

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('Start the series'))
      ?.trigger('click');
    await flush(20);

    // The whole reason this form asks for an audience and tone words rather than just a
    // premise. A series with a complete outline and an empty shortlist is one the
    // Characters screen can do nothing with, and that was the state every series the
    // studio created used to be in.
    const store = useStoryStore();
    expect(store.castCandidates.length).toBeGreaterThan(0);
  });

  it('keeps what was typed when the server refuses', async () => {
    const wrapper = await mountStudio(StoryView, { locale: 'en', path: EMPTY_PROJECT });
    await flush(30);

    const store = useStoryStore();
    const premise = 'A mapmaker inherits a map of a place that is not there.';
    await wrapper.find('input[type="text"]').setValue('Doomed');
    await wrapper.find('textarea').setValue(premise);
    await wrapper.vm.$nextTick();

    // A blank title is what the server itself would reject, so this exercises the same
    // path a network failure takes: `startSeries` returns false and nothing is cleared.
    const ok = await store.startSeries('prj_not_a_real_id' as never, {
      title: '',
      premise: '',
      targetAudience: '',
      toneWords: [],
      episodeMinutes: 8,
      seasons: 1,
      episodesPerSeason: 6,
    });
    expect(ok).toBe(false);
    await wrapper.vm.$nextTick();

    // The minute someone spent writing this survives the failure.
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe(premise);
  });
});

/**
 * Whether S0 has run, which no screen could tell you.
 *
 * The shortlist is a precondition for the Characters screen and was invisible on every
 * screen including the one that produces it. A series with thirty-four story nodes and
 * an empty shortlist looks, on the Story screen, exactly like a series with a full one -
 * and the Characters screen refuses in both cases without saying which it is.
 */
describe('whether S0 has run', () => {
  const EMPTY_PROJECT = '/story?project=prj_01JQZM5P9R7S2T4V6W8X0Y1Z3A';

  it('says S0 has not run for a series nobody took in', async () => {
    const wrapper = await mountStudio(StoryView, { locale: 'en', path: '/story' });
    await flush(30);

    // The demo series has an outline and no shortlist, which is exactly the state that
    // used to be indistinguishable from a finished one.
    expect(useStoryStore().castCandidates).toHaveLength(0);
    expect(wrapper.text()).toContain('S0 has not run');
    expect(wrapper.text()).toContain('Characters screen refuses');
  });

  it('reports the count once it has, rather than staying silent', async () => {
    const wrapper = await mountStudio(StoryView, { locale: 'en', path: EMPTY_PROJECT });
    await flush(30);

    const text = wrapper.findAll('input[type="text"]');
    await text[0]?.setValue('The Cartographer’s Apprentice');
    await text[1]?.setValue('Adults who like quiet, strange things');
    await text[2]?.setValue('melancholy, wry');
    await wrapper
      .find('textarea')
      .setValue('A mapmaker inherits a map of a place that is not there.');
    await wrapper.vm.$nextTick();

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('Start the series'))
      ?.trigger('click');
    await flush(20);
    await wrapper.vm.$nextTick();

    const store = useStoryStore();
    expect(store.castCandidates.length).toBeGreaterThan(0);
    // A met precondition takes the space of a met precondition: a line, not a panel.
    expect(wrapper.text()).toContain('S0 found');
    expect(wrapper.text()).not.toContain('S0 has not run');
  });

  it('re-runs S0 from the series’ own premise, without asking for the brief again', async () => {
    const wrapper = await mountStudio(StoryView, { locale: 'en', path: '/story' });
    await flush(30);

    const store = useStoryStore();
    expect(store.castCandidates).toHaveLength(0);

    // The retry is one button, not a form. Someone fixing a missing shortlist should not
    // have to restate an audience to get one.
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('Run S0 intake'))
      ?.trigger('click');
    await flush(20);
    await wrapper.vm.$nextTick();

    expect(store.castCandidates.length).toBeGreaterThan(0);
  });
});
