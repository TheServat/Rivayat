import { describe, expect, it } from 'vitest';
import { ContinuityIssue } from '@rv/contracts';

import { KAEL, SWORD, episodeOrdinal, valeGraph, valeRelations } from '../__fixtures__/vale';
import { episodeId, openLoop, relation, storyTime } from '../__fixtures__/builders';
import { TrackOpenLoopsUseCase, reportOpenLoops } from './track-open-loops';

const E01 = episodeId('e01');
const E05 = episodeId('e05');
const E09 = episodeId('e09');

function withForeshadow(): ReturnType<typeof valeGraph> {
  return valeGraph({
    relations: [
      ...valeRelations(),
      relation({
        slug: 'sword-foreshadows',
        from: SWORD,
        to: KAEL,
        type: 'foreshadows',
        fact: 'The sword is laid across Kael’s knees and never drawn.',
        validFrom: storyTime(episodeOrdinal(1)),
        sourceRef: { kind: 'episode', episodeId: E01 },
      }),
    ],
  });
}

describe('reportOpenLoops — implied loops', () => {
  it('lists a foreshadows edge with no payoff, with where it was planted and its age', () => {
    const report = reportOpenLoops(withForeshadow(), { episodeId: E05 });

    expect(report.undeclared).toHaveLength(1);
    expect(report.open).toHaveLength(1);
    const [standing] = report.open;
    expect(standing?.loop.plantedIn.episodeId).toBe(E01);
    // e01 is index 0, e05 is index 4.
    expect(standing?.ageInEpisodes).toBe(4);
    expect(standing?.loop.relations).toEqual([
      withForeshadow().relations.find((edge) => edge.type === 'foreshadows')?.id,
    ]);
  });

  it('closes the loop once something pays it off', () => {
    const graph = withForeshadow();
    const paid = graph.with({
      relations: [
        ...graph.relations,
        relation({
          slug: 'sword-payoff',
          from: KAEL,
          to: SWORD,
          type: 'pays-off',
          fact: 'Kael finally draws the sword.',
          validFrom: storyTime(episodeOrdinal(7)),
          sourceRef: { kind: 'episode', episodeId: episodeId('e07') },
        }),
      ],
    });

    const report = reportOpenLoops(paid, { episodeId: E09 });
    expect(report.open).toHaveLength(0);
    expect(report.paid).toHaveLength(1);
    expect(report.paid[0]?.loop.status).toBe('paid');
    expect(report.paid[0]?.loop.paidIn?.episodeId).toBe(episodeId('e07'));
    expect(report.paid[0]?.by.fact).toBe('Kael finally draws the sword.');
  });

  it('records no episode for a payoff the author asserted outside any episode', () => {
    const graph = withForeshadow();
    const paid = graph.with({
      relations: [
        ...graph.relations,
        relation({
          slug: 'sword-payoff-author',
          from: KAEL,
          to: SWORD,
          type: 'pays-off',
          fact: 'The author declares the sword paid off.',
          validFrom: storyTime(episodeOrdinal(7)),
          sourceRef: { kind: 'author' },
        }),
      ],
    });

    const report = reportOpenLoops(paid, { episodeId: E09 });
    expect(report.paid).toHaveLength(1);
    // Paid, but there is no episode to point at, and it says null rather than guessing.
    expect(report.paid[0]?.loop.paidIn).toBeNull();
  });

  it('takes the lowest-id payoff when several could discharge one loop', () => {
    const graph = withForeshadow();
    const many = graph.with({
      relations: [
        ...graph.relations,
        relation({
          slug: 'payoff-b',
          from: KAEL,
          to: SWORD,
          type: 'pays-off',
          fact: 'Second candidate.',
          validFrom: storyTime(episodeOrdinal(7)),
          sourceRef: { kind: 'episode', episodeId: episodeId('e07') },
        }),
        relation({
          slug: 'payoff-a',
          from: KAEL,
          to: SWORD,
          type: 'pays-off',
          fact: 'First candidate.',
          validFrom: storyTime(episodeOrdinal(8)),
          sourceRef: { kind: 'episode', episodeId: episodeId('e08') },
        }),
      ],
    });

    const once = reportOpenLoops(many, { episodeId: E09 });
    const twice = reportOpenLoops(many, { episodeId: E09 });
    expect(once.paid).toHaveLength(1);
    expect(twice).toStrictEqual(once);
  });

  it('ignores a payoff whose assertion has been retracted', () => {
    const graph = withForeshadow();
    const retracted = graph.with({
      relations: [
        ...graph.relations,
        relation({
          slug: 'payoff-retracted',
          from: KAEL,
          to: SWORD,
          type: 'pays-off',
          fact: 'A payoff we later decided against.',
          validFrom: storyTime(episodeOrdinal(7)),
          retractedAt: '2026-07-01T00:00:00.000Z',
        }),
      ],
    });
    expect(reportOpenLoops(retracted, { episodeId: E09 }).open).toHaveLength(1);
  });

  it('ignores a foreshadows edge whose assertion has been retracted', () => {
    const graph = valeGraph({
      relations: [
        ...valeRelations(),
        relation({
          slug: 'unplanted',
          from: SWORD,
          to: KAEL,
          type: 'foreshadows',
          fact: 'A setup we cut.',
          validFrom: storyTime(episodeOrdinal(1)),
          retractedAt: '2026-07-01T00:00:00.000Z',
        }),
      ],
    });
    expect(reportOpenLoops(graph, { episodeId: E09 }).undeclared).toHaveLength(0);
  });

  it('treats a foreshadows edge with no start as planted before the story', () => {
    const graph = valeGraph({
      relations: [
        ...valeRelations(),
        relation({
          slug: 'always-foreshadow',
          from: SWORD,
          to: KAEL,
          type: 'foreshadows',
          fact: 'The sword was always going to matter.',
          sourceRef: { kind: 'episode', episodeId: E01 },
        }),
      ],
    });
    expect(reportOpenLoops(graph, { episodeId: E05 }).open[0]?.loop.plantedAt).toEqual({
      ordinal: 0,
    });
  });

  it('does not accept a payoff that precedes the plant', () => {
    const graph = withForeshadow();
    const early = graph.with({
      relations: [
        ...graph.relations,
        relation({
          slug: 'sword-payoff-early',
          from: KAEL,
          to: SWORD,
          type: 'pays-off',
          fact: 'Kael drew it before it was ever laid down.',
          validFrom: storyTime(0),
        }),
      ],
    });
    expect(reportOpenLoops(early, { episodeId: E09 }).open).toHaveLength(1);
  });

  it('does not re-derive a loop somebody already declared for the same edge', () => {
    const graph = withForeshadow();
    const edge = graph.relations.find((relation) => relation.type === 'foreshadows');
    const declared = graph.with({
      openLoops: [openLoop('sword', { relations: edge === undefined ? [] : [edge.id] })],
    });
    const report = reportOpenLoops(declared, { episodeId: E05 });
    expect(report.undeclared).toHaveLength(0);
    expect(report.open).toHaveLength(1);
  });

  it('handles a foreshadows edge with no episode behind it', () => {
    const graph = valeGraph({
      relations: [
        ...valeRelations(),
        relation({
          slug: 'authored-foreshadow',
          from: SWORD,
          to: KAEL,
          type: 'foreshadows',
          fact: 'An author note points at the sword.',
          validFrom: storyTime(episodeOrdinal(1)),
          sourceRef: { kind: 'author' },
        }),
      ],
    });
    const report = reportOpenLoops(graph, { episodeId: E05 });
    // Off the schedule, so it has no measurable age - and says so rather than lying.
    expect(report.open[0]?.ageInEpisodes).toBeNull();
  });
});

describe('reportOpenLoops — overdue promises', () => {
  it('raises a warning, never an error, for a stale promise', () => {
    const report = reportOpenLoops(withForeshadow(), { episodeId: E09 });
    expect(report.issues).toHaveLength(1);
    const [issue] = report.issues;
    expect(issue?.rule).toBe('unpaid-open-loop');
    expect(issue?.severity).toBe('warning');
    // The one rule the schema exempts from "name both sides".
    expect(issue?.conflictingFacts).toEqual([]);
    expect(ContinuityIssue.safeParse(issue).success).toBe(true);
  });

  it('stays quiet while the promise is still young', () => {
    const report = reportOpenLoops(withForeshadow(), { episodeId: episodeId('e02') });
    expect(report.open).toHaveLength(1);
    expect(report.open[0]?.overdue).toBe(false);
    expect(report.issues).toEqual([]);
  });

  it('honours a configured staleness threshold', () => {
    expect(
      reportOpenLoops(withForeshadow(), { episodeId: E09, staleAfterEpisodes: 100 }).issues,
    ).toEqual([]);
  });

  it('treats a passed expected-payoff window as overdue regardless of episode count', () => {
    const graph = valeGraph().with({
      openLoops: [
        openLoop('letter', {
          expectedPayoff: { from: storyTime(0), until: storyTime(episodeOrdinal(3)) },
        }),
      ],
    });
    const report = reportOpenLoops(graph, {
      episodeId: E05,
      at: storyTime(episodeOrdinal(5)),
      staleAfterEpisodes: 100,
    });
    expect(report.open[0]?.overdue).toBe(true);
    expect(report.issues).toHaveLength(1);
  });

  it('raises nothing when no episode is being checked', () => {
    expect(reportOpenLoops(withForeshadow()).issues).toEqual([]);
  });

  it('leaves an abandoned promise out of the report entirely', () => {
    const graph = valeGraph().with({
      openLoops: [
        openLoop('dropped', {
          status: 'abandoned',
          abandonedReason: 'The subplot was cut in the season-two restructure.',
        }),
      ],
    });
    const report = reportOpenLoops(graph, { episodeId: E09 });
    expect(report.open).toHaveLength(0);
    expect(report.paid).toHaveLength(0);
  });

  it('leaves an already-paid promise out of the open list', () => {
    const graph = valeGraph().with({
      openLoops: [
        openLoop('settled', {
          status: 'paid',
          paidIn: { episodeId: E01, at: storyTime(episodeOrdinal(1)) },
        }),
      ],
    });
    expect(reportOpenLoops(graph, { episodeId: E09 }).open).toHaveLength(0);
  });
});

describe('TrackOpenLoopsUseCase', () => {
  it('is the same report, reachable as a use-case', () => {
    const graph = withForeshadow();
    expect(new TrackOpenLoopsUseCase().execute({ graph, episodeId: E05 })).toStrictEqual(
      reportOpenLoops(graph, { episodeId: E05 }),
    );
  });
});
