import { describe, expect, it } from 'vitest';

import { createRng, hashSeed } from './rng';

describe('determinism - the property the render pipeline depends on', () => {
  it('produces an identical sequence for the same seed', () => {
    const a = createRng('scene-1');
    const b = createRng('scene-1');
    const left = Array.from({ length: 100 }, () => a.next());
    const right = Array.from({ length: 100 }, () => b.next());
    expect(left).toEqual(right);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 20 }, (_, i) => createRng(`seed-${String(i)}`).next());
    expect(new Set(a).size).toBe(20);
  });

  it('accepts a numeric seed as well as a string', () => {
    expect(createRng(12345).next()).toBe(createRng(12345).next());
  });

  it('agrees between a string seed and its hashed numeric form', () => {
    expect(createRng('wind').next()).toBe(createRng(hashSeed('wind')).next());
  });
});

describe('fork - why adding a node must not perturb its siblings', () => {
  it('gives each label an independent, reproducible stream', () => {
    const parent = createRng('scene');
    expect(parent.fork('tree-1').next()).toBe(createRng('scene').fork('tree-1').next());
    expect(parent.fork('tree-1').next()).not.toBe(parent.fork('tree-2').next());
  });

  it("a fork's stream does not depend on how far the parent has advanced", () => {
    // Without this, inserting one leaf earlier in the scene would change the motion
    // of every leaf after it.
    const fresh = createRng('scene');
    const advanced = createRng('scene');
    for (let i = 0; i < 500; i += 1) advanced.next();

    expect(advanced.fork('bird').next()).toBe(fresh.fork('bird').next());
  });

  it('forks can be nested deterministically', () => {
    const nested = createRng('s').fork('a').fork('b').next();
    expect(createRng('s').fork('a').fork('b').next()).toBe(nested);
  });
});

describe('distribution and bounds', () => {
  const rng = createRng('stats');

  it('next() stays within [0, 1)', () => {
    for (let i = 0; i < 10_000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('next() has a mean near 0.5 over a large sample', () => {
    const local = createRng('mean');
    let total = 0;
    const n = 50_000;
    for (let i = 0; i < n; i += 1) total += local.next();
    expect(total / n).toBeCloseTo(0.5, 2);
  });

  it('int() respects [min, max) and covers the whole range', () => {
    const local = createRng('int');
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i += 1) {
      const value = local.int(3, 8);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThan(8);
      seen.add(value);
    }
    expect([...seen].sort((x, y) => x - y)).toEqual([3, 4, 5, 6, 7]);
  });

  it('int() rejects non-integer or inverted bounds', () => {
    expect(() => rng.int(0.5, 3)).toThrow(TypeError);
    expect(() => rng.int(5, 5)).toThrow(RangeError);
    expect(() => rng.int(5, 1)).toThrow(RangeError);
  });

  it('float() respects [min, max)', () => {
    const local = createRng('float');
    for (let i = 0; i < 1_000; i += 1) {
      const value = local.float(-2, 2);
      expect(value).toBeGreaterThanOrEqual(-2);
      expect(value).toBeLessThan(2);
    }
  });

  it('bool() honours the probability', () => {
    const local = createRng('bool');
    let hits = 0;
    const n = 20_000;
    for (let i = 0; i < n; i += 1) if (local.bool(0.25)) hits += 1;
    expect(hits / n).toBeCloseTo(0.25, 1);
  });

  it('bool() defaults to a fair coin', () => {
    const local = createRng('coin');
    let hits = 0;
    for (let i = 0; i < 20_000; i += 1) if (local.bool()) hits += 1;
    expect(hits / 20_000).toBeCloseTo(0.5, 1);
  });

  it('gaussian() approximates the requested mean and spread', () => {
    const local = createRng('gauss');
    const samples = Array.from({ length: 20_000 }, () => local.gaussian(10, 2));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
    expect(mean).toBeCloseTo(10, 1);
    expect(Math.sqrt(variance)).toBeCloseTo(2, 1);
  });

  it('gaussian() defaults to the standard normal', () => {
    const local = createRng('std');
    const samples = Array.from({ length: 20_000 }, () => local.gaussian());
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeCloseTo(0, 1);
  });
});

describe('collection helpers', () => {
  it('pick returns a member of the array', () => {
    const items = ['a', 'b', 'c'] as const;
    const local = createRng('pick');
    for (let i = 0; i < 100; i += 1) expect(items).toContain(local.pick(items));
  });

  it('pick eventually reaches every member', () => {
    const local = createRng('coverage');
    const seen = new Set(Array.from({ length: 200 }, () => local.pick([1, 2, 3])));
    expect(seen.size).toBe(3);
  });

  it('pick throws on an empty array rather than returning undefined', () => {
    expect(() => createRng('x').pick([])).toThrow(RangeError);
  });

  it('shuffle permutes without mutating the input', () => {
    const source = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const shuffled = createRng('shuffle').shuffle(source);
    expect(shuffled).not.toBe(source);
    expect(source).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual([...source]);
  });

  it('shuffle is deterministic for a given seed', () => {
    expect(createRng('s').shuffle([1, 2, 3, 4, 5])).toEqual(
      createRng('s').shuffle([1, 2, 3, 4, 5]),
    );
  });

  it('shuffle actually reorders (not the identity permutation)', () => {
    const source = Array.from({ length: 30 }, (_, i) => i);
    expect(createRng('reorder').shuffle(source)).not.toEqual(source);
  });

  it('shuffle handles empty and single-element arrays', () => {
    expect(createRng('s').shuffle([])).toEqual([]);
    expect(createRng('s').shuffle([9])).toEqual([9]);
  });
});

describe('hashSeed', () => {
  it('is deterministic and returns an unsigned 32-bit value', () => {
    const seed = hashSeed('wind-gust');
    expect(seed).toBe(hashSeed('wind-gust'));
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffff_ffff);
  });

  it('separates similar labels', () => {
    expect(hashSeed('tree-1')).not.toBe(hashSeed('tree-2'));
  });

  it('passes a number through as an unsigned 32-bit value', () => {
    expect(hashSeed(42)).toBe(42);
    expect(hashSeed(-1)).toBe(0xffff_ffff);
  });

  it('does not collide across a large label set', () => {
    const seeds = new Set(Array.from({ length: 5_000 }, (_, i) => hashSeed(`node-${String(i)}`)));
    expect(seeds.size).toBe(5_000);
  });
});
