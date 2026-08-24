import { describe, expect, it } from 'vitest';
import { isErr, unwrap } from '@rv/shared-kernel';
import type { AssetSpec } from '@rv/contracts';
import { AssetSpec as AssetSpecSchema } from '@rv/contracts';

import { InMemoryBlobStore } from '../__fixtures__/doubles';
import { specFor, testIds, threeBlobSpec } from '../__fixtures__/builders';
import { paintCutout } from '../__fixtures__/images';
import { PngRaster } from '../raster/png-raster';
import { assignComponents, toPlanTargets } from './assign-components';
import { SHEET_ALPHA_THRESHOLD, extractComponent, findComponents } from './connected-components';
import { SplitPartsUseCase } from './split-parts';

const raster = new PngRaster();

/** Three separated blobs: top-left, top-right, bottom-left, on a 120² canvas. */
function threeBlobs(): Promise<{ width: number; height: number; data: Uint8Array }> {
  return paintCutout(120, 120, [
    { x: 10, y: 10, width: 30, height: 30, color: { r: 200, g: 40, b: 40 } },
    { x: 78, y: 10, width: 30, height: 30, color: { r: 40, g: 200, b: 40 } },
    { x: 10, y: 78, width: 30, height: 30, color: { r: 40, g: 40, b: 200 } },
  ]);
}

function harness(): SplitPartsUseCase {
  return new SplitPartsUseCase({ raster, blobs: new InMemoryBlobStore(), ids: testIds() });
}

describe('connected-component segmentation', () => {
  it('finds three components in a three-blob image', async () => {
    const field = findComponents(await threeBlobs());
    expect(field.components).toHaveLength(3);
    expect(field.components.map((component) => component.pixelCount)).toEqual([900, 900, 900]);
  });

  it('never slices the canvas: a blob 30px off the grid is still one component', async () => {
    // The grid is advisory. Two blobs that a 2×1 arithmetic split would cut through are
    // still exactly two components here, whole.
    const image = await paintCutout(100, 40, [
      { x: 35, y: 5, width: 20, height: 30 },
      { x: 70, y: 5, width: 20, height: 30 },
    ]);
    const field = findComponents(image);

    expect(field.components).toHaveLength(2);
    expect(field.components[0]?.bounds).toEqual({ x: 35, y: 5, width: 20, height: 30 });
  });

  it('discards speckle below the area floor and says how much', async () => {
    const image = await paintCutout(100, 100, [
      { x: 10, y: 10, width: 40, height: 40 },
      { x: 90, y: 90, width: 2, height: 2 },
    ]);
    const field = findComponents(image, { minAreaFraction: 0.001 });

    expect(field.components).toHaveLength(1);
    expect(field.discarded).toBe(1);
    // The discarded label is cleared, so a later crop cannot pick it up.
    expect(field.labels[90 * 100 + 90]).toBe(0);
  });

  it('splits a diagonal touch under 4-connectivity and keeps it under 8', async () => {
    const image = await paintCutout(20, 20, [
      { x: 4, y: 4, width: 4, height: 4 },
      { x: 8, y: 8, width: 4, height: 4 },
    ]);
    expect(findComponents(image, { connectivity: 8, minAreaFraction: 0 }).components).toHaveLength(
      1,
    );
    expect(findComponents(image, { connectivity: 4, minAreaFraction: 0 }).components).toHaveLength(
      2,
    );
  });

  it('masks out an overlapping neighbour when cutting a component out', async () => {
    const image = await paintCutout(60, 30, [
      { x: 5, y: 5, width: 20, height: 20, color: { r: 255, g: 0, b: 0 } },
      { x: 35, y: 5, width: 20, height: 20, color: { r: 0, g: 0, b: 255 } },
    ]);
    const field = findComponents(image);
    const first = field.components[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    // Widen the crop so it reaches into the neighbour's territory.
    const cut = extractComponent(image, field, {
      ...first,
      bounds: { x: 5, y: 5, width: 50, height: 20 },
    });
    // Everything past the first blob must be transparent, not blue.
    expect(cut.data[(0 * 50 + 40) * 4 + 3]).toBe(0);
  });
});

describe('assignment', () => {
  it('matches three components to three plans by position and size', async () => {
    const spec = threeBlobSpec();
    const field = findComponents(await threeBlobs());
    const report = assignComponents(
      field.components,
      toPlanTargets(
        spec.parts,
        new Map([
          ['base', 0.25],
          ['segment-1', 0.25],
          ['segment-2', 0.25],
        ]),
      ),
      { width: 120, height: 120 },
    );

    expect(report.complete).toBe(true);
    expect(report.assignments.map((assignment) => assignment.plan.name)).toEqual([
      'base',
      'segment-1',
      'segment-2',
    ]);
  });

  it('reports the mismatch when the plan asked for four and three came back', async () => {
    const spec = fourPartSpec();
    const field = findComponents(await threeBlobs());
    const report = assignComponents(field.components, toPlanTargets(spec.parts, new Map()), {
      width: 120,
      height: 120,
    });

    // Reported, never guessed: three blobs cannot be four parts.
    expect(report.complete).toBe(false);
    expect(report.unfilled.map((plan) => plan.name)).toEqual(['segment-3']);
    expect(report.unmatched).toHaveLength(0);
  });

  it('reports a surplus component rather than forcing it onto a plan', async () => {
    const spec = threeBlobSpec();
    const image = await paintCutout(120, 120, [
      { x: 10, y: 10, width: 30, height: 30 },
      { x: 78, y: 10, width: 30, height: 30 },
      { x: 10, y: 78, width: 30, height: 30 },
      { x: 78, y: 78, width: 30, height: 30 },
    ]);
    const report = assignComponents(
      findComponents(image).components,
      toPlanTargets(spec.parts, new Map()),
      { width: 120, height: 120 },
    );

    expect(report.unmatched).toHaveLength(1);
    expect(report.complete).toBe(false);
  });

  it('refuses a pairing whose cost is beyond the ceiling', async () => {
    const spec = threeBlobSpec();
    const field = findComponents(await threeBlobs());
    const report = assignComponents(
      field.components,
      toPlanTargets(spec.parts, new Map()),
      { width: 120, height: 120 },
      { maxCost: 0.01 },
    );

    // With no acceptable pairing, everything is reported rather than force-matched.
    expect(report.assignments).toHaveLength(0);
    expect(report.unfilled).toHaveLength(3);
    expect(report.unmatched).toHaveLength(3);
  });

  it('forgives an unfilled optional plan', () => {
    const report = assignComponents(
      [],
      [
        {
          name: 'wisp',
          role: 'wisp',
          attachHint: { x: 0.5, y: 0.5 },
          expectedExtent: 0.2,
          optional: true,
        },
      ],
      { width: 100, height: 100 },
    );
    expect(report.complete).toBe(true);
  });

  it('falls back to the canvas centre when a plan carries no attach hint', () => {
    const targets = toPlanTargets(
      [
        {
          name: 'body',
          role: 'body',
          description: 'x',
          zOrder: 0,
          deformable: false,
          optional: false,
        },
      ],
      new Map(),
    );
    expect(targets[0]?.attachHint).toEqual({ x: 0.5, y: 0.5 });
    expect(targets[0]?.expectedExtent).toBe(0.2);
  });
});

describe('SplitPartsUseCase', () => {
  it('produces named parts with measured alpha coverage and a centroid pivot', async () => {
    const output = unwrap(
      await harness().execute({ spec: threeBlobSpec(), image: await threeBlobs() }),
    );

    expect(output.parts.map((part) => part.name)).toEqual(['base', 'segment-1', 'segment-2']);
    for (const part of output.parts) {
      expect(part.alphaCoverage).toBeCloseTo(1, 5);
      expect(part.size).toEqual({ width: 30, height: 30 });
      expect(part.pivot.x).toBeCloseTo(0.483, 2);
      expect(part.imageHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('carries the plan zOrder and deformable flag onto the part', async () => {
    const output = unwrap(
      await harness().execute({ spec: threeBlobSpec(), image: await threeBlobs() }),
    );
    expect(output.parts.map((part) => part.zOrder)).toEqual([0, 1, 2]);
    expect(output.parts.every((part) => !part.deformable)).toBe(true);
  });

  it('fails with parts-count-mismatch in strict mode', async () => {
    const failed = await harness().execute({
      spec: fourPartSpec(),
      image: await threeBlobs(),
      strict: true,
    });

    expect(isErr(failed)).toBe(true);
    if (isErr(failed)) {
      expect(failed.error.message).toBe('parts-count-mismatch');
      expect(failed.error.context.unfilled).toEqual(['segment-3']);
    }
  });

  it('returns the report instead of failing when not strict, so the chain can react', async () => {
    const output = unwrap(
      await harness().execute({ spec: fourPartSpec(), image: await threeBlobs() }),
    );
    expect(output.report.complete).toBe(false);
    expect(output.parts).toHaveLength(3);
  });

  it('registers the whole trimmed canvas as one part on the single-layer path', async () => {
    const output = unwrap(
      await harness().execute({
        spec: threeBlobSpec(),
        image: await paintCutout(120, 120, [{ x: 20, y: 30, width: 40, height: 20 }]),
        decomposition: 'single-layer',
      }),
    );

    expect(output.decomposition).toBe('single-layer');
    expect(output.parts).toHaveLength(1);
    expect(output.parts[0]?.bounds).toEqual({ x: 20, y: 30, width: 40, height: 20 });
    // The two plans it could not fill are named, so the fallback is visible in the record.
    expect(output.report.unfilled.map((plan) => plan.name)).toEqual(['segment-1', 'segment-2']);
  });

  it('falls back to the full canvas when a single-layer image is entirely transparent', async () => {
    const output = unwrap(
      await harness().execute({
        spec: threeBlobSpec(),
        image: await paintCutout(32, 32, []),
        decomposition: 'single-layer',
      }),
    );
    expect(output.parts[0]?.size).toEqual({ width: 32, height: 32 });
  });

  it('reports discarded speckle to the caller', async () => {
    const image = await paintCutout(120, 120, [
      { x: 10, y: 10, width: 30, height: 30 },
      { x: 78, y: 10, width: 30, height: 30 },
      { x: 10, y: 78, width: 30, height: 30 },
      { x: 119, y: 119, width: 1, height: 1 },
    ]);
    const output = unwrap(await harness().execute({ spec: threeBlobSpec(), image }));
    expect(output.discardedComponents).toBe(1);
  });

  it('rejects a spec with no plans on the single-layer path', async () => {
    const spec = { ...threeBlobSpec(), parts: [] } as unknown as AssetSpec;
    expect(
      isErr(
        await harness().execute({
          spec,
          image: await paintCutout(8, 8, [{ x: 1, y: 1, width: 2, height: 2 }]),
          decomposition: 'single-layer',
        }),
      ),
    ).toBe(true);
  });

  it('binds a tree spec so every produced part matches a template role', async () => {
    const spec = specFor('tree', { canvas: { width: 120, height: 120 } });
    const output = unwrap(await harness().execute({ spec, image: await threeBlobs() }));
    const roles = new Set(spec.parts.map((part) => part.role));
    for (const part of output.parts) expect(roles.has(part.role)).toBe(true);
  });
});

/** The three-blob spec plus one more required part, to force a count mismatch. */
function fourPartSpec(): AssetSpec {
  const base = threeBlobSpec();
  return AssetSpecSchema.parse({
    ...base,
    parts: [
      ...base.parts,
      {
        name: 'segment-3',
        role: 'segment-3',
        description: 'a fourth piece the model never drew',
        zOrder: 3,
        attachHint: { x: 0.8, y: 0.8 },
        deformable: false,
        optional: false,
      },
    ],
  });
}

describe('the keyed-sheet alpha threshold', () => {
  /**
   * Two separated blobs welded by a faint alpha bridge.
   *
   * This is what `ThresholdMatting` really leaves behind on a parts sheet: the field
   * between two pieces lands between `tolerance` and `softTolerance` and comes out at
   * alpha 25-191, which is invisible over any background and fully connective. Measured
   * on the live `prop/lamp-cart/laden` take, 10.6 % of the canvas sat in that band and
   * turned nine drawn pieces into one 677x466 component.
   */
  function weldedPair(bridgeAlpha: number): { width: number; height: number; data: Uint8Array } {
    const width = 120;
    const height = 40;
    const data = new Uint8Array(width * height * 4);
    const paint = (x0: number, x1: number, alpha: number): void => {
      for (let y = 12; y < 28; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const at = (y * width + x) * 4;
          data[at] = 40;
          data[at + 1] = 120;
          data[at + 2] = 90;
          data[at + 3] = alpha;
        }
      }
    };
    paint(10, 45, 255);
    paint(75, 110, 255);
    paint(45, 75, bridgeAlpha);
    return { width, height, data };
  }

  it('reads a faint bridge as background, where the default reads it as one part', () => {
    const image = weldedPair(90);

    // The default exists for a learned matte, whose soft edge *is* the silhouette.
    expect(findComponents(image).components).toHaveLength(1);
    // The sheet threshold sees the two pieces the model actually drew.
    expect(
      findComponents(image, { alphaThreshold: SHEET_ALPHA_THRESHOLD }).components,
    ).toHaveLength(2);
  });

  it('still keeps a piece whose own edge is antialiased', () => {
    // Only the interior has to clear the bar; a 1 px rim below it is not a part.
    const image = weldedPair(0);
    const components = findComponents(image, { alphaThreshold: SHEET_ALPHA_THRESHOLD }).components;

    expect(components).toHaveLength(2);
    for (const component of components) expect(component.pixelCount).toBeGreaterThan(400);
  });

  it('is a plateau, not a knife edge', () => {
    // 160 was picked because the live sweep saturated there and stayed saturated to 224.
    const image = weldedPair(90);
    for (const threshold of [128, SHEET_ALPHA_THRESHOLD, 224]) {
      expect(findComponents(image, { alphaThreshold: threshold }).components).toHaveLength(2);
    }
  });
});

describe('structural checks on the parts it produced', () => {
  /**
   * The same three blobs, with their corners keyed away.
   *
   * Worth saying out loud: `threeBlobs()` - the fixture most of this file is written
   * against - is three axis-aligned rectangles, and structurally that is exactly what an
   * unkeyed photograph looks like. Real artwork almost never has a rectangular
   * silhouette, so the clean case has to be built rather than borrowed.
   */
  async function keyedBlobs(): Promise<{ width: number; height: number; data: Uint8Array }> {
    const image = await threeBlobs();
    const data = new Uint8Array(image.data);
    for (const blob of [
      { x: 10, y: 10 },
      { x: 78, y: 10 },
      { x: 10, y: 78 },
    ]) {
      for (let dy = 0; dy < 8; dy += 1) {
        for (let dx = 0; dx + dy < 8; dx += 1) {
          for (const [cx, cy] of [
            [blob.x + dx, blob.y + dy],
            [blob.x + 29 - dx, blob.y + dy],
            [blob.x + dx, blob.y + 29 - dy],
            [blob.x + 29 - dx, blob.y + 29 - dy],
          ] as const) {
            data[(cy * image.width + cx) * 4 + 3] = 0;
          }
        }
      }
    }
    return { width: image.width, height: image.height, data };
  }

  it('reports the structure alongside the assignment, always', async () => {
    const output = unwrap(
      await harness().execute({ spec: threeBlobSpec(), image: await keyedBlobs() }),
    );
    expect(output.structure.inspectedParts).toBe(3);
    expect(output.structure.errorCount).toBe(0);
  });

  it('refuses a split whose parts were never cut out, under strict', async () => {
    const failed = await harness().execute({
      spec: threeBlobSpec(),
      image: await threeBlobs(),
      strict: true,
    });

    expect(isErr(failed)).toBe(true);
    if (!isErr(failed)) return;
    expect(failed.error.message).toBe('parts-structurally-invalid');
    const context = failed.error.context as { findings: { code: string }[] };
    expect(context.findings.map((finding) => finding.code)).toContain('part.corners-opaque');
  });

  it('lets the same split through when not strict, so a fallback chain can react', async () => {
    const output = unwrap(
      await harness().execute({ spec: threeBlobSpec(), image: await threeBlobs() }),
    );
    expect(output.parts).toHaveLength(3);
    expect(output.structure.errorCount).toBeGreaterThan(0);
  });

  it('honours structural bounds the caller widens, rather than hard-coding a policy', async () => {
    const output = unwrap(
      await harness().execute({
        spec: threeBlobSpec(),
        image: await threeBlobs(),
        strict: true,
        structureOptions: { maxOpaqueCorners: 4, maxAlphaCoverage: 1 },
      }),
    );
    expect(output.structure.errorCount).toBe(0);
  });

  it('checks a single-layer fallback too, which is where a whole canvas gets through', async () => {
    const output = unwrap(
      await harness().execute({
        spec: threeBlobSpec(),
        image: await keyedBlobs(),
        decomposition: 'single-layer',
      }),
    );
    expect(output.structure.inspectedParts).toBe(1);
  });
});
