/**
 * The exact edge of the crop solver's closed form.
 *
 * `solve-crop.ts` derives feasibility as `F.width ≤ S.width · w` and everything else
 * follows from it. That inequality is only worth having if the boundary itself is pinned:
 * a subject exactly as wide as the safe area allows must still crop, and one a single
 * composition pixel wider must fall through to a letterbox rather than to a crop that
 * quietly clips it.
 *
 * The interesting case is that both answers are *correct* answers - neither is an error -
 * so nothing fails loudly if the comparison drifts by an epsilon. The only thing that
 * notices is a face at the edge of the frame, three weeks later.
 *
 * Widths here are expressed in composition pixels and converted, because "one pixel
 * wider" is the unit an author and a reviewer actually work in.
 */

import { describe, expect, it } from 'vitest';
import { FORMAT_PRESETS, type NormRect, type Size } from '@rv/contracts';

import { EPSILON, contains, mapIntoCrop, maximalCrop } from './geometry';
import { feasibleInterval, solveShotCrop, type ShotFraming } from './solve-crop';

/** A 1:1 authoring canvas, so a 9:16 delivery crops on the horizontal axis. */
const COMPOSITION: Size = { width: 2560, height: 2560 };
const VERTICAL = FORMAT_PRESETS['shorts-9x16'];

/** One composition pixel, as a fraction of the canvas width. */
const ONE_PIXEL = 1 / COMPOSITION.width;

function framing(region: NormRect): ShotFraming {
  return {
    shotId: 'sht_0000000000000000000000000A',
    startMs: 0,
    durationMs: 3000,
    safeArea: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
    focus: [{ timeMs: 0, region }],
    priority: 'must-keep',
  };
}

/** A focus rectangle of the given width, centred on the canvas. */
function centred(width: number): NormRect {
  return { x: 0.5 - width / 2, y: 0.4, width, height: 0.2 };
}

describe('feasibleInterval at the width the inequality turns on', () => {
  const safeStart = 0.1;
  const safeExtent = 0.8;
  const cropExtent = 0.5;
  const widest = safeExtent * cropExtent;

  it('admits a focus exactly as wide as the safe area allows', () => {
    const interval = feasibleInterval(0.3, widest, safeStart, safeExtent, cropExtent);
    expect(interval).not.toBeNull();
    // Exactly one offset works: the interval collapses to a point rather than inverting.
    expect(interval?.high).toBeCloseTo(interval?.low ?? Number.NaN, 12);
    expect(interval?.high).toBeGreaterThanOrEqual(interval?.low ?? Number.NaN);
  });

  it('refuses a focus meaningfully wider than the safe area allows', () => {
    expect(feasibleInterval(0.3, widest + 1e-4, safeStart, safeExtent, cropExtent)).toBeNull();
  });

  it('absorbs a difference smaller than the solver’s epsilon rather than flapping', () => {
    // A rectangle wider by less than EPSILON is the same rectangle as far as anything
    // downstream is concerned; treating it as infeasible would make the strategy depend on
    // floating-point noise in whatever produced the region.
    const interval = feasibleInterval(0.3, widest + EPSILON / 2, safeStart, safeExtent, cropExtent);
    expect(interval).not.toBeNull();
  });

  it('the tolerance is an epsilon, not a licence', () => {
    // Ten epsilons is still an invisible width and still refused, so the tolerance cannot
    // grow into a de facto allowance.
    expect(
      feasibleInterval(0.3, widest + EPSILON * 10, safeStart, safeExtent, cropExtent),
    ).toBeNull();
  });
});

describe('one composition pixel decides crop or letterbox', () => {
  const cropWidth = maximalCrop(COMPOSITION, VERTICAL.size).width;
  /** The widest focus a 9:16 crop of this canvas can hold inside the platform safe area. */
  const widest = VERTICAL.safeArea.width * cropWidth;

  it('crops a subject exactly as wide as the safe area can hold', () => {
    const shot = framing(centred(widest));
    const solved = solveShotCrop(shot, COMPOSITION, VERTICAL.size, VERTICAL.safeArea);

    expect(solved.strategy).toBe('crop');
    expect(solved.safeAreaViolation).toBe(false);
    // And it genuinely lands inside, rather than being called a crop and clipping.
    const landed = mapIntoCrop(centred(widest), solved.sourceCrop);
    expect(contains(VERTICAL.safeArea, landed)).toBe(true);
  });

  it('still crops one pixel narrower, so the boundary is not off by one the wrong way', () => {
    const solved = solveShotCrop(
      framing(centred(widest - ONE_PIXEL)),
      COMPOSITION,
      VERTICAL.size,
      VERTICAL.safeArea,
    );
    expect(solved.strategy).toBe('crop');
    expect(solved.safeAreaViolation).toBe(false);
  });

  it('letterboxes one pixel wider instead of shipping a crop that clips', () => {
    const solved = solveShotCrop(
      framing(centred(widest + ONE_PIXEL)),
      COMPOSITION,
      VERTICAL.size,
      VERTICAL.safeArea,
    );

    expect(solved.strategy).toBe('letterbox');
    expect(solved.sourceCrop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    // A letterbox that still holds the subject is not a review item; it is the answer.
    expect(solved.safeAreaViolation).toBe(false);
    expect(solved.notes.join(' ')).toContain('letterboxed');
  });

  it('never answers with a crop that fails its own inequality', () => {
    // The property behind the three cases above, swept across the boundary: whenever the
    // solver says "crop", the focus is inside the safe area; whenever it says otherwise,
    // it is because no crop could have been.
    for (let offset = -4; offset <= 4; offset += 1) {
      const region = centred(widest + offset * ONE_PIXEL);
      const solved = solveShotCrop(framing(region), COMPOSITION, VERTICAL.size, VERTICAL.safeArea);
      if (solved.strategy !== 'crop') continue;
      expect(
        contains(VERTICAL.safeArea, mapIntoCrop(region, solved.sourceCrop)),
        `crop at offset ${String(offset)}px does not hold the focus`,
      ).toBe(true);
    }
  });
});

describe('the vertical axis behaves the same way as the horizontal one', () => {
  // A 16:9 delivery from a square canvas crops vertically, so the same inequality is
  // exercised on the other axis - where an asymmetric safe area could hide a swapped term.
  const WIDE = FORMAT_PRESETS['yt-1080p'];
  const cropHeight = maximalCrop(COMPOSITION, WIDE.size).height;
  const widest = WIDE.safeArea.height * cropHeight;
  const onePixel = 1 / COMPOSITION.height;

  function tall(height: number): NormRect {
    return { x: 0.4, y: 0.5 - height / 2, width: 0.2, height };
  }

  it('crops a subject exactly as tall as the safe area can hold', () => {
    const solved = solveShotCrop(framing(tall(widest)), COMPOSITION, WIDE.size, WIDE.safeArea);
    expect(solved.strategy).toBe('crop');
    expect(contains(WIDE.safeArea, mapIntoCrop(tall(widest), solved.sourceCrop))).toBe(true);
  });

  it('letterboxes one pixel taller', () => {
    const solved = solveShotCrop(
      framing(tall(widest + onePixel)),
      COMPOSITION,
      WIDE.size,
      WIDE.safeArea,
    );
    expect(solved.strategy).not.toBe('crop');
  });
});
