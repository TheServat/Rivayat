/**
 * One real `AnimationIR`, for a session with no API.
 *
 * There is no animation controller in `apps/api` yet (see `schemas/animations.ts`), so
 * without this the timeline screen has nothing to load and no way to demonstrate that
 * its preview agrees with `evaluate`. The document is a genuine IR - it is parsed by the
 * contract schema on the way out, so a fixture that violates the IR's own refinements
 * (a cycle in the hierarchy, a track on an unknown node, keyframes out of order) fails
 * at request time rather than rendering something the renderer never would.
 *
 * The scene is chosen to exercise the things a preview usually gets wrong:
 *
 *  - **Eased interpolation between distant keyframes.** The lantern fades over three
 *    whole seconds on `ease-in-out`, which is where a linear approximation looks
 *    plausible and is wrong by a fifth of the value in the middle.
 *  - **A stepped curve.** The moon rises on `stepped`, which is discontinuous; a player
 *    that lerps between keyframes cannot fake it.
 *  - **Procedural behaviours next to hand keyframes on the same node.** The heron has
 *    both a `position.x` track and a `wind` behaviour, and the evaluator's rule - tracks
 *    replace unless they declare themselves additive - is visible.
 *  - **A camera that moves and zooms.** Scene space has its origin at the centre of the
 *    canvas, and a camera keyframe at `{x: 0, y: 0}` therefore frames the middle. A
 *    player that put the origin in the corner would look fine until the camera moved.
 */

import type { AnimationIR } from '@rv/contracts';

import type { AnimationIndex, AnimationSummary } from '../schemas/animations';

/** Widens a fixture literal into the branded id the schema parses it back into. */
function id<T>(value: string): T {
  return value as T;
}

const TERRACE = 'anm_5QW8ZK3TB7DR2XNH9JMC0VF4A1';

const NODES = {
  stage: 'nod_2QW8ZK5TB1DR7XNH3JMC9VF06A',
  sky: 'nod_7QW8ZK1TB9DR3XNH5JMC2VF48A',
  moon: 'nod_9QW8ZK7TB3DR5XNH1JMC8VF62A',
  terrace: 'nod_4QW8ZK9TB5DR1XNH7JMC3VF80A',
  lamp: 'nod_6QW8ZK2TB8DR9XNH4JMC1VF57A',
  lampPost: 'nod_1QW8ZK4TB6DR0XNH8JMC5VF39A',
  lampHead: 'nod_3QW8ZK6TB0DR4XNH2JMC7VF15A',
  heron: 'nod_8QW8ZK0TB2DR6XNH9JMC4VF73A',
  title: 'nod_0QW8ZK8TB4DR2XNH6JMC9VF31A',
  dust: 'nod_5QW8ZK3TB9DR8XNH0JMC6VF24A',
} as const;

const TRACKS = {
  lantern: 'trk_3QW8ZK7TB1DR5XNH9JMC2VF60A',
  moon: 'trk_8QW8ZK2TB6DR0XNH4JMC7VF15A',
  heron: 'trk_1QW8ZK9TB4DR7XNH2JMC0VF83A',
  titleReveal: 'trk_6QW8ZK5TB8DR3XNH7JMC1VF49A',
} as const;

const BEHAVIOURS = {
  lampSway: 'bhv_2QW8ZK6TB0DR9XNH5JMC3VF71A',
  heronWind: 'bhv_7QW8ZK1TB5DR4XNH0JMC8VF26A',
  titleBoil: 'bhv_9QW8ZK4TB2DR6XNH8JMC5VF03A',
} as const;

const MARKERS = {
  open: 'mrk_4QW8ZK8TB7DR1XNH3JMC6VF92A',
  light: 'mrk_0QW8ZK3TB9DR5XNH7JMC2VF48A',
  line: 'mrk_5QW8ZK0TB4DR8XNH1JMC9VF36A',
} as const;

/**
 * The terrace at dusk.
 *
 * Shapes and text only. Nothing here places an `asset-instance`, because an instance
 * needs the part bitmaps and there is no route that serves a blob - see the endpoint
 * table in `schemas/assets.ts`. Everything the *evaluator* does is exercised regardless:
 * an `asset-instance` node resolves to the same `ResolvedNode` a shape does, and only
 * the last step, painting, differs.
 */
export const TERRACE_IR: AnimationIR = {
  irVersion: 1,
  id: id<AnimationIR['id']>(TERRACE),
  name: 'Terrace at dusk',
  fps: 24,
  durationMs: 6000,
  sceneSpace: { width: 1920, height: 1080 },
  seed: 20_260_823,
  nodes: [
    {
      kind: 'group',
      id: id<AnimationIR['nodes'][number]['id']>(NODES.stage),
      name: 'stage',
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
    {
      kind: 'shape',
      id: id<AnimationIR['nodes'][number]['id']>(NODES.sky),
      name: 'sky',
      parentId: id<AnimationIR['nodes'][number]['id']>(NODES.stage),
      transform: {
        position: { x: 0, y: -60 },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      visible: true,
      depth: 100,
      shape: 'rect',
      fill: '#1b2a4a',
      strokeWidth: 0,
      size: { width: 1920, height: 900 },
    },
    {
      kind: 'shape',
      id: id<AnimationIR['nodes'][number]['id']>(NODES.moon),
      name: 'moon',
      parentId: id<AnimationIR['nodes'][number]['id']>(NODES.stage),
      transform: {
        position: { x: 520, y: -220 },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      visible: true,
      depth: 90,
      shape: 'ellipse',
      fill: '#f4e3b8',
      strokeWidth: 0,
      size: { width: 140, height: 140 },
    },
    {
      kind: 'shape',
      id: id<AnimationIR['nodes'][number]['id']>(NODES.terrace),
      name: 'terrace',
      parentId: id<AnimationIR['nodes'][number]['id']>(NODES.stage),
      transform: {
        position: { x: 0, y: 420 },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      visible: true,
      depth: 20,
      shape: 'rect',
      fill: '#2f2a24',
      stroke: '#6b5a44',
      strokeWidth: 3,
      size: { width: 1920, height: 260 },
    },
    {
      kind: 'group',
      id: id<AnimationIR['nodes'][number]['id']>(NODES.lamp),
      name: 'lamp',
      parentId: id<AnimationIR['nodes'][number]['id']>(NODES.stage),
      transform: {
        position: { x: -520, y: 300 },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 1 },
        opacity: 1,
      },
      visible: true,
      depth: 10,
    },
    {
      kind: 'shape',
      id: id<AnimationIR['nodes'][number]['id']>(NODES.lampPost),
      name: 'lamp-post',
      parentId: id<AnimationIR['nodes'][number]['id']>(NODES.lamp),
      transform: {
        position: { x: 0, y: -150 },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 1 },
        opacity: 1,
      },
      visible: true,
      depth: 10,
      shape: 'rect',
      fill: '#3a3630',
      strokeWidth: 0,
      size: { width: 18, height: 320 },
    },
    {
      kind: 'shape',
      id: id<AnimationIR['nodes'][number]['id']>(NODES.lampHead),
      name: 'lamp-head',
      parentId: id<AnimationIR['nodes'][number]['id']>(NODES.lamp),
      transform: {
        position: { x: 0, y: -330 },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      visible: true,
      depth: 9,
      shape: 'ellipse',
      fill: '#ffd479',
      stroke: '#6b5a44',
      strokeWidth: 4,
      size: { width: 96, height: 120 },
    },
    {
      kind: 'shape',
      id: id<AnimationIR['nodes'][number]['id']>(NODES.heron),
      name: 'heron',
      parentId: id<AnimationIR['nodes'][number]['id']>(NODES.stage),
      transform: {
        position: { x: -700, y: 40 },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      visible: true,
      depth: 6,
      shape: 'polygon',
      fill: '#cfd6e4',
      stroke: '#4a5468',
      strokeWidth: 2,
      geometry: '-60,0 -10,-26 40,-6 66,10 10,18 -30,14',
      size: { width: 130, height: 46 },
    },
    {
      kind: 'text',
      id: id<AnimationIR['nodes'][number]['id']>(NODES.title),
      name: 'title',
      parentId: id<AnimationIR['nodes'][number]['id']>(NODES.stage),
      transform: {
        position: { x: 0, y: -380 },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      visible: true,
      depth: 2,
      text: 'مهتابی، سر شب',
      styleName: 'title',
      color: '#f4e3b8',
      align: 'center',
      direction: 'rtl',
    },
    {
      kind: 'fx-emitter',
      id: id<AnimationIR['nodes'][number]['id']>(NODES.dust),
      name: 'dust',
      parentId: id<AnimationIR['nodes'][number]['id']>(NODES.stage),
      transform: {
        position: { x: -420, y: 120 },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      visible: true,
      depth: 4,
      effect: 'dust',
      rate: 24,
      area: { width: 420, height: 300 },
      seed: 4211,
      intensity: 0.4,
    },
  ],
  tracks: [
    {
      // Three seconds between two keyframes, eased. This is the case the brief names:
      // a preview that approximates the curve is wrong by the most in the middle, and
      // the middle is exactly where somebody judges whether the light comes up well.
      id: id<AnimationIR['tracks'][number]['id']>(TRACKS.lantern),
      nodeId: id<AnimationIR['nodes'][number]['id']>(NODES.lampHead),
      channel: 'opacity',
      // The value is a *multiplier delta*, not an alpha: `evaluate` folds the opacity
      // channel as `base * (1 + delta)`, because "half as bright" composes and
      // "minus 0.5 alpha" does not. So -1 is dark and 0 is the authored opacity.
      keyframes: [
        { timeMs: 600, value: -1, easing: { kind: 'named', name: 'ease-in-out' } },
        { timeMs: 3600, value: 0, easing: { kind: 'named', name: 'linear' } },
        { timeMs: 6000, value: 0 },
      ],
      before: 'hold',
      after: 'hold',
      additive: false,
    },
    {
      // Stepped: discontinuous by construction, and the one curve a lerp cannot fake.
      id: id<AnimationIR['tracks'][number]['id']>(TRACKS.moon),
      nodeId: id<AnimationIR['nodes'][number]['id']>(NODES.moon),
      channel: 'position.y',
      keyframes: [
        { timeMs: 0, value: 0, easing: { kind: 'stepped', at: 'end', steps: 6 } },
        { timeMs: 6000, value: -120 },
      ],
      before: 'hold',
      after: 'hold',
      additive: false,
    },
    {
      id: id<AnimationIR['tracks'][number]['id']>(TRACKS.heron),
      nodeId: id<AnimationIR['nodes'][number]['id']>(NODES.heron),
      channel: 'position.x',
      keyframes: [
        {
          timeMs: 0,
          value: 0,
          easing: { kind: 'cubic-bezier', x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 },
        },
        { timeMs: 4200, value: 1240 },
        { timeMs: 6000, value: 1400 },
      ],
      before: 'hold',
      after: 'hold',
      additive: false,
    },
    {
      id: id<AnimationIR['tracks'][number]['id']>(TRACKS.titleReveal),
      nodeId: id<AnimationIR['nodes'][number]['id']>(NODES.title),
      channel: 'opacity',
      keyframes: [
        { timeMs: 200, value: -1, easing: { kind: 'named', name: 'ease-in-out' } },
        { timeMs: 1400, value: 0 },
      ],
      before: 'hold',
      after: 'hold',
      additive: false,
    },
  ],
  behaviours: [
    {
      kind: 'sway',
      id: id<AnimationIR['behaviours'][number]['id']>(BEHAVIOURS.lampSway),
      nodeId: id<AnimationIR['nodes'][number]['id']>(NODES.lamp),
      enabled: true,
      seed: 7719,
      weight: 1,
      hz: 0.35,
      amplitudeDeg: 2.5,
      axis: 'rotation',
    },
    {
      kind: 'wind',
      id: id<AnimationIR['behaviours'][number]['id']>(BEHAVIOURS.heronWind),
      nodeId: id<AnimationIR['nodes'][number]['id']>(NODES.heron),
      enabled: true,
      seed: 3301,
      weight: 0.8,
      hz: 0.9,
      amplitude: 0.3,
      gustiness: 0.5,
      direction: 12,
      tipBias: 0.8,
    },
    {
      kind: 'boil',
      id: id<AnimationIR['behaviours'][number]['id']>(BEHAVIOURS.titleBoil),
      nodeId: id<AnimationIR['nodes'][number]['id']>(NODES.title),
      enabled: true,
      seed: 991,
      weight: 0.6,
      amplitude: 0.08,
      hz: 8,
    },
  ],
  markers: [
    {
      id: id<AnimationIR['markers'][number]['id']>(MARKERS.open),
      timeMs: 0,
      kind: 'cut',
      label: 'Open on the terrace',
    },
    {
      id: id<AnimationIR['markers'][number]['id']>(MARKERS.light),
      timeMs: 1800,
      kind: 'beat',
      label: 'The lamp catches',
    },
    {
      id: id<AnimationIR['markers'][number]['id']>(MARKERS.line),
      timeMs: 4200,
      kind: 'dialogue',
      label: 'She says nothing',
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
      { timeMs: 6000, position: { x: 180, y: -40 }, zoom: 1.18, rotation: 0 },
    ],
    shakeAmplitude: 0,
    shakeSeed: 0,
    // Orthographic, which the contract guarantees is exactly the identity: this
    // document has to render byte-identically to one written before the field existed.
    projection: 'orthographic',
  },
};

function summaryOf(ir: AnimationIR, updatedAt: string): AnimationSummary {
  return {
    id: ir.id,
    name: ir.name,
    fps: ir.fps,
    durationMs: ir.durationMs,
    sceneSpace: ir.sceneSpace,
    nodeCount: ir.nodes.length,
    trackCount: ir.tracks.length,
    behaviourCount: ir.behaviours.length,
    markerCount: ir.markers.length,
    updatedAt,
  };
}

export const ANIMATION_INDEX: AnimationIndex = {
  animations: [summaryOf(TERRACE_IR, '2026-08-23T19:41:08.310Z')],
};

export function animationById(animationId: string): AnimationIR | undefined {
  return animationId === TERRACE_IR.id ? TERRACE_IR : undefined;
}
