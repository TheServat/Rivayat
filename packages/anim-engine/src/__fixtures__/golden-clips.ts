/**
 * The clips whose evaluated frames are pinned by a checked-in hash.
 *
 * Chosen against the two defects that proved the golden was missing, not for coverage's
 * sake. A fixture that cannot fail on a defect we already know about is decoration:
 *
 * - **`camera-pan-over-depths`** would have caught the inverted `parallax` sign. It pans
 *   and zooms a camera across four layers spanning the near half and the far half of the
 *   depth range, one per fall-off curve. Flip the sign and every layer's `position.x`
 *   changes sign; clamp the near half back to zero, as the code did before, and the
 *   nearest layer stops moving entirely.
 * - **`walk-cycle-two-statures`** would have caught the hard-coded 8 px bounce. Two
 *   walkers with the same `bounce` and a 2:1 difference in stride must rise by different
 *   amounts; under the old constant they rose identically, and the golden for both would
 *   move the moment the constant became a proportion.
 * - **`behaviour-menagerie`** is the breadth fixture: one node per remaining behaviour
 *   kind, so any change to any behaviour's arithmetic moves a hash rather than silently
 *   restyling a series.
 * - **`bird-shoulder-rig`** pins the demo scene's own rig, so a future edit to the bird
 *   that changes its motion arrives as a number in a diff.
 *
 * Every id is fixed. `evaluate` forks its RNG per node id, so a generated id would make
 * the hash a function of the run.
 */

import type { AnimationIR } from '@rv/contracts';

import { hashClip, type ClipHash } from '../golden/scene-hash';
import { shoulderPivotedBird } from './bird';

/** 26 Crockford base32 characters, which is what `NodeId` and friends validate. */
const STEM = '01J8ZQ4E7K9M2N4P6R8T0VG';
const nodeId = (tail: string): string => `nod_${STEM}${tail.padStart(3, '0')}`;
const behaviourId = (tail: string): string => `bhv_${STEM}${tail.padStart(3, '0')}`;
const animationId = (tail: string): string => `anm_${STEM}${tail.padStart(3, '0')}`;

interface NodeSpec {
  readonly name: string;
  readonly tail: string;
  readonly parent: string | null;
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly width?: number;
  readonly height?: number;
}

function shapeNode(spec: NodeSpec): unknown {
  return {
    kind: 'shape',
    id: nodeId(spec.tail),
    name: spec.name,
    parentId: spec.parent,
    transform: {
      position: { x: spec.x, y: spec.y },
      rotation: 0,
      scale: { x: 1, y: 1 },
      skew: { x: 0, y: 0 },
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    visible: true,
    depth: spec.depth,
    shape: 'rect',
    fill: '#334455',
    strokeWidth: 0,
    size: { width: spec.width ?? 120, height: spec.height ?? 120 },
  };
}

interface ClipSpec {
  readonly id: string;
  readonly name: string;
  readonly durationMs: number;
  readonly nodes: readonly unknown[];
  readonly behaviours: readonly unknown[];
  readonly tracks?: readonly unknown[];
  readonly camera?: unknown;
}

function clip(spec: ClipSpec): AnimationIR {
  return {
    irVersion: 1,
    id: spec.id,
    name: spec.name,
    fps: 24,
    durationMs: spec.durationMs,
    sceneSpace: { width: 1920, height: 1080 },
    seed: 20260824,
    nodes: spec.nodes,
    tracks: spec.tracks ?? [],
    behaviours: spec.behaviours,
    markers: [],
    ...(spec.camera === undefined ? {} : { camera: spec.camera }),
  } as unknown as AnimationIR;
}

/**
 * A camera pan and push-in across four depths, one per fall-off curve.
 *
 * `depth` is a **signed** distance from the camera plane: negative is in front of it and
 * over-travels, positive is behind it and lags. Both halves are represented on purpose -
 * the old implementation clamped the near half to zero, and a fixture with only positive
 * depths could not tell that apart from correct behaviour.
 */
export function cameraPanOverDepths(): AnimationIR {
  const root = nodeId('001');
  return clip({
    id: animationId('101'),
    name: 'camera-pan-over-depths',
    durationMs: 2000,
    nodes: [
      {
        kind: 'group',
        id: root,
        name: 'root',
        parentId: null,
        transform: {
          position: { x: 0, y: 0 },
          rotation: 0,
          scale: { x: 1, y: 1 },
          skew: { x: 0, y: 0 },
          anchor: { x: 0.5, y: 0.5 },
          opacity: 1,
        },
        visible: true,
        depth: 0,
      },
      shapeNode({ name: 'near-post', tail: '002', parent: root, x: -400, y: 120, depth: -30 }),
      shapeNode({ name: 'mid-subject', tail: '003', parent: root, x: 0, y: 0, depth: 0 }),
      shapeNode({ name: 'far-trees', tail: '004', parent: root, x: 320, y: -60, depth: 60 }),
      shapeNode({ name: 'distant-ridge', tail: '005', parent: root, x: 0, y: -200, depth: 100 }),
    ],
    behaviours: [
      {
        kind: 'parallax',
        id: behaviourId('006'),
        nodeId: nodeId('002'),
        enabled: true,
        seed: 1,
        weight: 1,
        strength: 0.8,
        curve: 'linear',
      },
      {
        kind: 'parallax',
        id: behaviourId('007'),
        nodeId: nodeId('003'),
        enabled: true,
        seed: 2,
        weight: 1,
        strength: 0.5,
        curve: 'exponential',
      },
      {
        kind: 'parallax',
        id: behaviourId('008'),
        nodeId: nodeId('004'),
        enabled: true,
        seed: 3,
        weight: 1,
        strength: 0.6,
        curve: 'exponential',
      },
      {
        kind: 'parallax',
        id: behaviourId('009'),
        nodeId: nodeId('005'),
        enabled: true,
        seed: 4,
        weight: 1,
        strength: 1,
        curve: 'logarithmic',
      },
    ],
    camera: {
      keyframes: [
        {
          timeMs: 0,
          position: { x: 0, y: 0 },
          zoom: 1,
          rotation: 0,
          easing: { kind: 'named', name: 'ease-in-out' },
        },
        { timeMs: 2000, position: { x: 300, y: 80 }, zoom: 1.25, rotation: 6 },
      ],
      focusNodeId: nodeId('003'),
      shakeAmplitude: 0,
      shakeSeed: 0,
      projection: 'orthographic',
    },
  });
}

/**
 * Three walkers who differ in stride and gait, and in nothing else that matters.
 *
 * `strideLength` is the stature proxy: a taller character covers more ground per step.
 * The bounce must scale with it, and the fixture exists so that a bounce which does not
 * is a number that moved.
 */
export function walkCycleTwoStatures(): AnimationIR {
  return clip({
    id: animationId('201'),
    name: 'walk-cycle-two-statures',
    durationMs: 2000,
    nodes: [
      shapeNode({
        name: 'short-walker',
        tail: '011',
        parent: null,
        x: -300,
        y: 0,
        depth: 0,
        height: 90,
      }),
      shapeNode({
        name: 'tall-walker',
        tail: '012',
        parent: null,
        x: 0,
        y: 0,
        depth: 0,
        height: 180,
      }),
      shapeNode({
        name: 'limping-walker',
        tail: '013',
        parent: null,
        x: 300,
        y: 0,
        depth: 0,
        height: 135,
      }),
    ],
    behaviours: [
      {
        kind: 'walk-cycle',
        id: behaviourId('014'),
        nodeId: nodeId('011'),
        enabled: true,
        seed: 11,
        weight: 1,
        stepsPerSecond: 1.6,
        strideLength: 60,
        bounce: 0.6,
        gait: 'walk',
      },
      {
        kind: 'walk-cycle',
        id: behaviourId('015'),
        nodeId: nodeId('012'),
        enabled: true,
        seed: 12,
        weight: 1,
        stepsPerSecond: 1.6,
        strideLength: 120,
        bounce: 0.6,
        gait: 'walk',
      },
      {
        kind: 'walk-cycle',
        id: behaviourId('016'),
        nodeId: nodeId('013'),
        enabled: true,
        seed: 13,
        weight: 1,
        stepsPerSecond: 1.6,
        strideLength: 90,
        bounce: 0.4,
        gait: 'limp',
      },
    ],
  });
}

/**
 * One node per remaining behaviour kind, so nothing changes arithmetic unobserved.
 *
 * `follow-path` currently resolves to no deltas at all - `evaluate` defers it and the
 * deferred pass only implements `look-at`. It is in the fixture anyway: the day it is
 * implemented, this hash moves, which is exactly the notification that is wanted.
 */
export function behaviourMenagerie(): AnimationIR {
  const anchor = nodeId('021');
  return clip({
    id: animationId('301'),
    name: 'behaviour-menagerie',
    durationMs: 5000,
    nodes: [
      shapeNode({ name: 'anchor', tail: '021', parent: null, x: 0, y: 0, depth: 0 }),
      shapeNode({ name: 'branch', tail: '022', parent: anchor, x: -200, y: -80, depth: 10 }),
      shapeNode({ name: 'chest', tail: '023', parent: anchor, x: -100, y: -80, depth: 10 }),
      shapeNode({ name: 'eyelid', tail: '024', parent: anchor, x: 0, y: -80, depth: 10 }),
      shapeNode({ name: 'lantern', tail: '025', parent: anchor, x: 100, y: -80, depth: 10 }),
      shapeNode({ name: 'wing', tail: '026', parent: anchor, x: 200, y: -80, depth: 10 }),
      shapeNode({ name: 'moth', tail: '027', parent: anchor, x: -200, y: 80, depth: 10 }),
      shapeNode({ name: 'outline', tail: '028', parent: anchor, x: -100, y: 80, depth: 10 }),
      shapeNode({ name: 'tail', tail: '029', parent: anchor, x: 0, y: 80, depth: 10 }),
      shapeNode({ name: 'watcher', tail: '02A', parent: anchor, x: 100, y: 80, depth: 10 }),
      shapeNode({ name: 'runner', tail: '02B', parent: anchor, x: 200, y: 80, depth: 10 }),
      shapeNode({ name: 'mouth', tail: '02C', parent: anchor, x: 300, y: 80, depth: 10 }),
    ],
    behaviours: [
      {
        kind: 'wind',
        id: behaviourId('031'),
        nodeId: nodeId('022'),
        enabled: true,
        seed: 1000,
        weight: 1,
        hz: 0.3,
        amplitude: 0.25,
        gustiness: 0.4,
        direction: 20,
        tipBias: 0.7,
      },
      {
        kind: 'breathe',
        id: behaviourId('032'),
        nodeId: nodeId('023'),
        enabled: true,
        seed: 1001,
        weight: 1,
        hz: 0.25,
        amplitude: 0.15,
      },
      {
        kind: 'blink',
        id: behaviourId('033'),
        nodeId: nodeId('024'),
        enabled: true,
        seed: 1002,
        weight: 1,
        intervalMs: 1400,
        varianceMs: 300,
        closeDurationMs: 110,
      },
      {
        kind: 'sway',
        id: behaviourId('034'),
        nodeId: nodeId('025'),
        enabled: true,
        seed: 1003,
        weight: 1,
        hz: 0.5,
        amplitudeDeg: 6,
        axis: 'rotation',
      },
      {
        kind: 'flap',
        id: behaviourId('035'),
        nodeId: nodeId('026'),
        enabled: true,
        seed: 1004,
        weight: 1,
        hz: 4,
        amplitudeDeg: 50,
        downstrokeBias: 0.35,
      },
      {
        kind: 'orbit',
        id: behaviourId('036'),
        nodeId: nodeId('027'),
        enabled: true,
        seed: 1005,
        weight: 1,
        centre: { x: 0, y: 0 },
        radius: { x: 240, y: 90 },
        periodMs: 3000,
        phase: 0.25,
      },
      {
        kind: 'boil',
        id: behaviourId('037'),
        nodeId: nodeId('028'),
        enabled: true,
        seed: 1006,
        weight: 1,
        amplitude: 0.15,
        hz: 8,
      },
      {
        kind: 'spring',
        id: behaviourId('038'),
        nodeId: nodeId('029'),
        enabled: true,
        seed: 1007,
        weight: 1,
        stiffness: 0.5,
        damping: 0.6,
        follows: 'position.x',
      },
      {
        kind: 'look-at',
        id: behaviourId('039'),
        nodeId: nodeId('02A'),
        enabled: true,
        seed: 1008,
        weight: 1,
        targetNodeId: nodeId('027'),
        maxAngleDeg: 35,
        responsiveness: 0.5,
      },
      {
        kind: 'follow-path',
        id: behaviourId('03A'),
        nodeId: nodeId('02B'),
        enabled: true,
        seed: 1009,
        weight: 1,
        path: 'M0,0 L100,50 L200,0',
        durationMs: 2500,
        orientToPath: true,
        loop: 'loop',
      },
      {
        kind: 'lip-sync',
        id: behaviourId('03B'),
        nodeId: nodeId('02C'),
        enabled: true,
        seed: 1010,
        weight: 1,
        intensity: 0.8,
        phonemes: [
          { timeMs: 0, viseme: 'aa', durationMs: 200 },
          { timeMs: 200, viseme: 'ee', durationMs: 150 },
          { timeMs: 350, viseme: 'oh', durationMs: 250 },
        ],
      },
      // A weighted behaviour, so the blend factor is part of the pinned arithmetic too.
      {
        kind: 'sway',
        id: behaviourId('03C'),
        nodeId: nodeId('022'),
        enabled: true,
        seed: 1011,
        weight: 0.4,
        hz: 1.2,
        amplitudeDeg: 3,
        axis: 'position.y',
      },
    ],
  });
}

/** Every fixture, by the name its stored hash is keyed on. */
export const GOLDEN_CLIPS: Readonly<Record<string, () => AnimationIR>> = {
  'camera-pan-over-depths': cameraPanOverDepths,
  'walk-cycle-two-statures': walkCycleTwoStatures,
  'behaviour-menagerie': behaviourMenagerie,
  'bird-shoulder-rig': shoulderPivotedBird,
};

/**
 * Where the blessed hashes live.
 *
 * Resolved from this module rather than from a caller's cwd, so the spec and the bless
 * script cannot disagree about which file they mean.
 */
export const GOLDEN_FILE_URL = new URL('../golden/__goldens__/frame-hashes.json', import.meta.url);

/** The key carrying re-blessing instructions to whoever opens the file. */
export const GOLDEN_NOTE_KEY = '$note';

export const GOLDEN_NOTE =
  'Blessed frame hashes for packages/anim-engine. Do not hand-edit. ' +
  'Re-bless with `pnpm --filter @rv/anim-engine bless:goldens`, and only when you meant ' +
  'to change what the engine draws - a moved hash here is a moved pixel in every shot.';

/** Every fixture hashed, keyed and ordered so the file diffs one line at a time. */
export function computeGoldens(): Record<string, ClipHash> {
  const goldens: Record<string, ClipHash> = {};
  for (const name of Object.keys(GOLDEN_CLIPS).sort()) {
    const build = GOLDEN_CLIPS[name];
    if (build === undefined) continue;
    goldens[name] = hashClip(build());
  }
  return goldens;
}

/** The exact bytes the golden file should contain, so writing and checking agree. */
export function serialiseGoldens(goldens: Record<string, ClipHash>): string {
  return `${JSON.stringify({ [GOLDEN_NOTE_KEY]: GOLDEN_NOTE, ...goldens }, null, 2)}\n`;
}
