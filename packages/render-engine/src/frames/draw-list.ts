/**
 * `SceneSnapshot` + `AnimationIR` → a flat, backend-agnostic list of things to paint.
 *
 * The snapshot the evaluator returns says *where* every node is and nothing about
 * *what* it is: `ResolvedNode` carries a world transform, visibility, depth and tint,
 * and the node's kind, geometry, text and asset reference stay in the IR. Joining the
 * two is the last piece of shared logic before the backends diverge, so it lives here
 * and both of them consume the result.
 *
 * That is not tidiness. ADR-0003 accepts two backends and names the risk: "a shot that
 * silently renders differently on the two backends is a real, and nasty, class of bug".
 * The narrower the surface each backend implements independently, the smaller that risk
 * is - so paint order, camera projection, anchor handling, alpha and tint are decided
 * once, here, and a backend only has to know how to stroke a path.
 *
 * ## Scene-space convention
 *
 * The IR declares `sceneSpace` as a `Size` and never says where its origin is. This
 * module fixes it: **the origin is the centre of the canvas**, so the canvas spans
 * `[-w/2, +w/2] x [-h/2, +h/2]`. A camera keyframe at `{x: 0, y: 0}` therefore frames
 * the middle of the composition, which is the only default that is not surprising.
 * Normalised rectangles (`focusTarget.region`, `safeArea`) remain fractions from the
 * top-left, and {@link normPointToScene} is the single conversion between the two.
 */

import { assertNever } from '@rv/shared-kernel';
import type {
  AnimNode,
  AnimationIR,
  NormRect,
  ResolvedNode,
  SceneSnapshot,
  Size,
  Vec2,
} from '@rv/contracts';

import { cameraMatrix, fromTransform, multiply, type Matrix2D } from './matrix';

// ── text styling ────────────────────────────────────────────────────────────

/**
 * A resolved typography token.
 *
 * `TextNode.styleName` is a *logical* name ("body", "title") resolved against the
 * project's tokens, which live in the style bible and not in the IR. The render engine
 * takes them as data rather than reaching for them, so a golden-frame test can pin the
 * exact font metrics it renders with.
 */
export interface TextStyleSpec {
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly fontWeight: number;
  readonly lineHeightPx: number;
  readonly colour: string;
}

/**
 * The fallback when a style name resolves to nothing.
 *
 * A generic family rather than a real font: the canvas backend must produce identical
 * pixels on the developer's Windows box and in CI, and any named font that is present
 * on one and absent on the other silently substitutes. Choosing the generic makes the
 * substitution the *same* substitution everywhere.
 */
export const DEFAULT_TEXT_STYLE: TextStyleSpec = {
  fontFamily: 'sans-serif',
  fontSizePx: 48,
  fontWeight: 400,
  lineHeightPx: 58,
  colour: '#ffffff',
};

export type TextStyleTable = Readonly<Record<string, TextStyleSpec>>;

// ── draw items ──────────────────────────────────────────────────────────────

interface DrawBase {
  readonly nodeId: string;
  /** Scene space → output pixels, camera already folded in. */
  readonly matrix: Matrix2D;
  readonly alpha: number;
  /** Normalised pivot in the item's own bounds. */
  readonly anchor: Vec2;
}

export interface ShapeDraw extends DrawBase {
  readonly kind: 'shape';
  readonly shape: 'rect' | 'ellipse' | 'line' | 'polygon' | 'path';
  readonly fill: string | null;
  readonly stroke: string | null;
  readonly strokeWidth: number;
  /** SVG path data for `path`, space/comma separated points for `polygon` and `line`. */
  readonly geometry: string | null;
  readonly size: Size | null;
}

export interface TextDraw extends DrawBase {
  readonly kind: 'text';
  readonly text: string;
  readonly style: TextStyleSpec;
  readonly align: 'start' | 'center' | 'end';
  readonly direction: 'ltr' | 'rtl' | 'auto';
  readonly maxWidth: number | null;
}

export interface ImageDraw extends DrawBase {
  readonly kind: 'image';
  /** Key into the resolved bitmap table. See {@link assetImageKey}. */
  readonly imageKey: string;
  readonly tint: string | null;
}

export interface ParticlesDraw extends DrawBase {
  readonly kind: 'particles';
  readonly effect: string;
  readonly rate: number;
  readonly area: Size;
  readonly seed: number;
  readonly intensity: number;
  readonly timeMs: number;
}

export type DrawItem = ShapeDraw | TextDraw | ImageDraw | ParticlesDraw;

export interface DrawList {
  readonly frame: number;
  readonly timeMs: number;
  readonly output: Size;
  readonly background: string | null;
  /** Painter's order: index 0 goes down first. */
  readonly items: readonly DrawItem[];
}

// ── keys ────────────────────────────────────────────────────────────────────

/**
 * The bitmap identity of a placed asset instance.
 *
 * Version-first because the version is what a render is pinned to; the variant and the
 * clip name qualify it. Built by string concatenation with a delimiter that cannot
 * appear in a `Slug`, so two different references cannot collide into one bitmap.
 */
export function assetImageKey(
  ref: { readonly versionId: string; readonly variantKey?: string | undefined },
  clipName?: string,
): string {
  return `${ref.versionId}|${ref.variantKey ?? ''}|${clipName ?? ''}`;
}

/**
 * The key a *tinted* bitmap is cached under.
 *
 * Tint is baked into the bitmap once per session rather than composited per frame: a
 * canvas tint costs a second full-size composite operation on every frame of every
 * tinted instance, while `ResolvedNode.tint` is fixed for the whole render (the
 * evaluator copies the node's authored tint through unchanged). Paying it once is
 * strictly better, and it keeps the painter free of blend-mode behaviour that the two
 * backends implement differently.
 */
export function bitmapKey(imageKey: string, tint: string | null): string {
  return tint === null ? imageKey : `${imageKey}#${tint}`;
}

/** Centre-origin scene coordinates for a point given as fractions of the canvas. */
export function normPointToScene(point: Vec2, scene: Size): Vec2 {
  return { x: (point.x - 0.5) * scene.width, y: (point.y - 0.5) * scene.height };
}

/** The centre of a normalised rectangle, in the same fractional space. */
export function normRectCentre(rect: NormRect): Vec2 {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

// ── the join ────────────────────────────────────────────────────────────────

export interface BuildDrawListOptions {
  readonly output: Size;
  readonly background?: string | null;
  readonly textStyles?: TextStyleTable;
}

/**
 * Joins a snapshot to its IR and sorts into painter's order.
 *
 * Sorted by `depth` **descending** - the IR defines higher depth as further from the
 * camera - and stably, so two nodes at the same depth keep the order the author wrote
 * them in. An unstable sort here would change the picture between Node versions.
 */
export function buildDrawList(
  ir: AnimationIR,
  snapshot: SceneSnapshot,
  options: BuildDrawListOptions,
): DrawList {
  const view = cameraMatrix(snapshot.camera, ir.sceneSpace, options.output);
  const byId = new Map<string, AnimNode>(ir.nodes.map((node) => [node.id, node]));
  const styles = options.textStyles ?? {};

  const drawable = snapshot.nodes
    .filter((resolved) => resolved.visible && resolved.worldTransform.opacity > 0)
    .map((resolved, index) => ({ resolved, index }));

  // Stable by construction: the authored index breaks depth ties explicitly rather
  // than relying on the engine's sort being stable.
  drawable.sort((left, right) =>
    left.resolved.depth === right.resolved.depth
      ? left.index - right.index
      : right.resolved.depth - left.resolved.depth,
  );

  const items: DrawItem[] = [];
  for (const { resolved } of drawable) {
    const node = byId.get(resolved.nodeId);
    if (node === undefined) continue; // a snapshot node with no IR node cannot be drawn
    const item = toDrawItem(node, resolved, view, styles, snapshot.timeMs);
    if (item !== null) items.push(item);
  }

  return {
    frame: snapshot.frame,
    timeMs: snapshot.timeMs,
    output: options.output,
    background: options.background ?? null,
    items,
  };
}

function toDrawItem(
  node: AnimNode,
  resolved: ResolvedNode,
  view: Matrix2D,
  styles: TextStyleTable,
  timeMs: number,
): DrawItem | null {
  const base: DrawBase = {
    nodeId: resolved.nodeId,
    matrix: multiply(view, fromTransform(resolved.worldTransform)),
    alpha: resolved.worldTransform.opacity,
    anchor: resolved.worldTransform.anchor,
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
        style: resolveTextStyle(styles, node.styleName, node.color),
        align: node.align,
        direction: node.direction,
        maxWidth: node.maxWidth ?? null,
      };

    case 'asset-instance':
      return {
        ...base,
        kind: 'image',
        imageKey: assetImageKey(node.asset, node.clipName),
        tint: resolved.tint ?? node.tint ?? null,
      };

    case 'fx-emitter':
      return {
        ...base,
        kind: 'particles',
        effect: node.effect,
        rate: node.rate,
        area: node.area,
        seed: node.seed,
        intensity: node.intensity,
        timeMs,
      };

    default:
      return assertNever(node, 'anim node kind');
  }
}

function resolveTextStyle(
  styles: TextStyleTable,
  styleName: string,
  colour: string | undefined,
): TextStyleSpec {
  const resolved = styles[styleName] ?? DEFAULT_TEXT_STYLE;
  return colour === undefined ? resolved : { ...resolved, colour };
}
