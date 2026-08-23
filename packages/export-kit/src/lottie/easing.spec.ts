import { describe, expect, it } from 'vitest';
import { DEFAULT_EASINGS, buildEasingLibrary } from '@rv/anim-engine';

import { isExactlyRepresentable, overshoots, toSegmentEase } from './easing';

const library = buildEasingLibrary([
  { name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } },
  { name: 'back-out', p1: { x: 0.34, y: 1.56 }, p2: { x: 0.64, y: 1 } },
]);

describe('toSegmentEase', () => {
  it('maps an inline bezier straight onto the out/in handles', () => {
    expect(
      toSegmentEase({ kind: 'cubic-bezier', x1: 0.2, y1: 0.9, x2: 0.7, y2: 0.1 }, library),
    ).toEqual({ kind: 'bezier', out: { x: [0.2], y: [0.9] }, in: { x: [0.7], y: [0.1] } });
  });

  it('resolves a named curve through the same library the evaluator uses', () => {
    expect(toSegmentEase({ kind: 'named', name: 'ease-in-out' }, library)).toEqual({
      kind: 'bezier',
      out: { x: [0.42], y: [0] },
      in: { x: [0.58], y: [1] },
    });
  });

  /**
   * One definition of a named curve, in `@rv/anim-engine`, for all three consumers.
   *
   * The style bible declares curves by name, the evaluator resolves them, and this
   * exporter writes them into a file. `DEFAULT_EASINGS` is exported from the evaluator
   * precisely so no second copy exists - a local table would produce an export that no
   * longer matches its own preview, and the fidelity number could not see it because
   * both halves of that comparison would use the local copy.
   *
   * So the assertion is against the evaluator's own array, read at test time. Re-declaring
   * `ease-in-out` here with different control points fails.
   */
  it('resolves the fallback curves from the evaluator, never from a local copy', () => {
    const fallback = buildEasingLibrary(DEFAULT_EASINGS);
    for (const curve of DEFAULT_EASINGS) {
      expect(toSegmentEase({ kind: 'named', name: curve.name }, fallback)).toEqual({
        kind: 'bezier',
        out: { x: [curve.p1.x], y: [curve.p1.y] },
        in: { x: [curve.p2.x], y: [curve.p2.y] },
      });
    }
    // And the mapping is the identity on the numbers, so nothing was rescaled on the way.
    expect(DEFAULT_EASINGS.map((curve) => curve.name)).toContain('ease-in-out');
  });

  it('throws on a name the style bible does not define, rather than easing linearly', () => {
    expect(() => toSegmentEase({ kind: 'named', name: 'invented' }, library)).toThrow();
  });

  it('treats an absent easing as the identity curve', () => {
    expect(toSegmentEase(undefined, library)).toEqual({
      kind: 'bezier',
      out: { x: [0], y: [0] },
      in: { x: [1], y: [1] },
    });
  });

  it('turns a stepped curve into a hold', () => {
    expect(toSegmentEase({ kind: 'stepped', at: 'end', steps: 1 }, library)).toEqual({
      kind: 'hold',
    });
  });
});

describe('isExactlyRepresentable', () => {
  it('accepts everything Lottie can express as one segment', () => {
    expect(isExactlyRepresentable(undefined)).toBe(true);
    expect(isExactlyRepresentable({ kind: 'cubic-bezier', x1: 0, y1: 0, x2: 1, y2: 1 })).toBe(true);
    expect(isExactlyRepresentable({ kind: 'named', name: 'ease-in-out' })).toBe(true);
    expect(isExactlyRepresentable({ kind: 'stepped', at: 'end', steps: 1 })).toBe(true);
  });

  it('rejects the stepped curves that change value inside a segment', () => {
    expect(isExactlyRepresentable({ kind: 'stepped', at: 'end', steps: 4 })).toBe(false);
    expect(isExactlyRepresentable({ kind: 'stepped', at: 'start', steps: 1 })).toBe(false);
  });
});

describe('overshoots', () => {
  it('detects a curve that leaves the 0..1 band, which breaks a clamped channel', () => {
    expect(overshoots({ kind: 'named', name: 'back-out' }, library)).toBe(true);
    expect(overshoots({ kind: 'cubic-bezier', x1: 0.3, y1: -0.4, x2: 0.7, y2: 1 }, library)).toBe(
      true,
    );
  });

  it('is false for well-behaved and stepped curves', () => {
    expect(overshoots({ kind: 'named', name: 'ease-in-out' }, library)).toBe(false);
    expect(overshoots(undefined, library)).toBe(false);
    expect(overshoots({ kind: 'stepped', at: 'end', steps: 1 }, library)).toBe(false);
  });
});
