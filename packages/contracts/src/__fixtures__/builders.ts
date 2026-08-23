/**
 * Minimal valid instances, for tests.
 *
 * Each builder returns the *smallest* thing that parses, and takes an override so a
 * test can perturb exactly the field it is about. That keeps every test's intent
 * visible: what differs from valid is what is under test.
 */

import { FixedClock, IdGenerator, instant } from '@rv/shared-kernel';

import type { z } from 'zod';

import { Ids } from '../primitives/ids';
import type { AnimationIR } from '../anim/ir';
import type { AssetSpec } from '../asset/asset-spec';
import type { Rig } from '../asset/rig';
import type { StyleBible } from '../style/style-bible';

/**
 * Builders return the schema's **input** type, not its output.
 *
 * A fixture is what you hand to `parse`, so `{}` is a legitimate value for a block
 * whose fields all have defaults - and tests need to be able to inject deliberately
 * invalid overrides without fighting the compiler.
 */
type In<T extends z.ZodType> = z.input<T>;

/** Deterministic id source, so fixtures are byte-stable across runs. */
export function testIds(startMs = 1_724_400_000_000): Ids {
  return new Ids(new IdGenerator(new FixedClock(instant(startMs)), fixedBytes()));
}

/**
 * An id source that provably cannot collide with `testIds()`.
 *
 * Needed because the fixtures are deterministic: two `testIds()` instances mint the
 * *same* sequence, so a test reaching for "an id that is not in the document" would
 * accidentally reach for one that is.
 */
export function foreignIds(): Ids {
  return testIds(1_900_000_000_000);
}

function fixedBytes(): (size: number) => Uint8Array {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, i) => (counter * 7 + i * 13) & 0xff);
  };
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const NOW = '2026-08-23T00:00:00.000Z';

export function provenance(): Record<string, unknown> {
  return { source: 'llm', parents: [], createdAt: NOW, costNanoUsd: 0 };
}

export function styleBible(overrides: Record<string, unknown> = {}): In<typeof StyleBible> {
  const ids = testIds();
  return {
    id: ids.styleBible(),
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
        contrastFloor: 0.35,
        organicRamp: [],
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
      backgroundTreatment: 'layered-parallax',
      negative: ['photorealism', 'text'],
    },
    motion: {
      fps: 24,
      stepMode: 'on-2s',
      easings: [{ name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } }],
      defaultEasing: 'ease-in-out',
      principles: {},
      boil: {},
      ambient: {},
      camera: {},
      tempo: 1,
    },
    render: {},
    prompts: {
      positive: 'layered paper cutout, matte textured paper, soft drop shadow',
      negative: 'photorealistic, 3d render, text, watermark',
      bySubject: { foliage: 'torn paper edges on every leaf cluster' },
      byModel: {},
    },
    anchors: [],
    seed: 12345,
    checksum: HASH_A,
    lockedAt: null,
    createdAt: NOW,
    ...overrides,
  } as unknown as In<typeof StyleBible>;
}

export function assetSpec(overrides: Record<string, unknown> = {}): In<typeof AssetSpec> {
  return {
    semanticKey: 'flora/oak-tree/mature',
    archetype: 'tree',
    subjectClass: 'foliage',
    label: 'Mature oak',
    description: 'A broad, weather-worn oak with three main boughs.',
    tags: [],
    canvas: { width: 1024, height: 1024 },
    nominalHeight: 512,
    parts: [
      {
        name: 'trunk',
        role: 'trunk',
        description: 'Thick furrowed trunk',
        zOrder: 0,
        deformable: false,
        optional: false,
      },
      {
        name: 'canopy',
        role: 'canopy',
        description: 'Dense leaf mass',
        zOrder: 1,
        parent: 'trunk',
        deformable: true,
        optional: false,
      },
    ],
    variants: [],
    references: [],
    quality: 'preview',
    requireAlpha: true,
    ...overrides,
  } as unknown as In<typeof AssetSpec>;
}

/** A two-bone rig: root trunk plus one canopy child. The smallest legal skeleton. */
export function rig(overrides: Record<string, unknown> = {}): In<typeof Rig> {
  const ids = testIds();
  const root = ids.bone();
  const child = ids.bone();
  return {
    id: ids.rig(),
    archetype: 'tree',
    templateId: 'tree-basic',
    bones: [
      {
        id: root,
        name: 'trunk',
        role: 'trunk',
        parentId: null,
        rest: { position: { x: 0, y: 0 }, rotation: 0, length: 200, scale: { x: 1, y: 1 } },
        partIds: [],
        zOrderBias: 0,
      },
      {
        id: child,
        name: 'canopy',
        role: 'canopy',
        parentId: root,
        rest: { position: { x: 0, y: -200 }, rotation: 0, length: 120, scale: { x: 1, y: 1 } },
        partIds: [],
        zOrderBias: 0,
      },
    ],
    meshes: [],
    ikChains: [],
    anchors: [],
    ...overrides,
  } as unknown as In<typeof Rig>;
}

/** A one-node IR with a single track. Enough to exercise every structural refinement. */
export function animationIr(overrides: Record<string, unknown> = {}): In<typeof AnimationIR> {
  const ids = testIds();
  const node = ids.node();
  return {
    irVersion: 1,
    id: ids.animation(),
    name: 'oak idle',
    fps: 24,
    durationMs: 4000,
    sceneSpace: { width: 2560, height: 2560 },
    seed: 7,
    nodes: [
      {
        kind: 'group',
        id: node,
        name: 'root',
        parentId: null,
        transform: {},
        visible: true,
        depth: 0,
      },
    ],
    tracks: [
      {
        id: ids.track(),
        nodeId: node,
        channel: 'rotation',
        keyframes: [
          { timeMs: 0, value: 0 },
          { timeMs: 2000, value: 3 },
          { timeMs: 4000, value: 0 },
        ],
        before: 'hold',
        after: 'hold',
        additive: false,
      },
    ],
    behaviours: [],
    markers: [],
    ...overrides,
  } as unknown as In<typeof AnimationIR>;
}

export const HASHES = { a: HASH_A, b: HASH_B } as const;
export const FIXED_NOW = NOW;
