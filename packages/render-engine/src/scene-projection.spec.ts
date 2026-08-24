/**
 * The projection, pinned on its own.
 *
 * `focus-track.spec.ts` asserts that the reframer *uses* this correctly. This file pins
 * the arithmetic, because the module is headed for `@rv/anim-engine` and a shared
 * definition wrong by a constant is wrong everywhere at once - which is the whole reason
 * it is being shared.
 *
 * Every expectation is written out longhand or derived from `cameraMatrix`, never from
 * the function under test.
 */

import { describe, expect, it } from 'vitest';
import type { Size, Vec2 } from '@rv/contracts';

import { applyPoint, cameraMatrix } from './frames/matrix';
import { IDENTITY_CAMERA, projectToNorm, type ProjectedCamera } from './scene-projection';

const SCENE: Size = { width: 400, height: 300 };

/** The renderer projection, normalised. The thing this module has to agree with. */
function viaMatrix(position: Vec2, camera: ProjectedCamera, scene: Size): Vec2 {
  const pixels = applyPoint(cameraMatrix(camera, scene, scene), position);
  return { x: pixels.x / scene.width, y: pixels.y / scene.height };
}

describe('an identity camera', () => {
  it('puts the scene origin at the middle of the composition', () => {
    expect(projectToNorm({ x: 0, y: 0 }, IDENTITY_CAMERA, SCENE)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('maps the canvas corners onto the composition corners', () => {
    expect(projectToNorm({ x: -200, y: -150 }, IDENTITY_CAMERA, SCENE)).toEqual({ x: 0, y: 0 });
    expect(projectToNorm({ x: 200, y: 150 }, IDENTITY_CAMERA, SCENE)).toEqual({ x: 1, y: 1 });
  });

  it('is the plain origin conversion, so a shot with no camera is unaffected', () => {
    for (const point of [
      { x: 0, y: 0 },
      { x: 137, y: -42 },
      { x: -199, y: 149 },
    ]) {
      const plain = { x: point.x / SCENE.width + 0.5, y: point.y / SCENE.height + 0.5 };
      expect(projectToNorm(point, IDENTITY_CAMERA, SCENE)).toEqual(plain);
    }
  });
});

describe('the camera', () => {
  it('scales a pan by the zoom, because the camera pans in the zoomed frame', () => {
    const camera: ProjectedCamera = { position: { x: 100, y: 0 }, zoom: 2, rotation: 0 };
    // 100 units of pan at 2x moves content 200 px, which on a 400 px canvas is half of it.
    expect(projectToNorm({ x: 0, y: 0 }, camera, SCENE).x).toBeCloseTo(0.5 - 0.5, 12);
  });

  it('rolls about the camera rather than about the middle of the canvas', () => {
    const camera: ProjectedCamera = { position: { x: 50, y: 25 }, zoom: 1.25, rotation: 40 };
    const point = { x: -120, y: 90 };

    // Longhand: rotate the camera-relative vector by -rotation, scale, then re-centre.
    const relative = { x: point.x - camera.position.x, y: point.y - camera.position.y };
    const radians = (-camera.rotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const rotated = {
      x: relative.x * cos - relative.y * sin,
      y: relative.x * sin + relative.y * cos,
    };
    const expected = {
      x: 0.5 + (rotated.x * camera.zoom) / SCENE.width,
      y: 0.5 + (rotated.y * camera.zoom) / SCENE.height,
    };

    const actual = projectToNorm(point, camera, SCENE);
    expect(actual.x).toBeCloseTo(expected.x, 12);
    expect(actual.y).toBeCloseTo(expected.y, 12);
  });

  it('reports a subject that has left the frame rather than clamping it to the edge', () => {
    // A clamped reading makes an off-screen subject look like one against the border, and
    // the solver would then report a crop it could satisfy instead of a shot to look at.
    const camera: ProjectedCamera = { position: { x: 900, y: 0 }, zoom: 1, rotation: 0 };
    expect(projectToNorm({ x: 0, y: 0 }, camera, SCENE).x).toBeLessThan(0);
  });
});

describe('the extraction stays a move rather than a rewrite', () => {
  it('imports nothing from this package, so it can be lifted into @rv/anim-engine as-is', async () => {
    // The module is destined for `@rv/anim-engine`, beside the bezier solver and for the
    // same reason. A single convenience import from `./frames` or `./reframe` would turn
    // that move into a rewrite, and it is the kind of edit that looks harmless in review.
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    // Resolved from this file, never from `process.cwd()`: a relative path here passes
    // under `cd packages/render-engine && vitest run` and fails under the root runner.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, 'scene-projection.ts'), 'utf8');

    const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gmu)].map(
      (match) => match[1] ?? '',
    );

    // Non-vacuity first: a regex that matched nothing would pass this test silently.
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers).toContain('@rv/contracts');

    const local = specifiers.filter((specifier) => specifier.startsWith('.'));
    expect(local, `local imports would block the move: ${local.join(', ')}`).toEqual([]);
  });
});

describe('agreement with the renderer', () => {
  it('matches cameraMatrix across a sweep of cameras and points', () => {
    // The property the reframer depends on, swept rather than sampled: if these two ever
    // disagree, the crop is solved against a place the master does not put the subject.
    for (const zoom of [0.4, 1, 1.4, 3]) {
      for (const rotation of [-180, -37, 0, 12, 90]) {
        for (const pan of [-250, 0, 175]) {
          const camera: ProjectedCamera = { position: { x: pan, y: -pan / 3 }, zoom, rotation };
          for (const point of [
            { x: 0, y: 0 },
            { x: 199, y: -149 },
            { x: -87, y: 61 },
          ]) {
            const expected = viaMatrix(point, camera, SCENE);
            const actual = projectToNorm(point, camera, SCENE);
            expect(actual.x).toBeCloseTo(expected.x, 10);
            expect(actual.y).toBeCloseTo(expected.y, 10);
          }
        }
      }
    }
  });

  it('is independent of the size the master is rendered at', () => {
    // Why the signature takes no output size: the crop is in composition fractions, and a
    // master that presents the composition undistorted normalises the fit away.
    const camera: ProjectedCamera = { position: { x: 60, y: -20 }, zoom: 1.3, rotation: 25 };
    const point = { x: 90, y: 110 };
    const reference = projectToNorm(point, camera, SCENE);

    for (const factor of [0.5, 2, 4.5]) {
      const output = { width: SCENE.width * factor, height: SCENE.height * factor };
      const pixels = applyPoint(cameraMatrix(camera, SCENE, output), point);
      expect(pixels.x / output.width).toBeCloseTo(reference.x, 10);
      expect(pixels.y / output.height).toBeCloseTo(reference.y, 10);
    }
  });
});
