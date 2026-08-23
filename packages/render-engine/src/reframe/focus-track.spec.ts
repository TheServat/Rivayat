import { describe, expect, it } from 'vitest';

import { SUBJECT_ID, cameraIr, pure2dIr, testId } from '../__fixtures__/ir';
import { centreRegionOn, sampleFocusTrack, staticFocusTrack, worldToNorm } from './focus-track';

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

  it('is deterministic', () => {
    const window = { startMs: 0, durationMs: 4000 };
    expect(sampleFocusTrack(cameraIr(), SUBJECT_ID, REGION, window)).toEqual(
      sampleFocusTrack(cameraIr(), SUBJECT_ID, REGION, window),
    );
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
