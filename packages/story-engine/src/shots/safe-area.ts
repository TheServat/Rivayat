/**
 * The region of the canvas that survives every crop the series ships.
 *
 * `Shot.safeArea` is "the region of the scene space no deliverable crop may cut into", and
 * for a composition authored once and reframed to four aspects that is not a style choice
 * - it is geometry. Given a canvas aspect and the target aspects, the largest centred
 * rectangle inside *every* centred maximal crop is determined, and computing it beats
 * asking a model for four numbers it has no way to derive.
 *
 * The title-safe inset on top is a convention rather than geometry, which is why it is a
 * parameter with a stated default instead of a constant buried in the maths.
 */

import type { DeliveryAspect, NormRect, Size } from '@rv/contracts';

/** Broadcast-style margin inside the geometric intersection. 5 % on each edge. */
export const DEFAULT_TITLE_SAFE_INSET = 0.05;

/**
 * `'16:9'` as a number.
 *
 * The four members of `DeliveryAspect` are a closed set of `w:h` strings, so this parses
 * rather than looking up a table - a table would be a fifth place to update when a fifth
 * aspect is added, and the parse cannot disagree with the label.
 */
export function aspectRatioOf(aspect: DeliveryAspect): number {
  const [width, height] = aspect.split(':');
  return Number(width) / Number(height);
}

/**
 * The fraction of the canvas a centred crop of `aspect` covers, per axis.
 *
 * A target wider than the canvas keeps the full width and loses height; a narrower one
 * keeps the full height and loses width. Both are `min(1, …)` because a crop can never
 * exceed the canvas it is taken from.
 */
export function cropCoverage(
  canvasAspect: number,
  aspect: DeliveryAspect,
): { readonly width: number; readonly height: number } {
  const target = aspectRatioOf(aspect);
  return {
    width: Math.min(1, target / canvasAspect),
    height: Math.min(1, canvasAspect / target),
  };
}

/**
 * The centred rectangle inside every deliverable crop, minus the title-safe inset.
 *
 * Returned in normalised canvas coordinates, which is what `Shot.safeArea` wants, so it
 * survives a change of canvas resolution.
 */
export function solveSafeArea(
  canvas: Size,
  aspects: readonly DeliveryAspect[],
  inset: number = DEFAULT_TITLE_SAFE_INSET,
): NormRect {
  const canvasAspect = canvas.width / canvas.height;

  let width = 1;
  let height = 1;
  for (const aspect of aspects) {
    const coverage = cropCoverage(canvasAspect, aspect);
    width = Math.min(width, coverage.width);
    height = Math.min(height, coverage.height);
  }

  // The inset is applied to the *intersection*, not to the canvas: insetting the canvas
  // first and then intersecting would double-count the margin on whichever axis is already
  // the tightest.
  const clamped = Math.min(Math.max(inset, 0), 0.45);
  const safeWidth = Math.max(0.01, width * (1 - clamped * 2));
  const safeHeight = Math.max(0.01, height * (1 - clamped * 2));

  return {
    x: (1 - safeWidth) / 2,
    y: (1 - safeHeight) / 2,
    width: safeWidth,
    height: safeHeight,
  };
}
