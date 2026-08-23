import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AFFINITY_RELATIONS,
  EPISTEMIC_RELATIONS,
  EpistemicView,
  KINSHIP_RELATIONS,
  KnownFact,
  NARRATIVE_RELATIONS,
  POSSESSION_RELATIONS,
  RELATION_GROUPS,
  RELATION_GROUP_NAMES,
  RELATION_TYPES,
  Relation,
  RelationQuery,
  RelationSource,
  RelationType,
  SOCIAL_RELATIONS,
  SPATIAL_RELATIONS,
  isEpistemicRelation,
  relationGroupOf,
} from './relation';

// ── fixtures ────────────────────────────────────────────────────────────────

const ulid = (tail: string): string => `01J9ZQ3K5M7N9P1R3T5V7X${tail}`;
const entityId = (tail: string): string => `ent_${ulid(tail)}`;

const RELATION_ID = `rel_${ulid('0001')}`;
const SERIES_ID = `ser_${ulid('0002')}`;
const EPISODE_ID = `ep_${ulid('0003')}`;
const SCENE_ID = `scn_${ulid('0004')}`;
const ARIA = entityId('0010');
const KAEL = entityId('0011');

function failurePaths<T>(result: z.ZodSafeParseResult<T>): string[] {
  if (result.success) throw new Error('expected the parse to fail, but it succeeded');
  return result.error.issues.map((issue) => issue.path.join('.'));
}

function prettyFailure<T>(result: z.ZodSafeParseResult<T>): string {
  if (result.success) throw new Error('expected the parse to fail, but it succeeded');
  return z.prettifyError(result.error);
}

/** Walks into a converted JSON Schema, whose nested nodes are typed `JSONSchema | boolean`. */
function schemaAt(json: unknown, ...path: readonly string[]): Record<string, unknown> {
  let node: unknown = json;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) {
      throw new Error(`no JSON Schema node at ${path.join('.')}`);
    }
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node !== 'object' || node === null) {
    throw new Error(`no JSON Schema node at ${path.join('.')}`);
  }
  return node as Record<string, unknown>;
}

/** `(Aria) —parent-of→ (Kael)`, the worked example from docs/02 §3. */
const relation = {
  id: RELATION_ID,
  seriesId: SERIES_ID,
  from: ARIA,
  to: KAEL,
  type: 'parent-of',
  fact: "Aria is Kael's mother.",
  assertedAt: '2026-03-01T09:00:00Z',
  sourceRef: { kind: 'author' },
};

// ── taxonomy ────────────────────────────────────────────────────────────────

describe('the relation taxonomy', () => {
  it('reproduces the seven groups from the domain model', () => {
    expect(RELATION_GROUP_NAMES).toEqual(Object.keys(RELATION_GROUPS));
    expect(KINSHIP_RELATIONS).toEqual(['parent-of', 'sibling-of', 'spouse-of', 'descendant-of']);
    expect(AFFINITY_RELATIONS).toEqual(['loves', 'trusts', 'resents', 'fears', 'envies', 'owes']);
    expect(SOCIAL_RELATIONS).toEqual([
      'ally-of',
      'rival-of',
      'enemy-of',
      'mentor-of',
      'serves',
      'commands',
    ]);
    expect(SPATIAL_RELATIONS).toEqual(['located-in', 'travels-to', 'native-to']);
    expect(POSSESSION_RELATIONS).toEqual(['owns', 'carries', 'lost', 'seeks', 'created']);
    expect(EPISTEMIC_RELATIONS).toEqual([
      'knows',
      'believes-falsely',
      'suspects',
      'witnessed',
      'told',
    ]);
    expect(NARRATIVE_RELATIONS).toEqual(['foreshadows', 'pays-off', 'parallels', 'symbolises']);
  });

  it('flattens every group into the enum exactly once', () => {
    const fromGroups = Object.values(RELATION_GROUPS).flat();
    expect([...RELATION_TYPES]).toEqual(fromGroups);
    expect(new Set(RELATION_TYPES).size).toBe(RELATION_TYPES.length);
    expect(RelationType.safeParse('betrays').success).toBe(false);
  });

  it.each(RELATION_TYPES)('places %s in the group that declares it', (type) => {
    const group = relationGroupOf(type);
    expect(RELATION_GROUPS[group]).toContain(type);
  });

  it('answers the epistemic question without the caller keeping a string list', () => {
    for (const type of EPISTEMIC_RELATIONS) {
      expect(isEpistemicRelation(type)).toBe(true);
      expect(relationGroupOf(type)).toBe('epistemic');
    }
    expect(isEpistemicRelation('parent-of')).toBe(false);
    expect(isEpistemicRelation('foreshadows')).toBe(false);
  });
});

// ── the edge ────────────────────────────────────────────────────────────────

describe('Relation', () => {
  it('parses the canonical example and defaults both clocks to unbounded', () => {
    const parsed = Relation.parse(relation);
    expect(parsed.type).toBe('parent-of');
    expect(parsed.validFrom).toBeNull();
    expect(parsed.validUntil).toBeNull();
    expect(parsed.retractedAt).toBeNull();
    expect(parsed.strength).toBe(0);
    expect(parsed.confidence).toBe(1);
    expect(parsed.visibility).toBe('public');
  });

  it('carries a signed strength', () => {
    expect(Relation.parse({ ...relation, type: 'resents', strength: -0.9 }).strength).toBe(-0.9);
    expect(failurePaths(Relation.safeParse({ ...relation, strength: 1.5 }))).toEqual(['strength']);
  });

  it('requires an authoring instant with an explicit offset', () => {
    expect(
      failurePaths(Relation.safeParse({ ...relation, assertedAt: '2026-03-01T09:00:00' })),
    ).toEqual(['assertedAt']);
    expect(
      Relation.safeParse({ ...relation, assertedAt: '2026-03-01T12:00:00+03:00' }).success,
    ).toBe(true);
  });

  it('discriminates the provenance of the assertion', () => {
    expect(Relation.parse({ ...relation, sourceRef: { kind: 'author' } }).sourceRef.kind).toBe(
      'author',
    );
    const fromEpisode = Relation.parse({
      ...relation,
      sourceRef: { kind: 'episode', episodeId: EPISODE_ID, sceneId: SCENE_ID },
    });
    if (fromEpisode.sourceRef.kind !== 'episode') throw new Error('expected an episode source');
    expect(fromEpisode.sourceRef.sceneId).toBe(SCENE_ID);

    // `inferred` must say what inferred it, so a bad inference is traceable.
    expect(failurePaths(RelationSource.safeParse({ kind: 'inferred' }))).toEqual(['rule']);
    expect(failurePaths(RelationSource.safeParse({ kind: 'divination' }))).toEqual(['kind']);
  });

  it('rejects an unknown key rather than dropping it', () => {
    expect(failurePaths(Relation.safeParse({ ...relation, weight: 3 }))).toEqual(['']);
  });
});

// ── the two clocks ──────────────────────────────────────────────────────────

describe('Relation story-time invariant', () => {
  it('accepts an interval that runs forwards', () => {
    const parsed = Relation.parse({
      ...relation,
      validFrom: { ordinal: 100 },
      validUntil: { ordinal: 800, label: 'E08' },
    });
    expect(parsed.validUntil?.label).toBe('E08');
  });

  it('accepts an interval that opens and closes at the same beat', () => {
    expect(
      Relation.safeParse({
        ...relation,
        validFrom: { ordinal: 400 },
        validUntil: { ordinal: 400 },
      }).success,
    ).toBe(true);
  });

  it('rejects an interval that runs backwards, at the offending field', () => {
    const bad = Relation.safeParse({
      ...relation,
      validFrom: { ordinal: 800 },
      validUntil: { ordinal: 100 },
    });
    expect(failurePaths(bad)).toEqual(['validUntil']);
    expect(prettyFailure(bad)).toContain('validUntil must not precede validFrom');
  });

  it('leaves an unbounded end unchecked in either direction', () => {
    expect(
      Relation.safeParse({ ...relation, validFrom: null, validUntil: { ordinal: -50 } }).success,
    ).toBe(true);
    expect(
      Relation.safeParse({ ...relation, validFrom: { ordinal: 900 }, validUntil: null }).success,
    ).toBe(true);
  });
});

describe('Relation authoring-time invariant', () => {
  it('accepts a retraction after the assertion', () => {
    const parsed = Relation.parse({
      ...relation,
      assertedAt: '2026-03-01T09:00:00Z',
      retractedAt: '2026-07-14T18:30:00Z',
    });
    expect(parsed.retractedAt).toBe('2026-07-14T18:30:00Z');
  });

  it('accepts a retraction at the same instant', () => {
    expect(
      Relation.safeParse({
        ...relation,
        assertedAt: '2026-03-01T09:00:00Z',
        retractedAt: '2026-03-01T09:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('compares instants, not strings, so a different offset is not a violation', () => {
    expect(
      Relation.safeParse({
        ...relation,
        assertedAt: '2026-03-01T09:00:00Z',
        retractedAt: '2026-03-01T12:00:00+03:00',
      }).success,
    ).toBe(true);
  });

  it('rejects a retraction before the assertion, at the offending field', () => {
    const bad = Relation.safeParse({
      ...relation,
      assertedAt: '2026-07-14T18:30:00Z',
      retractedAt: '2026-03-01T09:00:00Z',
    });
    expect(failurePaths(bad)).toEqual(['retractedAt']);
  });

  it('reports both clocks independently when both are inverted', () => {
    const bad = Relation.safeParse({
      ...relation,
      validFrom: { ordinal: 800 },
      validUntil: { ordinal: 100 },
      assertedAt: '2026-07-14T18:30:00Z',
      retractedAt: '2026-03-01T09:00:00Z',
    });
    expect(failurePaths(bad)).toEqual(['validUntil', 'retractedAt']);
  });

  it('lets the clocks disagree, which is the whole point of keeping two', () => {
    // Retro-fit: in E07 we decide the mentor was already lying back in E02. The story
    // interval opens early; the authoring instant is late. Neither contradicts the other.
    const retroFit = Relation.parse({
      ...relation,
      type: 'believes-falsely',
      fact: 'Kael believes his parents died in the fire.',
      validFrom: { ordinal: 100, label: 'E01' },
      validUntil: { ordinal: 800, label: 'E08' },
      assertedAt: '2026-07-14T18:30:00Z',
      retractedAt: null,
    });
    expect(retroFit.validFrom?.ordinal).toBe(100);
    expect(retroFit.retractedAt).toBeNull();

    // And the converse: an edge still true in the fiction but no longer believed by us.
    const unsaid = Relation.parse({
      ...relation,
      validUntil: null,
      retractedAt: '2026-08-01T00:00:00Z',
    });
    expect(unsaid.validUntil).toBeNull();
    expect(unsaid.retractedAt).not.toBeNull();
  });
});

// ── querying ────────────────────────────────────────────────────────────────

describe('RelationQuery', () => {
  it('defaults to every type, every family, every visibility, both directions', () => {
    const parsed = RelationQuery.parse({ seriesId: SERIES_ID });
    expect(parsed.direction).toBe('either');
    expect(parsed.types).toEqual([]);
    expect(parsed.groups).toEqual([]);
    expect(parsed.visibility).toEqual([]);
    expect(parsed.minConfidence).toBe(0);
    expect(parsed.limit).toBe(500);
    // Both clock points absent: "at any point in the story, as we believe it now".
    expect(parsed.at).toBeUndefined();
    expect(parsed.asOf).toBeUndefined();
  });

  it('takes a point on each clock', () => {
    const parsed = RelationQuery.parse({
      seriesId: SERIES_ID,
      entityId: KAEL,
      direction: 'in',
      groups: ['epistemic'],
      at: { ordinal: 500 },
      asOf: '2026-06-01T00:00:00Z',
      visibility: ['secret'],
      minConfidence: 0.6,
    });
    expect(parsed.at?.ordinal).toBe(500);
    expect(parsed.asOf).toBe('2026-06-01T00:00:00Z');
    expect(parsed.groups).toEqual(['epistemic']);
  });

  it('rejects an unknown group', () => {
    expect(
      failurePaths(RelationQuery.safeParse({ seriesId: SERIES_ID, groups: ['gossip'] })),
    ).toEqual(['groups.0']);
  });
});

// ── the epistemic view ──────────────────────────────────────────────────────

describe('EpistemicView', () => {
  const view = {
    seriesId: SERIES_ID,
    viewerId: KAEL,
    at: { ordinal: 500, label: 'E05' },
    asOf: '2026-06-01T00:00:00Z',
  };

  it('defaults to an empty head that admits it is empty', () => {
    const parsed = EpistemicView.parse(view);
    expect(parsed.knows).toEqual([]);
    expect(parsed.believesFalsely).toEqual([]);
    expect(parsed.suspects).toEqual([]);
    expect(parsed.blindSpots).toEqual([]);
    expect(parsed.truncated).toBe(false);
    expect(parsed.factCount).toBe(0);
  });

  it('separates what Kael holds from what is true but hidden from him', () => {
    const parsed = EpistemicView.parse({
      ...view,
      believesFalsely: [
        {
          relationId: RELATION_ID,
          fact: 'My parents died in the fire.',
          via: 'believes-falsely',
          learnedFrom: ARIA,
        },
      ],
      blindSpots: [`rel_${ulid('0099')}`],
      factCount: 12,
    });
    expect(parsed.believesFalsely.at(0)?.learnedAt).toBeNull();
    expect(parsed.believesFalsely.at(0)?.confidence).toBe(1);
    expect(parsed.knows).toEqual([]);
    expect(parsed.blindSpots).toHaveLength(1);
  });

  it('only accepts an epistemic relation as the route into a head', () => {
    expect(
      failurePaths(KnownFact.safeParse({ relationId: RELATION_ID, fact: 'x', via: 'parent-of' })),
    ).toEqual(['via']);
  });

  it('rejects a viewer id that is not an entity id', () => {
    expect(failurePaths(EpistemicView.safeParse({ ...view, viewerId: 'kael' }))).toEqual([
      'viewerId',
    ]);
  });
});

// ── structured output ───────────────────────────────────────────────────────

describe('JSON Schema conversion', () => {
  const fillable = { Relation, RelationQuery, EpistemicView, KnownFact };

  it.each(Object.entries(fillable))(
    '%s converts to a closed JSON Schema object',
    (_name, schema) => {
      const json = z.toJSONSchema(schema, { io: 'input' });
      expect(json.type).toBe('object');
      expect(json.additionalProperties).toBe(false);
    },
  );

  it('converts the provenance union to closed branches', () => {
    const json = z.toJSONSchema(RelationSource, { io: 'input' });
    const branches = json.oneOf ?? [];
    expect(branches).toHaveLength(3);
    for (const branch of branches) {
      expect(branch.additionalProperties).toBe(false);
    }
  });

  it('describes both clocks for the model that has to fill them', () => {
    const json = z.toJSONSchema(Relation, { io: 'input' });
    expect(schemaAt(json, 'properties', 'validUntil').description).toContain('story');
    // The description has to spell out the difference from `validUntil`, because the
    // model filling it in has no other way to learn that the two clocks are separate.
    expect(schemaAt(json, 'properties', 'retractedAt').description).toContain('validUntil');
    expect(json.required).toEqual([
      'id',
      'seriesId',
      'from',
      'to',
      'type',
      'fact',
      'assertedAt',
      'sourceRef',
    ]);
  });
});
