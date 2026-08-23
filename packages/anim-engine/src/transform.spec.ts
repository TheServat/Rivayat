import { describe, expect, it } from 'vitest';
import type { Transform2D } from '@rv/contracts';

import {
  composeTransform,
  identityTransform,
  rotateVec,
  transformPoint,
  transformsEqual,
} from './transform';

function t(overrides: Partial<Transform2D> = {}): Transform2D {
  return { ...identityTransform(), ...overrides };
}

describe('identityTransform', () => {
  it('is neutral: origin, no rotation, unit scale, centred pivot, opaque', () => {
    expect(identityTransform()).toEqual({
      position: { x: 0, y: 0 },
      rotation: 0,
      scale: { x: 1, y: 1 },
      skew: { x: 0, y: 0 },
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    });
  });

  it('returns a fresh object each time, so a caller cannot mutate the identity', () => {
    const a = identityTransform();
    a.position.x = 99;
    expect(identityTransform().position.x).toBe(0);
  });
});

describe('rotateVec', () => {
  it('is the identity at zero degrees, exactly', () => {
    const v = { x: 3, y: 4 };
    expect(rotateVec(v, 0)).toBe(v);
  });

  it('rotates a quarter turn', () => {
    const r = rotateVec({ x: 1, y: 0 }, 90);
    expect(r.x).toBeCloseTo(0, 12);
    expect(r.y).toBeCloseTo(1, 12);
  });

  it('preserves length', () => {
    for (const degrees of [17, 90, 180, -45, 359]) {
      const r = rotateVec({ x: 3, y: 4 }, degrees);
      expect(Math.hypot(r.x, r.y)).toBeCloseTo(5, 12);
    }
  });

  it('composes: two half-rotations equal one full one', () => {
    const once = rotateVec({ x: 2, y: -1 }, 70);
    const twice = rotateVec(rotateVec({ x: 2, y: -1 }, 35), 35);
    expect(twice.x).toBeCloseTo(once.x, 12);
    expect(twice.y).toBeCloseTo(once.y, 12);
  });
});

describe('composeTransform', () => {
  it('leaves a child unchanged under an identity parent', () => {
    const child = t({ position: { x: 5, y: -3 }, rotation: 30, opacity: 0.5 });
    expect(transformsEqual(composeTransform(identityTransform(), child), child)).toBe(true);
  });

  it('translates a child by its parent', () => {
    const world = composeTransform(
      t({ position: { x: 10, y: 20 } }),
      t({ position: { x: 1, y: 2 } }),
    );
    expect(world.position).toEqual({ x: 11, y: 22 });
  });

  it('rotates the child offset by the parent rotation', () => {
    const world = composeTransform(t({ rotation: 90 }), t({ position: { x: 10, y: 0 } }));
    expect(world.position.x).toBeCloseTo(0, 12);
    expect(world.position.y).toBeCloseTo(10, 12);
  });

  it('scales the child offset by the parent scale', () => {
    const world = composeTransform(t({ scale: { x: 2, y: 3 } }), t({ position: { x: 4, y: 5 } }));
    expect(world.position).toEqual({ x: 8, y: 15 });
  });

  it('adds rotations and multiplies scales', () => {
    const world = composeTransform(
      t({ rotation: 30, scale: { x: 2, y: 2 } }),
      t({ rotation: 15, scale: { x: 0.5, y: 3 } }),
    );
    expect(world.rotation).toBe(45);
    expect(world.scale).toEqual({ x: 1, y: 6 });
  });

  it('multiplies opacity, so a half-faded child of a half-faded parent is a quarter', () => {
    const world = composeTransform(t({ opacity: 0.5 }), t({ opacity: 0.5 }));
    expect(world.opacity).toBe(0.25);
  });

  it('adds skew', () => {
    const world = composeTransform(t({ skew: { x: 5, y: 0 } }), t({ skew: { x: 3, y: 7 } }));
    expect(world.skew).toEqual({ x: 8, y: 7 });
  });

  it('keeps the child anchor and never inherits the parent pivot', () => {
    // Inheriting a pivot would move a child every time its parent's pivot moved.
    const world = composeTransform(
      t({ anchor: { x: 0, y: 0 } }),
      t({ anchor: { x: 0.25, y: 0.75 } }),
    );
    expect(world.anchor).toEqual({ x: 0.25, y: 0.75 });
  });

  it('is associative for the cases the component model represents exactly', () => {
    // Uniform scale plus rotation composes exactly; the documented limitation is
    // non-uniform scale on a rotated parent, which is not asserted here.
    const a = t({ position: { x: 3, y: 1 }, rotation: 20, scale: { x: 2, y: 2 } });
    const b = t({ position: { x: -4, y: 6 }, rotation: 35, scale: { x: 0.5, y: 0.5 } });
    const c = t({ position: { x: 7, y: -2 }, rotation: 10 });

    const left = composeTransform(composeTransform(a, b), c);
    const right = composeTransform(a, composeTransform(b, c));
    expect(transformsEqual(left, right, 1e-9)).toBe(true);
  });

  it('does not mutate either input', () => {
    const parent = t({ position: { x: 1, y: 1 } });
    const child = t({ position: { x: 2, y: 2 } });
    const before = { parent: structuredClone(parent), child: structuredClone(child) };
    composeTransform(parent, child);
    expect(parent).toEqual(before.parent);
    expect(child).toEqual(before.child);
  });
});

describe('transformPoint', () => {
  it('is the identity under an identity transform', () => {
    expect(transformPoint(identityTransform(), { x: 3, y: -7 })).toEqual({ x: 3, y: -7 });
  });

  it('applies scale, then rotation, then translation, in that order', () => {
    const mapped = transformPoint(
      t({ scale: { x: 2, y: 2 }, rotation: 90, position: { x: 5, y: 0 } }),
      { x: 1, y: 0 },
    );
    // (1,0) -> scaled (2,0) -> rotated (0,2) -> translated (5,2)
    expect(mapped.x).toBeCloseTo(5, 12);
    expect(mapped.y).toBeCloseTo(2, 12);
  });

  it('applies skew', () => {
    const mapped = transformPoint(t({ skew: { x: 45, y: 0 } }), { x: 0, y: 1 });
    expect(mapped.x).toBeCloseTo(1, 9);
    expect(mapped.y).toBeCloseTo(1, 9);
  });

  it('maps the origin to the transform position', () => {
    const mapped = transformPoint(t({ position: { x: 8, y: -2 }, rotation: 37 }), { x: 0, y: 0 });
    expect(mapped).toEqual({ x: 8, y: -2 });
  });
});

describe('transformsEqual', () => {
  it('is true for identical transforms', () => {
    expect(transformsEqual(identityTransform(), identityTransform())).toBe(true);
  });

  it('is false when any single component differs', () => {
    const base = identityTransform();
    const variants: Partial<Transform2D>[] = [
      { position: { x: 1, y: 0 } },
      { position: { x: 0, y: 1 } },
      { rotation: 1 },
      { scale: { x: 2, y: 1 } },
      { scale: { x: 1, y: 2 } },
      { skew: { x: 1, y: 0 } },
      { skew: { x: 0, y: 1 } },
      { anchor: { x: 0, y: 0.5 } },
      { anchor: { x: 0.5, y: 0 } },
      { opacity: 0.9 },
    ];
    for (const variant of variants) {
      expect(transformsEqual(base, { ...base, ...variant })).toBe(false);
    }
  });

  it('tolerates a difference within epsilon', () => {
    const nudged = t({ rotation: 1e-12 });
    expect(transformsEqual(identityTransform(), nudged)).toBe(true);
    expect(transformsEqual(identityTransform(), nudged, 0)).toBe(false);
  });
});
