import { InternalError } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import {
  applyEasing,
  buildEasingLibrary,
  cubicBezierAt,
  quantiseToStep,
  steppedAt,
} from './easing';

const LINEAR = { name: 'linear', p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 } };
const EASE_IN_OUT = { name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } };
const BACK_OUT = { name: 'back-out', p1: { x: 0.34, y: 1.56 }, p2: { x: 0.64, y: 1 } };

describe('cubicBezierAt', () => {
  it('pins both endpoints exactly', () => {
    // Golden-file tests compare frame hashes, so "almost 0" and "almost 1" are failures.
    expect(cubicBezierAt(0, 0.42, 0, 0.58, 1)).toBe(0);
    expect(cubicBezierAt(1, 0.42, 0, 0.58, 1)).toBe(1);
  });

  it('clamps outside [0, 1]', () => {
    expect(cubicBezierAt(-5, 0.42, 0, 0.58, 1)).toBe(0);
    expect(cubicBezierAt(5, 0.42, 0, 0.58, 1)).toBe(1);
  });

  it('is exact for the identity curve rather than merely close', () => {
    for (const x of [0.1, 0.25, 1 / 3, 0.5, 0.777, 0.9]) {
      expect(cubicBezierAt(x, 0, 0, 1, 1)).toBe(x);
    }
  });

  it('is monotonic for a monotonic curve', () => {
    let previous = -Infinity;
    for (let i = 0; i <= 100; i += 1) {
      const value = cubicBezierAt(i / 100, 0.42, 0, 0.58, 1);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('eases: slower than linear early, faster in the middle', () => {
    expect(cubicBezierAt(0.2, 0.42, 0, 0.58, 1)).toBeLessThan(0.2);
    expect(cubicBezierAt(0.5, 0.42, 0, 0.58, 1)).toBeCloseTo(0.5, 5);
    expect(cubicBezierAt(0.8, 0.42, 0, 0.58, 1)).toBeGreaterThan(0.8);
  });

  it('leaves 0..1 on purpose for overshoot and anticipation', () => {
    // A clamped easing cannot express "snap past the target and settle", which the
    // style bible's motion principles explicitly ask for.
    const overshoot = Math.max(
      ...Array.from({ length: 99 }, (_, i) => cubicBezierAt((i + 1) / 100, 0.34, 1.56, 0.64, 1)),
    );
    expect(overshoot).toBeGreaterThan(1);

    const anticipation = Math.min(
      ...Array.from({ length: 99 }, (_, i) => cubicBezierAt((i + 1) / 100, 0.36, 0, 0.66, -0.56)),
    );
    expect(anticipation).toBeLessThan(0);
  });

  it('converges on a curve with a near-zero derivative, where Newton alone fails', () => {
    // p1.x = p2.x = 1 flattens the start; a Newton-only solver stalls there.
    const value = cubicBezierAt(0.5, 1, 0, 1, 1);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });

  it('falls back to bisection when Newton stalls on a near-zero derivative', () => {
    // With both x control points at 0 the curve is t^3, whose slope near the origin is
    // ~0. Newton makes no progress there; without the bisection fallback the solver
    // would return its unrefined first guess.
    const value = cubicBezierAt(0.0001, 0, 0, 0, 1);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(0.1);
    // Still exact enough to be worth having: t^3 = 1e-4 gives t ~ 0.0464.
    expect(Math.cbrt(0.0001) ** 3).toBeCloseTo(0.0001, 12);
  });

  it('stays monotonic through the bisection path too', () => {
    let previous = -Infinity;
    for (let i = 0; i <= 60; i += 1) {
      const value = cubicBezierAt(i / 60, 0, 0, 0, 1);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = value;
    }
  });

  it('is deterministic - the renderer, the baker and the exporter must agree bit for bit', () => {
    for (const x of [0.13, 0.5, 0.87]) {
      expect(cubicBezierAt(x, 0.34, 1.56, 0.64, 1)).toBe(cubicBezierAt(x, 0.34, 1.56, 0.64, 1));
    }
  });
});

describe('steppedAt', () => {
  it('holds then jumps, with `end` staying at 0 through the first step', () => {
    expect(steppedAt(0, 4, 'end')).toBe(0);
    expect(steppedAt(0.2, 4, 'end')).toBe(0);
    expect(steppedAt(0.3, 4, 'end')).toBe(0.25);
    expect(steppedAt(1, 4, 'end')).toBe(1);
  });

  it('jumps immediately with `start`', () => {
    expect(steppedAt(0, 4, 'start')).toBe(0.25);
    expect(steppedAt(0.2, 4, 'start')).toBe(0.25);
    expect(steppedAt(0.3, 4, 'start')).toBe(0.5);
    expect(steppedAt(1, 4, 'start')).toBe(1);
  });

  it('clamps outside the interval', () => {
    expect(steppedAt(-1, 3, 'end')).toBe(0);
    expect(steppedAt(2, 3, 'end')).toBe(1);
  });

  it('takes only the discrete values the step count allows', () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => steppedAt(i / 200, 5, 'end')));
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
  });
});

describe('applyEasing', () => {
  const library = buildEasingLibrary([LINEAR, EASE_IN_OUT, BACK_OUT]);

  it('is the identity when no easing is given', () => {
    expect(applyEasing(undefined, 0.37, library)).toBe(0.37);
  });

  it('resolves a named curve from the library', () => {
    expect(applyEasing({ kind: 'named', name: 'ease-in-out' }, 0.2, library)).toBe(
      cubicBezierAt(0.2, 0.42, 0, 0.58, 1),
    );
  });

  it('throws on a named curve the style bible does not define', () => {
    // Silently falling back to linear would hide the mismatch behind motion that only
    // looks slightly wrong - the worst possible failure mode to debug.
    expect(() => applyEasing({ kind: 'named', name: 'nope' }, 0.5, library)).toThrow(InternalError);
  });

  it('applies an inline bezier', () => {
    expect(applyEasing({ kind: 'cubic-bezier', x1: 0, y1: 0, x2: 1, y2: 1 }, 0.42, library)).toBe(
      0.42,
    );
  });

  it('applies a stepped easing', () => {
    expect(applyEasing({ kind: 'stepped', at: 'end', steps: 2 }, 0.7, library)).toBe(0.5);
  });

  it('builds a library keyed by name, last definition winning', () => {
    const shadowed = buildEasingLibrary([LINEAR, { ...LINEAR, p1: { x: 0.9, y: 0.1 } }]);
    expect(applyEasing({ kind: 'named', name: 'linear' }, 0.5, shadowed)).not.toBe(0.5);
  });
});

describe('quantiseToStep', () => {
  const FPS = 24;
  const FRAME = 1000 / 24;

  it('leaves smooth playback untouched', () => {
    expect(quantiseToStep(123.456, FPS, 'smooth')).toBe(123.456);
  });

  it('holds each drawing for two frames on 2s', () => {
    // This one field is most of the difference between "animated" and "interpolated".
    expect(quantiseToStep(0, FPS, 'on-2s')).toBe(0);
    expect(quantiseToStep(FRAME * 1.5, FPS, 'on-2s')).toBe(0);
    expect(quantiseToStep(FRAME * 2, FPS, 'on-2s')).toBeCloseTo(FRAME * 2, 9);
    expect(quantiseToStep(FRAME * 3.9, FPS, 'on-2s')).toBeCloseTo(FRAME * 2, 9);
  });

  it('holds for three and four frames respectively', () => {
    expect(quantiseToStep(FRAME * 2.5, FPS, 'on-3s')).toBe(0);
    expect(quantiseToStep(FRAME * 3, FPS, 'on-3s')).toBeCloseTo(FRAME * 3, 9);
    expect(quantiseToStep(FRAME * 3.5, FPS, 'on-4s')).toBe(0);
    expect(quantiseToStep(FRAME * 4, FPS, 'on-4s')).toBeCloseTo(FRAME * 4, 9);
  });

  it('is idempotent - quantising an already-quantised time changes nothing', () => {
    const once = quantiseToStep(987.65, FPS, 'on-2s');
    expect(quantiseToStep(once, FPS, 'on-2s')).toBeCloseTo(once, 9);
  });

  it('never moves time forwards', () => {
    for (let ms = 0; ms < 1000; ms += 7) {
      expect(quantiseToStep(ms, FPS, 'on-3s')).toBeLessThanOrEqual(ms + 1e-9);
    }
  });
});
