/**
 * The exact rectangle the reframer will be handed.
 *
 * `solveSafeArea` is not consumed inside this package. It is consumed by
 * `@rv/render-engine`'s crop solver, which has no dependency on this one and therefore
 * cannot test against the real thing. `packages/render-engine/src/reframe/shot-list-seam.spec.ts`
 * records these same figures as its input and asserts that they solve for all seven
 * delivery formats.
 *
 * So this file exists to make a change to the geometry *loud*. The tests beside it in
 * `pacing.spec.ts` assert the properties - centred, shrinking, inset once - and those are
 * the right tests for the function. What they cannot do is notice that the numbers moved,
 * and the numbers are what the other package is holding.
 *
 * If one of these fails: the change may be correct. Update the figure here **and** in
 * `shot-list-seam.spec.ts`, and re-run the reframer suite before assuming the crop solver
 * still copes.
 */

import { describe, expect, it } from 'vitest';
import type { DeliveryAspect, NormRect } from '@rv/contracts';

import { solveSafeArea } from './safe-area';

const ALL_ASPECTS: readonly DeliveryAspect[] = ['16:9', '9:16', '1:1', '4:5'];

/** The canvas the seam test on the other side uses. */
const SQUARE = { width: 2560, height: 2560 };

function expectRect(actual: NormRect, expected: NormRect): void {
  expect(actual.x).toBeCloseTo(expected.x, 12);
  expect(actual.y).toBeCloseTo(expected.y, 12);
  expect(actual.width).toBeCloseTo(expected.width, 12);
  expect(actual.height).toBeCloseTo(expected.height, 12);
}

describe('the safe area handed to the reframer', () => {
  it('is this rectangle for a square canvas shipping all four aspects', () => {
    // 9:16 covers 56.25 % of a square canvas's width; 16:9 covers 56.25 % of its height;
    // the 5 % title-safe inset takes 10 % off each axis of the intersection.
    expectRect(solveSafeArea(SQUARE, ALL_ASPECTS), {
      x: 0.246875,
      y: 0.246875,
      width: 0.50625,
      height: 0.50625,
    });
  });

  it('is this rectangle for a 4:3 canvas shipping all four aspects', () => {
    expectRect(solveSafeArea({ width: 2400, height: 1800 }, ALL_ASPECTS), {
      x: 0.31015625,
      y: 0.1625,
      width: 0.3796875,
      height: 0.675,
    });
  });

  it('is this rectangle for a 16:9 canvas shipping all four aspects', () => {
    // The canvas is already the widest deliverable, so only the vertical crop bites.
    expectRect(solveSafeArea({ width: 3840, height: 2160 }, ALL_ASPECTS), {
      x: 0.3576171875,
      y: 0.05,
      width: 0.284765625,
      height: 0.9,
    });
  });

  it('loses only the inset when the canvas is already the one deliverable aspect', () => {
    expectRect(solveSafeArea({ width: 3840, height: 2160 }, ['16:9']), {
      x: 0.05,
      y: 0.05,
      width: 0.9,
      height: 0.9,
    });
  });

  it('gives every aspect a rectangle a crop solver can actually satisfy', () => {
    // The precondition the crop solver relies on: the safe area fits inside the maximal
    // centred crop of every declared aspect, on both axes. A rectangle that failed this
    // would send every shot of that format to a letterbox.
    for (const canvas of [SQUARE, { width: 2400, height: 1800 }, { width: 3840, height: 2160 }]) {
      const area = solveSafeArea(canvas, ALL_ASPECTS);
      const canvasAspect = canvas.width / canvas.height;

      for (const aspect of ALL_ASPECTS) {
        const [w, h] = aspect.split(':').map(Number);
        const target = (w ?? 1) / (h ?? 1);
        const cropWidth = Math.min(1, target / canvasAspect);
        const cropHeight = Math.min(1, canvasAspect / target);
        expect(area.width, `${aspect} on ${String(canvas.width)}`).toBeLessThanOrEqual(cropWidth);
        expect(area.height, `${aspect} on ${String(canvas.height)}`).toBeLessThanOrEqual(
          cropHeight,
        );
      }
    }
  });
});
