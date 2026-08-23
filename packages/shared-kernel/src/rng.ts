/**
 * Deterministic pseudo-randomness.
 *
 * Animation behaviours need randomness - wind gusts, blink timing, leaf scatter, the
 * hand-drawn "boil" jitter. They also must be *seek-safe*: evaluating a timeline at
 * t=4.2s must give the same frame whether you scrubbed there, played there, or
 * resumed a distributed render there. `Math.random()` makes all three differ.
 *
 * So: every behaviour receives an `Rng` derived from a seed, and never calls the
 * global RNG.
 */

import type { Brand } from './brand';

export type Seed = Brand<number, 'Seed'>;

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number;
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** True with probability `p`. */
  bool(probability?: number): boolean;
  /** Uniform choice. Throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** Fisher-Yates on a copy; the input is not mutated. */
  shuffle<T>(items: readonly T[]): T[];
  /** Box-Muller normal deviate. */
  gaussian(mean?: number, stdDev?: number): number;
  /**
   * A child generator derived from this one's seed plus a label.
   *
   * This is the important one. Give each animated node `rng.fork(node.id)` and its
   * random sequence depends only on its own id - so adding, removing or reordering
   * nodes never perturbs the motion of the others. Without forking, one new leaf
   * changes every gust in the scene.
   */
  fork(label: string): Rng;
}

/** FNV-1a, for turning a label into a seed. */
export function hashSeed(input: string | number): Seed {
  if (typeof input === 'number') return (input >>> 0) as Seed;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) as Seed;
}

/** SplitMix32 - expands one 32-bit seed into the four xoshiro needs. */
function splitMix32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

class Xoshiro128SS implements Rng {
  #s0: number;
  #s1: number;
  #s2: number;
  #s3: number;
  readonly #seed: Seed;
  /** Cached second Box-Muller deviate; the transform produces them in pairs. */
  #spareGaussian: number | undefined;

  constructor(seed: Seed) {
    this.#seed = seed;
    const mix = splitMix32(seed);
    this.#s0 = mix();
    this.#s1 = mix();
    this.#s2 = mix();
    this.#s3 = mix();
    // An all-zero state is a fixed point of xoshiro; nudge it.
    if ((this.#s0 | this.#s1 | this.#s2 | this.#s3) === 0) this.#s0 = 1;
  }

  /** xoshiro128** - fast, and passes the statistical suites we care about. */
  #nextUint32(): number {
    const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

    const result = (Math.imul(rotl(Math.imul(this.#s1, 5) >>> 0, 7), 9) >>> 0) >>> 0;
    const t = (this.#s1 << 9) >>> 0;

    this.#s2 = (this.#s2 ^ this.#s0) >>> 0;
    this.#s3 = (this.#s3 ^ this.#s1) >>> 0;
    this.#s1 = (this.#s1 ^ this.#s2) >>> 0;
    this.#s0 = (this.#s0 ^ this.#s3) >>> 0;
    this.#s2 = (this.#s2 ^ t) >>> 0;
    this.#s3 = rotl(this.#s3, 11);

    return result;
  }

  next(): number {
    // 2^-32, so the result is in [0, 1).
    return this.#nextUint32() * 2.3283064365386963e-10;
  }

  int(minInclusive: number, maxExclusive: number): number {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
      throw new TypeError('Rng.int expects integer bounds');
    }
    if (maxExclusive <= minInclusive) {
      throw new RangeError(
        `Rng.int requires max > min, got [${String(minInclusive)}, ${String(maxExclusive)})`,
      );
    }
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('Rng.pick called on an empty array');
    const value = items[this.int(0, items.length)];
    if (value === undefined) throw new RangeError('Rng.pick produced an out-of-range index');
    return value;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i + 1);
      const a = out[i] as T;
      const b = out[j] as T;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  gaussian(mean = 0, stdDev = 1): number {
    if (this.#spareGaussian !== undefined) {
      const spare = this.#spareGaussian;
      this.#spareGaussian = undefined;
      return mean + stdDev * spare;
    }
    let u: number;
    let v: number;
    let s: number;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    this.#spareGaussian = v * factor;
    return mean + stdDev * (u * factor);
  }

  fork(label: string): Rng {
    // Derive from the *original* seed, not the current state, so a fork's stream is
    // independent of how many numbers the parent has already drawn.
    return new Xoshiro128SS(hashSeed(`${String(this.#seed)}:${label}`));
  }
}

export function createRng(seed: Seed | number | string): Rng {
  return new Xoshiro128SS(typeof seed === 'number' ? ((seed >>> 0) as Seed) : hashSeed(seed));
}
