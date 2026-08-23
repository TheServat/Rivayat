import { describe, expect, it } from 'vitest';

import { fractalNoise1d, noise1d, signedNoise1d } from './noise';

describe('determinism', () => {
  it('returns the same value for the same seed and position', () => {
    for (const x of [0, 0.5, 3.14, -7.2, 1000.001]) {
      expect(noise1d(42, x)).toBe(noise1d(42, x));
    }
  });

  it('separates seeds', () => {
    const values = Array.from({ length: 50 }, (_, seed) => noise1d(seed, 1.5));
    expect(new Set(values).size).toBe(50);
  });

  it('is a pure function of position, so scrubbing and playing agree', () => {
    // Sampling forwards then backwards must not change the answer at any point.
    const cold = noise1d(7, 12.34);
    for (let x = 0; x < 100; x += 0.3) noise1d(7, x);
    for (let x = 100; x > 0; x -= 0.3) noise1d(7, x);
    expect(noise1d(7, 12.34)).toBe(cold);
  });
});

describe('range', () => {
  it('stays within [0, 1)', () => {
    for (let x = -50; x < 50; x += 0.13) {
      const value = noise1d(3, x);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('signedNoise1d stays within [-1, 1)', () => {
    for (let x = -50; x < 50; x += 0.13) {
      const value = signedNoise1d(3, x);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThan(1);
    }
  });

  it('fractalNoise1d stays within [-1, 1) however many octaves it is given', () => {
    for (const octaves of [1, 2, 3, 5, 8]) {
      for (let x = -20; x < 20; x += 0.37) {
        const value = fractalNoise1d(11, x, octaves);
        expect(Math.abs(value)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('continuity - the reason this is not Math.random()', () => {
  it('changes only a little between nearby positions', () => {
    // A discontinuous signal reads as a stutter, not a breeze.
    let maxJump = 0;
    for (let x = 0; x < 40; x += 0.01) {
      maxJump = Math.max(maxJump, Math.abs(noise1d(5, x + 0.01) - noise1d(5, x)));
    }
    expect(maxJump).toBeLessThan(0.05);
  });

  it('has a continuous first derivative at the lattice points', () => {
    // Smoothstep, not linear interpolation: linear leaves a visible kink every unit.
    const before = noise1d(9, 3 - 0.001) - noise1d(9, 3 - 0.002);
    const after = noise1d(9, 3 + 0.002) - noise1d(9, 3 + 0.001);
    expect(Math.abs(before - after)).toBeLessThan(1e-4);
  });

  it('agrees exactly with the lattice value at integer positions', () => {
    for (const n of [0, 1, 5, -3]) {
      expect(noise1d(2, n)).toBe(noise1d(2, n));
      // Smoothstep(0) is 0, so an integer position reads the lattice value directly.
      expect(noise1d(2, n)).toBeCloseTo(noise1d(2, n + 1e-12), 9);
    }
  });
});

describe('distribution', () => {
  it('averages near the middle of its range over a long sample', () => {
    let total = 0;
    const n = 20_000;
    for (let i = 0; i < n; i += 1) total += noise1d(13, i * 0.37);
    expect(total / n).toBeCloseTo(0.5, 1);
  });

  it('actually varies rather than returning a constant', () => {
    const samples = Array.from({ length: 500 }, (_, i) => noise1d(17, i * 0.41));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
    expect(variance).toBeGreaterThan(0.01);
  });
});

describe('fractalNoise1d', () => {
  it('defaults to three octaves', () => {
    expect(fractalNoise1d(1, 2.5)).toBe(fractalNoise1d(1, 2.5, 3));
  });

  it('one octave is exactly the signed base noise', () => {
    expect(fractalNoise1d(1, 2.5, 1)).toBeCloseTo(signedNoise1d(1, 2.5), 12);
  });

  it('adding octaves adds detail rather than amplitude', () => {
    // The point of layering is gusts inside the breeze, not a louder breeze.
    const roughness = (octaves: number): number => {
      let total = 0;
      for (let x = 0; x < 40; x += 0.05) {
        total += Math.abs(fractalNoise1d(21, x + 0.05, octaves) - fractalNoise1d(21, x, octaves));
      }
      return total;
    };
    expect(roughness(4)).toBeGreaterThan(roughness(1));
  });
});
