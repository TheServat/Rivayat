/**
 * The painter: a `PlayerFrame` onto a 2D context.
 *
 * Everything interesting already happened in `frame.ts`. This file has no arithmetic
 * about *where* anything goes — it reads `item.matrix`, hands it to `setTransform`, and
 * draws. That is the point: if placement logic lived here it would be untestable,
 * because jsdom has no 2D context and a canvas cannot be compared to an expected value
 * without a pixel harness.
 *
 * Chrome colours (the stage edge, the letterbox, the placeholder box for an asset whose
 * bitmap the API cannot serve) are passed in, resolved from the design tokens by the
 * component. A canvas cannot inherit CSS, so the alternative is hard-coded colour in a
 * codebase whose whole colour system is two token layers deep, and a preview that stays
 * light-mode on a dark page.
 */

import type { PlayerFrame, PaintItem } from './frame';
import type { Matrix2D } from './scene-space';

/** The tokens the canvas cannot inherit, resolved by the component that owns it. */
export interface PainterChrome {
  readonly letterbox: string;
  readonly stageEdge: string;
  readonly placeholder: string;
  readonly placeholderInk: string;
  readonly text: string;
  readonly fontFamily: string;
}

/**
 * Draws one frame. Returns nothing, on purpose.
 *
 * A painter that returned anything would invite a test to assert on the return value
 * instead of on `buildFrame`, which is the thing worth asserting on.
 */
export function paintFrame(
  context: CanvasRenderingContext2D,
  frame: PlayerFrame,
  chrome: PainterChrome,
  devicePixelRatio: number,
): void {
  const { output, stage } = frame;

  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, output.width, output.height);

  // The letterbox is drawn rather than hidden: the fit is *contain*, and a preview that
  // filled the panel would be showing a composition nobody will render.
  context.fillStyle = chrome.letterbox;
  context.fillRect(0, 0, output.width, output.height);

  context.save();
  context.beginPath();
  context.rect(stage.x, stage.y, stage.width, stage.height);
  context.clip();

  for (const item of frame.items) paintItem(context, item, chrome, devicePixelRatio);

  context.restore();

  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.strokeStyle = chrome.stageEdge;
  context.lineWidth = 1;
  context.strokeRect(stage.x + 0.5, stage.y + 0.5, stage.width - 1, stage.height - 1);
}

function setMatrix(
  context: CanvasRenderingContext2D,
  matrix: Matrix2D,
  devicePixelRatio: number,
): void {
  context.setTransform(
    matrix.a * devicePixelRatio,
    matrix.b * devicePixelRatio,
    matrix.c * devicePixelRatio,
    matrix.d * devicePixelRatio,
    matrix.e * devicePixelRatio,
    matrix.f * devicePixelRatio,
  );
}

function paintItem(
  context: CanvasRenderingContext2D,
  item: PaintItem,
  chrome: PainterChrome,
  devicePixelRatio: number,
): void {
  setMatrix(context, item.matrix, devicePixelRatio);
  context.globalAlpha = item.alpha;

  switch (item.kind) {
    case 'shape':
      paintShape(context, item);
      return;
    case 'text':
      paintText(context, item, chrome);
      return;
    case 'instance':
      paintPlaceholder(context, item, chrome);
      return;
    case 'emitter':
      paintEmitter(context, item, chrome);
      return;
  }
}

function paintShape(
  context: CanvasRenderingContext2D,
  item: Extract<PaintItem, { kind: 'shape' }>,
): void {
  const width = item.size?.width ?? 0;
  const height = item.size?.height ?? 0;
  // The anchor is normalised in the item's own bounds, which only the painter knows,
  // which is exactly why `fromTransform` leaves it out.
  const offsetX = -width * item.anchor.x;
  const offsetY = -height * item.anchor.y;

  context.beginPath();
  switch (item.shape) {
    case 'rect':
      context.rect(offsetX, offsetY, width, height);
      break;
    case 'ellipse':
      context.ellipse(
        offsetX + width / 2,
        offsetY + height / 2,
        Math.max(width / 2, 0),
        Math.max(height / 2, 0),
        0,
        0,
        Math.PI * 2,
      );
      break;
    case 'line':
    case 'polygon': {
      const points = parsePoints(item.geometry);
      const first = points[0];
      if (first === undefined) return;
      context.moveTo(first.x, first.y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      if (item.shape === 'polygon') context.closePath();
      break;
    }
    case 'path': {
      if (item.geometry === null) return;
      // `Path2D` is a browser API; in jsdom it is absent, and a preview that threw on a
      // path node would take the whole screen down rather than skip one shape.
      if (typeof Path2D === 'undefined') return;
      const path = new Path2D(item.geometry);
      if (item.fill !== null) {
        context.fillStyle = item.fill;
        context.fill(path);
      }
      if (item.stroke !== null && item.strokeWidth > 0) {
        context.strokeStyle = item.stroke;
        context.lineWidth = item.strokeWidth;
        context.stroke(path);
      }
      return;
    }
  }

  if (item.fill !== null && item.shape !== 'line') {
    context.fillStyle = item.fill;
    context.fill();
  }
  if (item.stroke !== null && item.strokeWidth > 0) {
    context.strokeStyle = item.stroke;
    context.lineWidth = item.strokeWidth;
    context.stroke();
  }
}

/** `"-60,0 -10,-26 40,-6"` → points. Space- or comma-separated, as the IR documents. */
function parsePoints(geometry: string | null): { x: number; y: number }[] {
  if (geometry === null) return [];
  const numbers = geometry
    .split(/[\s,]+/)
    .map((token) => Number.parseFloat(token))
    .filter((value) => Number.isFinite(value));
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    const x = numbers[index];
    const y = numbers[index + 1];
    if (x === undefined || y === undefined) break;
    points.push({ x, y });
  }
  return points;
}

function paintText(
  context: CanvasRenderingContext2D,
  item: Extract<PaintItem, { kind: 'text' }>,
  chrome: PainterChrome,
): void {
  context.fillStyle = item.colour ?? chrome.text;
  context.font = `${String(item.fontSizePx)}px ${chrome.fontFamily}`;
  context.textBaseline = 'middle';
  // `start`/`end` rather than `left`/`right`, and `direction` set from the node: a
  // Persian line authored RTL has to lay out RTL on the canvas too, and the canvas has
  // its own direction that does not inherit the document's.
  context.textAlign = item.align === 'center' ? 'center' : item.align;
  context.direction = item.direction === 'auto' ? 'inherit' : item.direction;
  context.fillText(item.text, 0, 0);
}

/**
 * An asset instance, drawn as a labelled outline.
 *
 * Its *placement* is the renderer's, exactly; only the pixels are missing, because no
 * route serves a part bitmap yet. Drawing a wrong picture would be worse than drawing a
 * box that says what is not there.
 */
function paintPlaceholder(
  context: CanvasRenderingContext2D,
  item: Extract<PaintItem, { kind: 'instance' }>,
  chrome: PainterChrome,
): void {
  const size = 160;
  const offsetX = -size * item.anchor.x;
  const offsetY = -size * item.anchor.y;
  context.fillStyle = item.tint ?? chrome.placeholder;
  context.fillRect(offsetX, offsetY, size, size);
  context.strokeStyle = chrome.placeholderInk;
  context.lineWidth = 2;
  context.setLineDash([6, 6]);
  context.strokeRect(offsetX, offsetY, size, size);
  context.setLineDash([]);
  context.fillStyle = chrome.placeholderInk;
  context.font = `16px ${chrome.fontFamily}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(item.name, offsetX + size / 2, offsetY + size / 2);
}

/** The emitter's field, as an outline. Particles are the renderer's; the area is not. */
function paintEmitter(
  context: CanvasRenderingContext2D,
  item: Extract<PaintItem, { kind: 'emitter' }>,
  chrome: PainterChrome,
): void {
  const offsetX = -item.area.width * item.anchor.x;
  const offsetY = -item.area.height * item.anchor.y;
  context.strokeStyle = chrome.placeholderInk;
  context.globalAlpha = item.alpha * (0.25 + item.intensity * 0.35);
  context.lineWidth = 2;
  context.setLineDash([2, 10]);
  context.strokeRect(offsetX, offsetY, item.area.width, item.area.height);
  context.setLineDash([]);
}
