import { describe, expect, it } from 'vitest';
import { isErr, isOk, unwrap } from '@rv/shared-kernel';

import { compareByCodepoint, packAtlas, resolveAtlasOptions } from './pack';
import { blankImage, compositeImage, cropImage } from '../pixels';
import {
  OPAQUE_GREEN,
  SharpPngEncoder,
  decodePng,
  pixelAt,
  solid,
  withMargin,
} from '../__fixtures__/images';

const encoder = new SharpPngEncoder();
const options = unwrap(resolveAtlasOptions({}));

describe('resolveAtlasOptions', () => {
  it('defaults to a 2048 page with two pixels of padding', () => {
    expect(options).toMatchObject({ maxSize: 2048, padding: 2, trim: true, name: 'atlas' });
  });

  it('rejects sizes and gaps that cannot describe a page', () => {
    expect(isErr(resolveAtlasOptions({ maxSize: 0 }))).toBe(true);
    expect(isErr(resolveAtlasOptions({ maxSize: 12.5 }))).toBe(true);
    expect(isErr(resolveAtlasOptions({ padding: -1 }))).toBe(true);
    expect(isErr(resolveAtlasOptions({ border: 1.5 }))).toBe(true);
  });
});

describe('compareByCodepoint', () => {
  it('orders by codepoint, not by locale', () => {
    expect(compareByCodepoint('a', 'b')).toBe(-1);
    expect(compareByCodepoint('b', 'a')).toBe(1);
    expect(compareByCodepoint('a', 'a')).toBe(0);
    // A locale-aware comparator would sort these together; a byte-stable atlas must not.
    expect(compareByCodepoint('Z', 'a')).toBe(-1);
  });
});

describe('packAtlas', () => {
  it('refuses an empty frame list rather than writing an empty page', async () => {
    const result = await packAtlas([], options, encoder);
    expect(isErr(result)).toBe(true);
  });

  it('refuses duplicate names, because the JSON is keyed by them', async () => {
    const result = await packAtlas(
      [
        { name: 'a', image: solid(4, 4) },
        { name: 'a', image: solid(4, 4) },
      ],
      options,
      encoder,
    );
    expect(isErr(result)).toBe(true);
    if (isOk(result)) return;
    expect(result.error.kind).toBe('validation');
  });

  it('refuses a frame larger than the page instead of silently giving it its own bin', async () => {
    const small = unwrap(resolveAtlasOptions({ maxSize: 16 }));
    const result = await packAtlas([{ name: 'big', image: solid(64, 64) }], small, encoder);
    expect(isErr(result)).toBe(true);
    if (isOk(result)) return;
    expect(result.error.context.frame).toBe('big');
  });

  it('trims the transparent margin and records exactly what it removed', async () => {
    const image = withMargin({ width: 32, height: 24 }, { x: 5, y: 3, width: 10, height: 8 });
    const pages = unwrap(await packAtlas([{ name: 'part', image }], options, encoder));
    const frame = pages[0]?.frames[0];

    expect(frame?.trimmed).toBe(true);
    expect(frame?.trimOffset).toEqual({ x: 5, y: 3 });
    expect(frame?.rect.width).toBe(10);
    expect(frame?.rect.height).toBe(8);
    expect(frame?.sourceSize).toEqual({ width: 32, height: 24 });
  });

  it('adds the caller’s own offset to the one it removed', async () => {
    const image = withMargin({ width: 20, height: 20 }, { x: 2, y: 4, width: 6, height: 6 });
    const pages = unwrap(
      await packAtlas(
        [
          {
            name: 'part',
            image,
            sourceSize: { width: 100, height: 100 },
            sourceOffset: { x: 30, y: 40 },
          },
        ],
        options,
        encoder,
      ),
    );
    expect(pages[0]?.frames[0]?.trimOffset).toEqual({ x: 32, y: 44 });
  });

  it('keeps a wholly transparent frame as a 1×1 placeholder rather than dropping it', async () => {
    const pages = unwrap(
      await packAtlas(
        [
          { name: 'a', image: solid(4, 4) },
          { name: 'b-blank', image: blankImage({ width: 8, height: 8 }) },
        ],
        options,
        encoder,
      ),
    );
    const blank = pages[0]?.frames.find((frame) => frame.name === 'b-blank');
    expect(blank?.rect.width).toBe(1);
    expect(blank?.sourceSize).toEqual({ width: 8, height: 8 });
  });

  it('leaves the frame alone when trimming is off', async () => {
    const noTrim = unwrap(resolveAtlasOptions({ trim: false }));
    const image = withMargin({ width: 32, height: 24 }, { x: 5, y: 3, width: 10, height: 8 });
    const pages = unwrap(await packAtlas([{ name: 'part', image }], noTrim, encoder));

    expect(pages[0]?.frames[0]?.trimmed).toBe(false);
    expect(pages[0]?.frames[0]?.rect.width).toBe(32);
    expect(pages[0]?.frames[0]?.trimOffset).toEqual({ x: 0, y: 0 });
  });

  it('spills to a second page rather than failing when the frames do not fit', async () => {
    const small = unwrap(resolveAtlasOptions({ maxSize: 64, padding: 0 }));
    const sources = Array.from({ length: 6 }, (_, index) => ({
      name: `f${String(index)}`,
      image: solid(40, 40),
    }));
    const pages = unwrap(await packAtlas(sources, small, encoder));

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.reduce((sum, page) => sum + page.frames.length, 0)).toBe(6);
    expect(pages.map((page) => page.index)).toEqual(pages.map((_, index) => index));
  });

  it('honours power-of-two and square page constraints', async () => {
    const pot = unwrap(resolveAtlasOptions({ powerOfTwo: true, square: true }));
    const pages = unwrap(await packAtlas([{ name: 'a', image: solid(30, 12) }], pot, encoder));
    const size = pages[0]?.size;

    expect(size?.width).toBe(size?.height);
    expect(Math.log2(size?.width ?? 0) % 1).toBe(0);
  });

  it('produces the same page bytes for the same frames in a different order', async () => {
    const sources = [
      { name: 'trunk', image: solid(20, 30) },
      { name: 'branch', image: solid(14, 22) },
      { name: 'leaf', image: solid(9, 9) },
    ];
    const forwards = unwrap(await packAtlas(sources, options, encoder));
    const backwards = unwrap(await packAtlas([...sources].reverse(), options, encoder));

    expect(backwards[0]?.image.data).toEqual(forwards[0]?.image.data);
    expect(backwards[0]?.frames).toEqual(forwards[0]?.frames);
  });

  it('places the pixels where the frame rectangle says it did', async () => {
    const image = withMargin({ width: 20, height: 20 }, { x: 4, y: 6, width: 5, height: 3 });
    const pages = unwrap(await packAtlas([{ name: 'part', image }], options, encoder));
    const page = pages[0];
    const frame = page?.frames[0];
    if (page === undefined || frame === undefined) throw new Error('expected one packed frame');

    const decoded = await decodePng(page.image.data);
    expect(pixelAt(decoded, frame.rect.x, frame.rect.y)).toEqual(OPAQUE_GREEN);
    expect(
      pixelAt(decoded, frame.rect.x + frame.rect.width - 1, frame.rect.y + frame.rect.height - 1),
    ).toEqual(OPAQUE_GREEN);
  });

  it('round-trips a trimmed frame back to its original on-screen position', async () => {
    const original = withMargin({ width: 24, height: 18 }, { x: 7, y: 2, width: 6, height: 9 });
    const pages = unwrap(await packAtlas([{ name: 'part', image: original }], options, encoder));
    const page = pages[0];
    const frame = page?.frames[0];
    if (page === undefined || frame === undefined) throw new Error('expected one packed frame');

    const decoded = await decodePng(page.image.data);
    const cut = unwrap(
      cropImage(decoded, {
        x: frame.rect.x,
        y: frame.rect.y,
        width: frame.rect.width,
        height: frame.rect.height,
      }),
    );

    // Draw it back where the trim offset says it belongs, on a canvas of the source size.
    const restored = compositeImage(
      blankImage(frame.sourceSize),
      cut,
      frame.trimOffset.x,
      frame.trimOffset.y,
    );
    expect(restored.data).toEqual(original.data);

    // And confirm the offset is load-bearing: ignoring it displaces the art.
    const naive = compositeImage(blankImage(frame.sourceSize), cut, 0, 0);
    expect(naive.data).not.toEqual(original.data);
  });
});
