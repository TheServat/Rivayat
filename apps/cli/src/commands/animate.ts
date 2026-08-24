/**
 * `rv animate` - the thesis, made visible.
 *
 * Builds a small scene as an `AnimationIR`, evaluates it frame by frame with
 * `@rv/anim-engine`, rasterises each frame, and pipes raw RGBA straight into FFmpeg.
 * **No image model is called and nothing is generated per frame** - the motion is
 * arithmetic over a handful of behaviour parameters, which is the entire cost argument
 * behind ADR-0002.
 *
 * It also renders the same composition to two aspect ratios from one authored scene,
 * which is the other half of the claim: reframing is computed from `focusTarget`, not
 * re-authored.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { evaluate } from '@rv/anim-engine';
import type { Clock } from '@rv/shared-kernel';
import type { AnimationIR, MotionStyle, ResolvedNode, SceneSnapshot } from '@rv/contracts';

const SCENE = { width: 1920, height: 1080 } as const;

/** Palette pulled from the `paper-cutout` preset's spirit: matte, earthy, few colours. */
const INK = {
  sky: '#cfe3ef',
  hill: '#7d9e6a',
  hillBack: '#9ab884',
  trunk: '#5a4632',
  canopy: '#4a6b3f',
  canopyBack: '#5f7f52',
  bird: '#2f2a26',
  sun: '#f2d98c',
} as const;

interface Painted {
  readonly fill: string;
  readonly shape: 'rect' | 'ellipse';
  readonly width: number;
  readonly height: number;
}

/**
 * How each node is drawn.
 *
 * Kept beside the IR rather than inside it: the IR describes *motion*, and a renderer
 * decides what a node looks like. A real run resolves this from the asset library.
 */
const PAINT: Readonly<Record<string, Painted>> = {
  sky: { fill: INK.sky, shape: 'rect', width: 4000, height: 2400 },
  sun: { fill: INK.sun, shape: 'ellipse', width: 190, height: 190 },
  'hill-back': { fill: INK.hillBack, shape: 'ellipse', width: 2600, height: 900 },
  hill: { fill: INK.hill, shape: 'ellipse', width: 3000, height: 800 },
  'trunk-a': { fill: INK.trunk, shape: 'rect', width: 34, height: 240 },
  'canopy-a': { fill: INK.canopy, shape: 'ellipse', width: 320, height: 250 },
  'trunk-b': { fill: INK.trunk, shape: 'rect', width: 26, height: 180 },
  'canopy-b': { fill: INK.canopyBack, shape: 'ellipse', width: 240, height: 190 },
  'trunk-c': { fill: INK.trunk, shape: 'rect', width: 30, height: 210 },
  'canopy-c': { fill: INK.canopy, shape: 'ellipse', width: 280, height: 220 },
  bird: { fill: INK.bird, shape: 'ellipse', width: 46, height: 20 },
  'wing-l': { fill: INK.bird, shape: 'ellipse', width: 54, height: 12 },
  'wing-r': { fill: INK.bird, shape: 'ellipse', width: 54, height: 12 },
};

function id(prefix: string, n: number): string {
  return `${prefix}_01J8ZQ4E7K9M2N4P6R8T0V${n.toString(36).toUpperCase().padStart(3, '0')}`;
}

let counter = 0;
const nid = (): string => id('nod', counter++);
const bid = (): string => id('bhv', counter++);

/**
 * A grove with a bird over it.
 *
 * Three trees, each with its own wind seed, so they move independently - that
 * independence is what the `fork`-per-node seeding in `@rv/shared-kernel` buys, and
 * without it the whole grove gusts in unison.
 */
export function buildGroveScene(): { ir: AnimationIR; focusNodeName: string } {
  counter = 0;
  const nodes: unknown[] = [];
  const behaviours: unknown[] = [];
  const byName = new Map<string, string>();

  const add = (
    name: string,
    parent: string | null,
    x: number,
    y: number,
    depth: number,
    extra: Record<string, unknown> = {},
  ): string => {
    const nodeId = nid();
    byName.set(name, nodeId);
    nodes.push({
      kind: 'group',
      id: nodeId,
      name,
      parentId: parent,
      transform: {
        position: { x, y },
        rotation: 0,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 1 },
        opacity: 1,
      },
      visible: true,
      depth,
      ...extra,
    });
    return nodeId;
  };

  const root = add('root', null, 0, 0, 0);
  add('sky', root, 960, 1080, 90);
  add('sun', root, 1560, 300, 80);
  add('hill-back', root, 700, 1180, 60);
  add('hill', root, 1100, 1240, 40);

  // Each tree: a trunk that sways, a canopy that sways harder. `tipBias` is what makes
  // the top of a tree move more than its base.
  const trees: readonly { name: string; x: number; ground: number; depth: number; hz: number }[] = [
    { name: 'a', x: 520, ground: 900, depth: 20, hz: 0.28 },
    { name: 'b', x: 1180, ground: 860, depth: 35, hz: 0.36 },
    { name: 'c', x: 1520, ground: 920, depth: 25, hz: 0.22 },
  ];

  for (const [index, tree] of trees.entries()) {
    const trunk = add(`trunk-${tree.name}`, root, tree.x, tree.ground, tree.depth);
    const paint = PAINT[`trunk-${tree.name}`];
    const canopy = add(`canopy-${tree.name}`, trunk, 0, -(paint?.height ?? 200), tree.depth, {
      transform: undefined,
    });
    // `transform: undefined` above would break the schema; set it properly instead.
    const canopyNode = nodes[nodes.length - 1] as Record<string, unknown>;
    canopyNode.transform = {
      position: { x: 0, y: -(paint?.height ?? 200) },
      rotation: 0,
      scale: { x: 1, y: 1 },
      skew: { x: 0, y: 0 },
      anchor: { x: 0.5, y: 1 },
      opacity: 1,
    };

    behaviours.push({
      id: bid(),
      kind: 'wind',
      nodeId: trunk,
      enabled: true,
      seed: 1000 + index * 137,
      weight: 1,
      hz: tree.hz,
      amplitude: 0.22,
      gustiness: 0.5,
      direction: 0,
      tipBias: 0.35,
    });
    behaviours.push({
      id: bid(),
      kind: 'wind',
      nodeId: canopy,
      enabled: true,
      seed: 5000 + index * 311,
      weight: 1,
      hz: tree.hz * 1.4,
      amplitude: 0.3,
      gustiness: 0.6,
      direction: 0,
      tipBias: 0.9,
    });
  }

  // The bird orbits, and its wings flap asymmetrically.
  const bird = add('bird', root, 0, 0, 10);
  behaviours.push({
    id: bid(),
    kind: 'orbit',
    nodeId: bird,
    enabled: true,
    seed: 77,
    weight: 1,
    centre: { x: 980, y: 420 },
    radius: { x: 620, y: 130 },
    periodMs: 6000,
    phase: 0,
  });

  for (const [side, offset] of [
    ['wing-l', -22],
    ['wing-r', 22],
  ] as const) {
    const wing = add(side, bird, offset, 0, 10);
    behaviours.push({
      id: bid(),
      kind: 'flap',
      nodeId: wing,
      enabled: true,
      seed: side === 'wing-l' ? 11 : 12,
      weight: 1,
      hz: 5.5,
      amplitudeDeg: side === 'wing-l' ? 46 : -46,
      downstrokeBias: 0.35,
    });
  }

  const ir = {
    irVersion: 1,
    id: id('anm', 999),
    name: 'grove',
    fps: 24,
    durationMs: 6000,
    sceneSpace: SCENE,
    seed: 4242,
    nodes,
    tracks: [],
    behaviours,
    markers: [],
    camera: {
      keyframes: [{ timeMs: 0, position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }],
      focusNodeId: byName.get('bird'),
      shakeAmplitude: 0,
      shakeSeed: 0,
    },
  } as unknown as AnimationIR;

  return { ir, focusNodeName: 'bird' };
}

// ── rasterising ─────────────────────────────────────────────────────────────

export interface Viewport {
  readonly width: number;
  readonly height: number;
  /** Scene-space rectangle mapped onto the canvas. */
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

/**
 * Solves the crop for one delivery aspect, keeping the focus target in frame.
 *
 * A cut-down version of what `@rv/render-engine` does properly - enough to show that
 * one authored composition yields both aspects without being re-authored.
 */
export function solveViewport(
  target: { width: number; height: number },
  focus: { x: number; y: number },
): Viewport {
  const targetAspect = target.width / target.height;
  const sceneAspect = SCENE.width / SCENE.height;

  let sw = SCENE.width;
  let sh = SCENE.height;
  if (targetAspect < sceneAspect) sw = SCENE.height * targetAspect;
  else sh = SCENE.width / targetAspect;

  // Centre on the focus, then clamp so the crop never leaves the scene.
  const sx = Math.min(Math.max(focus.x - sw / 2, 0), SCENE.width - sw);
  const sy = Math.min(Math.max(focus.y - sh / 2, 0), SCENE.height - sh);
  return { width: target.width, height: target.height, sx, sy, sw, sh };
}

function drawFrame(
  ctx: SKRSContext2D,
  snapshot: SceneSnapshot,
  view: Viewport,
  names: Map<string, string>,
): void {
  ctx.save();
  ctx.fillStyle = INK.sky;
  ctx.fillRect(0, 0, view.width, view.height);

  const scale = view.width / view.sw;
  ctx.scale(scale, scale);
  ctx.translate(-view.sx, -view.sy);

  // Far layers first. Depth is "distance from camera", so larger draws behind.
  const ordered = [...snapshot.nodes].sort((a, b) => b.depth - a.depth);
  for (const node of ordered) {
    if (!node.visible) continue;
    const paint = PAINT[names.get(node.nodeId) ?? ''];
    if (paint === undefined) continue;
    paintNode(ctx, node, paint);
  }
  ctx.restore();
}

function paintNode(ctx: SKRSContext2D, node: ResolvedNode, paint: Painted): void {
  const t = node.worldTransform;
  ctx.save();
  ctx.translate(t.position.x, t.position.y);
  ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale(t.scale.x, t.scale.y);
  ctx.globalAlpha = t.opacity;
  ctx.fillStyle = paint.fill;

  const w = paint.width;
  const h = paint.height;
  const ox = -w * t.anchor.x;
  const oy = -h * t.anchor.y;

  if (paint.shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(ox + w / 2, oy + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillRect(ox, oy, w, h);
  }
  ctx.restore();
}

// ── encoding ────────────────────────────────────────────────────────────────

export interface RenderOptions {
  readonly outPath: string;
  readonly target: { width: number; height: number };
  readonly ffmpegPath: string;
  /**
   * Injected rather than read from `performance.now()`.
   *
   * Only the elapsed-time report depends on it, but the repo-wide determinism scan
   * treats every wall-clock read as a defect on principle - and it is right to, because
   * the exemption is always "only this one place" until it is not.
   */
  readonly clock: Clock;
  readonly motion?: Pick<MotionStyle, 'stepMode' | 'easings' | 'tempo'>;
  readonly onProgress?: (frame: number, total: number) => void;
}

export async function renderScene(
  ir: AnimationIR,
  focusNodeName: string,
  options: RenderOptions,
): Promise<{ frames: number; bytes: number; elapsedMs: number }> {
  const names = new Map<string, string>(
    (ir.nodes as readonly { id: string; name: string }[]).map((n) => [n.id, n.name]),
  );
  const focusId = [...names.entries()].find(([, name]) => name === focusNodeName)?.[0];

  const total = Math.round((ir.durationMs / 1000) * ir.fps);
  const canvas = createCanvas(options.target.width, options.target.height);
  const ctx = canvas.getContext('2d');

  await mkdir(dirname(options.outPath), { recursive: true });

  const ffmpeg = spawn(
    options.ffmpegPath,
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${String(options.target.width)}x${String(options.target.height)}`,
      '-r',
      String(ir.fps),
      '-i',
      '-',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      options.outPath,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );

  let stderr = '';
  ffmpeg.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const started = options.clock.now();
  let bytes = 0;

  const done = new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${String(code)}: ${stderr.trim()}`));
    });
  });

  for (let frame = 0; frame < total; frame += 1) {
    const timeMs = (frame / ir.fps) * 1000;
    const snapshot = evaluate(
      ir,
      timeMs,
      options.motion === undefined ? {} : { motion: options.motion },
    );

    const focus =
      focusId === undefined
        ? { x: SCENE.width / 2, y: SCENE.height / 2 }
        : (snapshot.nodes.find((n) => n.nodeId === focusId)?.worldTransform.position ?? {
            x: SCENE.width / 2,
            y: SCENE.height / 2,
          });

    drawFrame(ctx, snapshot, solveViewport(options.target, focus), names);

    const raw = Buffer.from(
      ctx.getImageData(0, 0, options.target.width, options.target.height).data.buffer,
    );
    bytes += raw.byteLength;
    if (!ffmpeg.stdin.write(raw)) {
      await new Promise<void>((resolve) =>
        ffmpeg.stdin.once('drain', () => {
          resolve();
        }),
      );
    }
    options.onProgress?.(frame + 1, total);
  }

  ffmpeg.stdin.end();
  await done;

  return { frames: total, bytes, elapsedMs: options.clock.now() - started };
}
