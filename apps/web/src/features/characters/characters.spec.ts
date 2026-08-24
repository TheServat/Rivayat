import type { EntityId, Relation } from '@rv/contracts';
import { describe, expect, it } from 'vitest';

import { flush, mountStudio, resetStudio } from '../../test/harness';

import CharactersView from './CharactersView.vue';
import {
  couldKnow,
  isObjectOfSecret,
  isValidAt,
  relationsAt,
  standingOf,
  viewerKnowledge,
  type Standpoint,
} from './api/epistemic';
import { useCharactersStore } from './characters.store';

/**
 * The tests this screen is actually answerable for.
 *
 * Most of them are about the bi-temporal projection rather than about markup, because
 * that is where this screen can be wrong in a way nobody notices: a graph that renders
 * beautifully and tells a character something they were never told is worse than one
 * that fails to render.
 *
 * The first block is the canonical case the epistemic model exists for. It is written
 * as an assertion about the *view* and not only about the helper, because the helper
 * being right is worth nothing if the screen collapses six standings into "connected".
 */

const PROJECT_ID = 'prj_01JQZK3M7X8YB4N2VTC6WPHRDE';

const E05: Standpoint = { at: { ordinal: 5 }, asOf: null };
const E09: Standpoint = { at: { ordinal: 9 }, asOf: null };

async function loadStore(): Promise<ReturnType<typeof useCharactersStore>> {
  resetStudio('fa');
  const store = useCharactersStore();
  await store.load(PROJECT_ID);
  return store;
}

function idOf(store: ReturnType<typeof useCharactersStore>, name: string): EntityId {
  const found = store.snapshot?.entities.find((entity) => entity.canonicalName === name);
  expect(found, `no entity named ${name}`).toBeDefined();
  return found?.id ?? '';
}

function relationsOf(store: ReturnType<typeof useCharactersStore>): readonly Relation[] {
  return store.snapshot?.relations ?? [];
}

describe('being the object of a secret is not knowing it', () => {
  it('withholds the parentage from the child it is kept from', async () => {
    const store = await loadStore();
    const relations = relationsOf(store);
    const keeper = idOf(store, 'بی‌بی گلاب');
    const child = idOf(store, 'مهتاب');

    const secret = relations.find(
      (relation) =>
        relation.type === 'parent-of' && relation.from === keeper && relation.to === child,
    );
    expect(secret?.visibility).toBe('secret');
    if (secret === undefined) return;

    // The child is the *object* of the edge, which is exactly who it is kept from.
    expect(couldKnow(relations, child, secret, E05)).toBe(false);
    expect(standingOf(relations, child, secret, E05)).toBe('blind');
    expect(isObjectOfSecret(secret, child)).toBe(true);

    // The subject of a fact knows their own fact.
    expect(couldKnow(relations, keeper, secret, E05)).toBe(true);
  });

  it('does let the object of a `told` edge know it, secret or not', async () => {
    const store = await loadStore();
    const relations = relationsOf(store);
    const engineer = idOf(store, 'مهندس فرهاد');

    const told = relations.find((relation) => relation.type === 'told' && relation.to === engineer);
    expect(told?.visibility).toBe('secret');
    if (told === undefined) return;

    // Being *told* something is knowing it: the narrowing above applies to secrets whose
    // meaning is not "information reached the object".
    expect(couldKnow(relations, engineer, told, E05)).toBe(true);
  });

  it('opens the fact to the child once the reveal lands', async () => {
    const store = await loadStore();
    const relations = relationsOf(store);
    const keeper = idOf(store, 'بی‌بی گلاب');
    const child = idOf(store, 'مهتاب');
    const secret = relations.find(
      (relation) =>
        relation.type === 'parent-of' && relation.from === keeper && relation.to === child,
    );
    if (secret === undefined) return;

    expect(standingOf(relations, child, secret, E05)).toBe('blind');
    expect(standingOf(relations, child, secret, E09)).toBe('knows');
  });
});

describe('the story clock changes the answer', () => {
  it('holds a false belief before the reveal and not after it', async () => {
    const store = await loadStore();
    const relations = relationsOf(store);
    const child = idOf(store, 'مهتاب');

    const atFive = viewerKnowledge(relations, child, E05);
    const atNine = viewerKnowledge(relations, child, E09);

    expect(atFive.believesFalsely).toHaveLength(1);
    expect(atNine.believesFalsely).toHaveLength(0);
    expect(atNine.knows.length).toBeGreaterThan(atFive.knows.length);
    // The dramatic irony available to the scene shrinks as the reveal lands.
    expect(atNine.blindSpots.length).toBeLessThan(atFive.blindSpots.length);
  });

  it('treats a validity interval as half-open', async () => {
    const store = await loadStore();
    const belief = relationsOf(store).find((relation) => relation.type === 'believes-falsely');
    expect(belief?.validUntil?.ordinal).toBe(8);
    if (belief === undefined) return;

    // A fact that ends at 8 is true at 7 and false at 8, which is what lets one state
    // end exactly where the next begins with no off-by-one gap.
    expect(isValidAt(belief, { ordinal: 7 })).toBe(true);
    expect(isValidAt(belief, { ordinal: 8 })).toBe(false);
  });
});

describe('the authoring clock is a second, independent question', () => {
  it('replays the graph as it stood before a later rewrite', async () => {
    const store = await loadStore();
    const relations = relationsOf(store);
    const revisions = store.snapshot?.revisions ?? [];
    const [firstPass, rewrite] = revisions;
    expect(firstPass).toBeDefined();
    expect(rewrite).toBeDefined();

    const now = relationsAt(relations, { at: { ordinal: 5 }, asOf: null });
    const before = relationsAt(relations, {
      at: { ordinal: 5 },
      asOf: firstPass?.at ?? null,
    });

    const typesNow = new Set(now.map((relation) => relation.type));
    const typesBefore = new Set(before.map((relation) => relation.type));

    // The retro-fit: `ally-of` was written first and retracted; `resents` was written
    // in the second pass *about* a story time in the first. Story time is identical in
    // both queries, so any difference is the authoring clock and nothing else.
    expect(typesBefore.has('ally-of')).toBe(true);
    expect(typesBefore.has('resents')).toBe(false);
    expect(typesNow.has('ally-of')).toBe(false);
    expect(typesNow.has('resents')).toBe(true);
  });
});

describe('the standpoint is state, not a filter', () => {
  it('re-answers the graph when the story time moves, without touching the filters', async () => {
    const store = await loadStore();
    const child = idOf(store, 'مهتاب');
    store.setViewer(child);
    store.focusOn(child);

    store.setStoryOrdinal(5);
    const atFive = store.standingCounts;
    expect(atFive['believes-falsely']).toBe(1);

    store.setStoryOrdinal(9);
    expect(store.standingCounts['believes-falsely']).toBe(0);
    expect(store.groupFilter).toBeNull();
    expect(store.visibilityFilter).toBeNull();
  });

  it('gives the narrator no standings at all, rather than calling everything known', async () => {
    const store = await loadStore();
    store.setViewer(null);
    const relation = relationsOf(store).at(0);
    if (relation === undefined) return;

    expect(store.standingFor(relation)).toBeNull();
    expect(Object.values(store.standingCounts).every((count) => count === 0)).toBe(true);
  });
});

describe('the screen', () => {
  it('renders every relation of the focus entity as a keyboard-reachable button', async () => {
    const wrapper = await mountStudio(CharactersView, { locale: 'fa', path: '/characters' });
    await flush(40);

    const store = useCharactersStore();
    store.setTab('graph');
    store.setViewer(idOf(store, 'مهتاب'));
    store.focusOn(idOf(store, 'مهتاب'));
    await wrapper.vm.$nextTick();

    const nodes = wrapper.findAll('.rv-graph__node');
    expect(nodes.length).toBe(store.neighbours.length);
    expect(nodes.length).toBeGreaterThan(0);
    // A graph that can only be driven with a mouse fails WCAG 2.2 outright.
    for (const node of nodes) {
      expect(node.element.tagName).toBe('BUTTON');
      expect(node.attributes('aria-label')?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('never carries a standing in colour alone', async () => {
    const wrapper = await mountStudio(CharactersView, { locale: 'fa', path: '/characters' });
    await flush(40);

    const store = useCharactersStore();
    store.setTab('graph');
    store.setViewer(idOf(store, 'مهتاب'));
    store.focusOn(idOf(store, 'مهتاب'));
    await wrapper.vm.$nextTick();

    const chips = wrapper.findAll('.rv-standing');
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      // A word, always. The `data-standing` attribute carries the colour and the
      // pattern; the text is what makes the difference readable without either.
      expect(chip.text().trim().length).toBeGreaterThan(0);
      expect(chip.attributes('data-standing')).toBeTruthy();
    }
  });

  it('names the object of a secret as such, where an eye would misread it', async () => {
    const wrapper = await mountStudio(CharactersView, { locale: 'fa', path: '/characters' });
    await flush(40);

    const store = useCharactersStore();
    store.setTab('graph');
    const child = idOf(store, 'مهتاب');
    store.setViewer(child);
    store.focusOn(child);
    store.setStoryOrdinal(5);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('موضوعِ راز است، نه دانندهٔ آن');
  });

  it('drops the secret-object note once the character actually knows the fact', async () => {
    const store = await loadStore();
    const child = idOf(store, 'مهتاب');
    store.setViewer(child);
    const secret = relationsOf(store).find(
      (relation) => relation.type === 'parent-of' && relation.to === child,
    );
    if (secret === undefined) return;

    store.setStoryOrdinal(5);
    expect(store.objectOfSecretFor(secret)).toBe(true);

    // After the reveal she holds it. Repeating "object of the secret, not a knower"
    // beside a `knows` badge would put two opposite claims on one edge.
    store.setStoryOrdinal(9);
    expect(store.standingFor(secret)).toBe('knows');
    expect(store.objectOfSecretFor(secret)).toBe(false);
  });

  it('shows more than one standing at once, so the model is not flattened', async () => {
    const wrapper = await mountStudio(CharactersView, { locale: 'en', path: '/characters' });
    await flush(40);

    const store = useCharactersStore();
    store.setTab('graph');
    const child = idOf(store, 'مهتاب');
    store.setViewer(child);
    store.focusOn(child);
    store.setStoryOrdinal(5);
    await wrapper.vm.$nextTick();

    const standings = new Set(
      wrapper.findAll('.rv-graph__node').map((node) => node.attributes('data-standing')),
    );
    expect(standings.size).toBeGreaterThan(1);
    expect(standings.has('blind')).toBe(true);
  });

  it('turns an edited prompt into a cache miss for that cell and no other', async () => {
    const wrapper = await mountStudio(CharactersView, { locale: 'fa', path: '/characters' });
    await flush(40);

    const store = useCharactersStore();
    const cells = store.states?.cells ?? [];
    const target = cells.find((cell) => cell.status === 'ready');
    expect(target).toBeDefined();
    if (target === undefined) return;

    const othersBefore = cells
      .filter((cell) => cell.variantKey !== target.variantKey)
      .map((cell) => `${cell.variantKey}:${cell.status}`);

    await store.saveCellPrompt(target.variantKey, 'متن تازه‌ای برای همین یک خانه.');
    await wrapper.vm.$nextTick();

    const after = store.states?.cells ?? [];
    expect(after.find((cell) => cell.variantKey === target.variantKey)?.status).toBe('stale');
    expect(
      after
        .filter((cell) => cell.variantKey !== target.variantKey)
        .map((cell) => `${cell.variantKey}:${cell.status}`),
    ).toEqual(othersBefore);
  });

  it('flags a state below the identity floor', async () => {
    const store = await loadStore();
    const cells = store.states?.cells ?? [];
    const floor = store.states?.identityFloor ?? 0;
    expect(floor).toBeGreaterThan(0);
    expect(
      cells.some((cell) => cell.identityMatch !== undefined && cell.identityMatch < floor),
    ).toBe(true);
  });

  it('renders the same structure in both directions', async () => {
    const structure = async (locale: 'fa' | 'en'): Promise<string[]> => {
      const wrapper = await mountStudio(CharactersView, { locale, path: '/characters' });
      await flush(40);
      const store = useCharactersStore();
      store.setTab('graph');
      store.setViewer(idOf(store, 'مهتاب'));
      store.setStoryOrdinal(5);
      await wrapper.vm.$nextTick();
      return [...(wrapper.element as Element).querySelectorAll('[class]')].map(
        (node) => node.getAttribute('class') ?? '',
      );
    };

    // The graph is where right-to-left layouts break. Node positions are logical
    // percentages and the edge layer is mirrored by one transform, so the markup is
    // identical in both directions and only the resolved CSS differs.
    expect(await structure('fa')).toEqual(await structure('en'));
  });
});
