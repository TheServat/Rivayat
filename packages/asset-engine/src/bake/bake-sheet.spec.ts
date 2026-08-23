import { describe, expect, it } from 'vitest';
import type { AnimationClip, Part, Sha256Hex } from '@rv/contracts';
import { isErr, sha256, unwrap } from '@rv/shared-kernel';

import { InMemoryBlobStore } from '../__fixtures__/doubles';
import { specFor, styleBible, testClock, testIds } from '../__fixtures__/builders';
import { paintCutout, solid } from '../__fixtures__/images';
import { PngRaster } from '../raster/png-raster';
import type { RgbaImage } from '../ports/raster-port';
import { buildClipIr } from '../clips/build-clip-ir';
import { BakeSheetUseCase, type BakeSheetInput } from './bake-sheet';
import { drawAffine, identityMatrix, multiply, placementMatrix } from './rasterise';

const raster = new PngRaster();

async function scene(): Promise<{ parts: Part[]; images: Map<Sha256Hex, RgbaImage> }> {
  const ids = testIds();
  const images = new Map<Sha256Hex, RgbaImage>();
  const parts: Part[] = [];

  for (const [index, role] of ['trunk', 'canopy'].entries()) {
    const bitmap = await paintCutout(24, 24, [{ x: 2, y: 2, width: 20, height: 20 }]);
    const hash: Sha256Hex = String(index).repeat(64).slice(0, 64);
    images.set(hash, bitmap);
    parts.push({
      id: ids.part(),
      name: role,
      role,
      imageHash: hash,
      bounds: { x: 20 + index * 30, y: 20 + index * 20, width: 24, height: 24 },
      size: { width: 24, height: 24 },
      pivot: { x: 0.5, y: 0.5 },
      zOrder: index,
      deformable: role === 'canopy',
      alphaCoverage: 0.69,
    });
  }

  return { parts, images };
}

async function bakeInput(overrides: Partial<BakeSheetInput> = {}): Promise<BakeSheetInput> {
  const style = styleBible();
  const spec = specFor('tree', { canvas: { width: 96, height: 96 } });
  const { ir } = buildClipIr({
    archetype: 'tree',
    clipName: 'sway',
    motion: style.motion,
    styleSeed: style.seed,
    sceneSpace: spec.canvas,
    nominalHeight: spec.nominalHeight,
    deformableRoles: ['canopy'],
  });
  const { parts, images } = await scene();

  const clip: AnimationClip = {
    id: testIds().clip(),
    name: 'sway',
    source: 'template',
    durationMs: ir.durationMs,
    fps: ir.fps,
    loop: 'loop',
    irHash: 'e'.repeat(64),
    tags: [],
    provenance: {
      source: 'derived',
      parents: [],
      createdAt: '2026-08-23T00:00:00.000Z',
      costNanoUsd: 0,
    },
  };

  return {
    clip,
    ir,
    parts,
    images,
    canvas: spec.canvas,
    motion: style.motion,
    settings: { frames: 4, maxSize: 256, padding: 2, trim: true },
    ...overrides,
  };
}

function useCase(): { bake: BakeSheetUseCase; blobs: InMemoryBlobStore } {
  const blobs = new InMemoryBlobStore();
  return { bake: new BakeSheetUseCase({ raster, blobs, clock: testClock() }), blobs };
}

describe('BakeSheetUseCase', () => {
  it('emits an atlas image and an atlas json, with every rect inside the bounds', async () => {
    const { bake } = useCase();
    const output = unwrap(await bake.execute(await bakeInput()));

    expect(output.pages).toHaveLength(1);
    const page = output.pages[0];
    expect(page).toBeDefined();
    if (page === undefined) return;

    expect(page.frameCount).toBe(4);
    expect(page.atlasImageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(page.atlasJsonHash).toMatch(/^[0-9a-f]{64}$/);
    for (const frame of page.frames) {
      expect(frame.rect.x + frame.rect.width).toBeLessThanOrEqual(page.atlasSize.width);
      expect(frame.rect.y + frame.rect.height).toBeLessThanOrEqual(page.atlasSize.height);
    }
  });

  it('packs without overlapping any two frames', async () => {
    const { bake } = useCase();
    const output = unwrap(await bake.execute(await bakeInput()));
    const rects = output.pages[0]?.frames.map((frame) => frame.rect) ?? [];

    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        if (a === undefined || b === undefined) continue;
        const disjoint =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(disjoint).toBe(true);
      }
    }
  });

  it('bakes deterministically: the same clip and settings produce the same atlas hash twice', async () => {
    const first = unwrap(await useCase().bake.execute(await bakeInput()));
    const second = unwrap(await useCase().bake.execute(await bakeInput()));

    // The whole "sheets are derived, never source of truth" claim rests on this: delete
    // the sheet, rebuild it, get the same bytes.
    expect(first.pages[0]?.atlasImageHash).toBe(second.pages[0]?.atlasImageHash);
    expect(first.pages[0]?.atlasJsonHash).toBe(second.pages[0]?.atlasJsonHash);
    expect(first.pages[0]?.id).toBe(second.pages[0]?.id);
  });

  it('records the trim offset for every frame', async () => {
    const { bake } = useCase();
    const output = unwrap(await bake.execute(await bakeInput()));
    for (const frame of output.pages[0]?.frames ?? []) {
      expect(frame.trimOffset.x).toBeGreaterThanOrEqual(0);
      expect(frame.trimOffset.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps full-frame rects when trimming is off', async () => {
    const { bake } = useCase();
    const input = await bakeInput({
      settings: { frames: 2, maxSize: 512, padding: 0, trim: false },
    });
    const output = unwrap(await bake.execute(input));

    expect(output.pages[0]?.trimmed).toBe(false);
    expect(output.pages[0]?.frames[0]?.rect.width).toBe(96);
  });

  it('spills to a second page rather than failing when the atlas is too small', async () => {
    const { bake } = useCase();
    const output = unwrap(
      await bake.execute(
        await bakeInput({ settings: { frames: 6, maxSize: 64, padding: 1, trim: true } }),
      ),
    );

    expect(output.pages.length).toBeGreaterThan(1);
    expect(output.pages.reduce((sum, page) => sum + page.frameCount, 0)).toBe(6);
  });

  it('gives a wholly transparent frame a rect anyway, so indices stay aligned', async () => {
    const { bake } = useCase();
    const input = await bakeInput({ images: new Map(), settings: { frames: 3, trim: true } });
    const output = unwrap(await bake.execute(input));

    expect(output.pages[0]?.frameCount).toBe(3);
    expect(output.pages[0]?.frames[0]?.rect.width).toBe(1);
  });

  it('skips a part whose node the clip marked invisible', async () => {
    const base = await bakeInput();
    const hidden = {
      ...base,
      ir: {
        ...base.ir,
        nodes: base.ir.nodes.map((node) =>
          node.name === 'trunk' ? { ...node, visible: false } : node,
        ),
      },
    };

    const withTrunk = unwrap(await useCase().bake.execute(base));
    const withoutTrunk = unwrap(await useCase().bake.execute(hidden));
    expect(withTrunk.pages[0]?.atlasImageHash).not.toBe(withoutTrunk.pages[0]?.atlasImageHash);
  });

  it('refuses a zero-frame bake', async () => {
    const { bake } = useCase();
    expect(isErr(await bake.execute(await bakeInput({ settings: { frames: 0 } })))).toBe(true);
  });

  it('defaults the frame count from the clip duration and fps', async () => {
    const { bake } = useCase();
    const input = await bakeInput({ settings: {} });
    const output = unwrap(await bake.execute(input));
    expect(output.frameCount).toBe(Math.round((input.clip.durationMs / 1000) * input.clip.fps));
  });
});

describe('the software rasteriser', () => {
  it('composes matrices left-to-right', () => {
    const scale = multiply([2, 0, 0, 2, 0, 0], identityMatrix());
    expect(scale).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it('rotates a part about its pivot, not about the bitmap corner', () => {
    const target = raster.blank({ width: 40, height: 40 });
    const source = solid(10, 10, { r: 255, g: 0, b: 0, a: 255 });
    const matrix = placementMatrix({
      transform: {
        position: { x: 0, y: 0 },
        rotation: 90,
        scale: { x: 1, y: 1 },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      restPivot: { x: 20, y: 20 },
      localPivot: { x: 5, y: 5 },
    });

    drawAffine(target, source, matrix, 1);
    // A square rotated about its own centre still covers its own centre.
    expect(target.data[(20 * 40 + 20) * 4 + 3]).toBe(255);
    // And it has not orbited into the corner.
    expect(target.data[3]).toBe(0);
  });

  it('draws nothing for a degenerate matrix or zero opacity', () => {
    const target = raster.blank({ width: 8, height: 8 });
    const source = solid(4, 4, { r: 255, g: 255, b: 255, a: 255 });

    drawAffine(target, source, [0, 0, 0, 0, 0, 0], 1);
    drawAffine(target, source, identityMatrix(), 0);
    expect([...target.data].every((byte) => byte === 0)).toBe(true);
  });

  it('clips a draw that runs off the canvas', () => {
    const target = raster.blank({ width: 8, height: 8 });
    const source = solid(4, 4, { r: 255, g: 255, b: 255, a: 255 });
    drawAffine(target, source, [1, 0, 0, 1, 20, 20], 1);
    expect([...target.data].every((byte) => byte === 0)).toBe(true);
  });

  it('honours per-node opacity', () => {
    const target = raster.blank({ width: 4, height: 4 });
    const source = solid(4, 4, { r: 255, g: 255, b: 255, a: 255 });
    drawAffine(target, source, identityMatrix(), 0.5);
    expect(target.data[3]).toBe(128);
  });

  it('is byte-reproducible', () => {
    const draw = (): Uint8Array => {
      const target = raster.blank({ width: 16, height: 16 });
      drawAffine(
        target,
        solid(6, 6, { r: 10, g: 20, b: 30, a: 200 }),
        [1.3, 0.2, -0.2, 1.3, 3, 3],
        0.8,
      );
      return target.data;
    };
    expect(sha256(draw())).toBe(sha256(draw()));
  });
});
