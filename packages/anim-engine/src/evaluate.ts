/**
 * `evaluate(ir, timeMs)` - the whole animation engine's contract, in one function.
 *
 * It is a **pure function of time**. Given the same IR and the same `timeMs` it returns
 * byte-identical output, on any machine, in any order, however many times it is called.
 * Everything downstream depends on that: scrubbing must agree with playback, a resumed
 * render must agree with the one it resumed, a sharded render must agree with itself,
 * and a baked sprite sheet must agree with live playback. None of those are separate
 * features - they all fall out of purity.
 *
 * The evaluation order per frame:
 *
 *   1. quantise time to the style's step cadence (`on-2s` and friends)
 *   2. resolve the camera
 *   3. per node: base transform → behaviours → tracks   (tracks win; a hand keyframe
 *      overrides a procedural behaviour unless it declared itself additive)
 *   4. compose world transforms parent-first
 *   5. second pass for behaviours that need other nodes' world positions
 */

import { at, createRng, must, type Rng } from '@rv/shared-kernel';
import type {
  AnimChannel,
  AnimNode,
  AnimationIR,
  Behaviour,
  EasingCurve,
  MotionStyle,
  NodeId,
  ResolvedNode,
  SceneSnapshot,
  Track,
  Transform2D,
  Vec2,
} from '@rv/contracts';

import { applyEasing, buildEasingLibrary, quantiseToStep, type EasingLibrary } from './easing';
import { signedNoise1d } from './noise';
import { evaluateBehaviour, type BehaviourContext, type ChannelDeltas } from './behaviours';
import { valueAt } from './track';
import { composeTransform, identityTransform } from './transform';

export interface EvaluateOptions {
  /**
   * Motion settings from the active style bible.
   *
   * Supplies the named easing curves and the step cadence, which is what makes the same
   * clip genuinely move differently in a paper-cutout series and a painterly one.
   */
  readonly motion?: Pick<MotionStyle, 'stepMode' | 'easings' | 'tempo'>;
}

/**
 * The curves `evaluate` falls back to when no style bible is supplied.
 *
 * Exported because anything that has to agree with the renderer needs the *same* two
 * curves - the Lottie exporter had replicated them locally, which is a drift risk that
 * only shows up as an exported animation that no longer matches its own preview.
 */
export const DEFAULT_EASINGS: readonly EasingCurve[] = [
  { name: 'linear', p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 } },
  { name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } },
];

export function evaluate(
  ir: AnimationIR,
  timeMs: number,
  options: EvaluateOptions = {},
): SceneSnapshot {
  const motion = options.motion;
  const tempo = motion?.tempo ?? 1;
  const library = buildEasingLibrary(motion?.easings ?? DEFAULT_EASINGS);

  // Tempo scales the whole clip, then the step cadence quantises what is left. Doing it
  // the other way round would make a tempo change silently break the frame grid.
  const scaled = timeMs * tempo;
  const time = quantiseToStep(scaled, ir.fps, motion?.stepMode ?? 'smooth');

  const camera = resolveCamera(ir, time, library);
  const rootRng = createRng(ir.seed);

  const tracksByNode = groupTracks(ir.tracks);
  const behavioursByNode = groupBehaviours(ir.behaviours);

  // Parent-first, so a parent's world transform always exists before its children need
  // it. The schema already rejects cycles, so this terminates.
  const ordered = orderParentFirst(ir.nodes);

  const locals = new Map<NodeId, Transform2D>();
  const worlds = new Map<NodeId, Transform2D>();
  const auxiliary = new Map<NodeId, ChannelDeltas>();

  for (const node of ordered) {
    const deltas = accumulate(node, time, {
      tracks: tracksByNode.get(node.id) ?? [],
      behaviours: behavioursByNode.get(node.id) ?? [],
      library,
      camera,
      rng: rootRng.fork(node.id),
    });

    const local = applyDeltas(node.transform, deltas);
    locals.set(node.id, local);
    auxiliary.set(node.id, deltas);

    const parent =
      node.parentId === null
        ? identityTransform()
        : must(worlds, node.parentId, 'parent transform');
    worlds.set(node.id, composeTransform(parent, local));
  }

  resolveDeferred(worlds, behavioursByNode, time);

  return {
    timeMs: Math.round(time),
    frame: Math.floor((time / 1000) * ir.fps),
    nodes: ordered.map((node) =>
      toResolved(
        node,
        must(worlds, node.id, 'world transform'),
        must(auxiliary, node.id, 'channel deltas'),
      ),
    ),
    camera,
  };
}

// ── per-node accumulation ───────────────────────────────────────────────────

interface NodeInputs {
  readonly tracks: readonly Track[];
  readonly behaviours: readonly Behaviour[];
  readonly library: EasingLibrary;
  readonly camera: SceneSnapshot['camera'];
  readonly rng: Rng;
}

function accumulate(node: AnimNode, timeMs: number, inputs: NodeInputs): ChannelDeltas {
  const deltas: ChannelDeltas = {};

  const ctx: BehaviourContext = {
    timeMs,
    depth: node.depth,
    camera: { position: inputs.camera.position, zoom: inputs.camera.zoom },
    rng: inputs.rng,
  };

  // Behaviours first and additively: several can contribute to one channel, and a tree
  // that both sways and boils should do both rather than one of them winning.
  for (const behaviour of inputs.behaviours) {
    for (const [channel, value] of Object.entries(evaluateBehaviour(behaviour, ctx))) {
      const key = channel as AnimChannel;
      deltas[key] = (deltas[key] ?? 0) + value;
    }
  }

  // Tracks last, and by default they *replace*. A hand-placed keyframe is a deliberate
  // statement about where something is; a behaviour is ambient. `additive` opts a track
  // into layering instead.
  for (const track of inputs.tracks) {
    const value = valueAt(track, timeMs, inputs.library);
    deltas[track.channel] = track.additive ? (deltas[track.channel] ?? 0) + value : value;
  }

  return deltas;
}

/**
 * Folds channel deltas onto the node's authored transform.
 *
 * Positional and rotational channels are **offsets** from the authored pose; scale and
 * opacity are **multipliers**, because "half as bright" composes and "minus 0.5 alpha"
 * does not.
 */
function applyDeltas(base: Transform2D, deltas: ChannelDeltas): Transform2D {
  return {
    position: {
      x: base.position.x + (deltas['position.x'] ?? 0),
      y: base.position.y + (deltas['position.y'] ?? 0),
    },
    rotation: base.rotation + (deltas.rotation ?? 0),
    scale: {
      x: base.scale.x * (1 + (deltas['scale.x'] ?? 0)),
      y: base.scale.y * (1 + (deltas['scale.y'] ?? 0)),
    },
    skew: {
      x: base.skew.x + (deltas['skew.x'] ?? 0),
      y: base.skew.y + (deltas['skew.y'] ?? 0),
    },
    anchor: {
      x: clamp01(base.anchor.x + (deltas['anchor.x'] ?? 0)),
      y: clamp01(base.anchor.y + (deltas['anchor.y'] ?? 0)),
    },
    opacity: clamp01(base.opacity * (1 + (deltas.opacity ?? 0))),
  };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// ── camera ──────────────────────────────────────────────────────────────────

function resolveCamera(
  ir: AnimationIR,
  timeMs: number,
  library: EasingLibrary,
): SceneSnapshot['camera'] {
  const track = ir.camera;
  if (track === undefined) return { position: { x: 0, y: 0 }, zoom: 1, rotation: 0 };

  const keyframes = track.keyframes;
  const first = at(keyframes, 0);
  const last = at(keyframes, keyframes.length - 1);

  let resolved: SceneSnapshot['camera'];
  if (timeMs <= first.timeMs || keyframes.length === 1) {
    resolved = { position: first.position, zoom: first.zoom, rotation: first.rotation };
  } else if (timeMs >= last.timeMs) {
    resolved = { position: last.position, zoom: last.zoom, rotation: last.rotation };
  } else {
    resolved = interpolateCamera(keyframes, timeMs, library);
  }

  if (track.shakeAmplitude === 0) return resolved;

  // Shake is seeded, not random: a re-render of the same explosion shakes identically.
  const shake = track.shakeAmplitude * 20;
  const tick = timeMs / 40;
  return {
    ...resolved,
    position: {
      x: resolved.position.x + signedNoise1d(track.shakeSeed, tick) * shake,
      y: resolved.position.y + signedNoise1d(track.shakeSeed + 1, tick) * shake,
    },
  };
}

type CameraKeyframes = NonNullable<AnimationIR['camera']>['keyframes'];

function interpolateCamera(
  keyframes: CameraKeyframes,
  timeMs: number,
  library: EasingLibrary,
): SceneSnapshot['camera'] {
  let index = 0;
  for (let i = 0; i < keyframes.length - 1; i += 1) {
    if (at(keyframes, i + 1).timeMs > timeMs) break;
    index = i + 1;
  }

  const from = at(keyframes, index);
  const to = at(keyframes, Math.min(index + 1, keyframes.length - 1));
  const span = to.timeMs - from.timeMs;
  // span is always positive: the caller only reaches here when 	imeMs lies strictly
  // between the first and last keyframe, so the scan cannot land on the last one.
  const progress = (timeMs - from.timeMs) / span;
  // The shared easing implementation, not a second copy: a camera that eased
  // differently from the nodes it frames would read as lag.
  const eased = applyEasing(from.easing, progress, library);

  return {
    position: {
      x: lerp(from.position.x, to.position.x, eased),
      y: lerp(from.position.y, to.position.y, eased),
    },
    zoom: lerp(from.zoom, to.zoom, eased),
    rotation: lerp(from.rotation, to.rotation, eased),
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ── deferred behaviours ─────────────────────────────────────────────────────

/**
 * Behaviours that need other nodes' resolved world positions.
 *
 * Run after the main pass, and deliberately **not** iterated to a fixed point: two
 * nodes looking at each other would never converge, and a frame that depends on how
 * many times a solver ran is not deterministic in any useful sense. One pass, using
 * last-computed world positions, is stable and explainable.
 */
function resolveDeferred(
  worlds: Map<NodeId, Transform2D>,
  behavioursByNode: ReadonlyMap<NodeId, readonly Behaviour[]>,
  timeMs: number,
): void {
  for (const [nodeId, behaviours] of behavioursByNode) {
    for (const behaviour of behaviours) {
      if (behaviour.kind !== 'look-at') continue;

      // No existence guards: the IR schema rejects a look-at naming an unknown node,
      // and the main pass gave every node a world transform. `must` turns a violation
      // of either into a loud failure rather than a silently skipped behaviour.
      const self = must(worlds, nodeId, 'world transform');
      const target = must(worlds, behaviour.targetNodeId, 'look-at target transform');

      const weight = behaviour.enabled ? behaviour.weight : 0;
      if (weight === 0) continue;
      if (behaviour.startMs !== undefined && timeMs < behaviour.startMs) continue;
      if (behaviour.endMs !== undefined && timeMs >= behaviour.endMs) continue;

      const towards = angleBetween(self.position, target.position);
      const clamped = clampAngle(towards - self.rotation, behaviour.maxAngleDeg);
      worlds.set(nodeId, {
        ...self,
        rotation: self.rotation + clamped * behaviour.responsiveness * weight,
      });
    }
  }
}

function angleBetween(from: Vec2, to: Vec2): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

function clampAngle(degrees: number, max: number): number {
  // Normalise into (-180, 180] first, so "turn 350 degrees left" becomes "10 right".
  let normalised = ((((degrees + 180) % 360) + 360) % 360) - 180;
  if (normalised > max) normalised = max;
  if (normalised < -max) normalised = -max;
  return normalised;
}

// ── plumbing ────────────────────────────────────────────────────────────────

function groupTracks(tracks: readonly Track[]): ReadonlyMap<NodeId, Track[]> {
  const map = new Map<NodeId, Track[]>();
  for (const track of tracks) {
    const bucket = map.get(track.nodeId);
    if (bucket === undefined) map.set(track.nodeId, [track]);
    else bucket.push(track);
  }
  return map;
}

function groupBehaviours(behaviours: readonly Behaviour[]): ReadonlyMap<NodeId, Behaviour[]> {
  const map = new Map<NodeId, Behaviour[]>();
  for (const behaviour of behaviours) {
    const bucket = map.get(behaviour.nodeId);
    if (bucket === undefined) map.set(behaviour.nodeId, [behaviour]);
    else bucket.push(behaviour);
  }
  return map;
}

/**
 * Parent-first ordering, preserving authored order among siblings.
 *
 * Stable rather than merely correct: the output array order is part of the paint order
 * the renderer consumes, so an unstable sort would change the picture.
 */
export function orderParentFirst(nodes: readonly AnimNode[]): readonly AnimNode[] {
  const byParent = new Map<NodeId | null, AnimNode[]>();
  for (const node of nodes) {
    const bucket = byParent.get(node.parentId);
    if (bucket === undefined) byParent.set(node.parentId, [node]);
    else bucket.push(node);
  }

  const ordered: AnimNode[] = [];
  const visit = (parentId: NodeId | null): void => {
    for (const node of byParent.get(parentId) ?? []) {
      ordered.push(node);
      visit(node.id);
    }
  };
  visit(null);

  return ordered;
}

function toResolved(node: AnimNode, world: Transform2D, deltas: ChannelDeltas): ResolvedNode {
  const base: ResolvedNode = {
    nodeId: node.id,
    worldTransform: world,
    visible: node.visible && world.opacity > 0,
    depth: node.depth + (deltas.depth ?? 0),
    bonePose: {},
  };

  const tint = node.kind === 'asset-instance' ? node.tint : undefined;
  return tint === undefined ? base : { ...base, tint };
}
