/**
 * Animation IR fixtures.
 *
 * Built with `AnimationIR.parse`, never by cast: a schema change should break these
 * before it breaks an assertion, and the parse is also what applies the defaults the
 * exporters rely on (`transform`, `visible`, `depth`, track extrapolation).
 *
 * Each one isolates one property of the export:
 *
 * | Fixture           | What it is for                                                     |
 * | ----------------- | ------------------------------------------------------------------ |
 * | `easedMoveIr`     | a root node with authored keyframes - the sparse, handle-preserving path |
 * | `hierarchyIr`     | a rotated parent with a child - flattening and world-transform fidelity  |
 * | `windIr`          | one procedural behaviour - baking, and the error a coarse stride costs   |
 * | `richIr`          | text, particles, a camera, a tint, a path shape - the loss report        |
 */

import type { AnimationIR, MotionStyle } from '@rv/contracts';
import { AnimationIR as AnimationIRSchema } from '@rv/contracts';

import { testIds } from './ids';

export type MotionSettingsFixture = Pick<MotionStyle, 'stepMode' | 'easings' | 'tempo'>;

/** A style whose curves are the ones the fixtures name. */
export function testMotion(overrides: Partial<MotionSettingsFixture> = {}): MotionSettingsFixture {
  return {
    stepMode: 'smooth',
    tempo: 1,
    easings: [
      { name: 'linear', p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 } },
      { name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } },
      { name: 'back-out', p1: { x: 0.34, y: 1.56 }, p2: { x: 0.64, y: 1 } },
    ],
    ...overrides,
  };
}

const SCENE = { width: 1920, height: 1080 };

/**
 * One root node, two position tracks on a shared grid, one bezier easing.
 *
 * Deliberately the shape the sparse path recognises, so a test can assert that authored
 * handles reach the file instead of ninety sampled keyframes.
 */
export function easedMoveIr(): AnimationIR {
  const ids = testIds();
  const nodeId = ids.node();

  return AnimationIRSchema.parse({
    irVersion: 1,
    id: ids.animation(),
    name: 'Eased Move',
    fps: 30,
    durationMs: 2000,
    sceneSpace: SCENE,
    seed: 7,
    nodes: [
      {
        id: nodeId,
        name: 'card',
        parentId: null,
        kind: 'shape',
        shape: 'rect',
        size: { width: 200, height: 120 },
        fill: '#4a6b3f',
        transform: { position: { x: 100, y: 50 } },
      },
    ],
    tracks: [
      {
        id: ids.track(),
        nodeId,
        channel: 'position.x',
        keyframes: [
          {
            timeMs: 0,
            value: 0,
            easing: { kind: 'cubic-bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
          },
          { timeMs: 1000, value: 400, easing: { kind: 'named', name: 'ease-in-out' } },
          { timeMs: 2000, value: 600 },
        ],
      },
      {
        id: ids.track(),
        nodeId,
        channel: 'position.y',
        keyframes: [
          {
            timeMs: 0,
            value: 0,
            easing: { kind: 'cubic-bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
          },
          { timeMs: 1000, value: 120, easing: { kind: 'named', name: 'ease-in-out' } },
          { timeMs: 2000, value: 0 },
        ],
      },
    ],
  });
}

/**
 * A rotated, uniformly scaled parent with two children.
 *
 * Uniform scale on purpose: the component-wise composition in `@rv/anim-engine` and a
 * matrix pipeline agree there, so the flattened export is the strongest possible fidelity
 * comparison rather than a measurement of a known modelling difference.
 */
export function hierarchyIr(): AnimationIR {
  const ids = testIds();
  const parentId = ids.node();
  const childId = ids.node();
  const labelId = ids.node();

  return AnimationIRSchema.parse({
    irVersion: 1,
    id: ids.animation(),
    name: 'Hierarchy',
    fps: 24,
    durationMs: 1500,
    sceneSpace: SCENE,
    seed: 11,
    nodes: [
      {
        id: parentId,
        name: 'rig-root',
        parentId: null,
        kind: 'group',
        depth: 10,
        transform: { position: { x: 400, y: 300 }, rotation: 12, scale: { x: 1.4, y: 1.4 } },
      },
      {
        id: childId,
        name: 'branch',
        parentId,
        kind: 'shape',
        shape: 'ellipse',
        size: { width: 80, height: 40 },
        stroke: '#1a1a1aff',
        strokeWidth: 3,
        depth: 5,
        transform: {
          position: { x: 60, y: -20 },
          rotation: -8,
          scale: { x: 0.8, y: 0.8 },
          opacity: 0.9,
        },
      },
      {
        id: labelId,
        name: 'label',
        parentId,
        kind: 'text',
        text: 'دِرَخت',
        direction: 'rtl',
        align: 'center',
        color: '#ffffff',
        depth: 0,
        transform: { position: { x: -30, y: 40 } },
      },
    ],
    tracks: [
      {
        id: ids.track(),
        nodeId: parentId,
        channel: 'rotation',
        keyframes: [
          { timeMs: 0, value: 0, easing: { kind: 'named', name: 'ease-in-out' } },
          { timeMs: 1500, value: 45 },
        ],
      },
      {
        id: ids.track(),
        nodeId: childId,
        channel: 'opacity',
        keyframes: [
          { timeMs: 0, value: 0 },
          { timeMs: 750, value: -0.5 },
          { timeMs: 1500, value: 0 },
        ],
      },
    ],
    markers: [
      { id: ids.marker(), timeMs: 0, kind: 'cut', label: 'in' },
      { id: ids.marker(), timeMs: 1000, kind: 'beat', label: 'settle' },
    ],
  });
}

/** One tree, one `wind` behaviour. The whole argument for baking, in eight lines of JSON. */
export function windIr(durationMs = 3000): AnimationIR {
  const ids = testIds();
  const nodeId = ids.node();

  return AnimationIRSchema.parse({
    irVersion: 1,
    id: ids.animation(),
    name: 'Wind Study',
    fps: 30,
    durationMs,
    sceneSpace: SCENE,
    seed: 42,
    nodes: [
      {
        id: nodeId,
        name: 'oak',
        parentId: null,
        kind: 'shape',
        shape: 'rect',
        size: { width: 300, height: 500 },
        fill: '#4a6b3f',
        transform: { position: { x: 700, y: 600 } },
      },
    ],
    behaviours: [
      {
        id: ids.behaviour(),
        nodeId,
        kind: 'wind',
        seed: 1337,
        hz: 0.6,
        amplitude: 0.5,
        gustiness: 0.4,
        direction: 20,
        tipBias: 0.8,
      },
    ],
  });
}

/**
 * One root node per edge of the sparse/baked decision.
 *
 * The Lottie exporter writes authored keyframes straight through only when doing so is
 * provably identical to what the evaluator computes, and bakes otherwise. Every node here
 * sits on one side of one of those conditions, so a change that makes the rule more
 * permissive shows up as a fidelity failure on exactly the node it broke rather than as a
 * vague drift somewhere in a bigger scene.
 */
export function sparseEdgeIr(): AnimationIR {
  const ids = testIds();
  const node = (
    name: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> & { id: string } => ({
    id: ids.node(),
    name,
    parentId: null,
    kind: 'shape',
    shape: 'rect',
    size: { width: 10, height: 10 },
    ...extra,
  });

  const additive = node('additive');
  const looped = node('looped');
  const stepped = node('stepped');
  const mixedEase = node('mixed-ease');
  const holdMix = node('hold-mix');
  const held = node('held');
  const fader = node('fader');
  const clamped = node('clamped', { transform: { opacity: 0.8 } });
  const overshootFade = node('overshoot-fade');
  const pulse = node('pulse');
  const twoX = node('two-x');
  const ghost = node('ghost', { visible: false });
  const shortHex = node('short-hex', { fill: '#f00' });
  const sizeless = node('sizeless', { size: undefined });
  const bareLine = node('bare-line', { shape: 'line', size: undefined });
  const captionOne = {
    id: ids.node(),
    name: 'caption-one',
    parentId: null,
    kind: 'text',
    text: 'one',
  };
  const captionTwo = {
    id: ids.node(),
    name: 'caption-two',
    parentId: null,
    kind: 'text',
    text: 'two',
  };
  const instance = {
    id: ids.node(),
    name: 'plain-instance',
    parentId: null,
    kind: 'asset-instance',
    asset: { assetId: ids.asset(), versionId: ids.assetVersion() },
  };

  const easeA = { kind: 'cubic-bezier', x1: 0.1, y1: 0, x2: 0.9, y2: 1 } as const;
  const easeB = { kind: 'cubic-bezier', x1: 0.5, y1: 0, x2: 0.5, y2: 1 } as const;
  const hold = { kind: 'stepped', at: 'end', steps: 1 } as const;

  const track = (
    nodeId: string,
    channel: string,
    keyframes: readonly Record<string, unknown>[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({ id: ids.track(), nodeId, channel, keyframes, ...extra });

  return AnimationIRSchema.parse({
    irVersion: 1,
    id: ids.animation(),
    name: 'Sparse Edges',
    fps: 20,
    durationMs: 1000,
    sceneSpace: SCENE,
    seed: 4,
    nodes: [
      additive,
      looped,
      stepped,
      mixedEase,
      holdMix,
      held,
      fader,
      clamped,
      overshootFade,
      pulse,
      twoX,
      ghost,
      shortHex,
      sizeless,
      bareLine,
      captionOne,
      captionTwo,
      instance,
    ],
    tracks: [
      // Additive and extrapolating tracks are folded by the evaluator, so the authored
      // keyframes are no longer the whole story and the channel has to be baked.
      track(
        additive.id,
        'position.x',
        [
          { timeMs: 0, value: 0 },
          { timeMs: 1000, value: 50 },
        ],
        {
          additive: true,
        },
      ),
      track(
        looped.id,
        'position.x',
        [
          { timeMs: 0, value: 0 },
          { timeMs: 500, value: 50 },
        ],
        {
          after: 'loop',
        },
      ),
      // A multi-step curve changes value strictly inside a segment, which Lottie's hold
      // key cannot say.
      track(stepped.id, 'position.x', [
        { timeMs: 0, value: 0, easing: { kind: 'stepped', at: 'start', steps: 4 } },
        { timeMs: 1000, value: 80 },
      ]),
      // x and y ease differently; one Lottie position property has one set of handles.
      track(mixedEase.id, 'position.x', [
        { timeMs: 0, value: 0, easing: easeA },
        { timeMs: 1000, value: 60 },
      ]),
      track(mixedEase.id, 'position.y', [
        { timeMs: 0, value: 0, easing: easeB },
        { timeMs: 1000, value: 60 },
      ]),
      track(holdMix.id, 'position.x', [
        { timeMs: 0, value: 0, easing: hold },
        { timeMs: 1000, value: 30 },
      ]),
      track(holdMix.id, 'position.y', [
        { timeMs: 0, value: 0 },
        { timeMs: 1000, value: 30 },
      ]),
      track(held.id, 'position.x', [
        { timeMs: 0, value: 0, easing: hold },
        { timeMs: 1000, value: 30 },
      ]),
      track(held.id, 'position.y', [
        { timeMs: 0, value: 0, easing: hold },
        { timeMs: 1000, value: 30 },
      ]),
      track(fader.id, 'opacity', [
        { timeMs: 0, value: 0 },
        { timeMs: 500, value: -0.4 },
        { timeMs: 1000, value: 0 },
      ]),
      // Multiplying past the ends of 0..1 engages the evaluator's clamp, which is not
      // affine and therefore not expressible as two eased keyframes.
      track(clamped.id, 'opacity', [
        { timeMs: 0, value: 0.5 },
        { timeMs: 1000, value: -1.5 },
      ]),
      // An overshooting curve leaves the range between its own keyframes.
      track(overshootFade.id, 'opacity', [
        { timeMs: 0, value: 0, easing: { kind: 'named', name: 'back-out' } },
        { timeMs: 1000, value: -0.5 },
      ]),
      track(pulse.id, 'scale.x', [
        { timeMs: 0, value: 0 },
        { timeMs: 1000, value: 0.5 },
      ]),
      // Two tracks on one channel: the evaluator folds them, so the authored keyframes of
      // either one are not the answer.
      track(twoX.id, 'position.x', [
        { timeMs: 0, value: 0 },
        { timeMs: 1000, value: 10 },
      ]),
      track(twoX.id, 'position.x', [
        { timeMs: 0, value: 5, easing: easeA },
        { timeMs: 1000, value: 20 },
      ]),
    ],
  });
}

/** One node per shape kind, including the two whose geometry has to be parsed. */
export function shapesIr(): AnimationIR {
  const ids = testIds();
  return AnimationIRSchema.parse({
    irVersion: 1,
    id: ids.animation(),
    name: 'Shapes',
    fps: 25,
    durationMs: 400,
    sceneSpace: SCENE,
    seed: 1,
    nodes: [
      {
        id: ids.node(),
        name: 'box',
        parentId: null,
        kind: 'shape',
        shape: 'rect',
        size: { width: 40, height: 20 },
        fill: '#ff000080',
      },
      { id: ids.node(), name: 'blob', parentId: null, kind: 'shape', shape: 'ellipse' },
      {
        id: ids.node(),
        name: 'edge',
        parentId: null,
        kind: 'shape',
        shape: 'line',
        geometry: '0,0 100,50',
        stroke: '#00ff00',
        strokeWidth: 4,
      },
      {
        id: ids.node(),
        name: 'triangle',
        parentId: null,
        kind: 'shape',
        shape: 'polygon',
        geometry: '0 0 50 0 25 40',
        fill: '#0000ff',
      },
      {
        id: ids.node(),
        name: 'broken',
        parentId: null,
        kind: 'shape',
        shape: 'polygon',
        geometry: 'not numbers at all',
      },
    ],
  });
}

/** A node skewing on both axes at once - the case Lottie's single skew angle cannot hold. */
export function skewIr(): AnimationIR {
  const ids = testIds();
  return AnimationIRSchema.parse({
    irVersion: 1,
    id: ids.animation(),
    name: 'Skew',
    fps: 24,
    durationMs: 500,
    sceneSpace: SCENE,
    seed: 2,
    nodes: [
      {
        id: ids.node(),
        name: 'sheared',
        parentId: null,
        kind: 'group',
        transform: { skew: { x: 12, y: 7 } },
      },
      {
        id: ids.node(),
        name: 'leaning',
        parentId: null,
        kind: 'group',
        transform: { skew: { x: 0, y: 9 } },
      },
    ],
  });
}

/**
 * Everything a format is likely to choke on, in one document.
 *
 * Not a realistic shot - a deliberate worst case, so the loss report can be asserted
 * feature by feature rather than in aggregate.
 */
export function richIr(): AnimationIR {
  const ids = testIds();
  const instanceId = ids.node();
  const emitterId = ids.node();
  const pathId = ids.node();

  return AnimationIRSchema.parse({
    irVersion: 1,
    id: ids.animation(),
    name: 'Kitchen Sink',
    fps: 25,
    durationMs: 1000,
    sceneSpace: SCENE,
    seed: 3,
    nodes: [
      {
        id: instanceId,
        name: 'hero',
        parentId: null,
        kind: 'asset-instance',
        asset: { assetId: ids.asset(), versionId: ids.assetVersion(), variantKey: 'winter' },
        clipName: 'idle',
        clipLoop: 'ping-pong',
        clipSpeed: 1.5,
        tint: '#ff8800',
        flipX: true,
        transform: { position: { x: 300, y: 400 } },
      },
      {
        id: emitterId,
        name: 'snowfall',
        parentId: null,
        kind: 'fx-emitter',
        effect: 'snow',
        rate: 40,
        area: { width: 1920, height: 400 },
        seed: 9,
      },
      {
        id: pathId,
        name: 'swoosh',
        parentId: null,
        kind: 'shape',
        shape: 'path',
        geometry: 'M0 0 C 20 40, 60 40, 80 0',
        stroke: '#112233',
        strokeWidth: 2,
      },
    ],
    tracks: [
      {
        id: ids.track(),
        nodeId: emitterId,
        channel: 'fx.intensity',
        keyframes: [
          { timeMs: 0, value: 0.2 },
          { timeMs: 1000, value: 0.9 },
        ],
      },
      {
        id: ids.track(),
        nodeId: instanceId,
        channel: 'depth',
        keyframes: [
          { timeMs: 0, value: 0 },
          { timeMs: 1000, value: 30 },
        ],
      },
      {
        id: ids.track(),
        nodeId: instanceId,
        channel: 'anchor.x',
        keyframes: [
          { timeMs: 0, value: 0 },
          { timeMs: 1000, value: 0.2 },
        ],
      },
      {
        id: ids.track(),
        nodeId: instanceId,
        channel: 'position.x',
        additive: true,
        before: 'loop',
        after: 'ping-pong',
        keyframes: [
          { timeMs: 0, value: 0, easing: { kind: 'stepped', at: 'start', steps: 4 } },
          { timeMs: 500, value: 40 },
        ],
      },
    ],
    behaviours: [
      { id: ids.behaviour(), nodeId: instanceId, kind: 'blink', seed: 5 },
      { id: ids.behaviour(), nodeId: emitterId, kind: 'boil', seed: 6, amplitude: 0.3, hz: 12 },
    ],
    markers: [{ id: ids.marker(), timeMs: 400, kind: 'sfx', label: 'wind-gust' }],
    camera: {
      keyframes: [
        {
          timeMs: 0,
          position: { x: 0, y: 0 },
          zoom: 1,
          easing: { kind: 'named', name: 'ease-in-out' },
        },
        { timeMs: 1000, position: { x: 120, y: -40 }, zoom: 1.25, rotation: 5 },
      ],
      focusNodeId: instanceId,
      shakeAmplitude: 0.2,
      shakeSeed: 77,
    },
  });
}
