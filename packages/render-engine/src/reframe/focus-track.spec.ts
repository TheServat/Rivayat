import { describe, expect, it } from 'vitest';
import { evaluate } from '@rv/anim-engine';

import { SUBJECT_ID, cameraIr, pure2dIr, testId } from '../__fixtures__/ir';
import { applyPoint, cameraMatrix } from '../frames/matrix';
import { centreRegionOn, sampleFocusTrack, staticFocusTrack, worldToNorm } from './focus-track';
import { rectCentre } from './geometry';
import type { FocusSample } from './solve-crop';

const REGION = { x: 0.45, y: 0.4, width: 0.1, height: 0.2 };

describe('sampleFocusTrack', () => {
  it('follows a node that crosses the scene', () => {
    // The whole point of naming an instance rather than a region: a subject that walks
    // across the shot stays framed instead of walking out of a crop solved at frame 0.
    const ir = pure2dIr();
    const samples = sampleFocusTrack(ir, SUBJECT_ID, REGION, { startMs: 0, durationMs: 4000 });
    const first = samples[0];
    const last = samples[samples.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect((last?.region.x ?? 0) - (first?.region.x ?? 0)).toBeGreaterThan(0.2);
  });

  it('keeps the authored region size rather than breathing with the subject', () => {
    const samples = sampleFocusTrack(pure2dIr(), SUBJECT_ID, REGION, {
      startMs: 0,
      durationMs: 4000,
    });
    for (const sample of samples) {
      expect(sample.region.width).toBe(REGION.width);
      expect(sample.region.height).toBe(REGION.height);
    }
  });

  it('times samples from the start of the shot, not of the composition', () => {
    const samples = sampleFocusTrack(
      pure2dIr(),
      SUBJECT_ID,
      REGION,
      {
        startMs: 1000,
        durationMs: 2000,
        // 3 samples: 0, 1000, 2000 into the shot.
      },
      { samples: 3 },
    );
    expect(samples.map((sample) => sample.timeMs)).toEqual([0, 1000, 2000]);
  });

  it('takes at least two samples however few are asked for', () => {
    expect(
      sampleFocusTrack(
        pure2dIr(),
        SUBJECT_ID,
        REGION,
        { startMs: 0, durationMs: 100 },
        { samples: 1 },
      ),
    ).toHaveLength(2);
  });

  it('falls back to the authored region for a node the snapshot does not contain', () => {
    // `FocusTarget.region` is documented as "the tie-breaker for the frames the
    // instance does not exist in".
    const samples = sampleFocusTrack(
      pure2dIr(),
      testId('nod', 'GHOST'),
      REGION,
      { startMs: 0, durationMs: 1000 },
      { samples: 2 },
    );
    expect(samples.every((sample) => sample.region.x === REGION.x)).toBe(true);
  });

  /**
   * The test that was missing, and the reason the bug shipped.
   *
   * What stood here asserted `sampleFocusTrack(...)` equalled `sampleFocusTrack(...)` -
   * true of any pure function, including one gutted to return a constant, and true of the
   * broken version. CLAUDE.md section 3 names this exactly: a test that would still pass
   * after the function is gutted is not a test. Replaced rather than added beside, because
   * leaving it would keep a green tick next to the thing it failed to check.
   *
   * The real property: the crop is applied by FFmpeg to the rendered **master**, which
   * carries the camera. So the sampled focus centre has to be where the subject actually
   * is in that image - which is what `cameraMatrix` computes, recomputed here from output
   * pixels rather than borrowed from the code under test.
   */
  it('locates the subject where the master actually shows it, not where the canvas has it', () => {
    const ir = cameraIr();
    const scene = ir.sceneSpace;
    const samples = sampleFocusTrack(ir, SUBJECT_ID, REGION, {
      startMs: 0,
      durationMs: ir.durationMs,
      // Five samples across a four-second shot: t = 0, 1000, 2000, 3000, 4000.
    });

    expect(samples).toHaveLength(5);

    for (const sample of samples) {
      const snapshot = evaluate(ir, sample.timeMs);
      const subject = snapshot.nodes.find((node) => node.nodeId === SUBJECT_ID);
      expect(subject).toBeDefined();
      if (subject === undefined) return;

      // Independently derived: project through the renderer matrix into output pixels at
      // the composition size, then normalise. Nothing here calls `projectToNorm`.
      const view = cameraMatrix(snapshot.camera, scene, scene);
      const pixels = applyPoint(view, subject.worldTransform.position);
      const expected = { x: pixels.x / scene.width, y: pixels.y / scene.height };

      const centre = rectCentre(sample.region);
      expect(centre.x, `x at ${String(sample.timeMs)}ms`).toBeCloseTo(expected.x, 9);
      expect(centre.y, `y at ${String(sample.timeMs)}ms`).toBeCloseTo(expected.y, 9);
    }
  });

  it('disagrees with the un-projected reading by the amount the camera moved', () => {
    // The regression stated as the error it used to make, so a revert is legible rather
    // than merely red. On this fixture the camera pans -100 to +100 and zooms 1 to 1.4
    // across a 400 px canvas, and the old reading was out by up to a quarter of the frame.
    const ir = cameraIr();
    const samples = sampleFocusTrack(ir, SUBJECT_ID, REGION, {
      startMs: 0,
      durationMs: ir.durationMs,
    });

    const errors = samples.map((sample) => {
      const snapshot = evaluate(ir, sample.timeMs);
      const subject = snapshot.nodes.find((node) => node.nodeId === SUBJECT_ID);
      const unprojected = worldToNorm(
        subject?.worldTransform.position ?? { x: 0, y: 0 },
        ir.sceneSpace,
      );
      return (rectCentre(sample.region).x - unprojected.x) * ir.sceneSpace.width;
    });

    // Worth pinning explicitly: the error vanishes at t = 2000 because the subject sits at
    // scene x = 0 while the camera pan is 0, so both terms vanish at once. A test that
    // sampled only the middle of the shot would have proved the bug absent.
    expect(errors[2] ?? Number.NaN).toBeCloseTo(0, 9);
    expect(Math.abs(errors[0] ?? 0)).toBeCloseTo(100, 6);
    expect(Math.abs(errors[4] ?? 0)).toBeCloseTo(80, 6);
  });

  it('is unchanged by a camera that does nothing', () => {
    // The other side of the same property: applying an identity camera must not move
    // anything, or every composition without a camera would need a second code path.
    const plain = pure2dIr();
    const samples = sampleFocusTrack(plain, SUBJECT_ID, REGION, { startMs: 0, durationMs: 4000 });

    for (const sample of samples) {
      const snapshot = evaluate(plain, sample.timeMs);
      const subject = snapshot.nodes.find((node) => node.nodeId === SUBJECT_ID);
      const expected = worldToNorm(
        subject?.worldTransform.position ?? { x: 0, y: 0 },
        plain.sceneSpace,
      );
      expect(rectCentre(sample.region).x).toBeCloseTo(expected.x, 9);
    }
  });

  it('is deterministic', () => {
    const window = { startMs: 0, durationMs: 4000 };
    const track = (): readonly FocusSample[] =>
      sampleFocusTrack(cameraIr(), SUBJECT_ID, REGION, window);
    // Kept, but no longer the only thing asserted about a cameraed shot.
    expect(track()).toEqual(track());
  });
});

describe('staticFocusTrack', () => {
  it('is one sample at the start', () => {
    expect(staticFocusTrack(REGION)).toEqual([{ timeMs: 0, region: REGION }]);
  });
});

describe('worldToNorm', () => {
  it('agrees with the rasteriser about where the middle is', () => {
    // Off by half a frame everywhere if these two conventions ever diverge.
    expect(worldToNorm({ x: 0, y: 0 }, { width: 400, height: 300 })).toEqual({ x: 0.5, y: 0.5 });
    expect(worldToNorm({ x: -200, y: 150 }, { width: 400, height: 300 })).toEqual({ x: 0, y: 1 });
  });
});

describe('centreRegionOn', () => {
  it('centres the region on the point', () => {
    expect(centreRegionOn({ x: 0, y: 0, width: 0.2, height: 0.4 }, { x: 0.5, y: 0.5 })).toEqual({
      x: 0.4,
      y: 0.3,
      width: 0.2,
      height: 0.4,
    });
  });

  it('keeps the region inside the canvas rather than letting it hang off the edge', () => {
    // A focus rectangle that extends past the composition describes a subject that is
    // partly not there, and the solver would try to keep the empty half in shot.
    const clamped = centreRegionOn({ x: 0, y: 0, width: 0.2, height: 0.2 }, { x: 0.98, y: 0.01 });
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(1);
    expect(clamped.y).toBeGreaterThanOrEqual(0);
  });

  it('shrinks a region wider than the canvas', () => {
    const clamped = centreRegionOn({ x: 0, y: 0, width: 1.5, height: 2 }, { x: 0.5, y: 0.5 });
    expect(clamped).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});
