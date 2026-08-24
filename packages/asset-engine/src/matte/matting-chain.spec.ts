import { describe, expect, it } from 'vitest';
import { ProviderError, err, isErr, ok, unwrap } from '@rv/shared-kernel';

import { ScriptedSegmentation } from '../__fixtures__/doubles';
import { paintGradedSheet, paintSheet } from '../__fixtures__/images';
import { alphaCoverage, cornersAreTransparent } from '../raster/alpha';
import { PngRaster } from '../raster/png-raster';
import type { RgbaImage } from '../ports/raster-port';
import { defaultMattingChain } from './matting-chain';
import { THRESHOLD_ENGINE } from './threshold-matting';

const raster = new PngRaster();
const BLOBS = [
  { x: 12, y: 12, width: 24, height: 24 },
  { x: 60, y: 60, width: 24, height: 24 },
] as const;

async function flat(): Promise<RgbaImage> {
  return unwrap(raster.decode(await paintSheet(96, 96, [...BLOBS])));
}

async function graded(): Promise<RgbaImage> {
  return unwrap(raster.decode(await paintGradedSheet(96, 96, [...BLOBS])));
}

/** The mask the blobs really occupy, which is what a learned matte would find. */
function truthMask(image: RgbaImage): Uint8Array {
  const mask = new Uint8Array(image.width * image.height);
  for (const blob of BLOBS) {
    for (let y = blob.y; y < blob.y + blob.height; y += 1) {
      for (let x = blob.x; x < blob.x + blob.width; x += 1) mask[y * image.width + x] = 255;
    }
  }
  return mask;
}

describe('defaultMattingChain', () => {
  it('keys a flat field on the first tier and never wakes the model', async () => {
    let segmentations = 0;
    const model = new ScriptedSegmentation('birefnet', (image) => {
      segmentations += 1;
      return ok(truthMask(image));
    });

    const matted = unwrap(
      await defaultMattingChain({ segmentation: model }).matte({ image: await flat() }),
    );

    expect(matted.engine).toBe(THRESHOLD_ENGINE);
    expect(matted.fallbacks).toEqual([]);
    // The 224 MB download is only avoidable if the tier is never reached at all.
    expect(segmentations).toBe(0);
  });

  it('escalates to the model when both key tiers refuse a graded backdrop', async () => {
    const model = new ScriptedSegmentation('birefnet', (image) => ok(truthMask(image)));

    const matted = unwrap(
      await defaultMattingChain({ segmentation: model }).matte({ image: await graded() }),
    );

    expect(matted.engine).toBe('birefnet');
    expect(matted.fallbacks).toHaveLength(2);
    // The escalation is driven by the refusal the chain already produced, not by a
    // separate "is this field flat" detector - so the reason has to be the key's own.
    for (const skipped of matted.fallbacks) {
      expect(skipped.engine).toBe(THRESHOLD_ENGINE);
      expect(skipped.reason).toContain('corners');
    }
    expect(cornersAreTransparent(matted.image)).toBe(true);
    expect(alphaCoverage(matted.image)).toBeCloseTo((2 * 24 * 24) / (96 * 96), 2);
  });

  it('proves the premise: a graded backdrop really does defeat both key tiers', async () => {
    const failed = await defaultMattingChain({ keyOnly: true }).matte({ image: await graded() });

    expect(isErr(failed)).toBe(true);
    if (!isErr(failed)) return;
    expect(failed.error.context.tried).toEqual([THRESHOLD_ENGINE, THRESHOLD_ENGINE]);
    expect(failed.error.context.reasons).toEqual([
      expect.stringContaining('corners'),
      expect.stringContaining('corners'),
    ]);
  });

  it('keeps a model failure typed rather than swallowing it into a validation error', async () => {
    const model = new ScriptedSegmentation('birefnet', () =>
      err(new ProviderError({ message: 'onnxruntime is not installed', provider: 'hf' })),
    );

    const failed = await defaultMattingChain({ segmentation: model }).matte({
      image: await graded(),
    });

    expect(isErr(failed)).toBe(true);
    if (!isErr(failed)) return;
    // The chain reports the tier that *threw*, because a missing model file is
    // actionable in a way that "the key removed nothing" is not.
    expect(failed.error.kind).toBe('provider');
    expect(failed.error.message).toContain('onnxruntime');
  });

  it('names its tiers in order, so the matte step hash changes when the chain does', () => {
    const model = new ScriptedSegmentation('birefnet', (image) => ok(truthMask(image)));

    expect(defaultMattingChain({ segmentation: model }).engine).toBe(
      `${THRESHOLD_ENGINE}>${THRESHOLD_ENGINE}>birefnet`,
    );
    expect(defaultMattingChain({ keyOnly: true }).engine).toBe(
      `${THRESHOLD_ENGINE}>${THRESHOLD_ENGINE}`,
    );
  });
});
