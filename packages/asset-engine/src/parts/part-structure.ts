/**
 * Is this actually a part, or is it a rectangle of the sheet with a name on it?
 *
 * The vision gate answers "does this look like the style". Nothing answered "is this
 * structurally a decomposition at all", and the difference is not academic. In
 * `workspace/produce-demo/prop_street-lamp_terrace` the generator returned a 2x2 contact
 * sheet of **photographs**, the matte keyed nothing, the segmenter found four clean
 * components - one per photograph - the assigner named them `base`, `segment-1`,
 * `segment-2`, `tip` by where they sat, and the rigger fitted four bones and an IK chain
 * to them. The recorded run says `4/4 parts`, `unfilled: []`, `alphaCoverage` between
 * 0.948 and 0.9995, and `part-4-tip.png` is a photograph of two doorways.
 *
 * Every number in that run was internally consistent. What nobody measured was the
 * artefact: a keyed cutout has transparent corners, and every one of those four "parts"
 * has at least one fully opaque corner - `segment-2` has all four - because nothing was
 * ever cut out of anything.
 *
 * ## The checks, and how much each one is worth
 *
 * - **`part.corners-opaque`** is the decisive one, and it is close to a fact rather than
 *   a threshold: a part's bounding box is the tightest box around its component, so its
 *   corners are background unless the component reaches into them - which for a keyed
 *   cutout means the key did nothing there. It fires on all four lamp "parts", where the
 *   coverage band catches only three.
 * - **`part.fills-source-canvas`** is arithmetic and should never have needed writing.
 *   `prop_wick-key_brass/part-1-body.png` is byte-identical to the canvas it was cut
 *   from, right down to the file size.
 * - **`parts.count-mismatch`** compares what segmentation found against what the sheet
 *   asked for. It would *not* have caught the lamp - four asked, four found - and saying
 *   so is more useful than implying otherwise.
 * - **`part.alpha-coverage-out-of-band`** is an empirical prior, not a derivation, and it
 *   is a warning for that reason. On the live data a legitimate single-layer prop scores
 *   0.8816 and the fake lamp parts score 0.9483 to 0.9995, so a ceiling that separates
 *   them cleanly does not exist; the default catches three of the four and the corner
 *   check catches all four.
 * - **`part.duplicate`** catches the same pixels emitted twice, by content hash for an
 *   exact repeat and by a downsampled signature for the same region cut a pixel or two
 *   differently.
 */

import { at } from '@rv/shared-kernel';
import type { Part, Size } from '@rv/contracts';

import type { RgbaImage } from '../ports/raster-port';
import { alphaCoverage } from '../raster/alpha';
import { at32, px } from '../raster/pixels';

/** Stable and greppable, in the same shape as the animation geometry findings. */
export const PART_STRUCTURE_CODES = [
  'parts.count-mismatch',
  'part.fills-source-canvas',
  'part.corners-opaque',
  'part.alpha-coverage-out-of-band',
  'part.duplicate',
] as const;
export type PartStructureCode = (typeof PART_STRUCTURE_CODES)[number];

export type PartStructureSeverity = 'error' | 'warning';

/**
 * How much each check is worth, as data.
 *
 * `part.alpha-coverage-out-of-band` is a warning because its bounds are a prior drawn
 * from a handful of live takes rather than a consequence of anything; the rest are
 * errors because each of them is a statement about the artefact that cannot be true of a
 * real decomposition.
 */
export const PART_STRUCTURE_SEVERITIES: Readonly<Record<PartStructureCode, PartStructureSeverity>> =
  {
    'parts.count-mismatch': 'error',
    'part.fills-source-canvas': 'error',
    'part.corners-opaque': 'error',
    'part.alpha-coverage-out-of-band': 'warning',
    'part.duplicate': 'error',
  };

export type PartStructureUnit = 'count' | 'fraction' | 'bits';

export interface PartStructureFinding {
  readonly code: PartStructureCode;
  readonly severity: PartStructureSeverity;
  /** The part at fault. Absent when the finding is about the set as a whole. */
  readonly partName?: string;
  /** The other part, for a duplicate pairing. */
  readonly relatedPartName?: string;
  /** What was measured on the artefact. */
  readonly measured: number;
  /** The bound it crossed, or the value it should have equalled. */
  readonly expected: number;
  readonly unit: PartStructureUnit;
}

export interface PartStructureReport {
  readonly findings: readonly PartStructureFinding[];
  readonly inspectedParts: number;
  readonly errorCount: number;
  readonly warningCount: number;
}

/** A part together with the pixels it was cut as - the check measures the pixels. */
export interface MeasuredPart {
  readonly part: Part;
  readonly image: RgbaImage;
}

export interface PartStructureOptions {
  /**
   * Coverage below which a part is almost certainly a matting failure.
   *
   * `Part.alphaCoverage` in `@rv/contracts` already names the case - "a wing that covers
   * 2 % of its box is almost certainly a matting failure" - and 0.05 is that with room
   * for a genuinely thin diagonal part.
   */
  readonly minAlphaCoverage?: number;
  /** Coverage above which a part is suspiciously close to a solid rectangle. */
  readonly maxAlphaCoverage?: number;
  /**
   * Share of the source canvas a single part may occupy.
   *
   * A sheet holds parts *and* the field between them, so one component covering nearly
   * all of it means nothing was separated from anything.
   */
  readonly maxCanvasFraction?: number;
  /**
   * How many bounding-box corners may be opaque before the part is suspect.
   *
   * Zero, which is the convention `cornersAreTransparent` already encodes: the bounding
   * box is the tightest box around the component, so its corners are background unless
   * the component reaches into them. A genuinely wedge-shaped part - a fin, a sail - can
   * legitimately fill one, and a project full of those raises this rather than losing the
   * check.
   */
  readonly maxOpaqueCorners?: number;
  /** Signature bits, out of 768, within which two parts count as the same pixels. */
  readonly duplicateBits?: number;
}

const DEFAULT_MIN_ALPHA_COVERAGE = 0.05;
const DEFAULT_MAX_ALPHA_COVERAGE = 0.98;
const DEFAULT_MAX_CANVAS_FRACTION = 0.98;
const DEFAULT_MAX_OPAQUE_CORNERS = 0;
/**
 * Sixteen bits of 768, and the number is measured rather than chosen.
 *
 * The question is "did the splitter emit the same region twice", not "do these look
 * alike", so the threshold has to sit in the gap between a cut that moved slightly and
 * two parts that are genuinely different. Measured on the fixtures in
 * `part-structure.spec.ts`, over the 16x16 grid this signature uses:
 *
 * | pair                                         | distance |
 * | -------------------------------------------- | -------- |
 * | identical pixels                             | 0        |
 * | the same cut, shifted 1 px                   | 0        |
 * | the same cut, shifted 3 px                   | 12       |
 * | unrelated shapes                             | 67       |
 * | the same silhouette in a different flat colour | 100    |
 * | a keyed cutout against a solid rectangle     | 372      |
 *
 * 16 accepts everything on the near side of that gap and nothing on the far side, with
 * roughly a factor of four of headroom in both directions.
 */
const DEFAULT_DUPLICATE_BITS = 16;

export interface PartStructureInput {
  readonly parts: readonly MeasuredPart[];
  /** The canvas the parts were cut out of. */
  readonly canvas: Size;
  /**
   * What the sheet asked for and what segmentation actually found.
   *
   * Both or neither: a `single-layer` fallback has no component count to compare, and
   * inventing one would turn every deliberate fallback into a finding.
   */
  readonly expectedComponents?: number;
  readonly foundComponents?: number;
  readonly options?: PartStructureOptions;
}

/**
 * Measures the parts a splitter produced and reports what cannot be true of a real one.
 *
 * Deterministic and pure: same pixels in, same findings out, in the same order.
 */
export function checkPartStructure(input: PartStructureInput): PartStructureReport {
  const options = input.options ?? {};
  const minCoverage = options.minAlphaCoverage ?? DEFAULT_MIN_ALPHA_COVERAGE;
  const maxCoverage = options.maxAlphaCoverage ?? DEFAULT_MAX_ALPHA_COVERAGE;
  const maxCanvasFraction = options.maxCanvasFraction ?? DEFAULT_MAX_CANVAS_FRACTION;
  const maxOpaqueCorners = options.maxOpaqueCorners ?? DEFAULT_MAX_OPAQUE_CORNERS;
  const duplicateBits = options.duplicateBits ?? DEFAULT_DUPLICATE_BITS;

  const findings: PartStructureFinding[] = [];
  const add = (finding: Omit<PartStructureFinding, 'severity'>): void => {
    findings.push({ ...finding, severity: PART_STRUCTURE_SEVERITIES[finding.code] });
  };

  const expected = input.expectedComponents;
  const found = input.foundComponents;
  if (expected !== undefined && found !== undefined && expected !== found) {
    add({ code: 'parts.count-mismatch', measured: found, expected, unit: 'count' });
  }

  const canvasArea = input.canvas.width * input.canvas.height;
  for (const measured of input.parts) {
    const { part, image } = measured;

    const fraction = canvasArea === 0 ? 0 : (part.bounds.width * part.bounds.height) / canvasArea;
    if (fraction >= maxCanvasFraction) {
      add({
        code: 'part.fills-source-canvas',
        partName: part.name,
        measured: fraction,
        expected: maxCanvasFraction,
        unit: 'fraction',
      });
    }

    const corners = opaqueCorners(image);
    if (corners > maxOpaqueCorners) {
      add({
        code: 'part.corners-opaque',
        partName: part.name,
        measured: corners,
        expected: maxOpaqueCorners,
        unit: 'count',
      });
    }

    // Measured here rather than trusted from `part.alphaCoverage`: the whole principle is
    // that a claim about an artefact is checked against the artefact.
    const coverage = alphaCoverage(image);
    if (coverage < minCoverage || coverage > maxCoverage) {
      add({
        code: 'part.alpha-coverage-out-of-band',
        partName: part.name,
        measured: coverage,
        expected: coverage < minCoverage ? minCoverage : maxCoverage,
        unit: 'fraction',
      });
    }
  }

  for (const duplicate of findDuplicates(input.parts, duplicateBits)) add(duplicate);

  return {
    findings,
    inspectedParts: input.parts.length,
    errorCount: findings.filter((finding) => finding.severity === 'error').length,
    warningCount: findings.filter((finding) => finding.severity === 'warning').length,
  };
}

/** How many of the four corners are not fully transparent. Reported, not just tested. */
function opaqueCorners(image: RgbaImage): number {
  const { width, height, data } = image;
  const corners = [0, width - 1, (height - 1) * width, height * width - 1];
  return corners.filter((index) => px(data, index * 4 + 3) > 0).length;
}

function findDuplicates(
  parts: readonly MeasuredPart[],
  bits: number,
): readonly Omit<PartStructureFinding, 'severity'>[] {
  const signatures = parts.map((measured) => partSignature(measured.image));
  const findings: Omit<PartStructureFinding, 'severity'>[] = [];

  for (let left = 0; left < parts.length; left += 1) {
    for (let right = left + 1; right < parts.length; right += 1) {
      const a = at(parts, left);
      const b = at(parts, right);
      const distance =
        a.part.imageHash === b.part.imageHash
          ? 0
          : signatureDistance(at(signatures, left), at(signatures, right));
      if (distance > bits) continue;
      findings.push({
        code: 'part.duplicate',
        partName: a.part.name,
        relatedPartName: b.part.name,
        measured: distance,
        expected: bits,
        unit: 'bits',
      });
    }
  }
  return findings;
}

/**
 * A 16x16 grid, not 8x8.
 *
 * Resolution decides whether the threshold means anything. On an 8x8 grid a sparse part
 * lights only a handful of cells, so two entirely unrelated shapes measured eight bits
 * apart - against a duplicate threshold of four, which is not a margin anybody should
 * trust. At 16x16 the same pair is tens of bits apart and the gap is wide enough to sit
 * a threshold in. The cost is one pass over pixels the caller already holds.
 */
const SIGNATURE_CELLS = 16;

/**
 * A 768-bit fingerprint: 256 bits of alpha shape, 512 of alpha-weighted brightness.
 *
 * Both halves are measured against **absolute** levels rather than against the image's
 * own mean, which is the correction to the obvious design. A classic average hash asks
 * "is this cell brighter than this image's average", and is therefore blind by
 * construction to a uniform change of level: a red wing and a black wing of the same
 * silhouette hash identically under it, and this check would then call them the same
 * pixels. What is wanted here is a fingerprint of "the same region, cut twice", not a
 * perceptual similarity score, and for that question absolute levels are the right
 * question to ask.
 *
 * Alpha gets one bit per cell against mid-opacity; brightness gets two, quantised to
 * quarters of the range - enough to separate flat colours, coarse enough to ignore the
 * sub-level noise of a re-encode. Weighting brightness by alpha stops the transparent
 * field voting, so a signature depends on the part rather than on how much empty box
 * happens to surround it.
 *
 * Cells are assigned by scaling each pixel's coordinate, so the signature is defined for
 * an image of any size including one narrower than the grid.
 */
export function partSignature(image: RgbaImage): string {
  const cells = SIGNATURE_CELLS * SIGNATURE_CELLS;
  const alphaSum = new Float64Array(cells);
  const lumaSum = new Float64Array(cells);
  const counts = new Float64Array(cells);

  for (let y = 0; y < image.height; y += 1) {
    const row = Math.min(SIGNATURE_CELLS - 1, Math.floor((y * SIGNATURE_CELLS) / image.height));
    for (let x = 0; x < image.width; x += 1) {
      const column = Math.min(SIGNATURE_CELLS - 1, Math.floor((x * SIGNATURE_CELLS) / image.width));
      const cell = row * SIGNATURE_CELLS + column;
      const index = (y * image.width + x) * 4;
      const alpha = px(image.data, index + 3);
      const luma =
        0.299 * px(image.data, index) +
        0.587 * px(image.data, index + 1) +
        0.114 * px(image.data, index + 2);
      // `at32` rather than `?? 0`: every index here is derived from the grid's own
      // dimensions, so an out-of-range read is a bug in the arithmetic and not a case to
      // handle - the same bargain `raster/pixels.ts` documents for the pixel reads.
      alphaSum[cell] = at32(alphaSum, cell) + alpha;
      lumaSum[cell] = at32(lumaSum, cell) + (luma * alpha) / 255;
      counts[cell] = at32(counts, cell) + 1;
    }
  }

  return toHex([
    ...cellMeans(alphaSum, counts).map((value) => value > 127),
    ...cellMeans(lumaSum, counts).flatMap((value) => {
      const level = Math.min(3, Math.floor(value / 64));
      return [level >= 2, (level & 1) === 1];
    }),
  ]);
}

/** Per-cell mean, with an empty cell reading zero rather than dividing by nothing. */
function cellMeans(sums: Float64Array, counts: Float64Array): number[] {
  return Array.from(sums, (sum, cell) => {
    const count = at32(counts, cell);
    return count === 0 ? 0 : sum / count;
  });
}

function toHex(bits: readonly boolean[]): string {
  let out = '';
  for (let start = 0; start < bits.length; start += 4) {
    let nibble = 0;
    for (let offset = 0; offset < 4; offset += 1) {
      nibble = (nibble << 1) | (bits[start + offset] === true ? 1 : 0);
    }
    out += nibble.toString(16);
  }
  return out;
}

const NIBBLE_BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4] as const;

/** Hamming distance between two {@link partSignature} strings, in bits. */
export function signatureDistance(left: string, right: string): number {
  let distance = 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = Number.parseInt(left.charAt(index) || '0', 16);
    const b = Number.parseInt(right.charAt(index) || '0', 16);
    distance += NIBBLE_BITS[(a ^ b) & 0xf] ?? 0;
  }
  return distance;
}
