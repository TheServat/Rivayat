/**
 * The numbers that decide whether a cutout is usable.
 *
 * `Part.alphaCoverage` exists in the contracts as a **matting-quality signal**, not as
 * a statistic: "a wing that covers 2 % of its box is almost certainly a matting
 * failure, and the QA gate rejects it before it reaches a rig". So this file computes
 * it, and computes the second thing the gate needs, which coverage alone cannot see -
 * a cutout can have perfect coverage and still be ringed with a halo.
 */

import type { RgbaImage } from '../ports/raster-port';
import { at32, px } from './pixels';

/** Alpha at or below this counts as background everywhere in this package. */
export const OPAQUE_FLOOR = 0;

/**
 * Fraction of the bitmap that is not fully transparent.
 *
 * Measured over the whole buffer the caller passes, so a caller that wants "of the
 * bounding box" crops first. That is deliberate: the two readings differ by an order of
 * magnitude for a thin diagonal part, and silently choosing one of them inside a helper
 * is how a threshold ends up meaning something different per call site.
 */
export function alphaCoverage(image: RgbaImage): number {
  const pixels = image.width * image.height;
  if (pixels === 0) return 0;

  let covered = 0;
  for (let i = 0; i < pixels; i += 1) {
    if (px(image.data, i * 4 + 3) > OPAQUE_FLOOR) covered += 1;
  }
  return covered / pixels;
}

/**
 * How clean the cutout's edge is, as a 0..1 score where 1 is perfect.
 *
 * RV-123 states the metric precisely: the fraction of partially transparent pixels
 * that sit **outside** a `bandPx` edge band. Antialiasing along the silhouette is
 * correct and expected, so it is excluded; semi-transparency in the interior or out in
 * the field is a halo, a soft matte or a failed key, and that is what this counts.
 *
 * Returned as a score rather than a defect rate so it composes with the rest of
 * `QualityScores`, where every field is "higher is better".
 */
export function alphaCleanliness(image: RgbaImage, bandPx = 2): number {
  const distance = distanceToEdge(image);
  let strays = 0;
  let considered = 0;

  for (let i = 0; i < image.width * image.height; i += 1) {
    const alpha = px(image.data, i * 4 + 3);
    if (alpha === 0 || alpha === 255) continue;
    considered += 1;
    if (at32(distance, i) > bandPx) strays += 1;
  }

  if (considered === 0) return 1;
  return 1 - strays / considered;
}

/**
 * Chebyshev distance from each pixel to the nearest alpha transition, capped.
 *
 * A two-pass chamfer rather than an exact transform: the only question asked of it is
 * "further than `bandPx`", and the cap keeps it linear in the pixel count regardless of
 * how large the transparent field is.
 */
function distanceToEdge(image: RgbaImage, cap = 8): Int32Array {
  const { width, height, data } = image;
  const distance = new Int32Array(width * height).fill(cap);

  const opaque = (index: number): boolean => px(data, index * 4 + 3) > 127;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const self = opaque(index);
      const boundary =
        (x > 0 && opaque(index - 1) !== self) ||
        (x + 1 < width && opaque(index + 1) !== self) ||
        (y > 0 && opaque(index - width) !== self) ||
        (y + 1 < height && opaque(index + width) !== self);
      if (boundary) distance[index] = 0;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let best = at32(distance, index);
      if (x > 0) best = Math.min(best, at32(distance, index - 1) + 1);
      if (y > 0) best = Math.min(best, at32(distance, index - width) + 1);
      distance[index] = best;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      let best = at32(distance, index);
      if (x + 1 < width) best = Math.min(best, at32(distance, index + 1) + 1);
      if (y + 1 < height) best = Math.min(best, at32(distance, index + width) + 1);
      distance[index] = best;
    }
  }

  return distance;
}

/** Whether the four corners are fully transparent - RV-123's cheapest sanity check. */
export function cornersAreTransparent(image: RgbaImage): boolean {
  const { width, height, data } = image;
  const corners = [0, width - 1, (height - 1) * width, height * width - 1];
  return corners.every((index) => px(data, index * 4 + 3) === 0);
}
