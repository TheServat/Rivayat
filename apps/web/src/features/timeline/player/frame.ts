/**
 * `AnimationIR` + `t` → a flat list of things to paint, in painter's order.
 *
 * The whole player is this function plus a `<canvas>` that draws its output. That split
 * is not tidiness: it is what makes the screen's central claim *testable*. "The preview
 * agrees with `evaluate(ir, t)`" is only an assertion if the thing being compared is a
 * value, and a `CanvasRenderingContext2D` is not one — jsdom does not even give you a
 * 2D context. So the arithmetic is here, pure, and the painter is a switch over the
 * result that draws and returns nothing.
 *
 * It calls `evaluate` from `@rv/anim-engine` and nothing else. There is no
 * preview-grade interpolation, no "close enough" easing, no local bezier: the solver in
 * `easing.ts` is shared by the renderer, the sprite-sheet baker and the Lottie exporter
 * precisely so all four answers are the same number, and a fourth implementation here
 * would make the preview a lie exactly where it is hardest to notice — eased
 * interpolation between distant keyframes, where a straight line still looks plausible.
 *
 * Paint order and projection both come from the contract rather than from here.
 * `CameraTrack.projection` says how scene coordinates reach the screen, and
 * `PROJECTION_BASES` says how to sort under it: `depth` descending for orthographic,
 * projected screen y ascending for isometric, because under an isometric projection
 * something further from the camera lands *higher* up the screen and screen y - not
 * depth - decides who occludes whom. Ties break on the authored index, so the sort is
 * stable by construction rather than by trusting the engine's.
 *
 * `projectScenePoint` is imported, not reimplemented, for the same reason `evaluate` is:
 * the contract says in as many words that a second copy of it "displaced every layer by
 * half a canvas". Under `orthographic` it short-circuits to the identity, so every
 * document that exists today projects to exactly the coordinates it already had.
 */

import { evaluate, type EvaluateOptions } from '@rv/anim-engine';
import {
  PROJECTION_BASES,
  projectScenePoint,
  type AnimNode,
  type AnimationIR,
  type CameraProjection,
  type SceneSnapshot,
  type Size,
  type Transform2D,
} from '@rv/contracts';

import { cameraMatrix, fromTransform, multiply, sceneRect, type Matrix2D } from './scene-space';

interface PaintBase {
  readonly nodeId: string;
  readonly name: string;
  /** Scene space → output pixels, camera already folded in. */
  readonly matrix: Matrix2D;
  readonly alpha: number;
  /** Normalised pivot in the item's own bounds. */
  readonly anchor: { readonly x: number; readonly y: number };
}

export interface ShapePaint extends PaintBase {
  readonly kind: 'shape';
  readonly shape: 'rect' | 'ellipse' | 'line' | 'polygon' | 'path';
  readonly fill: string | null;
  readonly stroke: string | null;
  readonly strokeWidth: number;
  readonly geometry: string | null;
  readonly size: Size | null;
}

export interface TextPaint extends PaintBase {
  readonly kind: 'text';
  readonly text: string;
  readonly colour: string | null;
  readonly align: 'start' | 'center' | 'end';
  readonly direction: 'ltr' | 'rtl' | 'auto';
  readonly fontSizePx: number;
}

/**
 * A placed asset, drawn as its silhouette.
 *
 * There is no route that serves a part bitmap (see `schemas/assets.ts`), so an instance
 * is drawn as a labelled outline at its resolved transform rather than as a wrong
 * picture. The *placement* is exactly what the renderer would use; only the pixels are
 * missing, and the box says so instead of pretending.
 */
export interface InstancePaint extends PaintBase {
  readonly kind: 'instance';
  readonly clipName: string | null;
  readonly tint: string | null;
}

export interface EmitterPaint extends PaintBase {
  readonly kind: 'emitter';
  readonly effect: string;
  readonly area: Size;
  readonly intensity: number;
}

export type PaintItem = ShapePaint | TextPaint | InstancePaint | EmitterPaint;

export interface PlayerFrame {
  readonly frame: number;
  /** Quantised by the style's step cadence, exactly as `evaluate` reports it. */
  readonly timeMs: number;
  readonly output: Size;
  /** The letterboxed rectangle the composition occupies, in output pixels. */
  readonly stage: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly camera: SceneSnapshot['camera'];
  readonly items: readonly PaintItem[];
}

export interface BuildFrameOptions extends EvaluateOptions {
  readonly output: Size;
}

/**
 * The one entry point.
 *
 * Takes the IR and a time; returns everything the canvas needs and nothing it does not.
 * Deterministic in the strong sense the IR promises: same arguments, same output, so
 * scrubbing to `t` and playing to `t` cannot differ.
 */
export function buildFrame(
  ir: AnimationIR,
  timeMs: number,
  options: BuildFrameOptions,
): PlayerFrame {
  const { output, ...evaluateOptions } = options;
  const snapshot = evaluate(ir, timeMs, evaluateOptions);
  return frameFromSnapshot(ir, snapshot, output);
}

/**
 * The half that does not evaluate, exposed so a test can hold the two apart.
 *
 * `frameFromSnapshot(ir, evaluate(ir, t), out)` and `buildFrame(ir, t, {output: out})`
 * must be the same value; asserting that is what pins the player to the evaluator
 * rather than to a copy of it.
 */
export function frameFromSnapshot(
  ir: AnimationIR,
  snapshot: SceneSnapshot,
  output: Size,
): PlayerFrame {
  const projection: CameraProjection = ir.camera?.projection ?? 'orthographic';
  // The camera frames a scene-space point, so it goes through the same projection the
  // nodes do. At depth zero: how deep a scene runs is a property of what is in it, not
  // of where the camera is looking.
  const view = cameraMatrix(
    { ...snapshot.camera, position: projectScenePoint(projection, snapshot.camera.position) },
    ir.sceneSpace,
    output,
  );
  const byId = new Map<string, AnimNode>(ir.nodes.map((node) => [node.id, node]));

  const drawable = snapshot.nodes
    .filter((resolved) => resolved.visible && resolved.worldTransform.opacity > 0)
    .map((resolved, index) => ({
      resolved,
      index,
      // Depth is folded into position here rather than carried into the matrix: an
      // affine map over three inputs does not fit a 2x3 canvas matrix, and the
      // `parallax` behaviour already establishes depth-drives-position as a legitimate
      // move. See `ProjectionBasis` in the contract.
      projected: projectScenePoint(projection, resolved.worldTransform.position, resolved.depth),
    }));

  const sort = PROJECTION_BASES[projection].sort;
  drawable.sort((left, right) => {
    if (sort === 'projected-y' && left.projected.y !== right.projected.y) {
      return left.projected.y - right.projected.y;
    }
    if (left.resolved.depth !== right.resolved.depth) {
      return right.resolved.depth - left.resolved.depth;
    }
    return left.index - right.index;
  });

  const items: PaintItem[] = [];
  for (const { resolved, projected } of drawable) {
    const node = byId.get(resolved.nodeId);
    if (node === undefined) continue;
    const placed: Transform2D = { ...resolved.worldTransform, position: projected };
    const item = toPaintItem(node, placed, view, resolved.tint ?? null);
    if (item !== null) items.push(item);
  }

  return {
    frame: snapshot.frame,
    timeMs: snapshot.timeMs,
    output,
    stage: sceneRect(ir.sceneSpace, output),
    camera: snapshot.camera,
    items,
  };
}

/** Body text at 1080p, matching `DEFAULT_TEXT_STYLE` in the renderer's draw list. */
const DEFAULT_FONT_SIZE_PX = 48;

function toPaintItem(
  node: AnimNode,
  world: Transform2D,
  view: Matrix2D,
  resolvedTint: string | null,
): PaintItem | null {
  const base: PaintBase = {
    nodeId: node.id,
    name: node.name,
    matrix: multiply(view, fromTransform(world)),
    alpha: world.opacity,
    anchor: world.anchor,
  };

  switch (node.kind) {
    // Structural and override-only nodes. They move other things; they draw nothing.
    case 'group':
    case 'part':
    case 'bone':
      return null;

    case 'shape':
      return {
        ...base,
        kind: 'shape',
        shape: node.shape,
        fill: node.fill ?? null,
        stroke: node.stroke ?? null,
        strokeWidth: node.strokeWidth,
        geometry: node.geometry ?? null,
        size: node.size ?? null,
      };

    case 'text':
      return {
        ...base,
        kind: 'text',
        text: node.text,
        colour: node.color ?? null,
        align: node.align,
        direction: node.direction,
        fontSizePx: node.styleName === 'title' ? DEFAULT_FONT_SIZE_PX * 1.5 : DEFAULT_FONT_SIZE_PX,
      };

    case 'asset-instance':
      return {
        ...base,
        kind: 'instance',
        clipName: node.clipName ?? null,
        tint: resolvedTint ?? node.tint ?? null,
      };

    case 'fx-emitter':
      return {
        ...base,
        kind: 'emitter',
        effect: node.effect,
        area: node.area,
        intensity: node.intensity,
      };
  }
}
