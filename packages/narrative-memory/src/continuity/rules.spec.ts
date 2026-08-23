import { describe, expect, it } from 'vitest';
import { fromIso } from '@rv/shared-kernel';
import { ContinuityIssue } from '@rv/contracts';

import {
  ARIA,
  KAEL,
  KEEP,
  REVEAL_ORDINAL,
  SWORD,
  VALE,
  episodeOrdinal,
  parentageEdge,
  valeGraph,
  valeRelations,
} from '../__fixtures__/vale';
import { character, episodeId, relation, sceneId, storyTime } from '../__fixtures__/builders';
import { runContinuityRules, type SceneUnderCheck } from './rules';

const ASOF = fromIso('2026-06-01T00:00:00.000Z');
const EPISODE = episodeId('e05');

function scene(overrides: Partial<SceneUnderCheck> & { readonly slug: string }): SceneUnderCheck {
  const { slug, ...rest } = overrides;
  return {
    sceneId: sceneId(slug),
    at: storyTime(episodeOrdinal(5)),
    locationId: VALE,
    ...rest,
  };
}

function rulesOf(issues: readonly ContinuityIssue[]): readonly string[] {
  return issues.map((issue) => issue.rule);
}

describe('runContinuityRules — the epistemic rule', () => {
  const graph = valeGraph();
  const parentage = parentageEdge(graph);

  it('fires when Kael acts on a secret nobody has told him', () => {
    const { issues, citedFacts } = runContinuityRules({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({
          slug: 'e05s01',
          at: storyTime(episodeOrdinal(5)),
          actingEntityIds: [KAEL],
          usesKnowledge: [{ knowerId: KAEL, relationId: parentage.id }],
        }),
      ],
    });

    expect(rulesOf(issues)).toEqual(['knowledge-without-source']);
    const [issue] = issues;
    expect(issue?.severity).toBe('error');
    expect(issue?.entities).toContain(KAEL);
    expect(issue?.conflictingFacts).toHaveLength(2);
    // Every cited id resolves: either to a fact the store already held, or to one the
    // pass materialised and handed back for the caller to persist. A citation that
    // resolves to neither is a finding the UI cannot open.
    const resolvable = new Set([...graph.facts, ...citedFacts].map((fact) => fact.id));
    for (const id of issue?.conflictingFacts ?? []) {
      expect(resolvable.has(id)).toBe(true);
    }
    // The scene side of the conflict did not exist as a row before this pass.
    expect(citedFacts).not.toHaveLength(0);
  });

  it('stops firing once he is told, and flips at exactly the reveal ordinal', () => {
    const before = runContinuityRules({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({
          slug: 'before',
          at: storyTime(REVEAL_ORDINAL - 1),
          usesKnowledge: [{ knowerId: KAEL, relationId: parentage.id }],
        }),
      ],
    });
    const at = runContinuityRules({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({
          slug: 'at',
          at: storyTime(REVEAL_ORDINAL),
          usesKnowledge: [{ knowerId: KAEL, relationId: parentage.id }],
        }),
      ],
    });

    expect(rulesOf(before.issues)).toEqual(['knowledge-without-source']);
    expect(at.issues).toHaveLength(0);
  });

  it('never fires on a public fact - a secret is the only thing you can fail to know', () => {
    const publicEdge = graph.relations.find((edge) => edge.type === 'located-in');
    const { issues } = runContinuityRules({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({
          slug: 'public',
          usesKnowledge: [{ knowerId: ARIA, relationId: publicEdge?.id ?? '' }],
        }),
      ],
    });
    expect(issues).toHaveLength(0);
  });

  it('does not fire on a secret whose whole meaning is that they were told it', () => {
    // The exception `couldKnow` carries: being the *object* of a secret is not knowing,
    // except where the relation is the telling. A secret `told` edge pointing at Kael
    // is information that reached him by definition.
    const toldEdge = relation({
      slug: 'aria-told-kael',
      from: ARIA,
      to: KAEL,
      type: 'told',
      fact: 'Aria told Kael the ledger was forged.',
      validFrom: storyTime(episodeOrdinal(4)),
      visibility: 'secret',
    });
    const withTelling = valeGraph().with({ relations: [...valeRelations(), toldEdge] });

    const { issues } = runContinuityRules({
      graph: withTelling,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({
          slug: 'acts-on-telling',
          usesKnowledge: [{ knowerId: KAEL, relationId: toldEdge.id }],
        }),
      ],
    });
    expect(issues).toHaveLength(0);
  });

  it('still fires on a secret about someone that merely names them', () => {
    // The other side of the same exception: `parent-of` is not a telling, so being its
    // object grants nothing. This is the docs/02 3 case, and it is the one that
    // regressed when every participant counted as a knower.
    const { issues } = runContinuityRules({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({
          slug: 'named-not-told',
          usesKnowledge: [{ knowerId: KAEL, relationId: parentage.id }],
        }),
      ],
    });
    expect(rulesOf(issues)).toEqual(['knowledge-without-source']);
  });

  it('says nothing about an edge the graph does not hold', () => {
    const { issues } = runContinuityRules({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({ slug: 'ghost', usesKnowledge: [{ knowerId: KAEL, relationId: 'rel_missing' }] }),
      ],
    });
    expect(issues).toHaveLength(0);
  });
});

describe('runContinuityRules — the other eight', () => {
  it('catches a dead character acting, and names when they died', () => {
    const graph = valeGraph().with({
      vitality: [
        {
          entityId: KAEL,
          status: 'dead',
          at: storyTime(episodeOrdinal(4)),
          sourceRef: { kind: 'episode', episodeId: episodeId('e04') },
        },
      ],
    });

    const { issues } = runContinuityRules({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [scene({ slug: 'ghost-speaks', actingEntityIds: [KAEL] })],
    });

    expect(rulesOf(issues)).toEqual(['dead-character-acting']);
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.entities).toEqual([KAEL]);
  });

  it('does not fire before the death', () => {
    const graph = valeGraph().with({
      vitality: [
        {
          entityId: KAEL,
          status: 'dead',
          at: storyTime(episodeOrdinal(6)),
          sourceRef: { kind: 'episode', episodeId: episodeId('e06') },
        },
      ],
    });
    const { issues } = runContinuityRules({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [scene({ slug: 'alive', actingEntityIds: [KAEL] })],
    });
    expect(issues).toHaveLength(0);
  });

  it('catches a character in two places, from two overlapping edges', () => {
    const graph = valeGraph().with({
      relations: [
        ...valeRelations(),
        relation({
          slug: 'kael-in-keep',
          from: KAEL,
          to: KEEP,
          type: 'located-in',
          fact: 'Kael is in the Keep.',
          validFrom: storyTime(0),
        }),
      ],
    });

    const { issues } = runContinuityRules({ graph, episodeId: EPISODE, asOf: ASOF, scenes: [] });
    expect(rulesOf(issues)).toEqual(['character-in-two-places']);
  });

  it('catches an object in two places, and calls it that', () => {
    const graph = valeGraph().with({
      relations: [
        ...valeRelations(),
        relation({
          slug: 'sword-in-keep',
          from: SWORD,
          to: KEEP,
          type: 'located-in',
          fact: 'The sword is in the Keep.',
          validFrom: storyTime(0),
        }),
        relation({
          slug: 'sword-in-vale',
          from: SWORD,
          to: VALE,
          type: 'located-in',
          fact: 'The sword is in the Vale.',
          validFrom: storyTime(0),
        }),
      ],
    });

    const { issues } = runContinuityRules({ graph, episodeId: EPISODE, asOf: ASOF, scenes: [] });
    expect(rulesOf(issues)).toEqual(['object-in-two-places']);
  });

  it('catches the same character in two scenes at one story moment', () => {
    const { issues } = runContinuityRules({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({ slug: 'a', locationId: VALE, presentEntityIds: [KAEL] }),
        scene({ slug: 'b', locationId: KEEP, presentEntityIds: [KAEL] }),
      ],
    });
    expect(rulesOf(issues)).toEqual(['character-in-two-places']);
  });

  it('catches an entity acting before it exists', () => {
    const { issues } = runContinuityRules({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [scene({ slug: 'too-early', at: storyTime(-10), actingEntityIds: [KAEL] })],
    });
    expect(rulesOf(issues)).toEqual(['timeline-inversion']);
    expect(issues[0]?.explanation).toContain('before their first appearance');
  });

  it('catches a scene asserting a fact into its own future', () => {
    const future = sceneId('future');
    const graph = valeGraph().with({
      relations: [
        ...valeRelations(),
        relation({
          slug: 'premature',
          from: KAEL,
          to: ARIA,
          type: 'told',
          fact: 'Kael tells Aria he is leaving.',
          validFrom: storyTime(episodeOrdinal(9)),
          sourceRef: { kind: 'episode', episodeId: EPISODE, sceneId: future },
        }),
      ],
    });

    const { issues } = runContinuityRules({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [{ sceneId: future, at: storyTime(episodeOrdinal(5)), locationId: VALE }],
    });
    expect(rulesOf(issues)).toEqual(['timeline-inversion']);
  });

  it('flags an outfit the character does not own', () => {
    const { issues } = runContinuityRules({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [scene({ slug: 'dressed', wardrobe: [{ entityId: KAEL, wardrobeSlug: 'gown' }] })],
    });
    expect(rulesOf(issues)).toEqual(['wardrobe-mismatch']);
    expect(issues[0]?.severity).toBe('warning');
  });

  it('flags an outfit worn outside the stretch of story time it belongs to', () => {
    const { issues } = runContinuityRules({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({
          slug: 'out-of-era',
          at: storyTime(episodeOrdinal(7)),
          wardrobe: [{ entityId: KAEL, wardrobeSlug: 'wardrobe-winter' }],
        }),
      ],
    });
    expect(rulesOf(issues)).toEqual(['wardrobe-mismatch']);
  });

  it('flags a costume change between two scenes at the same story moment', () => {
    const { issues } = runContinuityRules({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({ slug: 'w1', wardrobe: [{ entityId: KAEL, wardrobeSlug: 'wardrobe-winter' }] }),
        scene({ slug: 'w2', wardrobe: [{ entityId: KAEL, wardrobeSlug: 'wardrobe-mourning' }] }),
      ],
    });
    // The second outfit is also out of its era at this ordinal, so both wardrobe
    // findings fire and both are warnings.
    expect(new Set(rulesOf(issues))).toEqual(new Set(['wardrobe-mismatch']));
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it('accepts an outfit the character owns, in its own era', () => {
    const { issues } = runContinuityRules({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({
          slug: 'correct',
          at: storyTime(episodeOrdinal(2)),
          wardrobe: [{ entityId: KAEL, wardrobeSlug: 'wardrobe-winter' }],
        }),
      ],
    });
    expect(issues).toHaveLength(0);
  });

  it('flags a prop nobody was holding, and clears once they hold it', () => {
    const missing = runContinuityRules({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [scene({ slug: 'prop', props: [{ entityId: KAEL, propId: SWORD }] })],
    });
    expect(rulesOf(missing.issues)).toEqual(['prop-mismatch']);
    expect(missing.issues[0]?.severity).toBe('warning');

    const held = runContinuityRules({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [scene({ slug: 'prop', props: [{ entityId: ARIA, propId: SWORD }] })],
    });
    expect(held.issues).toHaveLength(0);
  });

  it('does age arithmetic against the series ordinal scale', () => {
    const { issues } = runContinuityRules({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      storyOrdinalsPerYear: 100,
      scenes: [
        scene({
          slug: 'age',
          at: storyTime(episodeOrdinal(5)),
          statedAges: [{ entityId: KAEL, years: 40 }],
        }),
      ],
    });
    // Kael is 19 at ordinal 0; five hundred ordinals is five years, so 24, not 40.
    expect(rulesOf(issues)).toEqual(['age-arithmetic']);
    expect(issues[0]?.explanation).toContain('24');
  });

  it('accepts a stated age inside the tolerance', () => {
    const { issues } = runContinuityRules({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      storyOrdinalsPerYear: 100,
      scenes: [scene({ slug: 'age-ok', statedAges: [{ entityId: KAEL, years: 24 }] })],
    });
    expect(issues).toHaveLength(0);
  });

  it('says nothing about an ageless being', () => {
    const graph = valeGraph().with({
      entities: [
        ...valeGraph().entities.filter((entity) => entity.id !== ARIA),
        character('aria', { canonicalName: 'Aria', id: ARIA }),
      ],
    });
    const { issues } = runContinuityRules({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [scene({ slug: 'ageless', statedAges: [{ entityId: ARIA, years: 900 }] })],
    });
    expect(issues).toHaveLength(0);
  });

  it('refuses a new edge that contradicts frozen canon', () => {
    const aired = episodeId('e03');
    const graph = valeGraph({
      relations: [
        ...valeRelations().filter((edge) => edge.type !== 'located-in'),
        relation({
          slug: 'canon-kael-in-vale',
          from: KAEL,
          to: VALE,
          type: 'located-in',
          fact: 'Kael is in the Vale.',
          validFrom: storyTime(episodeOrdinal(3)),
          sourceRef: { kind: 'episode', episodeId: aired },
        }),
        relation({
          slug: 'later-kael-in-keep',
          from: KAEL,
          to: KEEP,
          type: 'located-in',
          fact: 'Kael is in the Keep.',
          validFrom: storyTime(episodeOrdinal(3)),
          sourceRef: { kind: 'episode', episodeId: EPISODE },
        }),
      ],
      airedEpisodes: [aired],
    });

    const { issues } = runContinuityRules({ graph, episodeId: EPISODE, asOf: ASOF, scenes: [] });
    expect(rulesOf(issues)).toContain('aired-canon-contradiction');
    const canonIssue = issues.find((issue) => issue.rule === 'aired-canon-contradiction');
    expect(canonIssue?.severity).toBe('error');
  });

  it('allows a later episode to extend aired canon without overlapping it', () => {
    const aired = episodeId('e03');
    const graph = valeGraph({
      relations: [
        ...valeRelations().filter((edge) => edge.type !== 'located-in'),
        relation({
          slug: 'canon-kael-in-vale',
          from: KAEL,
          to: VALE,
          type: 'located-in',
          fact: 'Kael is in the Vale.',
          validFrom: storyTime(episodeOrdinal(3)),
          validUntil: storyTime(episodeOrdinal(5)),
          sourceRef: { kind: 'episode', episodeId: aired },
        }),
        relation({
          slug: 'later-kael-in-keep',
          from: KAEL,
          to: KEEP,
          type: 'located-in',
          fact: 'Kael is in the Keep.',
          validFrom: storyTime(episodeOrdinal(5)),
          sourceRef: { kind: 'episode', episodeId: EPISODE },
        }),
      ],
      airedEpisodes: [aired],
    });

    const { issues } = runContinuityRules({ graph, episodeId: EPISODE, asOf: ASOF, scenes: [] });
    expect(issues).toHaveLength(0);
  });
});

describe('runContinuityRules — shape and cost', () => {
  it('finds nothing in a clean episode', () => {
    const { issues, citedFacts } = runContinuityRules({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({
          slug: 'clean',
          at: storyTime(episodeOrdinal(2)),
          presentEntityIds: [KAEL],
          actingEntityIds: [KAEL],
          wardrobe: [{ entityId: KAEL, wardrobeSlug: 'wardrobe-winter' }],
        }),
      ],
    });
    expect(issues).toEqual([]);
    expect(citedFacts).toEqual([]);
  });

  it('emits findings that parse against the contract', () => {
    const graph = valeGraph();
    const { issues } = runContinuityRules({
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({
          slug: 'messy',
          usesKnowledge: [{ knowerId: KAEL, relationId: parentageEdge(graph).id }],
          props: [{ entityId: KAEL, propId: SWORD }],
        }),
      ],
    });

    expect(issues.length).toBeGreaterThan(1);
    for (const issue of issues) {
      expect(ContinuityIssue.safeParse(issue).success).toBe(true);
      expect(issue.detectedBy).toBe('rule');
      expect(issue.confidence).toBe(1);
    }
  });

  it('is deterministic: the same episode checked twice is the same findings in the same order', () => {
    const graph = valeGraph();
    const input = {
      graph,
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [
        scene({
          slug: 'twice',
          usesKnowledge: [{ knowerId: KAEL, relationId: parentageEdge(graph).id }],
          props: [{ entityId: KAEL, propId: SWORD }],
          wardrobe: [{ entityId: KAEL, wardrobeSlug: 'gown' }],
        }),
      ],
    };
    expect(runContinuityRules(input)).toStrictEqual(runContinuityRules(input));
  });

  it('is synchronous and takes no backend, so it cannot make a provider call', () => {
    // The strongest available assertion: `runContinuityRules` has no async signature and
    // no dependency to call through. A spy would only be able to prove the same thing.
    expect(runContinuityRules.length).toBe(1);
    const report = runContinuityRules({
      graph: valeGraph(),
      episodeId: EPISODE,
      asOf: ASOF,
      scenes: [],
    });
    expect(report).not.toBeInstanceOf(Promise);
  });
});
