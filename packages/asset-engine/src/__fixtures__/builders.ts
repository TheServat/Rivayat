/**
 * The smallest valid inputs, plus the deliberate perturbation each test needs.
 *
 * `@rv/contracts` ships its own builders but does not export them from the package
 * barrel, so these are local. They are built by `parse`, not by cast, so a schema
 * change breaks the fixtures before it breaks a test's assertion - which is the point
 * of having them.
 */

import { FixedClock, IdGenerator, instant } from '@rv/shared-kernel';
import {
  type AssetArchetype,
  type AssetSpec,
  AssetSpec as AssetSpecSchema,
  type Entity,
  Entity as EntitySchema,
  Ids,
  type MotionStyle,
  type StyleBible,
  StyleBible as StyleBibleSchema,
} from '@rv/contracts';

import { partPlansFor } from '../rig/templates/index';

export const NOW_ISO = '2026-08-23T00:00:00.000Z';
export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);

/** Deterministic ids, so a fixture's output is byte-stable across runs. */
export function testIds(startMs = 1_724_400_000_000): Ids {
  let counter = 0;
  return new Ids(
    new IdGenerator(new FixedClock(instant(startMs)), (size) => {
      counter += 1;
      return Uint8Array.from({ length: size }, (_, i) => (counter * 31 + i * 17) & 0xff);
    }),
  );
}

export function testClock(): FixedClock {
  return new FixedClock(NOW_ISO);
}

/** A locked paper-cutout bible: stepped, boiling, high hold bias. */
export function styleBible(overrides: Record<string, unknown> = {}): StyleBible {
  return StyleBibleSchema.parse({
    id: testIds().styleBible(),
    name: 'Paper Grove',
    version: 1,
    origin: 'preset',
    visual: {
      medium: 'paper-cutout',
      palette: {
        colors: [
          { name: 'moss', hex: '#4a6b3f', role: 'primary' },
          { name: 'bark', hex: '#5a4632', role: 'secondary' },
          { name: 'sky', hex: '#cfe3ef', role: 'background' },
        ],
        harmony: 'earthy',
      },
      line: {},
      shading: {},
      texture: {},
      shape: {
        roundness: 0.7,
        exaggeration: 0.4,
        headToBodyRatio: 5,
        silhouetteRule: 'Readable as a solid black shape at 64px.',
        detailDensity: 0.3,
      },
      negative: ['photorealism', 'text'],
    },
    motion: paperCutoutMotion(),
    render: {},
    prompts: {
      positive: 'layered paper cutout, matte textured paper, soft drop shadow',
      negative: 'photorealistic, 3d render, text, watermark',
      bySubject: { foliage: 'torn paper edges on every leaf cluster' },
      byModel: {},
    },
    anchors: [],
    seed: 12_345,
    checksum: HASH_A,
    lockedAt: NOW_ISO,
    createdAt: NOW_ISO,
    ...overrides,
  });
}

/** Stepped on 3s, boiling, heavy holds - the cut-paper feel. */
export function paperCutoutMotion(): Record<string, unknown> {
  return {
    fps: 24,
    stepMode: 'on-3s',
    easings: [
      { name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } },
      { name: 'linear', p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 } },
    ],
    defaultEasing: 'ease-in-out',
    principles: {
      squashStretch: 0.05,
      anticipation: 0.1,
      followThrough: 0.1,
      overshoot: 0.05,
      secondaryMotion: 0.2,
      arcBias: 0.2,
      holdBias: 0.8,
      weight: 0.8,
    },
    boil: { enabled: true, amplitude: 0.2, hz: 8 },
    ambient: { windHz: 0.2, windAmplitude: 0.12, breathHz: 0.15, idleAmplitude: 0.08 },
    camera: {},
    tempo: 1,
  };
}

/** Smooth, springy, secondary-motion-heavy - the painterly feel. */
export function painterlyMotion(): Record<string, unknown> {
  return {
    fps: 24,
    stepMode: 'smooth',
    easings: [
      { name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } },
      { name: 'back-out', p1: { x: 0.34, y: 1.56 }, p2: { x: 0.64, y: 1 } },
    ],
    defaultEasing: 'back-out',
    principles: {
      squashStretch: 0.7,
      anticipation: 0.8,
      followThrough: 0.85,
      overshoot: 0.7,
      secondaryMotion: 0.9,
      arcBias: 0.9,
      holdBias: 0.1,
      weight: 0.3,
    },
    boil: { enabled: false },
    ambient: { windHz: 0.9, windAmplitude: 0.6, breathHz: 0.5, idleAmplitude: 0.5 },
    camera: {},
    tempo: 1.5,
  };
}

export function motionOf(style: StyleBible): MotionStyle {
  return style.motion;
}

/** A spec whose parts really are the archetype's template roles. */
export function specFor(
  archetype: AssetArchetype,
  overrides: Record<string, unknown> = {},
): AssetSpec {
  const label = 'Mature oak';
  return AssetSpecSchema.parse({
    semanticKey: 'flora/oak-tree/mature',
    archetype,
    subjectClass: 'foliage',
    label,
    description: 'A broad, weather-worn oak with three main boughs.',
    tags: [],
    canvas: { width: 256, height: 256 },
    nominalHeight: 512,
    parts: partPlansFor(archetype, label),
    variants: [],
    references: [],
    quality: 'preview',
    requireAlpha: true,
    ...overrides,
  });
}

/** A three-part spec with hints at the three corners the blob fixtures paint. */
export function threeBlobSpec(overrides: Record<string, unknown> = {}): AssetSpec {
  return AssetSpecSchema.parse({
    semanticKey: 'prop/lantern/base',
    archetype: 'articulated-prop',
    subjectClass: 'prop',
    label: 'Lantern',
    description: 'A dented brass lantern in three pieces.',
    tags: [],
    canvas: { width: 120, height: 120 },
    nominalHeight: 256,
    parts: [
      {
        name: 'base',
        role: 'base',
        description: 'lantern base',
        zOrder: 0,
        attachHint: { x: 0.2, y: 0.2 },
        deformable: false,
        optional: false,
      },
      {
        name: 'segment-1',
        role: 'segment-1',
        description: 'lantern body',
        zOrder: 1,
        attachHint: { x: 0.75, y: 0.2 },
        parent: 'base',
        deformable: false,
        optional: false,
      },
      {
        name: 'segment-2',
        role: 'segment-2',
        description: 'lantern hood',
        zOrder: 2,
        attachHint: { x: 0.2, y: 0.75 },
        parent: 'segment-1',
        deformable: false,
        optional: false,
      },
    ],
    variants: [],
    references: [],
    quality: 'draft',
    requireAlpha: true,
    ...overrides,
  });
}

export function characterEntity(overrides: Record<string, unknown> = {}): Entity {
  const ids = testIds();
  return EntitySchema.parse({
    kind: 'character',
    id: ids.entity(),
    seriesId: ids.series(),
    canonicalName: 'Kael Vandermeer',
    aliases: ['Kael'],
    summary: 'A lamplighter who has stopped believing the lamps matter.',
    firstAppearance: { ordinal: 1 },
    importance: 'lead',
    assetRefs: [],
    embedding: [],
    payload: {
      identity: {
        age: '41',
        ageYears: 41,
        gender: 'man',
        species: 'human',
        occupation: 'lamplighter',
        origin: 'the lower terraces',
      },
      psych: {
        want: 'to be relieved of the round',
        need: 'to be seen doing it',
        wound: 'a fire he did not prevent',
        lie: 'nobody is watching',
        ghost: 'the night the terrace lamps were out and a stair killed a child',
        virtues: ['punctual'],
        flaws: ['incurious'],
        fears: ['being replaced quietly'],
        values: ['the round is finished'],
        temperament: {},
      },
      voice: {
        register: 'colloquial',
        verbosity: 'clipped',
        profanity: 'mild',
        sentenceRhythm: 'staccato',
        humourMode: 'dry',
        idiolect: ['right then'],
        verbalTics: ['answers with the time'],
        silenceHabits: 'Goes quiet when thanked, and finds something to check.',
      },
      arc: { startState: 'dutiful and hollow', endState: 'dutiful and present', turningPoints: [] },
      visual: {
        silhouetteNote: 'A long coat with one shoulder permanently lower.',
        build: 'lean',
        height: 'a head above most',
        palette: [],
        distinguishingMarks: ['burn scar across the left wrist'],
        wardrobe: [
          {
            slug: 'winter',
            label: 'Winter round',
            description: 'Oiled canvas coat over two jerseys, mittens on a string.',
            validity: { from: null, until: null },
            palette: [],
          },
        ],
        expressionSet: [
          { slug: 'cornered', label: 'Cornered', description: 'brow low, jaw set, weight back' },
        ],
        poseSet: [
          { slug: 'reaching', label: 'Reaching', description: 'arm extended, shoulders open' },
        ],
        propAffinities: [],
      },
      motionSignature: {
        gaitStyle: 'trudge',
        posture: 'slouched',
        gestureFrequency: 0.2,
        energy: 0.3,
        idleBehaviour: 'rolls the wick key between two fingers',
        tellOnLying: 'looks at the lamp instead of the person',
      },
      knowledgeScope: 'limited',
    },
    ...overrides,
  });
}

export function creatureEntity(): Entity {
  const ids = testIds();
  return EntitySchema.parse({
    kind: 'creature',
    id: ids.entity(),
    seriesId: ids.series(),
    canonicalName: 'Terrace Fox',
    aliases: [],
    summary: 'A lean urban fox that follows the lamplighter on his round.',
    firstAppearance: { ordinal: 2 },
    importance: 'recurring',
    assetRefs: [],
    embedding: [],
    payload: {
      species: 'fox',
      sizeClass: 'small',
      intelligence: 'cunning',
      anatomy: 'Four legs, long brush, low-slung.',
      silhouetteNote: 'The brush is half its length.',
      gait: 'prowl',
      movementNote: 'Head leads, tail counterweights.',
      hostility: -0.2,
      abilities: [],
      vocalisations: [],
      palette: [],
      stateVariants: [{ slug: 'wary', label: 'Wary', description: 'ears flat, weight back' }],
    },
  });
}

export function vehicleEntity(): Entity {
  const ids = testIds();
  return EntitySchema.parse({
    kind: 'vehicle',
    id: ids.entity(),
    seriesId: ids.series(),
    canonicalName: 'Lamp Cart',
    aliases: [],
    summary: 'A two-wheeled cart of oil cans and spare wicks.',
    firstAppearance: { ordinal: 1 },
    importance: 'background',
    assetRefs: [],
    embedding: [],
    payload: {
      vehicleType: 'land',
      propulsion: 'pushed by hand',
      riggable: true,
      materials: ['oak', 'iron'],
      palette: [],
      conditionVariants: [{ slug: 'laden', label: 'Laden', description: 'stacked to the handles' }],
    },
  });
}

export function locationEntity(): Entity {
  const ids = testIds();
  return EntitySchema.parse({
    kind: 'location',
    id: ids.entity(),
    seriesId: ids.series(),
    canonicalName: 'Lower Terraces',
    aliases: [],
    summary: 'Stacked stone walkways lit by forty-one lamps.',
    firstAppearance: { ordinal: 1 },
    importance: 'supporting',
    assetRefs: [],
    embedding: [],
    payload: {
      locationType: 'exterior',
      scale: 'district',
      establishingNote: 'Four levels of walkway, each one lamp shorter than the last.',
      architecture: 'Dry stone and salvaged iron, patched for two centuries.',
      soundscape: ['gulls'],
      palette: [],
      timeOfDayVariants: ['dusk', 'night'],
      weatherVariants: ['rain'],
      moodVariants: [{ slug: 'after', label: 'After', description: 'every lamp out, doors shut' }],
      affordances: ['climb'],
    },
  });
}

export function propEntity(riggable: boolean): Entity {
  const ids = testIds();
  return EntitySchema.parse({
    kind: 'prop',
    id: ids.entity(),
    seriesId: ids.series(),
    canonicalName: 'The Wick Key',
    aliases: [],
    summary: 'A brass key worn smooth by forty years of the same grip.',
    firstAppearance: { ordinal: 1 },
    importance: 'recurring',
    assetRefs: [],
    embedding: [],
    payload: {
      scale: 'handheld',
      materials: ['brass'],
      riggable,
      ...(riggable ? { articulation: 'the shaft telescopes out of the grip' } : {}),
      isUnique: true,
      significance: 'It is the only thing he has kept.',
      palette: [],
      conditionVariants: [{ slug: 'bent', label: 'Bent', description: 'shaft kinked ten degrees' }],
    },
  });
}
