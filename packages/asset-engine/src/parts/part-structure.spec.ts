import { describe, expect, it } from 'vitest';
import { at } from '@rv/shared-kernel';
import type { Part } from '@rv/contracts';

import { paintCutout, solid } from '../__fixtures__/images';
import type { RgbaImage } from '../ports/raster-port';
import {
  PART_STRUCTURE_CODES,
  PART_STRUCTURE_SEVERITIES,
  checkPartStructure,
  partSignature,
  signatureDistance,
  type MeasuredPart,
  type PartStructureCode,
  type PartStructureFinding,
} from './part-structure';

const CANVAS = { width: 200, height: 200 };

/** A properly keyed part: opaque shape, transparent corners, room to breathe. */
function cutout(colour = { r: 20, g: 90, b: 40 }): Promise<RgbaImage> {
  return paintCutout(100, 100, [{ x: 15, y: 15, width: 70, height: 70, color: colour }]);
}

/** What the lamp's "parts" are: a rectangle of source image, nothing keyed. */
function photograph(): RgbaImage {
  return solid(100, 100, { r: 130, g: 120, b: 110, a: 255 });
}

function measuredPart(
  image: RgbaImage,
  overrides: Partial<Part> & { readonly name: string },
): MeasuredPart {
  return {
    image,
    part: {
      id: 'prt_01J8ZQ4E7K9M2N4P6R8T0VAA01',
      role: overrides.name,
      imageHash: overrides.name.padEnd(64, '0'),
      bounds: { x: 10, y: 10, width: image.width, height: image.height },
      size: { width: image.width, height: image.height },
      pivot: { x: 0.5, y: 0.5 },
      zOrder: 0,
      deformable: false,
      alphaCoverage: 0.5,
      ...overrides,
    },
  };
}

function codes(findings: readonly PartStructureFinding[]): readonly PartStructureCode[] {
  return findings.map((finding) => finding.code);
}

function only(
  findings: readonly PartStructureFinding[],
  code: PartStructureCode,
): readonly PartStructureFinding[] {
  return findings.filter((finding) => finding.code === code);
}

describe('a decomposition that is what it claims to be', () => {
  it('reports nothing about parts that were genuinely cut out', async () => {
    const report = checkPartStructure({
      parts: [
        measuredPart(await cutout({ r: 200, g: 40, b: 40 }), { name: 'base' }),
        measuredPart(await paintCutout(90, 60, [{ x: 5, y: 20, width: 40, height: 20 }]), {
          name: 'arm',
        }),
      ],
      canvas: CANVAS,
      expectedComponents: 2,
      foundComponents: 2,
    });
    expect(report.findings).toEqual([]);
    expect(report.inspectedParts).toBe(2);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(0);
  });

  it('answers identically twice, because a gate that drifts is not a gate', async () => {
    const parts = [measuredPart(await cutout(), { name: 'base' })];
    expect(checkPartStructure({ parts, canvas: CANVAS })).toEqual(
      checkPartStructure({ parts, canvas: CANVAS }),
    );
  });
});

describe('the street-lamp failure: four photographs named as parts', () => {
  it('reports a part whose bounding-box corners were never keyed', async () => {
    const report = checkPartStructure({
      parts: [
        measuredPart(photograph(), { name: 'tip' }),
        measuredPart(await cutout(), { name: 'base' }),
      ],
      canvas: CANVAS,
    });

    const corners = only(report.findings, 'part.corners-opaque');
    expect(corners).toHaveLength(1);
    expect(at(corners, 0).partName).toBe('tip');
    expect(at(corners, 0).measured).toBe(4);
    expect(at(corners, 0).severity).toBe('error');
  });

  it('fires on a single opaque corner, which is what the live take actually had', async () => {
    // Three of the four lamp "parts" had exactly one opaque corner - the model's
    // vignette made the others slightly transparent. A check that waited for all four
    // would have caught one part in four.
    const oneCorner = await paintCutout(100, 100, [{ x: 0, y: 0, width: 40, height: 40 }]);
    const report = checkPartStructure({
      parts: [measuredPart(oneCorner, { name: 'wedge' })],
      canvas: CANVAS,
    });
    expect(at(only(report.findings, 'part.corners-opaque'), 0).measured).toBe(1);
  });

  it('lets a project with genuinely wedge-shaped parts raise the bar deliberately', async () => {
    const oneCorner = await paintCutout(100, 100, [{ x: 0, y: 0, width: 40, height: 40 }]);
    const report = checkPartStructure({
      parts: [measuredPart(oneCorner, { name: 'fin' })],
      canvas: CANVAS,
      options: { maxOpaqueCorners: 1 },
    });
    expect(codes(report.findings)).not.toContain('part.corners-opaque');
  });

  it('also flags the coverage, but only as a warning, because the band is a prior', () => {
    const report = checkPartStructure({
      parts: [measuredPart(photograph(), { name: 'tip' })],
      canvas: CANVAS,
    });
    const coverage = only(report.findings, 'part.alpha-coverage-out-of-band');
    expect(at(coverage, 0).severity).toBe('warning');
    expect(at(coverage, 0).measured).toBe(1);
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(1);
  });
});

describe('the wick-key failure: the canvas handed back as a part', () => {
  it('reports a part whose bounds are the sheet it was cut from', async () => {
    const report = checkPartStructure({
      parts: [
        measuredPart(await paintCutout(200, 200, [{ x: 10, y: 10, width: 180, height: 180 }]), {
          name: 'body',
          bounds: { x: 0, y: 0, width: 200, height: 200 },
        }),
      ],
      canvas: CANVAS,
    });
    const filled = only(report.findings, 'part.fills-source-canvas');
    expect(filled).toHaveLength(1);
    expect(at(filled, 0).measured).toBeCloseTo(1, 9);
    expect(at(filled, 0).severity).toBe('error');
  });

  it('says nothing about a part that leaves the sheet room for its siblings', async () => {
    const report = checkPartStructure({
      parts: [
        measuredPart(await cutout(), {
          name: 'body',
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        }),
      ],
      canvas: CANVAS,
    });
    expect(codes(report.findings)).not.toContain('part.fills-source-canvas');
  });

  it('does not divide by a canvas of no area', async () => {
    const report = checkPartStructure({
      parts: [measuredPart(await cutout(), { name: 'body' })],
      canvas: { width: 0, height: 0 },
    });
    expect(codes(report.findings)).not.toContain('part.fills-source-canvas');
  });
});

describe('component counts', () => {
  it('reports the sheet finding a different number of pieces than were asked for', async () => {
    const report = checkPartStructure({
      parts: [measuredPart(await cutout(), { name: 'base' })],
      canvas: CANVAS,
      expectedComponents: 4,
      foundComponents: 6,
    });
    const mismatch = only(report.findings, 'parts.count-mismatch');
    expect(mismatch).toHaveLength(1);
    expect(at(mismatch, 0).measured).toBe(6);
    expect(at(mismatch, 0).expected).toBe(4);
    expect(at(mismatch, 0).partName).toBeUndefined();
  });

  it('would not have caught the street lamp, which asked for four and found four', async () => {
    // Stated as a test rather than as a comment, because the value of the other checks
    // depends on this one being known to be blind here.
    const report = checkPartStructure({
      parts: [measuredPart(await cutout(), { name: 'base' })],
      canvas: CANVAS,
      expectedComponents: 4,
      foundComponents: 4,
    });
    expect(codes(report.findings)).not.toContain('parts.count-mismatch');
  });

  it('does not invent a count for a single-layer fallback that has none', async () => {
    const report = checkPartStructure({
      parts: [measuredPart(await cutout(), { name: 'base' })],
      canvas: CANVAS,
      expectedComponents: 4,
    });
    expect(codes(report.findings)).not.toContain('parts.count-mismatch');
  });
});

describe('alpha coverage', () => {
  it('reports a part that is almost entirely transparent as a matting failure', async () => {
    const speck = await paintCutout(100, 100, [{ x: 1, y: 1, width: 4, height: 4 }]);
    const report = checkPartStructure({
      parts: [measuredPart(speck, { name: 'wing' })],
      canvas: CANVAS,
    });
    const coverage = only(report.findings, 'part.alpha-coverage-out-of-band');
    expect(at(coverage, 0).measured).toBeCloseTo(0.0016, 6);
    expect(at(coverage, 0).expected).toBe(0.05);
  });

  it('accepts a band the caller widens on purpose', async () => {
    const speck = await paintCutout(100, 100, [{ x: 1, y: 1, width: 4, height: 4 }]);
    const report = checkPartStructure({
      parts: [measuredPart(speck, { name: 'wing' })],
      canvas: CANVAS,
      options: { minAlphaCoverage: 0.001, maxAlphaCoverage: 1 },
    });
    expect(codes(report.findings)).not.toContain('part.alpha-coverage-out-of-band');
  });

  it('measures the pixels rather than trusting what the part record claims', () => {
    // The whole principle: `Part.alphaCoverage` says 0.5 here and the image says 1.0.
    const report = checkPartStructure({
      parts: [measuredPart(photograph(), { name: 'tip', alphaCoverage: 0.5 })],
      canvas: CANVAS,
    });
    expect(at(only(report.findings, 'part.alpha-coverage-out-of-band'), 0).measured).toBe(1);
  });
});

describe('duplicates', () => {
  it('reports the same blob emitted twice, and names both parts', async () => {
    const image = await cutout();
    const report = checkPartStructure({
      parts: [
        measuredPart(image, { name: 'left-wing' }),
        measuredPart(image, { name: 'right-wing' }),
      ],
      canvas: CANVAS,
    });
    const duplicates = only(report.findings, 'part.duplicate');
    expect(duplicates).toHaveLength(1);
    expect(at(duplicates, 0).partName).toBe('left-wing');
    expect(at(duplicates, 0).relatedPartName).toBe('right-wing');
    expect(at(duplicates, 0).measured).toBe(0);
  });

  it('reports two parts stored under one hash without looking at a pixel', async () => {
    const report = checkPartStructure({
      parts: [
        measuredPart(await cutout({ r: 10, g: 10, b: 200 }), {
          name: 'left',
          imageHash: 'a'.repeat(64),
        }),
        measuredPart(await paintCutout(40, 90, [{ x: 2, y: 2, width: 8, height: 60 }]), {
          name: 'right',
          imageHash: 'a'.repeat(64),
        }),
      ],
      canvas: CANVAS,
    });
    expect(only(report.findings, 'part.duplicate')).toHaveLength(1);
  });

  it('leaves genuinely different parts of one asset alone', async () => {
    const report = checkPartStructure({
      parts: [
        measuredPart(await cutout(), { name: 'body' }),
        measuredPart(await paintCutout(40, 90, [{ x: 2, y: 2, width: 8, height: 60 }]), {
          name: 'antenna',
        }),
      ],
      canvas: CANVAS,
    });
    expect(codes(report.findings)).not.toContain('part.duplicate');
  });
});

describe('partSignature', () => {
  it('is 768 bits, so the distance has room for a threshold to sit in', async () => {
    expect(partSignature(await cutout())).toHaveLength(192);
  });

  it('is identical for identical pixels', async () => {
    expect(signatureDistance(partSignature(await cutout()), partSignature(await cutout()))).toBe(0);
  });

  it('barely moves for the same region cut a few pixels differently', async () => {
    const first = await paintCutout(100, 100, [{ x: 15, y: 15, width: 70, height: 70 }]);
    const shifted = await paintCutout(100, 100, [{ x: 18, y: 15, width: 70, height: 70 }]);
    // The near side of the gap the duplicate threshold sits in.
    expect(signatureDistance(partSignature(first), partSignature(shifted))).toBeLessThanOrEqual(16);
  });

  it('moves a long way between unrelated shapes, which is what makes 16 a threshold', async () => {
    const blob = await paintCutout(100, 100, [{ x: 60, y: 60, width: 35, height: 35 }]);
    const strip = await paintCutout(100, 100, [{ x: 0, y: 45, width: 100, height: 10 }]);
    // Four times the threshold away, so the two sides of the gap are not neighbours.
    expect(signatureDistance(partSignature(blob), partSignature(strip))).toBeGreaterThan(64);
  });

  it('tells two identically shaped parts apart by their colour', async () => {
    const red = await cutout({ r: 220, g: 20, b: 20 });
    const dark = await cutout({ r: 10, g: 10, b: 10 });
    // The alpha halves agree exactly; only the luma half can separate these, which is
    // why the signature carries both. A left and a right wing are this case.
    expect(signatureDistance(partSignature(red), partSignature(dark))).toBeGreaterThan(64);
  });

  it('is defined for an image narrower than the cell grid', () => {
    expect(partSignature(solid(3, 3, { r: 10, g: 20, b: 30, a: 255 }))).toHaveLength(192);
  });

  it('treats the missing tail of a short signature as zero rather than crashing', () => {
    expect(signatureDistance('00', 'ffff')).toBe(16);
    expect(signatureDistance('ffff', '00')).toBe(16);
    expect(signatureDistance('ff00', 'ff')).toBe(0);
  });
});

describe('severities', () => {
  it('classifies every declared code, so no finding can arrive without one', () => {
    expect(Object.keys(PART_STRUCTURE_SEVERITIES).sort()).toEqual([...PART_STRUCTURE_CODES].sort());
  });

  it('counts errors and warnings separately, because only one should stop a pipeline', () => {
    const report = checkPartStructure({
      parts: [measuredPart(photograph(), { name: 'tip' })],
      canvas: CANVAS,
      expectedComponents: 1,
      foundComponents: 3,
    });
    expect(report.errorCount).toBe(2);
    expect(report.warningCount).toBe(1);
  });
});
