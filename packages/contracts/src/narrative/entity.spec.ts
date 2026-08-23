import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CharacterPayload,
  ConceptPayload,
  CreaturePayload,
  ENTITY_KINDS,
  Entity,
  EntityAssetLink,
  EntityKind,
  EventPayload,
  FactionPayload,
  IMPORTANCE_LEVELS,
  Importance,
  LocationPayload,
  NamedVisualState,
  PropPayload,
  SubstancePayload,
  VehiclePayload,
  WardrobeSet,
} from './entity';

// ── fixtures ────────────────────────────────────────────────────────────────

const ulid = (tail: string): string => `01J9ZQ3K5M7N9P1R3T5V7X${tail}`;
const entityId = (tail: string): string => `ent_${ulid(tail)}`;
const beatId = (tail: string): string => `bet_${ulid(tail)}`;
const assetId = (tail: string): string => `ast_${ulid(tail)}`;

const SERIES_ID = `ser_${ulid('0001')}`;

function failurePaths<T>(result: z.ZodSafeParseResult<T>): string[] {
  if (result.success) throw new Error('expected the parse to fail, but it succeeded');
  return result.error.issues.map((issue) => issue.path.join('.'));
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

const characterPayload = {
  identity: {
    age: '34',
    gender: 'woman',
    occupation: 'harbour clerk',
    origin: 'Tallow Reach',
  },
  psych: {
    want: "To buy back her father's berth on the quay.",
    need: 'To stop paying for a debt that was never hers.',
    wound: 'She signed the manifest that sent the Kestrel out in a storm.',
    lie: 'If she is useful enough, nobody will look too closely at her.',
    ghost: 'The night the Kestrel did not come back.',
    temperament: {},
  },
  voice: { silenceHabits: 'Goes flat and administrative when she is frightened.' },
  arc: {
    startState: 'Answers every question with paperwork.',
    endState: 'Says the thing out loud, in front of the guild.',
  },
  visual: {
    silhouetteNote: 'A long coat two sizes too big, shoulders squared inside it.',
    build: 'lean',
    height: 'a head above most',
  },
  motionSignature: {
    idleBehaviour: 'Squares the edges of whatever paper is in front of her.',
    tellOnLying: 'Stops blinking.',
  },
};

const locationPayload = {
  locationType: 'exterior',
  scale: 'district',
  establishingNote: 'A tide-scoured quay under a sky the colour of wet slate.',
  architecture: 'Tarred timber on stone footings, patched a century past its span.',
};

const propPayload = {
  scale: 'handheld',
  materials: ['whalebone', 'brass'],
  significance: 'The only object her father left that was not sold.',
};

const factionPayload = {
  factionType: 'guild',
  ideology: 'The quay feeds the city; the guild feeds the quay.',
  goal: 'Hold the berth rights through the winter charter.',
  methods: 'Paperwork first, then the harbour watch, then the river.',
  insignia: 'A brass cleat crossed with a tally-stick, stamped not painted.',
};

const creaturePayload = {
  species: 'reach-hound',
  sizeClass: 'large',
  anatomy: 'Quadruped, long in the spine, no visible eyes.',
  silhouetteNote: 'A low wedge that ends in too much shoulder.',
  movementNote: 'Leads with the nose, drags the hindquarters, then arrives all at once.',
};

const conceptPayload = {
  conceptType: 'law',
  definition: 'A berth right is held by the person whose name is on the winter charter.',
  manifestation: 'Wax seals, and a queue that never moves.',
};

const eventPayload = {
  eventType: 'disaster',
  occurredAt: { ordinal: -400, label: 'the year of the long storm' },
  account: 'The Kestrel went out on a signed manifest and did not come back.',
  consequences: 'Eleven berths changed hands inside a month.',
};

const vehiclePayload = {
  vehicleType: 'sea',
  propulsion: 'eight oars and a following wind',
  materials: ['tarred oak'],
};

const substancePayload = {
  substanceType: 'organic',
  appearance: 'A grey wax that holds the light a half-second too long.',
};

const PAYLOADS: Record<EntityKind, unknown> = {
  character: characterPayload,
  location: locationPayload,
  prop: propPayload,
  faction: factionPayload,
  creature: creaturePayload,
  concept: conceptPayload,
  event: eventPayload,
  vehicle: vehiclePayload,
  substance: substancePayload,
};

const envelope = {
  id: entityId('0100'),
  seriesId: SERIES_ID,
  canonicalName: 'Aria Vess',
  summary: 'The harbour clerk who signed the manifest.',
  firstAppearance: { ordinal: 0 },
};

const entityOf = (kind: EntityKind): Record<string, unknown> => ({
  ...envelope,
  kind,
  payload: PAYLOADS[kind],
});

// ── the taxonomy ────────────────────────────────────────────────────────────

describe('EntityKind and Importance', () => {
  it('carries exactly the nine kinds from the domain model', () => {
    expect(ENTITY_KINDS).toEqual([
      'character',
      'location',
      'prop',
      'faction',
      'creature',
      'concept',
      'event',
      'vehicle',
      'substance',
    ]);
    expect(EntityKind.parse('creature')).toBe('creature');
    expect(EntityKind.safeParse('spaceship').success).toBe(false);
  });

  it('orders importance from lead down to mentioned', () => {
    expect(IMPORTANCE_LEVELS).toEqual([
      'lead',
      'supporting',
      'recurring',
      'background',
      'mentioned',
    ]);
    expect(Importance.safeParse('protagonist').success).toBe(false);
  });
});

// ── the union ───────────────────────────────────────────────────────────────

describe('Entity', () => {
  it.each(ENTITY_KINDS)('parses a valid %s entity', (kind) => {
    const parsed = Entity.parse(entityOf(kind));
    expect(parsed.kind).toBe(kind);
  });

  it('routes the discriminant to the matching payload type', () => {
    const parsed = Entity.parse(entityOf('character'));
    // Narrowing on `kind` must give the character payload with no cast.
    if (parsed.kind !== 'character') throw new Error('expected a character');
    expect(parsed.payload.psych.want).toContain('berth');
    expect(parsed.payload.knowledgeScope).toBe('limited');

    const place = Entity.parse(entityOf('location'));
    if (place.kind !== 'location') throw new Error('expected a location');
    expect(place.payload.scale).toBe('district');
  });

  it('rejects a payload that belongs to a different kind', () => {
    const mismatch = Entity.safeParse({ ...envelope, kind: 'character', payload: locationPayload });
    const paths = failurePaths(mismatch);
    // Every complaint must point inside `payload`, so the caller knows which half is wrong.
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path.startsWith('payload'))).toBe(true);
    expect(paths).toContain('payload.identity');
  });

  it('rejects an unknown discriminant at the `kind` path', () => {
    expect(failurePaths(Entity.safeParse({ ...envelope, kind: 'spaceship', payload: {} }))).toEqual(
      ['kind'],
    );
  });

  it('rejects unknown envelope keys rather than dropping them', () => {
    const extra = Entity.safeParse({ ...entityOf('prop'), narrator: 'omniscient' });
    expect(failurePaths(extra)).toEqual(['']);
  });

  it('rejects a malformed branded id at the field that carries it', () => {
    const bad = Entity.safeParse({ ...entityOf('prop'), id: 'ent_not-a-ulid' });
    expect(failurePaths(bad)).toEqual(['id']);
  });

  it('applies envelope defaults', () => {
    const parsed = Entity.parse(entityOf('concept'));
    expect(parsed.importance).toBe('background');
    expect(parsed.aliases).toEqual([]);
    expect(parsed.assetRefs).toEqual([]);
    expect(parsed.embedding).toEqual([]);
  });
});

// ── character payload ───────────────────────────────────────────────────────

describe('CharacterPayload', () => {
  it('defaults temperament to the neutral pole on every axis', () => {
    const parsed = CharacterPayload.parse(characterPayload);
    expect(parsed.psych.temperament).toEqual({
      warmth: 0,
      dominance: 0,
      volatility: 0,
      openness: 0,
      conscientiousness: 0,
    });
  });

  it('treats temperament as bipolar and accepts the negative pole', () => {
    const parsed = CharacterPayload.parse({
      ...characterPayload,
      psych: { ...characterPayload.psych, temperament: { warmth: -1, dominance: 0.4 } },
    });
    expect(parsed.psych.temperament.warmth).toBe(-1);
    expect(parsed.psych.temperament.dominance).toBe(0.4);
  });

  it('rejects a temperament value outside the signed unit range', () => {
    const bad = CharacterPayload.safeParse({
      ...characterPayload,
      psych: { ...characterPayload.psych, temperament: { volatility: 1.5 } },
    });
    expect(failurePaths(bad)).toEqual(['psych.temperament.volatility']);
  });

  it('defaults identity, voice, motion and knowledge scope', () => {
    const parsed = CharacterPayload.parse(characterPayload);
    expect(parsed.identity.species).toBe('human');
    expect(parsed.identity.ageYears).toBeUndefined();
    expect(parsed.voice.register).toBe('neutral');
    expect(parsed.voice.verbosity).toBe('measured');
    expect(parsed.voice.profanity).toBe('none');
    expect(parsed.voice.sentenceRhythm).toBe('balanced');
    expect(parsed.voice.humourMode).toBe('none');
    expect(parsed.voice.idiolect).toEqual([]);
    expect(parsed.motionSignature.gaitStyle).toBe('stride');
    expect(parsed.motionSignature.posture).toBe('upright');
    expect(parsed.motionSignature.gestureFrequency).toBe(0.5);
    expect(parsed.motionSignature.energy).toBe(0.5);
    expect(parsed.knowledgeScope).toBe('limited');
  });

  it('keeps the numeric age when the fiction has one, for age arithmetic', () => {
    const parsed = CharacterPayload.parse({
      ...characterPayload,
      identity: { ...characterPayload.identity, ageYears: 34 },
    });
    expect(parsed.identity.ageYears).toBe(34);
  });

  it('carries the arc turning points as beat ids', () => {
    const parsed = CharacterPayload.parse({
      ...characterPayload,
      arc: { ...characterPayload.arc, turningPoints: [beatId('0201'), beatId('0202')] },
    });
    expect(parsed.arc.turningPoints).toHaveLength(2);
  });

  it('rejects a turning point that is not a beat id', () => {
    const bad = CharacterPayload.safeParse({
      ...characterPayload,
      arc: { ...characterPayload.arc, turningPoints: [entityId('0203')] },
    });
    expect(failurePaths(bad)).toEqual(['arc.turningPoints.0']);
  });

  it('accepts wardrobe, expression and pose sets and reports the path of a bad one', () => {
    const parsed = CharacterPayload.parse({
      ...characterPayload,
      visual: {
        ...characterPayload.visual,
        wardrobe: [
          {
            slug: 'wardrobe-winter',
            label: 'Winter quay coat',
            description: 'Oiled canvas over three layers of wool, salt-stiff at the hem.',
            validity: { from: { ordinal: 120 }, until: null },
            palette: [{ name: 'wet slate', hex: '#3b4148', role: 'neutral' }],
          },
        ],
        expressionSet: [
          {
            slug: 'cornered',
            label: 'Cornered',
            description: 'Chin down, eyes level, both hands flat on the desk.',
          },
        ],
        poseSet: [
          {
            slug: 'signing',
            label: 'Signing',
            description: 'Weight on the left, pen already down.',
          },
        ],
      },
    });
    expect(parsed.visual.wardrobe.at(0)?.validity.until).toBeNull();
    expect(parsed.visual.expressionSet.at(0)?.intensity).toBe(0.7);
    expect(parsed.visual.poseSet.at(0)?.slug).toBe('signing');

    const bad = CharacterPayload.safeParse({
      ...characterPayload,
      visual: {
        ...characterPayload.visual,
        expressionSet: [{ slug: 'Not A Slug', label: 'x', description: 'y' }],
      },
    });
    expect(failurePaths(bad)).toEqual(['visual.expressionSet.0.slug']);
  });
});

describe('NamedVisualState and WardrobeSet', () => {
  it('defaults expression intensity to a readable-but-not-theatrical 0.7', () => {
    const parsed = NamedVisualState.parse({
      slug: 'grieving',
      label: 'Grieving',
      description: 'Mouth slack, jaw loose, eyes fixed past the camera.',
    });
    expect(parsed.intensity).toBe(0.7);
  });

  it('rejects an intensity outside 0..1', () => {
    const bad = NamedVisualState.safeParse({
      slug: 'grieving',
      label: 'Grieving',
      description: 'x',
      intensity: 2,
    });
    expect(failurePaths(bad)).toEqual(['intensity']);
  });

  it('accepts an unbounded wardrobe validity at both ends', () => {
    const parsed = WardrobeSet.parse({
      slug: 'wardrobe-default',
      label: 'Default',
      description: 'What she wears when nothing has happened yet.',
      validity: { from: null, until: null },
    });
    expect(parsed.validity).toEqual({ from: null, until: null });
    expect(parsed.palette).toEqual([]);
  });
});

describe('EntityAssetLink', () => {
  it('expresses demand before an asset exists', () => {
    const parsed = EntityAssetLink.parse({
      semanticKey: 'char/aria/base',
      role: 'turnaround',
    });
    expect(parsed.assetId).toBeUndefined();
    expect(parsed.variantKey).toBeUndefined();
  });

  it('carries the resolved asset once the registry has minted it', () => {
    const parsed = EntityAssetLink.parse({
      semanticKey: 'char/aria/base',
      role: 'expression',
      variantKey: 'cornered',
      assetId: assetId('0300'),
    });
    expect(parsed.assetId).toBe(assetId('0300'));
  });

  it('rejects a semantic key that is not a slug path', () => {
    expect(
      failurePaths(EntityAssetLink.safeParse({ semanticKey: 'Char Aria', role: 'portrait' })),
    ).toEqual(['semanticKey']);
  });
});

// ── the other payloads ──────────────────────────────────────────────────────

describe('LocationPayload', () => {
  it('defaults the parent link to null and the variant lists to empty', () => {
    const parsed = LocationPayload.parse(locationPayload);
    expect(parsed.parentLocation).toBeNull();
    expect(parsed.timeOfDayVariants).toEqual([]);
    expect(parsed.weatherVariants).toEqual([]);
    expect(parsed.moodVariants).toEqual([]);
  });

  it('carries the mood, time-of-day and weather variants the asset planner multiplies', () => {
    const parsed = LocationPayload.parse({
      ...locationPayload,
      parentLocation: entityId('0400'),
      timeOfDayVariants: ['dawn', 'night'],
      weatherVariants: ['storm', 'fog'],
      moodVariants: [
        {
          slug: 'after-the-wreck',
          label: 'After the wreck',
          description: 'Empty, and too bright.',
        },
      ],
    });
    expect(parsed.parentLocation).toBe(entityId('0400'));
    expect(parsed.timeOfDayVariants).toEqual(['dawn', 'night']);
    expect(parsed.weatherVariants).toEqual(['storm', 'fog']);
    expect(parsed.moodVariants).toHaveLength(1);
  });

  it('rejects an unknown time of day', () => {
    expect(
      failurePaths(
        LocationPayload.safeParse({ ...locationPayload, timeOfDayVariants: ['teatime'] }),
      ),
    ).toEqual(['timeOfDayVariants.0']);
  });
});

describe('PropPayload', () => {
  it('defaults to un-rigged, unique set dressing', () => {
    const parsed = PropPayload.parse(propPayload);
    expect(parsed.riggable).toBe(false);
    expect(parsed.isUnique).toBe(true);
    expect(parsed.conditionVariants).toEqual([]);
  });

  it('requires at least one material', () => {
    expect(failurePaths(PropPayload.safeParse({ ...propPayload, materials: [] }))).toEqual([
      'materials',
    ]);
  });

  it('accepts a riggable prop that says what articulates', () => {
    const parsed = PropPayload.parse({
      ...propPayload,
      riggable: true,
      articulation: 'The blade pivots out of the handle through 170 degrees.',
    });
    expect(parsed.riggable).toBe(true);
  });

  it('rejects a riggable prop with nothing for the rig builder to fit', () => {
    const bad = PropPayload.safeParse({ ...propPayload, riggable: true });
    expect(failurePaths(bad)).toEqual(['articulation']);
  });

  it('allows a non-riggable prop to omit articulation', () => {
    expect(PropPayload.safeParse({ ...propPayload, riggable: false }).success).toBe(true);
  });
});

describe('FactionPayload', () => {
  it('defaults hierarchy, seat and reputation', () => {
    const parsed = FactionPayload.parse(factionPayload);
    expect(parsed.hierarchy).toBe('strict-hierarchy');
    expect(parsed.seat).toBeNull();
    expect(parsed.reputation).toBe(0);
    expect(parsed.ranks).toEqual([]);
  });

  it('accepts a signed reputation', () => {
    expect(FactionPayload.parse({ ...factionPayload, reputation: -0.8 }).reputation).toBe(-0.8);
    expect(failurePaths(FactionPayload.safeParse({ ...factionPayload, reputation: -2 }))).toEqual([
      'reputation',
    ]);
  });
});

describe('CreaturePayload', () => {
  it('defaults intelligence, gait and hostility', () => {
    const parsed = CreaturePayload.parse(creaturePayload);
    expect(parsed.intelligence).toBe('animal');
    expect(parsed.gait).toBe('prowl');
    expect(parsed.hostility).toBe(0);
    expect(parsed.stateVariants).toEqual([]);
  });
});

describe('ConceptPayload', () => {
  it('defaults diffusion to common and the rule lists to empty', () => {
    const parsed = ConceptPayload.parse(conceptPayload);
    expect(parsed.diffusion).toBe('common');
    expect(parsed.rules).toEqual([]);
    expect(parsed.costs).toEqual([]);
  });

  it('keeps world rules as separate quotable entries', () => {
    const parsed = ConceptPayload.parse({
      ...conceptPayload,
      diffusion: 'secret',
      rules: ['A charter name may be struck only by the person who wrote it.'],
    });
    expect(parsed.diffusion).toBe('secret');
    expect(parsed.rules).toHaveLength(1);
  });
});

describe('EventPayload, VehiclePayload and SubstancePayload', () => {
  it('places an event before the series opens', () => {
    const parsed = EventPayload.parse(eventPayload);
    expect(parsed.occurredAt.ordinal).toBe(-400);
    expect(parsed.place).toBeNull();
    expect(parsed.disputed).toBe(false);
  });

  it('makes vehicles riggable by default, unlike props', () => {
    const parsed = VehiclePayload.parse(vehiclePayload);
    expect(parsed.riggable).toBe(true);
    expect(parsed.interiorLocation).toBeNull();
    expect(parsed.capacity).toBeUndefined();
  });

  it('defaults substance rarity to common', () => {
    const parsed = SubstancePayload.parse(substancePayload);
    expect(parsed.rarity).toBe('common');
    expect(parsed.hazard).toBeUndefined();
  });
});

// ── structured output ───────────────────────────────────────────────────────

describe('JSON Schema conversion', () => {
  const fillable = {
    CharacterPayload,
    LocationPayload,
    PropPayload,
    FactionPayload,
    CreaturePayload,
    ConceptPayload,
    EventPayload,
    VehiclePayload,
    SubstancePayload,
    NamedVisualState,
    WardrobeSet,
    EntityAssetLink,
  };

  it.each(Object.entries(fillable))(
    '%s converts to a closed JSON Schema object',
    (_name, schema) => {
      const json = z.toJSONSchema(schema, { io: 'input' });
      expect(json.type).toBe('object');
      // Without this an LLM may invent fields, and the invented ones are the ones
      // that silently do not reach the pipeline.
      expect(json.additionalProperties).toBe(false);
    },
  );

  it('converts the Entity union to one closed branch per kind', () => {
    const json = z.toJSONSchema(Entity, { io: 'input' });
    const branches = json.oneOf ?? [];
    expect(branches).toHaveLength(ENTITY_KINDS.length);
    for (const branch of branches) {
      expect(branch.additionalProperties).toBe(false);
    }
  });

  it('carries the field descriptions the model actually reads', () => {
    const json = z.toJSONSchema(CharacterPayload, { io: 'input' });
    expect(schemaAt(json, 'properties', 'psych', 'properties', 'want').description).toContain(
      'conscious',
    );
  });

  it('marks defaulted fields optional on the input side and keeps their default', () => {
    const json = z.toJSONSchema(CharacterPayload, { io: 'input' });
    expect(json.required).toEqual([
      'identity',
      'psych',
      'voice',
      'arc',
      'visual',
      'motionSignature',
    ]);
    expect(schemaAt(json, 'properties', 'knowledgeScope').default).toBe('limited');
  });
});
