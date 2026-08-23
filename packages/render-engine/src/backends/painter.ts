/**
 * One painter, both backends.
 *
 * `DrawList → canvas calls`. Every decision that could make two backends disagree -
 * where the anchor puts a shape, how a polygon's points are parsed, which corner text
 * hangs from, whether a stroke is drawn before or after a fill - is made once, here.
 * The backends supply a surface and nothing else.
 *
 * Two rules the painter never breaks:
 *
 *  - **No wall clock and no randomness.** Particles are a seeded function of
 *    `(seed, timeMs)`, so the same frame drawn twice is the same pixels. `Math.random`
 *    in a particle system is the classic way a "deterministic" renderer stops being one.
 *  - **State is saved and restored per item.** An item that throws mid-draw must not
 *    leave the next item with its transform.
 */

import { assertNever, createRng } from '@rv/shared-kernel';

import {
  bitmapKey,
  type DrawItem,
  type DrawList,
  type ImageDraw,
  type ParticlesDraw,
  type ShapeDraw,
  type TextDraw,
} from '../frames/draw-list';
import type { CanvasContext2DLike, DrawableImage, SurfaceProvider } from './surface';
import { fontShorthand, layoutText, lineOffsetX } from './text-layout';

/** Bitmaps resolved for this session, keyed by {@link assetImageKey}. */
export type BitmapTable = ReadonlyMap<string, DrawableImage>;

export interface PaintDeps {
  readonly provider: SurfaceProvider;
  readonly bitmaps: BitmapTable;
}

export function paint(context: CanvasContext2DLike, list: DrawList, deps: PaintDeps): void {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, list.output.width, list.output.height);
  if (list.background !== null) {
    context.globalAlpha = 1;
    context.fillStyle = list.background;
    context.fillRect(0, 0, list.output.width, list.output.height);
  }
  context.restore();

  for (const item of list.items) {
    context.save();
    try {
      const { a, b, c, d, e, f } = item.matrix;
      context.setTransform(a, b, c, d, e, f);
      context.globalAlpha = item.alpha;
      paintItem(context, item, deps);
    } finally {
      context.restore();
    }
  }
}

function paintItem(context: CanvasContext2DLike, item: DrawItem, deps: PaintDeps): void {
  switch (item.kind) {
    case 'shape':
      paintShape(context, item, deps);
      return;
    case 'text':
      paintText(context, item);
      return;
    case 'image':
      paintImage(context, item, deps);
      return;
    case 'particles':
      paintParticles(context, item);
      return;
    default:
      return assertNever(item, 'draw item');
  }
}

// ── shapes ──────────────────────────────────────────────────────────────────

function paintShape(context: CanvasContext2DLike, item: ShapeDraw, deps: PaintDeps): void {
  context.fillStyle = item.fill ?? 'transparent';
  context.strokeStyle = item.stroke ?? 'transparent';
  context.lineWidth = item.strokeWidth;
  context.lineJoin = 'round';
  context.lineCap = 'round';

  const size = item.size;
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  // The anchor is a fraction of the node's own bounds, so it only becomes a pixel
  // offset once the bounds are known - which is here, and not in the transform.
  const left = -item.anchor.x * width;
  const top = -item.anchor.y * height;

  switch (item.shape) {
    case 'rect':
      if (item.fill !== null) context.fillRect(left, top, width, height);
      if (item.stroke !== null && item.strokeWidth > 0) {
        context.strokeRect(left, top, width, height);
      }
      return;

    case 'ellipse':
      context.beginPath();
      context.ellipse(left + width / 2, top + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      context.closePath();
      if (item.fill !== null) context.fill();
      if (item.stroke !== null && item.strokeWidth > 0) context.stroke();
      return;

    case 'line':
    case 'polygon': {
      const points = parsePoints(item.geometry);
      if (points.length < 2) return;
      context.beginPath();
      const [first, ...rest] = points;
      if (first === undefined) return;
      context.moveTo(left + first.x, top + first.y);
      for (const point of rest) context.lineTo(left + point.x, top + point.y);
      if (item.shape === 'polygon') {
        context.closePath();
        if (item.fill !== null) context.fill();
      }
      if (item.stroke !== null && item.strokeWidth > 0) context.stroke();
      return;
    }

    case 'path': {
      if (item.geometry === null) return;
      const path = deps.provider.createPath(item.geometry);
      // A surface with no Path2D draws nothing rather than approximating the path with
      // a bounding box; a wrong shape is worse than a missing one, because it looks
      // deliberate.
      if (path === null) return;
      if (item.fill !== null) context.fill(path);
      if (item.stroke !== null && item.strokeWidth > 0) context.stroke(path);
      return;
    }

    default:
      return assertNever(item.shape, 'shape kind');
  }
}

/** `"0,0 100,0 50,80"` or `"0 0 100 0 50 80"`. Both are written by hand and by models. */
export function parsePoints(geometry: string | null): readonly { x: number; y: number }[] {
  if (geometry === null) return [];
  const numbers = geometry
    .split(/[\s,]+/)
    .filter((token) => token.length > 0)
    .map(Number);
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    const x = numbers[i];
    const y = numbers[i + 1];
    if (x === undefined || y === undefined) break;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    points.push({ x, y });
  }
  return points;
}

// ── text ────────────────────────────────────────────────────────────────────

function paintText(context: CanvasContext2DLike, item: TextDraw): void {
  context.font = fontShorthand(item.style);
  context.fillStyle = item.style.colour;
  context.textBaseline = 'top';
  // Alignment is computed from measured widths rather than delegated, because
  // `textAlign: 'start'` under an RTL direction is not implemented identically by
  // every canvas and this has to be.
  context.textAlign = 'left';
  context.direction = item.direction === 'auto' ? 'inherit' : item.direction;

  const block = layoutText(
    item.text,
    item.style,
    item.maxWidth,
    (text) => context.measureText(text).width,
  );
  const blockWidth = item.maxWidth ?? block.width;
  const left = -item.anchor.x * blockWidth;
  const top = -item.anchor.y * block.height;

  for (const line of block.lines) {
    const offset = lineOffsetX(item.align, item.direction, line.width, blockWidth);
    context.fillText(line.text, left + offset, top + line.top);
  }
}

// ── images ──────────────────────────────────────────────────────────────────

function paintImage(context: CanvasContext2DLike, item: ImageDraw, deps: PaintDeps): void {
  const bitmap = deps.bitmaps.get(bitmapKey(item.imageKey, item.tint));
  // Missing bitmaps are rejected when the session opens, so reaching here means the
  // table and the draw list disagree - draw nothing rather than a placeholder that
  // would pass a visual review.
  if (bitmap === undefined) return;
  context.drawImage(bitmap, -item.anchor.x * bitmap.width, -item.anchor.y * bitmap.height);
}

// ── particles ───────────────────────────────────────────────────────────────

/**
 * A deterministic stand-in for a real particle system.
 *
 * The `napi-canvas` backend declares `particles` unsupported and refuses such a
 * composition at `open`, so this only runs on a surface that asked for it - the browser
 * backend's fallback path, and the tests. It is seeded from the emitter's own `seed`
 * and the frame time, so re-rendering frame 400 draws the same dust it drew last time.
 */
function paintParticles(context: CanvasContext2DLike, item: ParticlesDraw): void {
  const count = Math.max(0, Math.round((item.rate * item.intensity) / 4));
  if (count === 0) return;

  context.fillStyle = '#ffffff';
  const left = -item.anchor.x * item.area.width;
  const top = -item.anchor.y * item.area.height;
  const radius = 1 + item.intensity * 3;

  for (let index = 0; index < count; index += 1) {
    const rng = createRng(item.seed).fork(`${item.effect}:${String(index)}`);
    const phase = rng.next();
    const drift = rng.next();
    // Position advances with time and wraps, so the field is continuous across frames
    // without any state carried between them.
    const x = wrap01(phase + (item.timeMs / 20_000) * (0.2 + drift)) * item.area.width;
    const y = wrap01(drift + (item.timeMs / 12_000) * (0.3 + phase)) * item.area.height;
    context.beginPath();
    context.ellipse(left + x, top + y, radius, radius, 0, 0, Math.PI * 2);
    context.closePath();
    context.fill();
  }
}

function wrap01(value: number): number {
  return value - Math.floor(value);
}
