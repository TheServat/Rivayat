import { describe, expect, it } from 'vitest';
import { fromIso } from '@rv/shared-kernel';
import { EpistemicView } from '@rv/contracts';

import { ARIA, FIRE, KAEL, REVEAL_ORDINAL, episodeOrdinal, valeGraph } from '../__fixtures__/vale';
import { character, relation, storyTime } from '../__fixtures__/builders';
import { NarrativeGraph } from './narrative-graph';
import { buildEpistemicView, isOmniscient } from './epistemic-view';

const ASOF = fromIso('2026-06-01T00:00:00.000Z');

describe('buildEpistemicView', () => {
  it('gives Kael the lie and withholds the secret before the reveal', () => {
    const view = buildEpistemicView(valeGraph(), KAEL, {
      at: storyTime(episodeOrdinal(5)),
      asOf: ASOF,
    });

    expect(view.believesFalsely.map((known) => known.fact)).toEqual([
      'Kael believes his parents died in the fire.',
    ]);
    expect(view.knows).toHaveLength(0);
    // The parentage edge is true, secret, and not his: exactly the dramatic irony the
    // scene can spend.
    expect(view.blindSpots).toHaveLength(1);
  });

  it('flips at the reveal: the truth is held and the lie is gone', () => {
    const view = buildEpistemicView(valeGraph(), KAEL, {
      at: storyTime(episodeOrdinal(9)),
      asOf: ASOF,
    });

    expect(view.knows.map((known) => known.fact)).toEqual(['Kael knows Aria is his mother.']);
    expect(view.believesFalsely).toHaveLength(0);
    // Nothing secret is left outside his head, so the irony is discharged.
    expect(view.blindSpots).toHaveLength(0);
  });

  it('is exactly half-open at the reveal ordinal', () => {
    const graph = valeGraph();
    const before = buildEpistemicView(graph, KAEL, {
      at: storyTime(REVEAL_ORDINAL - 1),
      asOf: ASOF,
    });
    const at = buildEpistemicView(graph, KAEL, { at: storyTime(REVEAL_ORDINAL), asOf: ASOF });

    expect(before.believesFalsely).toHaveLength(1);
    expect(before.knows).toHaveLength(0);
    expect(at.believesFalsely).toHaveLength(0);
    expect(at.knows).toHaveLength(1);
  });

  it('parses against the contract, with the viewer and the moment carried inside it', () => {
    const view = buildEpistemicView(valeGraph(), KAEL, {
      at: storyTime(episodeOrdinal(5)),
      asOf: ASOF,
    });
    const parsed = EpistemicView.safeParse(view);
    expect(parsed.success).toBe(true);
    expect(view.viewerId).toBe(KAEL);
    expect(view.at.ordinal).toBe(episodeOrdinal(5));
  });

  it('reports every current fact for an omniscient viewer and gives them no blind spots', () => {
    const graph = valeGraph();
    const view = buildEpistemicView(graph, ARIA, {
      at: storyTime(episodeOrdinal(5)),
      asOf: ASOF,
      omniscient: true,
    });

    expect(view.blindSpots).toHaveLength(0);
    expect(view.factCount).toBeGreaterThan(0);
    expect(view.knows.length).toBe(view.factCount);
  });

  it('caps a view and says so rather than clipping it silently', () => {
    const view = buildEpistemicView(valeGraph(), KAEL, {
      at: storyTime(episodeOrdinal(5)),
      asOf: ASOF,
      cap: 0,
    });
    expect(view.truncated).toBe(true);
    expect(view.believesFalsely).toHaveLength(0);
    expect(view.factCount).toBe(1);
  });

  it('truncates an omniscient view at the cap too', () => {
    const view = buildEpistemicView(valeGraph(), ARIA, {
      at: storyTime(episodeOrdinal(5)),
      asOf: ASOF,
      omniscient: true,
      cap: 1,
    });
    expect(view.truncated).toBe(true);
    expect(view.knows).toHaveLength(1);
  });

  it('treats a suspicion as neither knowledge nor a lie', () => {
    const graph = valeGraph();
    const withSuspicion = graph.with({
      relations: [
        ...graph.relations,
        relation({
          slug: 'kael-suspects-aria',
          from: KAEL,
          to: ARIA,
          type: 'suspects',
          fact: 'Kael suspects Aria is hiding something.',
          validFrom: storyTime(episodeOrdinal(2)),
        }),
      ],
    });

    const view = buildEpistemicView(withSuspicion, KAEL, {
      at: storyTime(episodeOrdinal(5)),
      asOf: ASOF,
    });
    expect(view.suspects).toHaveLength(1);
    expect(view.knows).toHaveLength(0);
  });
});

describe('isOmniscient', () => {
  it('is true only for a character whose sheet says so', () => {
    const narrator = character('narrator', { payload: { knowledgeScope: 'omniscient' } });
    const graph = new NarrativeGraph({
      seriesId: narrator.seriesId,
      entities: [narrator, ...valeGraph().entities],
    });

    expect(isOmniscient(graph, narrator.id)).toBe(true);
    expect(isOmniscient(graph, KAEL)).toBe(false);
    // A prop is not a viewer, and asking is not an error.
    expect(isOmniscient(graph, FIRE)).toBe(false);
  });
});
