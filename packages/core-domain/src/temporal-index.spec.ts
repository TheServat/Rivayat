import { fromIso } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { CAST, relation, t } from './__fixtures__/relations';
import { BiTemporalIndex } from './temporal-index';

const E01 = t(100);
const E05 = t(500);
const E08 = t(800);

const JAN = '2026-01-01T00:00:00.000Z';
const JUL = '2026-07-01T00:00:00.000Z';

describe('story time - was it true then', () => {
  const fact = relation({ validFrom: E01, validUntil: E08 });

  it('is true inside the span', () => {
    expect(BiTemporalIndex.isValidAt(fact, E05)).toBe(true);
  });

  it('includes its start and excludes its end - the interval is half-open', () => {
    // A state that ends at 800 and one that begins at 800 must not both be true at
    // 800, or every state change leaves a one-tick contradiction behind.
    expect(BiTemporalIndex.isValidAt(fact, E01)).toBe(true);
    expect(BiTemporalIndex.isValidAt(fact, E08)).toBe(false);
  });

  it('is false before it starts', () => {
    expect(BiTemporalIndex.isValidAt(fact, t(0))).toBe(false);
  });

  it('treats a null bound as unbounded', () => {
    const forever = relation({ validFrom: null, validUntil: null });
    expect(BiTemporalIndex.isValidAt(forever, t(-999_999))).toBe(true);
    expect(BiTemporalIndex.isValidAt(forever, t(999_999))).toBe(true);
  });
});

describe('authoring time - did we know it then', () => {
  it('is unknown before it was written down', () => {
    const fact = relation({ assertedAt: JUL });
    expect(BiTemporalIndex.wasKnownAt(fact, fromIso(JAN))).toBe(false);
    expect(BiTemporalIndex.wasKnownAt(fact, fromIso(JUL))).toBe(true);
  });

  it('stops being known once retracted', () => {
    const fact = relation({ assertedAt: JAN, retractedAt: JUL });
    expect(BiTemporalIndex.wasKnownAt(fact, fromIso('2026-03-01T00:00:00.000Z'))).toBe(true);
    expect(BiTemporalIndex.wasKnownAt(fact, fromIso(JUL))).toBe(false);
  });

  it('compares instants, not strings - a different UTC offset is the same moment', () => {
    const fact = relation({ assertedAt: '2026-01-01T03:00:00.000+03:00' });
    expect(BiTemporalIndex.wasKnownAt(fact, fromIso('2026-01-01T00:00:00.000Z'))).toBe(true);
  });

  it('distinguishes current from retracted', () => {
    expect(BiTemporalIndex.isCurrent(relation())).toBe(true);
    expect(BiTemporalIndex.isCurrent(relation({ retractedAt: JUL }))).toBe(false);
  });
});

describe('the two clocks are genuinely independent', () => {
  it('supports retro-fitted backstory', () => {
    // In July we decide that back in episode 2 the mentor was already lying.
    // Story time starts at episode 2; authoring time starts in July.
    const retrofit = relation({
      from: CAST.mentor,
      to: CAST.kael,
      type: 'believes-falsely',
      validFrom: t(200),
      assertedAt: JUL,
      visibility: 'secret',
    });
    const index = new BiTemporalIndex([retrofit]);

    // It is true in the fiction from episode 2 onward...
    expect(index.query({ storyAt: t(250) })).toHaveLength(1);
    // ...but was not part of what we had written in January.
    expect(index.query({ storyAt: t(250), authoredAt: fromIso(JAN) })).toHaveLength(0);
    // ...and is part of what we had written in July.
    expect(index.query({ storyAt: t(250), authoredAt: fromIso(JUL) })).toHaveLength(1);
  });

  it('can reconstruct what the model believed at an earlier authoring instant', () => {
    const superseded = relation({ fact: 'v1', assertedAt: JAN, retractedAt: JUL });
    const replacement = relation({ fact: 'v2', assertedAt: JUL });
    const index = new BiTemporalIndex([superseded, replacement]);

    const inMarch = index.query({ authoredAt: fromIso('2026-03-01T00:00:00.000Z') });
    expect(inMarch.map((r) => r.fact)).toEqual(['v1']);

    const today = index.query();
    expect(today.map((r) => r.fact)).toEqual(['v2']);
  });
});

describe('query', () => {
  const index = new BiTemporalIndex([
    relation({ from: CAST.kael, to: CAST.aria, type: 'trusts', strength: 0.8 }),
    relation({ from: CAST.kael, to: CAST.mentor, type: 'fears', strength: -0.4 }),
    relation({ from: CAST.aria, to: CAST.village, type: 'located-in' }),
    relation({ from: CAST.kael, to: CAST.lantern, type: 'owns', visibility: 'secret' }),
    relation({ from: CAST.mentor, to: CAST.kael, type: 'loves', confidence: 0.3 }),
  ]);

  it('returns everything by default', () => {
    expect(index.query()).toHaveLength(5);
    expect(index.size).toBe(5);
    expect(index.all()).toHaveLength(5);
  });

  it('filters by subject and by object', () => {
    expect(index.query({ from: CAST.kael })).toHaveLength(3);
    expect(index.query({ to: CAST.kael })).toHaveLength(1);
  });

  it('filters by type', () => {
    expect(index.query({ types: ['trusts', 'fears'] })).toHaveLength(2);
  });

  it('filters by visibility, which is how a spoiler-free view is produced', () => {
    expect(index.query({ visibility: ['public'] })).toHaveLength(4);
    expect(index.query({ visibility: ['secret'] })).toHaveLength(1);
  });

  it('filters low-confidence inferences', () => {
    expect(index.query({ minConfidence: 0.5 })).toHaveLength(4);
  });

  it('combines filters conjunctively', () => {
    expect(index.query({ from: CAST.kael, types: ['owns'], visibility: ['secret'] })).toHaveLength(
      1,
    );
    expect(index.query({ from: CAST.kael, types: ['owns'], visibility: ['public'] })).toHaveLength(
      0,
    );
  });

  it('narrows by subject and object together', () => {
    expect(index.query({ from: CAST.kael, to: CAST.aria })).toHaveLength(1);
    expect(index.query({ from: CAST.kael, to: CAST.village })).toHaveLength(0);
  });

  it('returns nothing for an entity with no relations', () => {
    expect(index.query({ from: CAST.citadel })).toEqual([]);
  });

  it('excludes retracted facts unless an authoring standpoint is given', () => {
    const withRetracted = new BiTemporalIndex([relation({ retractedAt: JUL })]);
    expect(withRetracted.query()).toHaveLength(0);
    expect(withRetracted.query({ authoredAt: fromIso(JAN) })).toHaveLength(1);
  });

  it('does not reflect later mutation of the array it was built from', () => {
    const source = [relation()];
    const built = new BiTemporalIndex(source);
    source.push(relation({ type: 'fears' }));
    expect(built.size).toBe(1);
  });
});

describe('the epistemic layer - who knows what', () => {
  const truth = relation({
    from: CAST.aria,
    to: CAST.kael,
    type: 'parent-of',
    visibility: 'secret',
    validFrom: null,
  });
  const belief = relation({
    from: CAST.kael,
    to: CAST.mentor,
    type: 'believes-falsely',
    validFrom: t(0),
    validUntil: E08,
  });
  const reveal = relation({
    from: CAST.kael,
    to: CAST.aria,
    type: 'knows',
    validFrom: E08,
  });
  const index = new BiTemporalIndex([truth, belief, reveal]);

  it('returns only epistemic edges', () => {
    const known = index.knowledgeOf(CAST.kael, { storyAt: E05 });
    expect(known).toHaveLength(1);
    expect(known[0]?.type).toBe('believes-falsely');
  });

  it('changes as the story advances - a belief ends when the truth lands', () => {
    expect(index.knowledgeOf(CAST.kael, { storyAt: E05 }).map((r) => r.type)).toEqual([
      'believes-falsely',
    ]);
    expect(index.knowledgeOf(CAST.kael, { storyAt: t(900) }).map((r) => r.type)).toEqual(['knows']);
  });

  it('returns nothing for a character with no epistemic edges', () => {
    expect(index.knowledgeOf(CAST.village)).toEqual([]);
  });

  it('lets anyone act on a public fact', () => {
    const publicFact = relation({ visibility: 'public' });
    expect(index.couldKnow(CAST.village, publicFact)).toBe(true);
  });

  it('lets the subject of a secret act on it, but not its object', () => {
    // `truth` is (Aria) -parent-of-> (Kael), secret. Aria knows she is the mother.
    // Kael is the *object*, and is exactly the character the secret is kept from -
    // treating him as a participant made the rule answer "yes" for the single fact
    // the epistemic layer exists to withhold.
    expect(index.couldKnow(CAST.aria, truth, { storyAt: E05 })).toBe(true);
    expect(index.couldKnow(CAST.kael, truth, { storyAt: E05 })).toBe(false);
  });

  it('lets the object act on it once the story has told him', () => {
    // The question is meaningless without a standpoint: at E05 Kael has only a false
    // belief, and at E09 he has a `knows` edge reaching Aria. Same fact, same
    // character, opposite answers - which is the entire point of the temporal graph.
    expect(index.couldKnow(CAST.kael, truth, { storyAt: t(900) })).toBe(true);
  });

  it('still treats both participants of a non-secret fact as knowing it', () => {
    // A private marriage is not a secret from the spouses.
    const marriage = relation({
      from: CAST.aria,
      to: CAST.mentor,
      type: 'spouse-of',
      visibility: 'private',
    });
    const withMarriage = new BiTemporalIndex([marriage]);
    expect(withMarriage.couldKnow(CAST.mentor, marriage)).toBe(true);
  });

  it('lets the object of a secret act on it when being told is the whole relation', () => {
    const confided = relation({
      from: CAST.aria,
      to: CAST.kael,
      type: 'told',
      visibility: 'secret',
    });
    expect(new BiTemporalIndex([confided]).couldKnow(CAST.kael, confided)).toBe(true);
  });

  it('stops a bystander acting on a secret they were never told', () => {
    // This is the mechanism: the scene writer for episode 5 gets Kael's view, so Kael
    // cannot reveal something nobody has told him.
    expect(index.couldKnow(CAST.village, truth, { storyAt: E05 })).toBe(false);
  });

  it('lets a character act once an epistemic edge reaches the fact subject', () => {
    const told = relation({ from: CAST.village, to: CAST.aria, type: 'told', validFrom: t(0) });
    const withTelling = new BiTemporalIndex([truth, told]);
    expect(withTelling.couldKnow(CAST.village, truth, { storyAt: E05 })).toBe(true);
  });

  it('also counts an epistemic edge reaching the fact object', () => {
    // `truth` is (Aria)-parent-of->(Kael). Knowing about Kael is enough.
    const witnessed = relation({
      from: CAST.village,
      to: CAST.kael,
      type: 'witnessed',
      validFrom: t(0),
    });
    const withWitness = new BiTemporalIndex([truth, witnessed]);
    expect(withWitness.couldKnow(CAST.village, truth, { storyAt: E05 })).toBe(true);
  });
});

describe('neighbourhood traversal', () => {
  const index = new BiTemporalIndex([
    relation({ from: CAST.kael, to: CAST.aria, type: 'trusts' }),
    relation({ from: CAST.aria, to: CAST.mentor, type: 'mentor-of' }),
    relation({ from: CAST.mentor, to: CAST.citadel, type: 'located-in' }),
    relation({ from: CAST.village, to: CAST.lantern, type: 'owns' }),
  ]);

  it('reaches one hop', () => {
    const hood = index.neighbourhood([CAST.kael], 1);
    expect([...hood.entities].sort()).toEqual([CAST.aria, CAST.kael].sort());
    expect(hood.relations).toHaveLength(1);
  });

  it('reaches two hops', () => {
    const hood = index.neighbourhood([CAST.kael], 2);
    expect(hood.entities.has(CAST.mentor)).toBe(true);
    expect(hood.entities.has(CAST.citadel)).toBe(false);
  });

  it('traverses undirected - being the object counts as a connection', () => {
    // "Who is Kael's mentor" and "whose mentor is Aria" are one question to a reader.
    const hood = index.neighbourhood([CAST.mentor], 1);
    expect(hood.entities.has(CAST.aria)).toBe(true);
    expect(hood.entities.has(CAST.citadel)).toBe(true);
  });

  it('records the hop at which each entity was first reached', () => {
    const hood = index.neighbourhood([CAST.kael], 3);
    expect(hood.distance.get(CAST.kael)).toBe(0);
    expect(hood.distance.get(CAST.aria)).toBe(1);
    expect(hood.distance.get(CAST.mentor)).toBe(2);
  });

  it('never returns the same relation twice', () => {
    const hood = index.neighbourhood([CAST.kael, CAST.aria], 2);
    expect(new Set(hood.relations.map((r) => r.id)).size).toBe(hood.relations.length);
  });

  it('accepts several seeds and de-duplicates them', () => {
    const hood = index.neighbourhood([CAST.kael, CAST.kael], 0);
    expect(hood.entities.size).toBe(1);
    expect(hood.relations).toEqual([]);
  });

  it('reaches nothing from an isolated entity', () => {
    const hood = index.neighbourhood([CAST.citadel], 1);
    expect(hood.entities.has(CAST.mentor)).toBe(true);
    expect(index.neighbourhood([], 3).entities.size).toBe(0);
  });

  it('honours the temporal standpoint while traversing', () => {
    const later = new BiTemporalIndex([
      relation({ from: CAST.kael, to: CAST.aria, type: 'trusts', validFrom: E08 }),
    ]);
    expect(later.neighbourhood([CAST.kael], 1, { storyAt: E05 }).entities.size).toBe(1);
    expect(later.neighbourhood([CAST.kael], 1, { storyAt: t(900) }).entities.size).toBe(2);
  });
});

describe('structural contradictions', () => {
  it('finds a subject in two places at once', () => {
    const index = new BiTemporalIndex([
      relation({ from: CAST.kael, to: CAST.village, type: 'located-in', validFrom: t(0) }),
      relation({ from: CAST.kael, to: CAST.citadel, type: 'located-in', validFrom: t(50) }),
    ]);
    const found = index.findContradictions();
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('conflicting-object');
  });

  it('accepts the same functional relation when the spans do not overlap', () => {
    // Moving house is not a contradiction.
    const index = new BiTemporalIndex([
      relation({
        from: CAST.kael,
        to: CAST.village,
        type: 'located-in',
        validFrom: t(0),
        validUntil: t(50),
      }),
      relation({ from: CAST.kael, to: CAST.citadel, type: 'located-in', validFrom: t(50) }),
    ]);
    expect(index.findContradictions()).toEqual([]);
  });

  it('finds the same relation asserted with opposite valence', () => {
    const index = new BiTemporalIndex([
      relation({ from: CAST.kael, to: CAST.aria, type: 'trusts', strength: 0.9 }),
      relation({ from: CAST.kael, to: CAST.aria, type: 'trusts', strength: -0.8 }),
    ]);
    const found = index.findContradictions();
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('opposite-strength');
    expect(found[0]?.explanation).toMatch(/opposite valence/);
  });

  it('ignores a retracted assertion - it is no longer claimed', () => {
    const index = new BiTemporalIndex([
      relation({ from: CAST.kael, to: CAST.village, type: 'located-in' }),
      relation({
        from: CAST.kael,
        to: CAST.citadel,
        type: 'located-in',
        retractedAt: JUL,
      }),
    ]);
    expect(index.findContradictions()).toEqual([]);
  });

  it('does not flag non-functional relations with different objects', () => {
    // Trusting two people is not a contradiction; being in two places is.
    const index = new BiTemporalIndex([
      relation({ from: CAST.kael, to: CAST.aria, type: 'trusts', strength: 0.5 }),
      relation({ from: CAST.kael, to: CAST.mentor, type: 'trusts', strength: 0.5 }),
    ]);
    expect(index.findContradictions()).toEqual([]);
  });

  it('does not flag different subjects', () => {
    const index = new BiTemporalIndex([
      relation({ from: CAST.kael, to: CAST.village, type: 'located-in' }),
      relation({ from: CAST.aria, to: CAST.citadel, type: 'located-in' }),
    ]);
    expect(index.findContradictions()).toEqual([]);
  });

  it('treats unbounded facts as overlapping everything', () => {
    // Both bounds null on one side exercises the DAWN/HORIZON fallbacks.
    const index = new BiTemporalIndex([
      relation({
        from: CAST.kael,
        to: CAST.village,
        type: 'located-in',
        validFrom: null,
        validUntil: null,
      }),
      relation({
        from: CAST.kael,
        to: CAST.citadel,
        type: 'located-in',
        validFrom: t(500),
        validUntil: t(600),
      }),
    ]);
    expect(index.findContradictions()).toHaveLength(1);
  });

  it('handles the unbounded fact appearing second as well as first', () => {
    const index = new BiTemporalIndex([
      relation({
        from: CAST.kael,
        to: CAST.citadel,
        type: 'located-in',
        validFrom: t(500),
        validUntil: t(600),
      }),
      relation({
        from: CAST.kael,
        to: CAST.village,
        type: 'located-in',
        validFrom: null,
        validUntil: null,
      }),
    ]);
    expect(index.findContradictions()).toHaveLength(1);
  });

  it('finds nothing in an empty graph', () => {
    expect(new BiTemporalIndex([]).findContradictions()).toEqual([]);
  });
});
