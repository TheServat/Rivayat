import { describe, expect, it } from 'vitest';
import { ProviderError, ValidationError, err, isErr, ok, sha256, unwrap } from '@rv/shared-kernel';

import { InMemoryBlobStore, ScriptedMatting, ScriptedSegmentation } from '../__fixtures__/doubles';
import { NEUTRAL_FIELD, paintCutout, paintSheet, solid } from '../__fixtures__/images';
import { alphaCoverage, cornersAreTransparent } from '../raster/alpha';
import { PngRaster } from '../raster/png-raster';
import type { RgbaImage } from '../ports/raster-port';
import {
  BiRefNetSegmentation,
  type RawImageLike,
  type TransformersLike,
} from './adapters/birefnet-segmentation';
import { ChainedMatting } from './chained-matting';
import { MatteCanvasUseCase } from './matte-canvas';
import { ModelMatting } from './model-matting';
import { ThresholdMatting, sampleBackground } from './threshold-matting';

const raster = new PngRaster();

async function sheet(): Promise<RgbaImage> {
  const encoded = await paintSheet(64, 64, [
    { x: 8, y: 8, width: 16, height: 16 },
    { x: 40, y: 40, width: 16, height: 16 },
  ]);
  return unwrap(raster.decode(encoded));
}

describe('ThresholdMatting', () => {
  it('keys the neutral field out and leaves the components opaque', async () => {
    const matted = unwrap(await new ThresholdMatting().matte({ image: await sheet() }));

    expect(cornersAreTransparent(matted.image)).toBe(true);
    // Two 16×16 blobs on a 64×64 field.
    expect(alphaCoverage(matted.image)).toBeCloseTo((2 * 256) / 4096, 2);
    expect(matted.engine).toBe('threshold-key');
  });

  it('keeps a background-coloured region that is not connected to the border', async () => {
    const image = await sheet();
    // Punch the field colour into the middle of a blob: a highlight, not background.
    for (let y = 12; y < 16; y += 1) {
      for (let x = 12; x < 16; x += 1) {
        const at = (y * 64 + x) * 4;
        image.data[at] = NEUTRAL_FIELD.r;
        image.data[at + 1] = NEUTRAL_FIELD.g;
        image.data[at + 2] = NEUTRAL_FIELD.b;
      }
    }

    const matted = unwrap(await new ThresholdMatting().matte({ image }));
    // A naive colour key punches a hole here; the flood fill from the border does not.
    expect(matted.image.data[(13 * 64 + 13) * 4 + 3]).toBe(255);
  });

  it('accepts an explicit background hint from the lane', async () => {
    const matted = unwrap(
      await new ThresholdMatting().matte({ image: await sheet(), backgroundHint: NEUTRAL_FIELD }),
    );
    expect(cornersAreTransparent(matted.image)).toBe(true);
  });

  it('samples the background as the median of the corners', async () => {
    expect(sampleBackground(await sheet())).toEqual(NEUTRAL_FIELD);
  });

  it('gives a partially matching pixel partial alpha instead of a hard edge', async () => {
    const image = solid(16, 16, { r: 200, g: 200, b: 200, a: 255 });
    // A ring of near-background colour: inside the soft tolerance, outside the hard one.
    for (let i = 0; i < 16; i += 1) {
      const at = (8 * 16 + i) * 4;
      image.data[at] = 170;
      image.data[at + 1] = 170;
      image.data[at + 2] = 170;
    }
    const matted = unwrap(await new ThresholdMatting().matte({ image }));
    const alpha = matted.image.data[(8 * 16 + 4) * 4 + 3] ?? 0;
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(255);
  });

  it('does not resurrect alpha the generator already removed', async () => {
    const cut = await paintCutout(16, 16, [{ x: 4, y: 4, width: 4, height: 4 }]);
    const matted = unwrap(await new ThresholdMatting().matte({ image: cut }));
    expect(matted.image.data[3]).toBe(0);
  });

  it('is deterministic: the same input mattes to the same bytes', async () => {
    const engine = new ThresholdMatting();
    const input = await sheet();
    const first = unwrap(await engine.matte({ image: input }));
    const second = unwrap(await engine.matte({ image: input }));
    expect(sha256(first.image.data)).toBe(sha256(second.image.data));
  });
});

describe('ModelMatting', () => {
  it('applies a segmentation mask as alpha, with a floor and a ceiling', async () => {
    const image = solid(4, 4, { r: 10, g: 20, b: 30, a: 255 });
    const model = new ScriptedSegmentation('fake-birefnet', (input) => {
      const mask = new Uint8Array(input.width * input.height);
      mask.fill(255);
      mask[0] = 5; // below the floor
      mask[1] = 128; // inside the ramp
      return ok(mask);
    });

    const matted = unwrap(await new ModelMatting(model).matte({ image }));
    expect(matted.image.data[3]).toBe(0);
    expect(matted.image.data[7]).toBeGreaterThan(0);
    expect(matted.image.data[7]).toBeLessThan(255);
    expect(matted.image.data[11]).toBe(255);
    expect(matted.engine).toBe('fake-birefnet');
  });

  it('rejects a mask that does not match the image', async () => {
    const model = new ScriptedSegmentation('short', () => ok(new Uint8Array(3)));
    const failed = await new ModelMatting(model).matte({
      image: solid(4, 4, { r: 0, g: 0, b: 0, a: 255 }),
    });
    expect(isErr(failed)).toBe(true);
  });

  it('propagates a model failure', async () => {
    const model = new ScriptedSegmentation('down', () =>
      err(new ProviderError({ message: 'no model', provider: 'x' })),
    );
    expect(
      isErr(
        await new ModelMatting(model).matte({ image: solid(2, 2, { r: 0, g: 0, b: 0, a: 255 }) }),
      ),
    ).toBe(true);
  });
});

describe('ChainedMatting', () => {
  it('needs at least one engine', () => {
    expect(() => new ChainedMatting([])).toThrow(ValidationError);
  });

  it('returns the primary when it produces a usable cutout', async () => {
    const primary = new ScriptedMatting('primary', () => ok(cutoutOf()));
    const fallback = new ScriptedMatting('fallback', () => ok(cutoutOf()));
    const result = unwrap(
      await new ChainedMatting([primary, fallback]).matte({ image: cutoutOf() }),
    );

    expect(result.engine).toBe('primary');
    expect(result.fallbacks).toHaveLength(0);
    expect(fallback.calls).toHaveLength(0);
  });

  it('falls through when the primary throws, and records why', async () => {
    const primary = new ScriptedMatting('birefnet', () =>
      err(new ProviderError({ message: 'model missing', provider: 'hf' })),
    );
    const fallback = new ScriptedMatting('imgly', () => ok(cutoutOf()));
    const result = unwrap(
      await new ChainedMatting([primary, fallback]).matte({ image: cutoutOf() }),
    );

    expect(result.engine).toBe('imgly');
    expect(result.fallbacks[0]).toEqual({ engine: 'birefnet', reason: 'model missing' });
  });

  it('falls through when an engine succeeds but removed the subject', async () => {
    const eraser = new ScriptedMatting('eraser', (request) => ok(blank(request.image)));
    const good = new ScriptedMatting('good', () => ok(cutoutOf()));
    const result = unwrap(await new ChainedMatting([eraser, good]).matte({ image: cutoutOf() }));

    expect(result.engine).toBe('good');
    expect(result.fallbacks[0]?.reason).toContain('removed the subject');
  });

  it('falls through when an engine removed nothing', async () => {
    const passthrough = new ScriptedMatting('passthrough', (request) => ok(request.image));
    const good = new ScriptedMatting('good', () => ok(cutoutOf()));
    const opaque = solid(16, 16, { r: 5, g: 5, b: 5, a: 255 });
    const result = unwrap(await new ChainedMatting([passthrough, good]).matte({ image: opaque }));

    expect(result.engine).toBe('good');
    expect(result.fallbacks[0]?.reason).toContain('removed nothing');
  });

  it('rejects opaque corners when the acceptance asks for transparent ones', async () => {
    // Half opaque: inside the coverage window, but the corners give it away.
    const halfOpaque = solid(16, 16, { r: 5, g: 5, b: 5, a: 255 });
    for (let i = 128; i < 256; i += 1) halfOpaque.data[i * 4 + 3] = 0;

    const suspect = new ScriptedMatting('suspect', () => ok(halfOpaque));
    const good = new ScriptedMatting('good', () => ok(cutoutOf()));
    const result = unwrap(await new ChainedMatting([suspect, good]).matte({ image: cutoutOf() }));
    expect(result.fallbacks[0]?.reason).toContain('corners');
  });

  it('fails when every engine fails, keeping the last error', async () => {
    const first = new ScriptedMatting('a', () =>
      err(new ProviderError({ message: 'a down', provider: 'a' })),
    );
    const second = new ScriptedMatting('b', () =>
      err(new ProviderError({ message: 'b down', provider: 'b' })),
    );
    const failed = await new ChainedMatting([first, second]).matte({ image: cutoutOf() });

    expect(isErr(failed)).toBe(true);
    if (isErr(failed)) expect(failed.error.message).toBe('b down');
  });

  it('fails with an explanation when every engine merely produced rubbish', async () => {
    const eraser = new ScriptedMatting('eraser', (request) => ok(blank(request.image)));
    const failed = await new ChainedMatting([eraser]).matte({ image: cutoutOf() });
    expect(isErr(failed)).toBe(true);
    if (isErr(failed)) expect(failed.error.message).toContain('unusable cutout');
  });
});

describe('MatteCanvasUseCase', () => {
  it('decodes, mattes, stores and measures in one step', async () => {
    const blobs = new InMemoryBlobStore();
    const useCase = new MatteCanvasUseCase({ raster, matting: new ThresholdMatting(), blobs });
    const source = await paintSheet(48, 48, [{ x: 8, y: 8, width: 16, height: 16 }]);

    const result = unwrap(
      await useCase.execute({ source, backgroundHint: NEUTRAL_FIELD, subject: 'prop' }),
    );

    expect(result.imageHash).toBeDefined();
    expect(blobs.puts).toHaveLength(1);
    expect(result.cornersTransparent).toBe(true);
    expect(result.coverage).toBeGreaterThan(0);
    expect(result.cleanliness).toBeGreaterThan(0.9);
  });

  it('skips the blob write when the caller does not want one', async () => {
    const blobs = new InMemoryBlobStore();
    const useCase = new MatteCanvasUseCase({ raster, matting: new ThresholdMatting(), blobs });
    const result = unwrap(
      await useCase.execute({ source: await paintSheet(16, 16, []), store: false }),
    );

    expect(result.imageHash).toBeUndefined();
    expect(blobs.puts).toHaveLength(0);
  });

  it('propagates a decode failure', async () => {
    const useCase = new MatteCanvasUseCase({
      raster,
      matting: new ThresholdMatting(),
      blobs: new InMemoryBlobStore(),
    });
    expect(
      isErr(await useCase.execute({ source: { mimeType: 'image/png', data: new Uint8Array(4) } })),
    ).toBe(true);
  });

  it('propagates a matting failure', async () => {
    const useCase = new MatteCanvasUseCase({
      raster,
      matting: new ScriptedMatting('down', () =>
        err(new ProviderError({ message: 'no', provider: 'x' })),
      ),
      blobs: new InMemoryBlobStore(),
    });
    expect(isErr(await useCase.execute({ source: await paintSheet(8, 8, []) }))).toBe(true);
  });
});

describe('BiRefNetSegmentation', () => {
  it('reads the alpha plane of the pipeline output as the mask', async () => {
    const model = new BiRefNetSegmentation({ load: () => Promise.resolve(fakeTransformers(4)) });
    const mask = unwrap(await model.segment(solid(2, 2, { r: 1, g: 2, b: 3, a: 255 })));

    expect(mask).toHaveLength(4);
    expect([...mask]).toEqual([255, 255, 255, 255]);
    expect(model.id).toBe('birefnet');
  });

  it('treats a channel-poor result as fully foreground rather than inventing a gradient', async () => {
    const model = new BiRefNetSegmentation({ load: () => Promise.resolve(fakeTransformers(3)) });
    expect([...unwrap(await model.segment(solid(2, 2, { r: 0, g: 0, b: 0, a: 255 })))]).toEqual([
      255, 255, 255, 255,
    ]);
  });

  it('accepts an array result from the pipeline', async () => {
    const model = new BiRefNetSegmentation({
      load: () => Promise.resolve(fakeTransformers(4, true)),
    });
    expect(unwrap(await model.segment(solid(2, 2, { r: 0, g: 0, b: 0, a: 255 })))).toHaveLength(4);
  });

  it('converts a load failure into a typed provider error at the boundary', async () => {
    const model = new BiRefNetSegmentation({
      model: 'onnx-community/BiRefNet_lite',
      load: () => Promise.reject(new Error('onnxruntime is not installed')),
    });
    const failed = await model.segment(solid(2, 2, { r: 0, g: 0, b: 0, a: 255 }));

    expect(isErr(failed)).toBe(true);
    if (isErr(failed)) {
      expect(failed.error.kind).toBe('provider');
      expect(failed.error.retryable).toBe(false);
    }
  });

  it('fails when the pipeline returns nothing', async () => {
    const model = new BiRefNetSegmentation({
      load: () =>
        Promise.resolve({
          pipeline: () => Promise.resolve(() => Promise.resolve([])),
          RawImage: FakeRawImage,
        } as unknown as TransformersLike),
    });
    expect(isErr(await model.segment(solid(1, 1, { r: 0, g: 0, b: 0, a: 255 })))).toBe(true);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function cutoutOf(): RgbaImage {
  const image = solid(16, 16, { r: 5, g: 90, b: 40, a: 0 });
  for (let y = 4; y < 12; y += 1) {
    for (let x = 4; x < 12; x += 1) image.data[(y * 16 + x) * 4 + 3] = 255;
  }
  return image;
}

function blank(source: RgbaImage): RgbaImage {
  return { width: source.width, height: source.height, data: new Uint8Array(source.data.length) };
}

class FakeRawImage {
  constructor(
    readonly data: Uint8Array | Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
    readonly channels: number,
  ) {}
}

function fakeTransformers(channels: number, asArray = false): TransformersLike {
  return {
    pipeline: () =>
      Promise.resolve((image: RawImageLike) => {
        const data = new Uint8Array(image.width * image.height * channels).fill(255);
        const raw = new FakeRawImage(data, image.width, image.height, channels);
        return Promise.resolve(asArray ? [raw] : raw);
      }),
    RawImage: FakeRawImage,
  };
}
