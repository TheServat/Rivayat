/**
 * Measuring colour instead of asking about it.
 *
 * Two operations, both pure, both deterministic, both dramatically better than the
 * language-model alternative:
 *
 *  - **Extraction.** A vision model asked "what colours are in this reference" returns
 *    plausible hexes that are not in the image. Median-cut over the actual pixels
 *    returns the colours that *are*, with the share of the frame each one occupies -
 *    and the share is the part a model could never supply.
 *  - **Adherence.** "Does this generated asset stay on palette" is a distance
 *    computation, not a judgement. Running it through a scoring model costs a call,
 *    costs money, and returns a number that changes between runs.
 *
 * Sampling is strided rather than random: a seeded RNG would also be reproducible, but
 * a stride additionally guarantees even spatial coverage, so a palette measured from a
 * 4K reference matches the one measured from its thumbnail.
 */

import type { RgbaImage } from '../ports/raster';
import { type Oklab, oklabDistance, parseHex, rgbToOklab, toHex } from './oklab';

/** Pixels at or below this alpha are background, not colour. */
const OPAQUE_THRESHOLD = 250;

/** Upper bound on sampled pixels. Enough for a stable palette, cheap enough to run inline. */
const DEFAULT_MAX_SAMPLES = 8192;

/**
 * How far off-palette a pixel may be before it scores zero.
 *
 * 0.12 in OKLab, where black-to-white is 1.0. Roughly "a shade or two out" - close
 * enough that a soft-shaded gradient between two palette colours still passes, far
 * enough that a colour the style never declared does not.
 */
export const PALETTE_TOLERANCE = 0.12;

interface Sample {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly lab: Oklab;
}

export interface PaletteSwatch {
  /** Lowercase `#rrggbb`. */
  readonly hex: string;
  /** Fraction of sampled opaque pixels this cluster accounts for, 0..1. */
  readonly share: number;
}

export interface MeasuredPalette {
  readonly swatches: readonly PaletteSwatch[];
  /** Opaque pixels actually examined. Zero means the image was fully transparent. */
  readonly sampled: number;
}

export interface ExtractPaletteOptions {
  /** How many swatches to return. Clamped to the number of distinct clusters found. */
  readonly count?: number;
  readonly maxSamples?: number;
}

/**
 * Walks the image on a stride, skipping anything not effectively opaque.
 *
 * The stride is derived from the pixel count so the sample size is bounded regardless
 * of resolution, and it is the same stride for the same dimensions every time.
 */
function sample(image: RgbaImage, maxSamples: number): readonly Sample[] {
  const total = image.width * image.height;
  if (total === 0) return [];
  const stride = Math.max(1, Math.floor(Math.sqrt(total / Math.max(1, maxSamples))));

  const samples: Sample[] = [];
  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      const offset = (y * image.width + x) * 4;
      const alpha = image.data[offset + 3];
      if (alpha === undefined || alpha < OPAQUE_THRESHOLD) continue;
      const r = image.data[offset] ?? 0;
      const g = image.data[offset + 1] ?? 0;
      const b = image.data[offset + 2] ?? 0;
      samples.push({ r, g, b, lab: rgbToOklab(r, g, b) });
    }
  }
  return samples;
}

/**
 * Below this OKLab distance two colours are the same colour with different
 * antialiasing, and folding them together is what stops a palette from being six
 * shades of the same green.
 */
const MERGE_DISTANCE = 0.06;

interface Cluster {
  readonly hex: string;
  readonly lab: Oklab;
  count: number;
}

/**
 * The dominant colours of an image, largest share first.
 *
 * A frequency histogram with perceptual merging rather than median cut, because this
 * pipeline's art is flat colour: median cut averages across a split and hands back a
 * colour that appears nowhere in the image, which is precisely the wrong answer for a
 * palette a series is going to be drawn in. Merging instead keeps the *actual* most
 * common pixel value as each swatch and folds its near-duplicates into its share.
 *
 * Ties on share break on hex so the ordering is total - two clusters of identical size
 * must not swap places between runs, because the result feeds a `StyleBibleDraft` whose
 * byte-for-byte reproducibility is asserted.
 */
export function extractPalette(
  image: RgbaImage,
  options: ExtractPaletteOptions = {},
): MeasuredPalette {
  const samples = sample(image, options.maxSamples ?? DEFAULT_MAX_SAMPLES);
  if (samples.length === 0) return { swatches: [], sampled: 0 };
  const budget = Math.max(1, options.count ?? 6);

  const histogram = new Map<string, { sample: Sample; count: number }>();
  for (const entry of samples) {
    const hex = toHex(entry.r, entry.g, entry.b);
    const seen = histogram.get(hex);
    if (seen === undefined) histogram.set(hex, { sample: entry, count: 1 });
    else seen.count += 1;
  }

  // Most common first, so the anchors of each cluster are the colours actually used
  // rather than whichever near-duplicate happened to be visited first.
  const ordered = [...histogram.entries()].sort(
    (left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]),
  );

  const clusters: Cluster[] = [];
  for (const [hex, entry] of ordered) {
    let nearest: Cluster | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const cluster of clusters) {
      const distance = oklabDistance(entry.sample.lab, cluster.lab);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = cluster;
      }
    }

    if (nearest !== undefined && (nearestDistance <= MERGE_DISTANCE || clusters.length >= budget)) {
      nearest.count += entry.count;
      continue;
    }
    clusters.push({ hex, lab: entry.sample.lab, count: entry.count });
  }

  const swatches = clusters
    .map((cluster) => ({ hex: cluster.hex, share: cluster.count / samples.length }))
    .sort((left, right) => right.share - left.share || left.hex.localeCompare(right.hex));

  return { swatches, sampled: samples.length };
}

export interface PaletteAdherence {
  /** 0..1. The mean per-pixel closeness to the nearest declared colour. */
  readonly score: number;
  /** Fraction of sampled pixels further than `PALETTE_TOLERANCE` from every colour. */
  readonly offPaletteShare: number;
  readonly sampled: number;
  /** Worst single-pixel distance seen, for diagnosing *what* drifted. */
  readonly worstDistance: number;
}

export interface MeasureAdherenceOptions {
  readonly tolerance?: number;
  readonly maxSamples?: number;
}

/**
 * How closely an image keeps to a declared palette.
 *
 * A graded score rather than a pass/fail count: cel shading legitimately produces
 * colours *between* two palette entries at an antialiased edge, and a hard threshold
 * would fail every image with a soft edge in it. The graded form lets a nearly-right
 * colour cost a little and a wrong one cost everything.
 *
 * An empty palette scores 0 rather than 1 - "no declared colours" is not "everything
 * matches", and returning 1 there would silently pass every asset in a malformed style.
 */
export function measurePaletteAdherence(
  image: RgbaImage,
  palette: readonly string[],
  options: MeasureAdherenceOptions = {},
): PaletteAdherence {
  const tolerance = options.tolerance ?? PALETTE_TOLERANCE;
  const samples = sample(image, options.maxSamples ?? DEFAULT_MAX_SAMPLES);
  if (samples.length === 0 || palette.length === 0) {
    return { score: 0, offPaletteShare: 1, sampled: samples.length, worstDistance: 1 };
  }

  const targets = palette.map((hex) => {
    const { r, g, b } = parseHex(hex);
    return rgbToOklab(r, g, b);
  });

  let total = 0;
  let off = 0;
  let worst = 0;

  for (const entry of samples) {
    let nearest = Number.POSITIVE_INFINITY;
    for (const target of targets) {
      const distance = oklabDistance(entry.lab, target);
      if (distance < nearest) nearest = distance;
    }
    if (nearest > worst) worst = nearest;
    if (nearest > tolerance) off += 1;
    total += Math.max(0, 1 - nearest / tolerance);
  }

  return {
    score: total / samples.length,
    offPaletteShare: off / samples.length,
    sampled: samples.length,
    worstDistance: worst,
  };
}
