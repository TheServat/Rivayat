/**
 * The conversion every exporter shares, tested on its own.
 *
 * The two format-level specs (`lottie/scene-space.spec.ts`, `dragonbones/scene-space.spec.ts`)
 * assert that each projection *uses* this correctly. This one pins the arithmetic itself,
 * because it is now the single definition and a wrong number here is wrong in every format
 * at once - which is the trade sharing it buys and the reason it needs its own guard.
 */

import { describe, expect, it } from 'vitest';
import type { Size, Transform2D } from '@rv/contracts';

import { sceneCentreOf, toCompositionSpace, transformInCompositionSpace } from './scene-space';

const SCENE: Size = { width: 1920, height: 1080 };
const IDENTITY_CAMERA = { position: { x: 0, y: 0 }, zoom: 1, rotation: 0 };

/** The renderer's projection, written out. Not imported, so this cannot agree by borrowing. */
function projected(
  point: { readonly x: number; readonly y: number },
  camera: { position: { x: number; y: number }; zoom: number; rotation: number },
): { x: number; y: number } {
  const relative = { x: point.x - camera.position.x, y: point.y - camera.position.y };
  const radians = (-camera.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const turned = { x: relative.x * cos - relative.y * sin, y: relative.x * sin + relative.y * cos };
  return {
    x: SCENE.width / 2 + turned.x * camera.zoom,
    y: SCENE.height / 2 + turned.y * camera.zoom,
  };
}

describe('sceneCentreOf', () => {
  it('is the middle of the canvas, which is where scene (0,0) is', () => {
    expect(sceneCentreOf(SCENE)).toEqual({ x: 960, y: 540 });
    expect(sceneCentreOf({ width: 1, height: 3 })).toEqual({ x: 0.5, y: 1.5 });
  });
});

describe('toCompositionSpace without a camera', () => {
  it('moves the origin from the middle of the canvas to its top-left corner', () => {
    expect(toCompositionSpace({ x: 0, y: 0 }, SCENE)).toEqual({ x: 960, y: 540 });
  });

  it('maps the canvas corners onto the composition corners', () => {
    expect(toCompositionSpace({ x: -960, y: -540 }, SCENE)).toEqual({ x: 0, y: 0 });
    expect(toCompositionSpace({ x: 960, y: 540 }, SCENE)).toEqual({ x: 1920, y: 1080 });
  });

  it('brings the negative half of the canvas inside the output, which is the point', () => {
    const point = toCompositionSpace({ x: -400, y: -200 }, SCENE);
    expect(point).toEqual({ x: 560, y: 340 });
    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeGreaterThanOrEqual(0);
  });
});

describe('toCompositionSpace with a camera', () => {
  it('changes nothing beyond the shift when the camera is an identity', () => {
    expect(toCompositionSpace({ x: 120, y: -80 }, SCENE, IDENTITY_CAMERA)).toEqual(
      toCompositionSpace({ x: 120, y: -80 }, SCENE),
    );
  });

  it('scales a pan by the zoom, because the camera pans in the zoomed frame', () => {
    const camera = { position: { x: 300, y: 0 }, zoom: 2, rotation: 0 };
    const point = toCompositionSpace({ x: 0, y: 0 }, SCENE, camera);
    // 300 units of pan at 2x is 600 pixels of movement, not 300.
    expect(point.x).toBeCloseTo(960 - 600, 9);
    expect(point.y).toBeCloseTo(540, 9);
  });

  it('rolls about the camera rather than about the middle of the canvas', () => {
    const camera = { position: { x: 200, y: 100 }, zoom: 1.5, rotation: 30 };
    const point = { x: -160, y: 240 };
    const actual = toCompositionSpace(point, SCENE, camera);
    const expected = projected(point, camera);
    expect(actual.x).toBeCloseTo(expected.x, 9);
    expect(actual.y).toBeCloseTo(expected.y, 9);
  });

  it('agrees with the renderer projection across a sweep of cameras', () => {
    for (const zoom of [0.5, 1, 2.5]) {
      for (const rotation of [-90, -15, 0, 33, 180]) {
        for (const pan of [-500, 0, 275]) {
          const camera = { position: { x: pan, y: pan / 2 }, zoom, rotation };
          const point = { x: -321, y: 654 };
          const actual = toCompositionSpace(point, SCENE, camera);
          const expected = projected(point, camera);
          expect(actual.x).toBeCloseTo(expected.x, 9);
          expect(actual.y).toBeCloseTo(expected.y, 9);
        }
      }
    }
  });
});

describe('transformInCompositionSpace', () => {
  const transform: Transform2D = {
    position: { x: -100, y: 40 },
    rotation: 33,
    scale: { x: 1.5, y: 0.5 },
    skew: { x: 2, y: -3 },
    anchor: { x: 0.25, y: 0.75 },
    opacity: 0.6,
  };

  it('moves the position and leaves every other component alone', () => {
    const moved = transformInCompositionSpace(transform, SCENE);
    expect(moved.position).toEqual({ x: 860, y: 580 });
    expect(moved.rotation).toBe(transform.rotation);
    expect(moved.scale).toEqual(transform.scale);
    expect(moved.skew).toEqual(transform.skew);
    expect(moved.anchor).toEqual(transform.anchor);
    expect(moved.opacity).toBe(transform.opacity);
  });

  it('preserves the difference between two transforms, which is why deltas are unaffected', () => {
    // The property the DragonBones bone tree relies on: a constant offset applied to both
    // operands cancels, so only something with nothing to be relative to can see it.
    const other: Transform2D = { ...transform, position: { x: 250, y: -75 } };
    const movedA = transformInCompositionSpace(transform, SCENE);
    const movedB = transformInCompositionSpace(other, SCENE);

    expect(movedB.position.x - movedA.position.x).toBeCloseTo(
      other.position.x - transform.position.x,
      9,
    );
    expect(movedB.position.y - movedA.position.y).toBeCloseTo(
      other.position.y - transform.position.y,
      9,
    );
  });
});
