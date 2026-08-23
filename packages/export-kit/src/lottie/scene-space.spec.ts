/**
 * The seam between the renderer's scene space and the file's composition space.
 *
 * Nothing in `AnimationIR` says where the origin of `sceneSpace` is. `@rv/render-engine`
 * fixes it - `frames/draw-list.ts`: "the origin is the centre of the canvas, so the canvas
 * spans `[-w/2, +w/2] x [-h/2, +h/2]`" - and `frames/matrix.ts#cameraMatrix` implements it,
 * as does `reframe/focus-track.ts#worldToNorm`. A Lottie composition is top-left origin.
 *
 * Two engines reading one undeclared convention differently is invisible in both of their
 * own test suites and obvious the moment a file is opened, so the conversion is pinned
 * here with numbers derived from the convention rather than from the exporter. Every
 * expectation in this file is computed by a formula written out in the test, so gutting
 * `toCompositionSpace` cannot make any of them pass.
 */

import { describe, expect, it } from 'vitest';
import { unwrap } from '@rv/shared-kernel';
import { AnimationIR as AnimationIRSchema, type AnimationIR } from '@rv/contracts';
import { evaluate } from '@rv/anim-engine';

import { LottieExporter } from './lottie-exporter';
import { sampleLottieProperty } from './sample';
import type { LottieDocument } from './types';
import { readJson } from '../__fixtures__/read';
import { testIds } from '../__fixtures__/ids';

const SCENE = { width: 1920, height: 1080 };
const CENTRE = { x: SCENE.width / 2, y: SCENE.height / 2 };
const exporter = new LottieExporter();

interface ProbeOptions {
  readonly position?: { readonly x: number; readonly y: number };
  readonly camera?: {
    readonly position: { readonly x: number; readonly y: number };
    readonly zoom: number;
    readonly rotation: number;
  };
  readonly track?: boolean;
}

/** One marker node at a chosen scene position, optionally under a camera. */
function probeIr(options: ProbeOptions = {}): AnimationIR {
  const ids = testIds();
  const nodeId = ids.node();
  const position = options.position ?? { x: 0, y: 0 };

  return AnimationIRSchema.parse({
    irVersion: 1,
    id: ids.animation(),
    name: 'Origin Probe',
    fps: 30,
    durationMs: 1000,
    sceneSpace: SCENE,
    seed: 1,
    nodes: [
      {
        id: nodeId,
        name: 'marker',
        parentId: null,
        kind: 'shape',
        shape: 'rect',
        size: { width: 10, height: 10 },
        fill: '#ffffff',
        transform: { position },
      },
    ],
    ...(options.track === true
      ? {
          tracks: [
            {
              id: ids.track(),
              nodeId,
              channel: 'position.x',
              keyframes: [
                {
                  timeMs: 0,
                  value: 0,
                  easing: { kind: 'cubic-bezier', x1: 0.4, y1: 0, x2: 0.6, y2: 1 },
                },
                { timeMs: 1000, value: 200 },
              ],
            },
          ],
        }
      : {}),
    ...(options.camera === undefined
      ? {}
      : {
          camera: {
            keyframes: [
              {
                timeMs: 0,
                position: options.camera.position,
                zoom: options.camera.zoom,
                rotation: options.camera.rotation,
              },
            ],
          },
        }),
  });
}

async function positionAt(
  ir: AnimationIR,
  frame: number,
  options: Parameters<LottieExporter['export']>[1] = {},
): Promise<readonly number[]> {
  const output = unwrap(await exporter.export({ ir }, options));
  const doc = readJson<LottieDocument>(output, output.artifacts[0]?.path ?? '');
  const layer = doc.layers[0];
  expect(layer).toBeDefined();
  return sampleLottieProperty(layer!.ks.p, frame);
}

/** `rotateVec` written out, so the expectation does not borrow the code under test. */
function rotate(
  point: { readonly x: number; readonly y: number },
  degrees: number,
): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

describe('the scene-space origin the renderer fixed', () => {
  it('puts a node at scene (0,0) in the middle of the composition, not in its corner', async () => {
    // The whole defect in one assertion: the renderer draws this node dead centre, and an
    // exporter that treats scene coordinates as composition coordinates writes it at the
    // top-left pixel with everything to its left and above it outside the file.
    expect(await positionAt(probeIr(), 0)).toEqual([CENTRE.x, CENTRE.y]);
  });

  it('maps the corners of the authoring canvas onto the corners of the composition', async () => {
    const topLeft = probeIr({ position: { x: -SCENE.width / 2, y: -SCENE.height / 2 } });
    const bottomRight = probeIr({ position: { x: SCENE.width / 2, y: SCENE.height / 2 } });

    expect(await positionAt(topLeft, 0)).toEqual([0, 0]);
    expect(await positionAt(bottomRight, 0)).toEqual([SCENE.width, SCENE.height]);
  });

  it('keeps a node composed left of centre inside the composition instead of off it', async () => {
    // Negative scene coordinates are half the canvas, and they are legal. A file whose
    // layer sits at a negative x is a file whose left half is not there.
    const [x, y] = await positionAt(probeIr({ position: { x: -400, y: -200 } }), 0);
    expect(x).toBe(CENTRE.x - 400);
    expect(y).toBe(CENTRE.y - 200);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
  });

  it('applies the same origin on the sparse path as on the baked one', async () => {
    // A sparsely written property takes the authored keyframe values straight through, so
    // it is the one place the conversion can be forgotten without any sampling to hide it.
    const ir = probeIr({ position: { x: 100, y: 50 }, track: true });
    const output = unwrap(await exporter.export({ ir }, {}));
    const doc = readJson<LottieDocument>(output, output.artifacts[0]?.path ?? '');
    const layer = doc.layers[0];
    expect(layer?.ks.p.a).toBe(1);
    expect(output.stats.bakedKeyframeCount).toBe(0);

    const world = evaluate(ir, 0).nodes[0]?.worldTransform.position;
    expect(world).toEqual({ x: 100, y: 50 });
    expect(sampleLottieProperty(layer!.ks.p, 0)).toEqual([CENTRE.x + 100, CENTRE.y + 50]);
  });

  it('still writes composition coordinates when the camera is deliberately not folded in', async () => {
    const ir = probeIr({ camera: { position: { x: 300, y: 0 }, zoom: 2, rotation: 0 } });
    expect(await positionAt(ir, 0, { lottie: { applyCamera: false } })).toEqual([
      CENTRE.x,
      CENTRE.y,
    ]);
  });
});

describe('the camera, folded the way the renderer projects it', () => {
  /**
   * `cameraMatrix` in `@rv/render-engine`, written out.
   *
   * `screen = outputCentre + fit·zoom·R(-rotation)·(scenePoint - cameraPosition)`, with
   * `fit = 1` because the composition is the scene space. Anything the exporter does that
   * is not this is a file that disagrees with its own preview.
   */
  function projected(
    point: { readonly x: number; readonly y: number },
    camera: { position: { x: number; y: number }; zoom: number; rotation: number },
  ): { x: number; y: number } {
    const relative = { x: point.x - camera.position.x, y: point.y - camera.position.y };
    const turned = rotate(relative, -camera.rotation);
    return { x: CENTRE.x + turned.x * camera.zoom, y: CENTRE.y + turned.y * camera.zoom };
  }

  it('leaves everything where it was under an identity camera', async () => {
    const ir = probeIr({
      position: { x: 120, y: -80 },
      camera: { position: { x: 0, y: 0 }, zoom: 1, rotation: 0 },
    });
    expect(await positionAt(ir, 0)).toEqual([CENTRE.x + 120, CENTRE.y - 80]);
  });

  it('scales a pan by the zoom, because the camera pans in the zoomed frame', async () => {
    // The regression: panning 300 units at 2x moves content 600 pixels, not 300. A fold
    // that subtracted the raw pan after zooming agreed with the renderer only at zoom 1.
    const camera = { position: { x: 300, y: 0 }, zoom: 2, rotation: 0 };
    const ir = probeIr({ position: { x: 0, y: 0 }, camera });

    const [x, y] = await positionAt(ir, 0);
    const expected = projected({ x: 0, y: 0 }, camera);
    expect(x).toBeCloseTo(expected.x, 6);
    expect(y).toBeCloseTo(expected.y, 6);
    // Stated absolutely as well, so the test still says something if `projected` is wrong.
    expect(x).toBeCloseTo(CENTRE.x - 600, 6);
  });

  it('rolls about the camera rather than about the middle of the canvas', async () => {
    const camera = { position: { x: 200, y: 100 }, zoom: 1.5, rotation: 30 };
    const point = { x: -160, y: 240 };
    const ir = probeIr({ position: point, camera });

    const [x, y] = await positionAt(ir, 0);
    const expected = projected(point, camera);
    expect(x).toBeCloseTo(expected.x, 6);
    expect(y).toBeCloseTo(expected.y, 6);
  });

  it('agrees with the projection at every frame of a moving camera', async () => {
    const ids = testIds();
    const nodeId = ids.node();
    const ir = AnimationIRSchema.parse({
      irVersion: 1,
      id: ids.animation(),
      name: 'Camera Sweep',
      fps: 10,
      durationMs: 1000,
      sceneSpace: SCENE,
      seed: 3,
      nodes: [
        {
          id: nodeId,
          name: 'marker',
          parentId: null,
          kind: 'shape',
          shape: 'rect',
          size: { width: 10, height: 10 },
          fill: '#ffffff',
          transform: { position: { x: -300, y: 150 } },
        },
      ],
      camera: {
        keyframes: [
          { timeMs: 0, position: { x: -200, y: -50 }, zoom: 0.8, rotation: -15 },
          { timeMs: 1000, position: { x: 400, y: 120 }, zoom: 1.6, rotation: 25 },
        ],
      },
    });

    const output = unwrap(await exporter.export({ ir }, {}));
    const doc = readJson<LottieDocument>(output, output.artifacts[0]?.path ?? '');
    const layer = doc.layers[0];

    for (let frame = 0; frame <= 10; frame += 1) {
      const snapshot = evaluate(ir, (frame * 1000) / ir.fps);
      const world = snapshot.nodes[0]?.worldTransform.position;
      expect(world).toBeDefined();
      const expected = projected(world!, snapshot.camera);
      const [x, y] = sampleLottieProperty(layer!.ks.p, frame);
      expect(Math.abs((x ?? 0) - expected.x), `frame ${String(frame)} x`).toBeLessThan(1e-4);
      expect(Math.abs((y ?? 0) - expected.y), `frame ${String(frame)} y`).toBeLessThan(1e-4);
    }
  });
});
