import { transformPoint } from '@rv/anim-engine';
import { describe, expect, it } from 'vitest';
import type { Transform2D } from '@rv/contracts';

import {
  IDENTITY,
  applyPoint,
  cameraMatrix,
  fromTransform,
  multiply,
  rotation,
  scaling,
  translation,
} from './matrix';

function transform(overrides: Partial<Transform2D> = {}): Transform2D {
  return {
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: { x: 1, y: 1 },
    skew: { x: 0, y: 0 },
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
    ...overrides,
  };
}

describe('matrix primitives', () => {
  it('composes right-to-left', () => {
    // translate ∘ scale: scale first, then move. The other order moves then scales the
    // offset too, which is the classic transform bug.
    const composed = multiply(translation(10, 0), scaling(2, 2));
    expect(applyPoint(composed, { x: 3, y: 0 })).toEqual({ x: 16, y: 0 });
  });

  it('leaves points alone under the identity', () => {
    expect(applyPoint(IDENTITY, { x: 5, y: -2 })).toEqual({ x: 5, y: -2 });
  });

  it('rotates counter-clockwise in the canvas sense', () => {
    const turned = applyPoint(rotation(90), { x: 1, y: 0 });
    expect(turned.x).toBeCloseTo(0, 10);
    expect(turned.y).toBeCloseTo(1, 10);
  });
});

describe('fromTransform', () => {
  // The load-bearing property: the rasteriser must place a point exactly where the
  // evaluator's own `transformPoint` says it is, or the renderer and every behaviour
  // that reasons about world positions (look-at, parallax) disagree silently.
  const cases: readonly Transform2D[] = [
    transform(),
    transform({ position: { x: 30, y: -12 } }),
    transform({ rotation: 37 }),
    transform({ scale: { x: 2, y: 0.5 } }),
    transform({ skew: { x: 12, y: -8 } }),
    transform({
      position: { x: 5, y: 9 },
      rotation: -23,
      scale: { x: 1.3, y: 0.7 },
      skew: { x: 4, y: 6 },
    }),
  ];

  it.each(cases.map((value, index) => [index, value] as const))(
    'agrees with the evaluator for case %i',
    (_index, value) => {
      for (const point of [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: -4, y: 17 },
      ]) {
        const viaMatrix = applyPoint(fromTransform(value), point);
        const viaEvaluator = transformPoint(value, point);
        expect(viaMatrix.x).toBeCloseTo(viaEvaluator.x, 9);
        expect(viaMatrix.y).toBeCloseTo(viaEvaluator.y, 9);
      }
    },
  );
});

describe('cameraMatrix', () => {
  const scene = { width: 400, height: 300 };

  it('puts the camera position at the centre of the output', () => {
    const matrix = cameraMatrix({ position: { x: 40, y: -20 }, zoom: 1, rotation: 0 }, scene, {
      width: 800,
      height: 600,
    });
    expect(applyPoint(matrix, { x: 40, y: -20 })).toEqual({ x: 400, y: 300 });
  });

  it('contains rather than crops when the aspects differ', () => {
    // 400x300 into 1080x1920: the fit is limited by width, so the whole canvas is
    // visible and the extra height is empty. Cropping is the reframer's job, not the
    // master renderer's.
    const matrix = cameraMatrix({ position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }, scene, {
      width: 1080,
      height: 1920,
    });
    const left = applyPoint(matrix, { x: -200, y: 0 });
    const right = applyPoint(matrix, { x: 200, y: 0 });
    expect(left.x).toBeCloseTo(0, 6);
    expect(right.x).toBeCloseTo(1080, 6);
  });

  it('scales by zoom about the camera', () => {
    const matrix = cameraMatrix({ position: { x: 0, y: 0 }, zoom: 2, rotation: 0 }, scene, {
      width: 400,
      height: 300,
    });
    expect(applyPoint(matrix, { x: 50, y: 0 }).x).toBeCloseTo(300, 6);
  });

  it('turns the world the opposite way from the camera', () => {
    const matrix = cameraMatrix({ position: { x: 0, y: 0 }, zoom: 1, rotation: 90 }, scene, {
      width: 400,
      height: 400,
    });
    const point = applyPoint(matrix, { x: 10, y: 0 });
    expect(point.x).toBeCloseTo(200, 6);
    expect(point.y).toBeCloseTo(200 - 10, 6);
  });
});
