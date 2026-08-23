import { describe, expect, it } from 'vitest';
import { fromIso } from '@rv/shared-kernel';
import type { EpistemicView } from '@rv/contracts';

import { ARIA, KAEL, VALE, episodeOrdinal, valeGraph } from '../__fixtures__/vale';
import {
  SERIES_ID,
  character,
  episodeSummary,
  factId,
  openLoop,
  relation,
  relationFact,
  seriesSummary,
  statementFact,
  storyTime,
} from '../__fixtures__/builders';
import { buildEpistemicView } from '../graph/epistemic-view';
import {
  renderEntitySheet,
  renderEpisodeOutline,
  renderEpistemicView,
  renderFact,
  renderOpenLoop,
  renderPremise,
  renderRelation,
} from './render';

const ASOF = fromIso('2026-06-01T00:00:00.000Z');

describe('renderPremise', () => {
  it('carries the premise, the tone and every rule of the world', () => {
    const text = renderPremise(seriesSummary());
    expect(text).toContain('PREMISE:');
    expect(text).toContain('Themes: inheritance');
    expect(text).toContain('Tone:');
    expect(text).toContain('Rule of the world: The dead do not come back.');
  });

  it('omits the themes line for a series that has not named any', () => {
    const text = renderPremise(seriesSummary({ themes: [], rulesOfTheWorld: [] }));
    expect(text).not.toContain('Themes:');
    expect(text).not.toContain('Rule of the world:');
  });
});

describe('renderEpisodeOutline', () => {
  it('leads with the number and the title and then the beats', () => {
    const text = renderEpisodeOutline(episodeSummary('e05', { index: 4, title: 'The Torn Page' }));
    expect(text).toContain('EPISODE 4 - The Torn Page');
    expect(text).toContain('- They meet.');
  });

  it('survives an outline with no beats yet', () => {
    expect(renderEpisodeOutline(episodeSummary('e05', { beats: [] }))).not.toContain('\n- ');
  });
});

describe('renderEntitySheet', () => {
  it('gives a character the dramatic engine, the voice and the silhouette', () => {
    const entity = valeGraph().entity(KAEL);
    if (entity === undefined) throw new Error('fixture');
    const text = renderEntitySheet(entity);

    expect(text).toContain('Kael (character, lead)');
    expect(text).toContain('Also called: Kael Ardent, the boy');
    expect(text).toContain('Wants');
    expect(text).toContain('Believes the lie:');
    expect(text).toContain('Voice:');
    expect(text).toContain('Silhouette:');
  });

  it('omits the alias line when there are none', () => {
    expect(renderEntitySheet(character('lone'))).not.toContain('Also called:');
  });

  it('gives a non-character only the envelope, because there is no psychology to give', () => {
    const place = valeGraph().entity(VALE);
    if (place === undefined) throw new Error('fixture');
    const text = renderEntitySheet(place);
    expect(text).toContain('(location,');
    expect(text).not.toContain('Wants');
  });
});

describe('renderEpistemicView', () => {
  it('renders each bucket it has, labelled by how the belief got there', () => {
    const view = buildEpistemicView(valeGraph(), KAEL, {
      at: storyTime(episodeOrdinal(5)),
      asOf: ASOF,
    });
    const text = renderEpistemicView(view, 'Kael');

    expect(text).toContain('WHAT KAEL KNOWS');
    expect(text).toContain('Believes, wrongly:');
    expect(text).toContain('(via believes-falsely)');
  });

  it('never leaks a blind spot into the prompt', () => {
    const graph = valeGraph();
    const view = buildEpistemicView(graph, KAEL, {
      at: storyTime(episodeOrdinal(5)),
      asOf: ASOF,
    });
    expect(view.blindSpots.length).toBeGreaterThan(0);
    // The secret is the whole reason for the layer: it must not appear as a fact.
    expect(renderEpistemicView(view, 'Kael')).not.toContain('Aria is Kael’s mother.');
  });

  it('says so plainly when they know nothing at all', () => {
    const empty: EpistemicView = {
      seriesId: SERIES_ID,
      viewerId: KAEL,
      at: storyTime(0),
      asOf: '2026-06-01T00:00:00.000Z',
      knows: [],
      believesFalsely: [],
      suspects: [],
      blindSpots: [],
      truncated: false,
      factCount: 0,
    };
    expect(renderEpistemicView(empty, 'Kael')).toContain('They walk in blind.');
  });

  it('admits when the view was clipped', () => {
    const view = buildEpistemicView(valeGraph(), KAEL, {
      at: storyTime(episodeOrdinal(5)),
      asOf: ASOF,
      cap: 0,
    });
    expect(renderEpistemicView(view, 'Kael')).toContain('view truncated');
  });

  it('renders knowledge and suspicion under their own headings', () => {
    const view = buildEpistemicView(valeGraph(), KAEL, {
      at: storyTime(episodeOrdinal(9)),
      asOf: ASOF,
    });
    expect(renderEpistemicView(view, 'Kael')).toContain('Holds as true:');
  });
});

describe('renderFact', () => {
  const edge = relation({
    slug: 'aria-loves-kael',
    from: ARIA,
    to: KAEL,
    type: 'loves',
    fact: 'Aria loves Kael more than she will admit.',
  });

  it('takes a relation fact’s sentence from the edge, never from a copy', () => {
    expect(renderFact(relationFact('rf', edge), edge)).toBe(
      'Aria loves Kael more than she will admit.',
    );
    expect(renderRelation(edge)).toBe('Aria loves Kael more than she will admit.');
  });

  it('renders nothing for a relation fact whose edge is gone', () => {
    expect(renderFact(relationFact('rf', edge), undefined)).toBeUndefined();
  });

  it('renders a standalone statement as itself', () => {
    expect(renderFact(statementFact('sf', 'The bridge at Elsmere burned.'), undefined)).toBe(
      'The bridge at Elsmere burned.',
    );
  });

  it('renders a summary as itself, so a rung of the ladder can be retrieved directly', () => {
    const summary = {
      ...statementFact('sum', 'placeholder'),
      content: {
        kind: 'summary' as const,
        text: 'The Vale closed its gates and never opened them again.',
        covers: [factId('a'), factId('b')],
      },
    };
    expect(renderFact(summary, undefined)).toBe(
      'The Vale closed its gates and never opened them again.',
    );
  });
});

describe('renderOpenLoop', () => {
  it('states the plant and the debt, because the debt is the half that gets forgotten', () => {
    const text = renderOpenLoop(openLoop('letter'));
    expect(text).toContain('UNPAID SETUP:');
    expect(text).toContain('the audience is owed:');
  });
});
