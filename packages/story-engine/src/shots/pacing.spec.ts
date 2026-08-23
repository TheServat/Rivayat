import { describe, expect, it } from 'vitest';
import { CameraGrammar } from '@rv/contracts';
import { isErr } from '@rv/shared-kernel';

import { CUT_RHYTHM_FACTOR, type CutRhythm, distributeDurations, targetShotCount } from './pacing';
import { DEFAULT_TITLE_SAFE_INSET, aspectRatioOf, cropCoverage, solveSafeArea } from './safe-area';

function camera(cutRhythm: CutRhythm, defaultShotMs = 3_000): CameraGrammar {
  return CameraGrammar.parse({ cutRhythm, defaultShotMs });
}

describe('targetShotCount', () => {
  it('cuts more often the more frenetic the style is', () => {
    // Twelve beats in a minute, so neither the one-shot-per-beat floor nor the four-per-beat
    // ceiling is doing the work - the rhythm is.
    const counts = (['languid', 'measured', 'brisk', 'frenetic'] as const).map((rhythm) =>
      targetShotCount({ sceneDurationMs: 60_000, camera: camera(rhythm), beatCount: 12 }),
    );
    // Strictly increasing: pacing is the most legible signature of a style, so the four
    // settings have to be visibly different rather than nominally different.
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts[3]).toBeGreaterThan((counts[0] ?? 0) * 3);
  });

  it('never returns fewer shots than beats - a beat with no shot does not happen', () => {
    expect(
      targetShotCount({ sceneDurationMs: 1_000, camera: camera('languid'), beatCount: 6 }),
    ).toBe(6);
  });

  it('caps at four shots per beat, because past that the cut is decoration', () => {
    expect(
      targetShotCount({ sceneDurationMs: 600_000, camera: camera('frenetic'), beatCount: 2 }),
    ).toBe(8);
  });

  it('keeps the rhythm factors spread far enough apart to see', () => {
    expect(CUT_RHYTHM_FACTOR.languid / CUT_RHYTHM_FACTOR.frenetic).toBeGreaterThan(4);
    expect(CUT_RHYTHM_FACTOR.measured).toBe(1);
  });
});

describe('distributeDurations', () => {
  it('sums to exactly the scene duration', () => {
    const outcome = distributeDurations([1, 2, 1, 3], 12_000, 24);
    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.reduce((total, ms) => total + ms, 0)).toBe(12_000);
  });

  it('respects the relative weights it was given', () => {
    const outcome = distributeDurations([1, 3], 8_000, 24);
    if (isErr(outcome)) throw new Error(outcome.error.message);
    const [short, long] = outcome.value;
    expect(long).toBeGreaterThan((short ?? 0) * 2);
  });

  it('lands every shot on a frame boundary, give or take the placed residual', () => {
    const outcome = distributeDurations([1, 1, 1], 10_000, 25);
    if (isErr(outcome)) throw new Error(outcome.error.message);
    // 25 fps means 40 ms frames; two of the three are exact multiples and the third
    // carries the residual so the total is exact.
    expect(outcome.value.filter((ms) => ms % 40 === 0).length).toBeGreaterThanOrEqual(2);
    expect(outcome.value.reduce((total, ms) => total + ms, 0)).toBe(10_000);
  });

  it('gives every shot at least one frame', () => {
    const outcome = distributeDurations([100, 1, 1], 5_000, 24);
    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.every((ms) => ms > 0)).toBe(true);
  });

  it('splits evenly when the weights express no preference', () => {
    const outcome = distributeDurations([0, 0, 0], 9_000, 30);
    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.reduce((total, ms) => total + ms, 0)).toBe(9_000);
    expect(new Set(outcome.value).size).toBeLessThanOrEqual(2);
  });

  it('refuses a scene too short to hold the shots asked of it', () => {
    const outcome = distributeDurations([1, 1, 1, 1, 1], 100, 24);
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'scene-too-short-for-shots' });
  });

  it('refuses to distribute across no shots at all', () => {
    const outcome = distributeDurations([], 5_000, 24);
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'no-shots' });
  });

  it('is exact across a sweep of durations, weights and frame rates', () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const totalMs of [4_000, 7_333, 12_000, 61_500]) {
        const outcome = distributeDurations([1, 2, 3, 5, 8], totalMs, fps);
        if (isErr(outcome)) throw new Error(outcome.error.message);
        expect(outcome.value.reduce((total, ms) => total + ms, 0)).toBe(totalMs);
        expect(outcome.value.every((ms) => ms > 0)).toBe(true);
      }
    }
  });
});

describe('safe area', () => {
  it('reads an aspect label as a number', () => {
    expect(aspectRatioOf('16:9')).toBeCloseTo(16 / 9);
    expect(aspectRatioOf('1:1')).toBe(1);
  });

  it('keeps full width for a target wider than the canvas, and loses height', () => {
    const coverage = cropCoverage(1, '16:9');
    expect(coverage.width).toBe(1);
    expect(coverage.height).toBeCloseTo(9 / 16);
  });

  it('keeps full height for a narrower target, and loses width', () => {
    const coverage = cropCoverage(16 / 9, '9:16');
    expect(coverage.height).toBe(1);
    expect(coverage.width).toBeCloseTo(9 / 16 / (16 / 9));
  });

  it('shrinks as more aspects have to survive the same crop', () => {
    const canvas = { width: 2_048, height: 2_048 };
    const wideOnly = solveSafeArea(canvas, ['16:9']);
    const both = solveSafeArea(canvas, ['16:9', '9:16']);
    expect(both.width).toBeLessThan(wideOnly.width);
    expect(both.height).toBeLessThanOrEqual(wideOnly.height);
  });

  it('centres the safe area and keeps it inside the canvas', () => {
    const area = solveSafeArea({ width: 2_048, height: 2_048 }, ['16:9', '9:16', '1:1', '4:5']);
    expect(area.x + area.width / 2).toBeCloseTo(0.5);
    expect(area.y + area.height / 2).toBeCloseTo(0.5);
    expect(area.x).toBeGreaterThanOrEqual(0);
    expect(area.x + area.width).toBeLessThanOrEqual(1);
  });

  it('applies the title-safe inset once, to the intersection', () => {
    const canvas = { width: 1_000, height: 1_000 };
    const withInset = solveSafeArea(canvas, ['1:1'], DEFAULT_TITLE_SAFE_INSET);
    expect(withInset.width).toBeCloseTo(1 - DEFAULT_TITLE_SAFE_INSET * 2);
    expect(solveSafeArea(canvas, ['1:1'], 0).width).toBe(1);
  });

  it('clamps an absurd inset rather than producing a negative rectangle', () => {
    const area = solveSafeArea({ width: 1_000, height: 1_000 }, ['1:1'], 5);
    expect(area.width).toBeGreaterThan(0);
    expect(area.height).toBeGreaterThan(0);
  });
});
