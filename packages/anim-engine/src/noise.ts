/**
 * Deterministic value noise.
 *
 * Wind gusts, hand-drawn boil and idle drift all need a signal that is *irregular* but
 * **continuous in time and reproducible from a seed**. A plain sine is too regular and
 * reads as mechanical; `Math.random()` is neither continuous nor reproducible, so
 * scrubbing to 4.2s would give a different frame from playing there.
 *
 * Value noise on an integer lattice gives both: `noise1d(seed, x)` is a pure function,
 * smooth across the whole real line, and identical on every machine.
 */

/**
 * Hashes a lattice coordinate to [0, 1). Integer ops only, so it is exact.
 *
 * The coordinate and the seed are each mixed into the word *before* being combined.
 * The obvious `(x | 0) ^ seed` leaves adjacent seeds correlated - forty trees seeded
 * 0..39 then gust in near-unison, which is the exact artefact seeding them separately
 * was supposed to prevent.
 */
function latticeValue(seed: number, x: number): number {
  let h = Math.imul((x | 0) ^ 0x27d4eb2f, 0x9e3779b1);
  h ^= Math.imul((seed | 0) ^ 0x85ebca6b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  return ((h ^ (h >>> 16)) >>> 0) * 2.3283064365386963e-10;
}

/**
 * Smoothstep, so the first derivative is continuous at the lattice points.
 *
 * Linear interpolation would give a signal with visible kinks every unit, which reads
 * as a stutter rather than a breeze.
 */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise in [0, 1). */
export function noise1d(seed: number, x: number): number {
  const cell = Math.floor(x);
  const frac = x - cell;
  const a = latticeValue(seed, cell);
  const b = latticeValue(seed, cell + 1);
  return a + (b - a) * smoothstep(frac);
}

/** Value noise in [-1, 1). */
export function signedNoise1d(seed: number, x: number): number {
  return noise1d(seed, x) * 2 - 1;
}

/**
 * Layered noise: several octaves at halving amplitude and doubling frequency.
 *
 * One octave is a lazy breeze. Three is a breeze with gusts in it. Normalised so the
 * result stays in [-1, 1) regardless of how many octaves are asked for.
 */
export function fractalNoise1d(seed: number, x: number, octaves = 3): number {
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  let normalisation = 0;

  for (let i = 0; i < octaves; i += 1) {
    total += signedNoise1d(seed + i * 0x9e37, x * frequency) * amplitude;
    normalisation += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }

  return total / normalisation;
}
