import { describe, expect, it } from 'vitest';
import { EntityId, FactId, IssueId, OpenLoopId, RelationId } from '@rv/contracts';

import {
  ARIA,
  KAEL,
  EPISODES,
  episodeOrdinal,
  valeEntities,
  valeGraph,
  valeRelations,
} from '../__fixtures__/vale';
import {
  SERIES_ID,
  episodeId,
  openLoop,
  relationFact,
  statementFact,
  storyTime,
} from '../__fixtures__/builders';
import { NarrativeGraph, compareStrings } from './narrative-graph';
import {
  deriveEntityId,
  deriveFactId,
  deriveId,
  deriveIssueId,
  deriveOpenLoopId,
  deriveRelationId,
  seed,
} from './derive-id';

describe('NarrativeGraph', () => {
  it('sorts every collection by id, whatever order it was handed', () => {
    const graph = new NarrativeGraph({
      seriesId: SERIES_ID,
      entities: [...valeEntities()].reverse(),
      relations: [...valeRelations()].reverse(),
    });

    const entityIds = graph.entities.map((entity) => entity.id);
    expect(entityIds).toEqual([...entityIds].sort(compareStrings));
    const relationIds = graph.relations.map((relation) => relation.id);
    expect(relationIds).toEqual([...relationIds].sort(compareStrings));
  });

  it('hashes content, not array order', () => {
    const forwards = new NarrativeGraph({ seriesId: SERIES_ID, relations: valeRelations() });
    const backwards = new NarrativeGraph({
      seriesId: SERIES_ID,
      relations: [...valeRelations()].reverse(),
    });
    expect(backwards.stateHash).toBe(forwards.stateHash);

    const changed = forwards.with({ relations: valeRelations().slice(1) });
    expect(changed.stateHash).not.toBe(forwards.stateHash);
  });

  it('caches its hash, so repeated reads are the same object', () => {
    const graph = valeGraph();
    expect(graph.stateHash).toBe(graph.stateHash);
  });

  it('looks up every kind of node it holds', () => {
    const loop = openLoop('letter');
    const relation = valeRelations()[0];
    if (relation === undefined) throw new Error('fixture');
    const graph = valeGraph().with({
      openLoops: [loop],
      facts: [relationFact('f1', relation), statementFact('f2', 'The bridge burned.')],
      episodeSummaries: [],
    });

    expect(graph.entity(KAEL)?.canonicalName).toBe('Kael');
    expect(graph.relation(relation.id)?.type).toBe(relation.type);
    expect(graph.fact(graph.facts[0]?.id ?? 'fct_x')).toBeDefined();
    expect(graph.openLoop(loop.id)?.promise).toBe(loop.promise);
    expect(graph.episodeSummary(episodeId('e01'))).toBeUndefined();
    expect(graph.entity(deriveEntityId('nobody'))).toBeUndefined();
  });

  it('reports broadcast position, and -1 for an episode nobody scheduled', () => {
    const graph = valeGraph();
    expect(graph.episodeIndex(EPISODES[0] ?? episodeId('e01'))).toBe(0);
    expect(graph.episodeIndex(episodeId('never-made'))).toBe(-1);
  });

  it('defaults an entity with no ledger entry to alive', () => {
    expect(valeGraph().statusAt(KAEL, storyTime(episodeOrdinal(9)))).toBe('alive');
    expect(valeGraph().canAct(KAEL, storyTime(episodeOrdinal(9)))).toBe(true);
  });

  it('walks the ledger in story order and stops at the moment asked for', () => {
    const graph = valeGraph().with({
      vitality: [
        {
          entityId: ARIA,
          status: 'missing',
          at: storyTime(episodeOrdinal(6)),
          sourceRef: { kind: 'author' },
        },
        {
          entityId: ARIA,
          status: 'dead',
          at: storyTime(episodeOrdinal(8)),
          sourceRef: { kind: 'author' },
        },
      ],
    });

    expect(graph.statusAt(ARIA, storyTime(episodeOrdinal(5)))).toBe('alive');
    expect(graph.statusAt(ARIA, storyTime(episodeOrdinal(7)))).toBe('missing');
    expect(graph.statusAt(ARIA, storyTime(episodeOrdinal(9)))).toBe('dead');
    // Missing is not dead: they can still act.
    expect(graph.canAct(ARIA, storyTime(episodeOrdinal(7)))).toBe(true);
    expect(graph.canAct(ARIA, storyTime(episodeOrdinal(9)))).toBe(false);
  });

  it('replaces rather than merges, so a bounded edge cannot sit beside its original', () => {
    const graph = valeGraph();
    const trimmed = graph.with({ relations: graph.relations.slice(0, 1) });
    expect(trimmed.relations).toHaveLength(1);
    // Everything not named carries over.
    expect(trimmed.entities).toHaveLength(graph.entities.length);
    expect(trimmed.seriesId).toBe(graph.seriesId);
  });

  it('is empty and usable with nothing in it', () => {
    const graph = new NarrativeGraph({ seriesId: SERIES_ID });
    expect(graph.index.size).toBe(0);
    expect(graph.seriesSummary).toBeNull();
    expect(graph.airedEpisodes.size).toBe(0);
    expect(graph.seasonSummaries).toEqual([]);
  });
});

describe('compareStrings', () => {
  it('orders by bytes, not by locale', () => {
    expect(compareStrings('a', 'b')).toBe(-1);
    expect(compareStrings('b', 'a')).toBe(1);
    expect(compareStrings('a', 'a')).toBe(0);
  });
});

describe('derive-id', () => {
  it('mints ids that satisfy the contract schemas', () => {
    expect(EntityId.safeParse(deriveEntityId('kael')).success).toBe(true);
    expect(RelationId.safeParse(deriveRelationId('kael-loves-aria')).success).toBe(true);
    expect(FactId.safeParse(deriveFactId('a fact')).success).toBe(true);
    expect(IssueId.safeParse(deriveIssueId('an issue')).success).toBe(true);
    expect(OpenLoopId.safeParse(deriveOpenLoopId('a promise')).success).toBe(true);
  });

  it('is a function of the seed, so a replay mints the same id', () => {
    expect(deriveRelationId('x')).toBe(deriveRelationId('x'));
    expect(deriveRelationId('x')).not.toBe(deriveRelationId('y'));
  });

  it('uses the prefix registry rather than a literal', () => {
    expect(deriveId('scene', 'a')).toMatch(/^scn_/);
    expect(deriveId('episode', 'a')).toMatch(/^ep_/);
  });

  it('joins seed parts unambiguously', () => {
    // The classic collision: `['ab','c']` and `['a','bc']` must not produce one seed.
    expect(seed('ab', 'c')).not.toBe(seed('a', 'bc'));
    expect(seed('a', 'b')).toBe(seed('a', 'b'));
  });
});
