/**
 * A fingerprint of what a clip evaluates to - the thing a golden file pins.
 *
 * ## Why this exists
 *
 * `CLAUDE.md` §3 promises "Golden-file tests: `AnimationIR -> frame hash`". What the repo
 * had was a *determinism* suite - scrub equals play equals resume equals shard - which is
 * genuinely valuable and is exactly the property `evaluate`'s purity buys. It is also
 * blind to a change in what gets drawn, because it only ever compares one run against
 * another run of the same code.
 *
 * Two defects proved the gap in one day. The `parallax` sign was inverted, so backgrounds
 * raced past foregrounds instead of lagging behind them; `walk-cycle`'s bounce was a
 * hard-coded 8 px, so a tall character and a short one rose the same absolute distance
 * and the tall one read as crouching. Both changed every frame of every affected shot.
 * Both passed 550 render-engine, 245 export-kit and 420 asset-engine tests without a
 * single assertion moving, and both were found by eye.
 *
 * A stored hash closes that. When the drawing changes, a checked-in number changes, and
 * the diff carries the new number next to the commit that caused it.
 *
 * ## What is hashed, and what deliberately is not
 *
 * The **evaluated scene**, not the encoded video. A hash of an MP4 also moves when FFmpeg
 * changes its rate control, when libx264 is rebuilt, or when a container timestamp
 * shifts - none of which is our drawing changing. A red build caused by somebody else's
 * patch release is a red build people learn to ignore, and an ignored golden is worse
 * than none. This hashes `evaluate(ir, t)` across the clip's own frames: it moves when
 * *our* arithmetic moves, and at no other time.
 *
 * It therefore does **not** cover the rasteriser. A change to how `@rv/render-engine`
 * paints a resolved node is invisible here, and that is a real limit rather than an
 * oversight - the rasteriser needs its own golden over its own output, and it is a
 * different package.
 *
 * ## Why the numbers are quantised
 *
 * `Math.sin`, `Math.cos`, `Math.exp` and `Math.log1p` are not bit-specified by IEEE 754,
 * and V8 has changed their last-place results between releases. Hashing raw doubles would
 * make the golden a hash of the Node version. Every value is therefore recorded as an
 * integer count of {@link SCENE_HASH_QUANTUM}: far above transcendental last-bit noise
 * (~1e-16 relative), and far below any change a viewer could ever see, since one output
 * pixel is half a scene unit at the sharpest format this project ships.
 *
 * The canonical text format below is part of the golden's contract. Changing it moves
 * every stored hash at once - which is a legitimate reason to re-bless, and one that will
 * be obvious in the diff because every line changes together.
 */

import { at, sha256 } from '@rv/shared-kernel';
import type { AnimationIR, ResolvedNode, SceneSnapshot } from '@rv/contracts';

import { evaluate, type EvaluateOptions } from '../evaluate';

/**
 * One millionth of a scene unit.
 *
 * A change smaller than this cannot move a pixel in any deliverable - the finest format
 * in `FORMAT_PRESETS` puts one output pixel at half a scene unit - and a difference this
 * large cannot come from a library's transcendental rounding.
 */
export const SCENE_HASH_QUANTUM = 1e-6;

/** A value as a whole number of quanta. Exact, compact, and free of `-0`. */
function q(value: number, quantum: number): string {
  return String(Math.round(value / quantum));
}

/**
 * One resolved node as a single canonical line.
 *
 * Every field of `ResolvedNode` is present. That is the point: a field left out is a
 * field a regression can move without anybody noticing, which is the failure this module
 * exists to end.
 */
function canonicalNode(node: ResolvedNode, quantum: number): string {
  const t = node.worldTransform;
  const bones = Object.entries(node.bonePose)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, angle]) => `${role}=${q(angle, quantum)}`)
    .join(',');
  return [
    node.nodeId,
    `${q(t.position.x, quantum)},${q(t.position.y, quantum)}`,
    q(t.rotation, quantum),
    `${q(t.scale.x, quantum)},${q(t.scale.y, quantum)}`,
    `${q(t.skew.x, quantum)},${q(t.skew.y, quantum)}`,
    `${q(t.anchor.x, quantum)},${q(t.anchor.y, quantum)}`,
    q(t.opacity, quantum),
    node.visible ? '1' : '0',
    q(node.depth, quantum),
    node.tint ?? '-',
    bones,
  ].join('|');
}

/**
 * One frame as canonical text.
 *
 * Exported because a failing golden otherwise says only "a number changed". With this a
 * developer can print two frames and see which node moved, which is the difference
 * between a useful failure and an annoying one.
 */
export function canonicalScene(
  snapshot: SceneSnapshot,
  quantum: number = SCENE_HASH_QUANTUM,
): string {
  const camera = snapshot.camera;
  const header = [
    `f${String(snapshot.frame)}`,
    `t${String(snapshot.timeMs)}`,
    `cam:${q(camera.position.x, quantum)},${q(camera.position.y, quantum)},${q(camera.zoom, quantum)},${q(camera.rotation, quantum)}`,
  ].join('|');
  // Node order is `evaluate`'s parent-first ordering, which is also the paint order, so
  // a reordering that would change the picture changes the hash.
  return [header, ...snapshot.nodes.map((node) => canonicalNode(node, quantum))].join('\n');
}

export interface ClipHashOptions {
  /** Defaults to the clip's own fps: the golden should pin the frames that ship. */
  readonly sampleFps?: number;
  readonly motion?: EvaluateOptions['motion'];
  readonly quantum?: number;
}

export interface ClipHash {
  /** Frames sampled. Stored so a duration or fps change is separable from a motion one. */
  readonly frames: number;
  /** Frame 0 alone: distinguishes "the rest pose moved" from "the motion moved". */
  readonly restHash: string;
  /** The whole sequence. */
  readonly clipHash: string;
}

/**
 * Evaluates a clip frame by frame and fingerprints the result.
 *
 * Two hashes rather than one, because the first question on a failure is always "did the
 * pose change or did the motion change" and answering it from a single number is
 * impossible.
 */
export function hashClip(ir: AnimationIR, options: ClipHashOptions = {}): ClipHash {
  const quantum = options.quantum ?? SCENE_HASH_QUANTUM;
  const sampleFps = options.sampleFps ?? ir.fps;
  const evaluateOptions: EvaluateOptions =
    options.motion === undefined ? {} : { motion: options.motion };

  const frames = Math.max(1, Math.round((ir.durationMs / 1000) * sampleFps));
  const lines: string[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    lines.push(canonicalScene(evaluate(ir, (frame / sampleFps) * 1000, evaluateOptions), quantum));
  }

  return {
    frames,
    restHash: sha256(at(lines, 0)),
    clipHash: sha256(lines.join('\n')),
  };
}
