import { describe, expect, it } from 'vitest';
import { FixedClock, fromIso, instant, isOk } from '@rv/shared-kernel';
import { StateDelta, WorldStateSnapshot, type Relation } from '@rv/contracts';

import {
  ARIA,
  FIRE,
  KAEL,
  KEEP,
  SWORD,
  VALE,
  episodeOrdinal,
  valeGraph,
} from '../__fixtures__/vale';
import { SERIES_ID, episodeId, openLoop, sceneId, storyTime } from '../__fixtures__/builders';
import { FoldStateDeltaUseCase } from './fold-state-delta';
import { foldWorldState } from './world-state';

const CLOCK = new FixedClock(instant(Date.parse('2026-06-01T00:00:00.000Z')));
const ASOF = fromIso('2026-07-01T00:00:00.000Z');
const EPISODE = episodeId('e06');
const SCENE = sceneId('e06s01');

function delta(overrides: Partial<StateDelta> = {}): StateDelta {
  return StateDelta.parse({
    sceneId: SCENE,
    episodeId: EPISODE,
    seriesId: SERIES_ID,
    at: storyTime(episodeOrdinal(6)),
    ...overrides,
  });
}

function fold(): FoldStateDeltaUseCase {
  return new FoldStateDeltaUseCase({ clock: CLOCK });
}

function edge(relations: readonly Relation[], slugFact: string): Relation | undefined {
  return relations.find((relation) => relation.fact === slugFact);
}

describe('FoldStateDeltaUseCase — a fact that stops being true is bounded, not deleted', () => {
  it('leaves the old fact queryable at an earlier story time', () => {
    const graph = valeGraph();
    const belief = edge(graph.relations, 'Kael believes his parents died in the fire.');
    expect(belief).toBeDefined();
    if (belief === undefined) return;

    // Re-open the belief so the fold is what closes it.
    const open = graph.with({
      relations: graph.relations.map((relation) =>
        relation.id === belief.id ? { ...relation, validUntil: null } : relation,
      ),
    });

    const result = fold().execute({
      graph: open,
      delta: delta({ relationsRetracted: [belief.id] }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    // The row survives, with an end rather than a hole.
    expect(result.value.graph.relations).toHaveLength(open.relations.length);
    expect(result.value.bounded).toHaveLength(1);
    expect(result.value.bounded[0]?.after.validUntil?.ordinal).toBe(episodeOrdinal(6));
    expect(result.value.bounded[0]?.after.retractedAt).toBeNull();

    // And the whole point: what he believed in episode 5 is still answerable.
    const beforeIt = result.value.graph.index.query({
      storyAt: storyTime(episodeOrdinal(5)),
      authoredAt: ASOF,
    });
    expect(beforeIt.map((relation) => relation.id)).toContain(belief.id);

    const afterIt = result.value.graph.index.query({
      storyAt: storyTime(episodeOrdinal(7)),
      authoredAt: ASOF,
    });
    expect(afterIt.map((relation) => relation.id)).not.toContain(belief.id);
  });

  it('ends the fact in story time without retracting the assertion', () => {
    const graph = valeGraph();
    const located = edge(graph.relations, 'Kael is in the Vale.');
    if (located === undefined) throw new Error('fixture');

    const result = fold().execute({
      graph,
      delta: delta({ relationsRetracted: [located.id] }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // `validUntil` is the story ending; `retractedAt` would mean "we were wrong to have
    // written it", which no scene can say.
    expect(result.value.bounded[0]?.after.retractedAt).toBeNull();
    expect(result.value.bounded[0]?.after.validUntil).not.toBeNull();
  });

  it('reports a retraction against an edge the graph does not hold, rather than dropping it', () => {
    const result = fold().execute({
      graph: valeGraph(),
      delta: delta({ relationsRetracted: ['rel_00000000000000000000000000'] }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.skipped).toEqual([
      expect.objectContaining({ reason: 'relation-not-found' }),
    ]);
  });

  it('refuses to close an edge at or before its own start', () => {
    const graph = valeGraph();
    const knows = edge(graph.relations, 'Kael knows Aria is his mother.');
    if (knows === undefined) throw new Error('fixture');

    const result = fold().execute({
      graph,
      // The knows edge starts at episode 8; the delta is at episode 6.
      delta: delta({ relationsRetracted: [knows.id] }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.bounded).toHaveLength(0);
    expect(result.value.skipped).toEqual([
      expect.objectContaining({ reason: 'starts-at-or-after-boundary' }),
    ]);
  });

  it('refuses to close an edge that has already ended', () => {
    const graph = valeGraph();
    const belief = edge(graph.relations, 'Kael believes his parents died in the fire.');
    if (belief === undefined) throw new Error('fixture');

    const result = fold().execute({
      graph,
      delta: delta({
        at: storyTime(episodeOrdinal(9)),
        relationsRetracted: [belief.id],
      }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.skipped).toEqual([expect.objectContaining({ reason: 'already-ended' })]);
  });
});

describe('FoldStateDeltaUseCase — derived edges', () => {
  it('moves a character by closing the old placement and opening a new one', () => {
    const result = fold().execute({
      graph: valeGraph(),
      delta: delta({ positionChanges: [{ entityId: KAEL, from: VALE, to: KEEP }] }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.bounded.map((change) => change.why)).toEqual(['moved']);
    const opened = result.value.added.find((relation) => relation.type === 'located-in');
    expect(opened?.to).toBe(KEEP);
    expect(opened?.validFrom?.ordinal).toBe(episodeOrdinal(6));
    // Authoring time comes from the injected clock, story time from the scene.
    expect(opened?.assertedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(opened?.fact).toBe('Kael is in the Keep.');
  });

  it('does not churn an edge when the character has not actually moved', () => {
    const result = fold().execute({
      graph: valeGraph(),
      delta: delta({ positionChanges: [{ entityId: KAEL, from: VALE, to: VALE }] }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.bounded).toHaveLength(0);
    expect(result.value.added).toHaveLength(0);
  });

  it('walks a character off the map without opening a placement', () => {
    const result = fold().execute({
      graph: valeGraph(),
      delta: delta({ positionChanges: [{ entityId: KAEL, from: VALE, to: null }] }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.bounded).toHaveLength(1);
    expect(result.value.added).toHaveLength(0);
  });

  it('hands an object over: the old holder stops carrying it, the new one starts', () => {
    const result = fold().execute({
      graph: valeGraph(),
      delta: delta({
        possessionChanges: [{ itemId: SWORD, from: ARIA, to: KAEL, mode: 'given' }],
      }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.bounded.map((change) => change.why)).toEqual(['handed-over']);
    const carried = result.value.added.find((relation) => relation.type === 'carries');
    expect(carried?.from).toBe(KAEL);
    expect(carried?.to).toBe(SWORD);
  });

  it('leaves a destroyed item with nobody holding it', () => {
    const result = fold().execute({
      graph: valeGraph(),
      delta: delta({
        possessionChanges: [{ itemId: SWORD, from: ARIA, to: KAEL, mode: 'destroyed' }],
      }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.bounded).toHaveLength(1);
    expect(result.value.added.filter((relation) => relation.type === 'carries')).toHaveLength(0);
  });

  it('closes the belief a scene disproves, named by its own edge', () => {
    const graph = valeGraph();
    const belief = edge(graph.relations, 'Kael believes his parents died in the fire.');
    if (belief === undefined) throw new Error('fixture');
    const open = graph.with({
      relations: graph.relations.map((relation) =>
        relation.id === belief.id ? { ...relation, validUntil: null } : relation,
      ),
    });

    const result = fold().execute({
      graph: open,
      delta: delta({
        knowledgeChanges: [
          {
            knowerId: KAEL,
            change: 'disproved',
            proposition: 'Kael believes his parents died in the fire.',
            aboutRelationId: belief.id,
          },
        ],
      }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.bounded.map((change) => change.why)).toEqual(['disproved']);
  });

  it('finds the belief by its sentence when no edge id was supplied', () => {
    const graph = valeGraph();
    const belief = edge(graph.relations, 'Kael believes his parents died in the fire.');
    if (belief === undefined) throw new Error('fixture');
    const open = graph.with({
      relations: graph.relations.map((relation) =>
        relation.id === belief.id ? { ...relation, validUntil: null } : relation,
      ),
    });

    const result = fold().execute({
      graph: open,
      delta: delta({
        knowledgeChanges: [
          {
            knowerId: KAEL,
            change: 'disproved',
            proposition: 'Kael believes his parents died in the fire.',
          },
        ],
      }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.bounded).toHaveLength(1);
  });

  it('reports a belief ending that matches nothing', () => {
    const result = fold().execute({
      graph: valeGraph(),
      delta: delta({
        knowledgeChanges: [
          { knowerId: ARIA, change: 'forgot', proposition: 'something she never held' },
        ],
      }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.skipped).toEqual([expect.objectContaining({ reason: 'no-target-edge' })]);
  });

  it('records a death on the vitality ledger', () => {
    const result = fold().execute({
      graph: valeGraph(),
      delta: delta({ vitalityChanges: [{ entityId: ARIA, to: 'dead' }] }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.graph.statusAt(ARIA, storyTime(episodeOrdinal(5)))).toBe('alive');
    expect(result.value.graph.statusAt(ARIA, storyTime(episodeOrdinal(6)))).toBe('dead');
    expect(result.value.graph.canAct(ARIA, storyTime(episodeOrdinal(7)))).toBe(false);
  });

  it('marks a promise paid where the scene paid it', () => {
    const loop = openLoop('letter');
    const result = fold().execute({
      graph: valeGraph().with({ openLoops: [loop] }),
      delta: delta({ openLoopsPaid: [loop.id] }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.paidLoops[0]?.status).toBe('paid');
    expect(result.value.paidLoops[0]?.paidIn?.episodeId).toBe(EPISODE);
  });

  it('ignores a payoff for a promise nobody planted', () => {
    const result = fold().execute({
      graph: valeGraph(),
      delta: delta({ openLoopsPaid: ['lop_00000000000000000000000000'] }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.paidLoops).toHaveLength(0);
  });
});

describe('FoldStateDeltaUseCase — replay', () => {
  it('is idempotent: folding the same delta twice is the same graph', () => {
    const graph = valeGraph();
    const change = delta({ positionChanges: [{ entityId: KAEL, from: VALE, to: KEEP }] });

    const once = fold().execute({ graph, delta: change });
    expect(isOk(once)).toBe(true);
    if (!isOk(once)) return;
    const twice = fold().execute({ graph: once.value.graph, delta: change });
    expect(isOk(twice)).toBe(true);
    if (!isOk(twice)) return;

    expect(twice.value.graph.stateHash).toBe(once.value.graph.stateHash);
    expect(twice.value.added).toHaveLength(0);
  });

  it('adopts the edges the extractor minted, once', () => {
    const graph = valeGraph();
    const minted = {
      ...graph.relations[0],
      id: 'rel_0000000000000000000000000M',
    } as (typeof graph.relations)[number];

    const result = fold().execute({
      graph,
      delta: delta({ relationsAsserted: [minted.id] }),
      relations: [minted, minted],
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.added.filter((relation) => relation.id === minted.id)).toHaveLength(1);
  });
});

describe('foldWorldState', () => {
  it('reports who is where, holding what, and knowing what', () => {
    const snapshot = foldWorldState(valeGraph(), {
      at: storyTime(episodeOrdinal(5)),
      asOf: ASOF,
    });

    expect(WorldStateSnapshot.safeParse(snapshot).success).toBe(true);
    expect(snapshot.positions[KAEL]).toBe(VALE);
    expect(snapshot.possessions[ARIA]).toEqual([SWORD]);
    expect(snapshot.knowledge[KAEL]?.believesFalsely).toHaveLength(1);
    expect(snapshot.entities.find((entry) => entry.entityId === KAEL)?.status).toBe('alive');
  });

  it('is deep-equal when the same graph is folded twice', () => {
    const graph = valeGraph();
    const options = { at: storyTime(episodeOrdinal(5)), asOf: ASOF };
    expect(foldWorldState(graph, options)).toStrictEqual(foldWorldState(graph, options));
  });

  it('is deep-equal after a sequence of deltas is replayed in the same order', () => {
    const deltas = [
      delta({
        at: storyTime(episodeOrdinal(6)),
        positionChanges: [{ entityId: KAEL, from: VALE, to: KEEP }],
      }),
      delta({
        at: storyTime(episodeOrdinal(7)),
        possessionChanges: [{ itemId: SWORD, from: ARIA, to: KAEL, mode: 'given' }],
      }),
    ];

    const replay = (): ReturnType<typeof foldWorldState> => {
      let graph = valeGraph();
      for (const change of deltas) {
        const folded = fold().execute({ graph, delta: change });
        if (!isOk(folded)) throw new Error('fold failed');
        graph = folded.value.graph;
      }
      return foldWorldState(graph, { at: storyTime(episodeOrdinal(8)), asOf: ASOF });
    };

    const first = replay();
    expect(replay()).toStrictEqual(first);
    expect(first.positions[KAEL]).toBe(KEEP);
    expect(first.possessions[KAEL]).toEqual([SWORD]);
    expect(first.possessions[ARIA]).toBeUndefined();
  });

  it('lists a holder‘s items once each, in a stable order', () => {
    const graph = valeGraph();
    const carries = graph.relations.find((relation) => relation.type === 'carries');
    if (carries === undefined) throw new Error('fixture');
    // The same holder, the same item, asserted twice: once as `carries`, once as `owns`.
    const doubled = graph.with({
      relations: [
        ...graph.relations,
        { ...carries, id: 'rel_0000000000000000000000000O', type: 'owns' },
      ],
    });

    const snapshot = foldWorldState(doubled, { at: storyTime(episodeOrdinal(5)), asOf: ASOF });
    expect(snapshot.possessions[ARIA]).toEqual([SWORD]);
  });

  it('has no positions or possessions at a moment before anything is true', () => {
    const snapshot = foldWorldState(valeGraph(), { at: storyTime(-5000), asOf: ASOF });
    expect(snapshot.positions).toEqual({});
    expect(snapshot.possessions).toEqual({});
  });

  it('resolves only the viewers it is asked for', () => {
    const snapshot = foldWorldState(valeGraph(), {
      at: storyTime(episodeOrdinal(5)),
      asOf: ASOF,
      viewers: [KAEL],
    });
    expect(Object.keys(snapshot.knowledge)).toEqual([KAEL]);
    expect(snapshot.knowledge[FIRE]).toBeUndefined();
  });
});
