/**
 * Segmentation by connected components. **The grid is advisory.**
 *
 * The parts-sheet prompt asks for components "arranged loosely in N columns", and it
 * is worth asking - it is what stops the model drawing one finished, overlapping
 * composition. But nothing downstream may *depend* on the cells landing where they
 * were asked for. A diffusion model is not a layout engine: it will put the wing 30 px
 * off the grid, make one cell twice the size of its neighbour, or fit five components
 * into a four-cell layout, and arithmetic slicing turns every one of those into two
 * half-parts.
 *
 * So the canvas is segmented by alpha connectivity and the grid is never divided.
 * A component is whatever is actually connected, wherever it actually is.
 */

import { at } from '@rv/shared-kernel';
import type { Rect, Vec2 } from '@rv/contracts';

import type { RgbaImage } from '../ports/raster-port';
import { at32, px } from '../raster/pixels';

export interface Component {
  /** Label id, 1-based, assigned in raster order so the list is deterministic. */
  readonly id: number;
  readonly bounds: Rect;
  readonly pixelCount: number;
  /** Alpha-weighted centre of mass, in canvas pixels. */
  readonly centroid: Vec2;
  /** `pixelCount` over the area of `bounds`. Low means a thin or hollow shape. */
  readonly fill: number;
}

export interface ComponentField {
  readonly components: readonly Component[];
  /** Per-pixel label, 0 for background. Lets a crop exclude an overlapping neighbour. */
  readonly labels: Int32Array;
  /** Components dropped for being smaller than `minPixels`. Reported, not hidden. */
  readonly discarded: number;
}

export interface ComponentOptions {
  /** Alpha above which a pixel belongs to a component. */
  readonly alphaThreshold?: number;
  /**
   * Smallest component worth keeping, as a fraction of the canvas.
   *
   * Speckle from a soft matte is not a part. The default is deliberately small - a
   * hand on a 1024² sheet is around 0.2 %, and losing it is far worse than keeping a
   * few crumbs that the assignment step will report as unmatched.
   */
  readonly minAreaFraction?: number;
  /** 8 lets a diagonal hairline hold together; 4 splits it. */
  readonly connectivity?: 4 | 8;
}

const DEFAULT_ALPHA_THRESHOLD = 8;
const DEFAULT_MIN_AREA_FRACTION = 0.0002;

/**
 * One raster-order pass with an explicit stack.
 *
 * Iterative rather than recursive because a 1024² canvas of one connected shape is a
 * million-deep recursion, and the stack overflow arrives only for the assets that
 * matted best.
 */
export function findComponents(image: RgbaImage, options: ComponentOptions = {}): ComponentField {
  const { width, height, data } = image;
  const threshold = options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
  const connectivity = options.connectivity ?? 8;
  const minPixels = Math.max(
    1,
    Math.floor((options.minAreaFraction ?? DEFAULT_MIN_AREA_FRACTION) * width * height),
  );

  const labels = new Int32Array(width * height);
  const raw: Component[] = [];
  const stack: number[] = [];
  let nextLabel = 0;

  for (let seed = 0; seed < width * height; seed += 1) {
    if (labels[seed] !== 0) continue;
    if (px(data, seed * 4 + 3) <= threshold) continue;

    nextLabel += 1;
    labels[seed] = nextLabel;
    stack.length = 0;
    stack.push(seed);

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let sumWeight = 0;

    // Breadth-first over a growing array with a head cursor, rather than `pop()`:
    // the cursor is always in range, so the read needs no undefined case.
    for (let head = 0; head < stack.length; head += 1) {
      const index = at(stack, head);
      const x = index % width;
      const y = (index - x) / width;
      const alpha = px(data, index * 4 + 3);

      count += 1;
      sumX += x * alpha;
      sumY += y * alpha;
      sumWeight += alpha;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          if (connectivity === 4 && dx !== 0 && dy !== 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbour = ny * width + nx;
          if (labels[neighbour] !== 0) continue;
          if (px(data, neighbour * 4 + 3) <= threshold) continue;
          labels[neighbour] = nextLabel;
          stack.push(neighbour);
        }
      }
    }

    const boundsWidth = maxX - minX + 1;
    const boundsHeight = maxY - minY + 1;
    raw.push({
      id: nextLabel,
      bounds: { x: minX, y: minY, width: boundsWidth, height: boundsHeight },
      pixelCount: count,
      centroid: { x: sumX / sumWeight, y: sumY / sumWeight },
      fill: count / (boundsWidth * boundsHeight),
    });
  }

  const kept = raw.filter((component) => component.pixelCount >= minPixels);
  const keptIds = new Set(kept.map((component) => component.id));
  if (kept.length !== raw.length) {
    for (let i = 0; i < labels.length; i += 1) {
      if (!keptIds.has(at32(labels, i))) labels[i] = 0;
    }
  }

  return { components: kept, labels, discarded: raw.length - kept.length };
}

/**
 * Cuts one component out, masking every other label to transparent.
 *
 * The masking is the point. Two components whose bounding boxes overlap - a wing tip
 * crossing a tail, which is common on a loosely gridded sheet - would otherwise each
 * carry a slice of the other, and the rig would move a wing with a piece of tail
 * welded to it.
 */
export function extractComponent(
  image: RgbaImage,
  field: ComponentField,
  component: Component,
): RgbaImage {
  const width = Math.round(component.bounds.width);
  const height = Math.round(component.bounds.height);
  const x0 = Math.round(component.bounds.x);
  const y0 = Math.round(component.bounds.y);
  const out = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y0 + y) * image.width + (x0 + x);
      if (field.labels[source] !== component.id) continue;
      out.set(image.data.subarray(source * 4, source * 4 + 4), (y * width + x) * 4);
    }
  }

  return { width, height, data: out };
}
