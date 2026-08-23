/**
 * The vocabulary the compiler turns numbers into.
 *
 * An image model cannot use `roughness: 0.43`. It can use "hand-wobbled". So every
 * unit slider in `VisualStyle` is banded into one of five words, and **the band is the
 * real resolution of the control**: a UI slider that moves 0.40 to 0.41 changes the
 * checksum and forks the asset library without changing a single generated pixel. The
 * bands are declared here, in one place, so that a UI can snap to them.
 *
 * Five bands rather than three because three collapses "barely there" and "moderate"
 * into one word, and that is the difference between a subtle paper grain and a poster
 * that looks like it was printed on sandpaper.
 */

import { at } from '@rv/shared-kernel';

/** Words for the five bands, from lowest to highest. */
export type BandWords = readonly [string, string, string, string, string];

/**
 * Band boundaries.
 *
 * Not evenly spaced: the low end is compressed because the perceptual difference
 * between 0.05 and 0.10 of a texture effect is larger than between 0.65 and 0.70.
 */
export const BAND_EDGES: readonly [number, number, number, number] = [0.15, 0.35, 0.6, 0.85];

export function bandIndex(value: number): 0 | 1 | 2 | 3 | 4 {
  const [a, b, c, d] = BAND_EDGES;
  if (value < a) return 0;
  if (value < b) return 1;
  if (value < c) return 2;
  if (value < d) return 3;
  return 4;
}

/** Picks the word for `value`. Total over the unit interval by construction. */
export function band(value: number, words: BandWords): string {
  return words[bandIndex(value)];
}

/**
 * Eight-point compass for a key light, in the bible's own convention.
 *
 * `Shading.lightDirection` is "degrees, 0 = from the right, counter-clockwise", which
 * is unambiguous and completely unusable in a prompt. This is the only place that
 * conversion happens, so a light coming from the upper left never becomes a light
 * coming from the lower right halfway down the pipeline.
 */
export function lightDirectionPhrase(degrees: number): string {
  const normalised = ((degrees % 360) + 360) % 360;
  const sector = Math.round(normalised / 45) % 8;
  return at(LIGHT_SECTORS, sector, 'light sector');
}

const LIGHT_SECTORS: readonly string[] = [
  'key light from the right',
  'key light from the upper right',
  'key light from directly above',
  'key light from the upper left',
  'key light from the left',
  'key light from the lower left',
  'key light from below, uplit',
  'key light from the lower right',
];

/**
 * Joins clause fragments into one prompt line.
 *
 * Empty fragments are dropped rather than leaving a double separator - a prompt with
 * ", , " in it reads to a tokeniser as an empty concept and costs adherence.
 */
export function joinClauses(fragments: readonly (string | undefined)[], separator = ', '): string {
  return fragments
    .filter((fragment): fragment is string => fragment !== undefined && fragment.trim() !== '')
    .map((fragment) => trimTerminator(fragment.trim()))
    .join(separator);
}

/**
 * Drops a trailing sentence terminator.
 *
 * Author-written fields like `silhouetteRule` are written as sentences, and splicing
 * one into a comma-joined clause list produces "... at 64px., set against ...", which
 * a tokeniser reads as a sentence boundary in the middle of a description.
 */
function trimTerminator(fragment: string): string {
  return fragment.replace(/[.;]+$/, '');
}

/**
 * De-duplicates while preserving first-appearance order.
 *
 * The negative prompt is assembled from four sources that legitimately overlap, and
 * RV-047 requires every entry to appear exactly once with a stable order - a negative
 * list whose order depends on a `Set`'s insertion history is not reproducible, and the
 * compiled string is part of the cache key.
 */
export function dedupeStable(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value === '') continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Rounds to a fixed number of decimals so a float never varies the compiled string. */
export function fixed(value: number, decimals = 2): string {
  return value.toFixed(decimals);
}

/**
 * `1 band` / `3 bands`.
 *
 * Trivial, and worth a function: "exactly 1 hard tonal bands" is the kind of phrasing a
 * language-conditioned encoder notices, and a flat-shaded style legitimately has one.
 */
export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
