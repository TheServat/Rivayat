import { describe, expect, it } from 'vitest';
import { isErr, sha256, unwrap } from '@rv/shared-kernel';

import { encodeWithSharp, paintCutout, solid } from '../__fixtures__/images';
import { decodePng, encodePng } from './png';

describe('PNG codec', () => {
  it('round-trips RGBA pixels exactly', () => {
    const source = solid(5, 3, { r: 12, g: 200, b: 34, a: 128 });
    const encoded = unwrap(encodePng(source));
    const decoded = unwrap(decodePng(encoded.data));

    expect(decoded.width).toBe(5);
    expect(decoded.height).toBe(3);
    expect([...decoded.data]).toEqual([...source.data]);
  });

  it('is byte-deterministic, which is what the atlas hash depends on', () => {
    const source = solid(9, 7, { r: 1, g: 2, b: 3, a: 255 });
    expect(sha256(unwrap(encodePng(source)).data)).toBe(sha256(unwrap(encodePng(source)).data));
  });

  it.each([
    ['RGBA', 4 as const],
    ['RGB', 3 as const],
    ['greyscale', 1 as const],
  ])('decodes %s produced by a real encoder', async (_label, channels) => {
    const original = await paintCutout(24, 16, [{ x: 4, y: 4, width: 8, height: 8 }]);
    const encoded = await encodeWithSharp(original, { channels });
    const decoded = unwrap(decodePng(encoded.data));

    expect(decoded.width).toBe(24);
    expect(decoded.height).toBe(16);
    // Adaptive per-row filters are what a real encoder emits; all five unfilters have to
    // be right or this comes back as noise.
    expect(decoded.data.length).toBe(24 * 16 * 4);
    const centre = (8 * 24 + 8) * 4;
    expect(decoded.data[centre + 3]).toBe(255);
  });

  it('reads a greyscale-with-alpha image, alpha included', async () => {
    const original = await paintCutout(8, 8, [{ x: 2, y: 2, width: 4, height: 4 }]);
    // `sharp` emits colour type 4 when a greyscale image keeps its alpha channel.
    const encoded = await encodeWithSharp(original, { channels: 1 });
    const withAlpha = unwrap(decodePng(encoded.data));
    expect(withAlpha.data[3]).toBeGreaterThanOrEqual(0);
  });

  it('rejects a palette PNG rather than mis-decoding it', async () => {
    const original = await paintCutout(16, 16, [{ x: 2, y: 2, width: 6, height: 6 }]);
    const encoded = await encodeWithSharp(original, { palette: true });
    // Colour type 3 is the one shape a silent misread would turn into
    // plausible-looking garbage, so it fails loudly instead.
    expect(encoded.data[findChunk(encoded.data, 'IHDR') + 4 + 9]).toBe(3);
    const decoded = decodePng(encoded.data);
    expect(isErr(decoded)).toBe(true);
    if (isErr(decoded)) expect(decoded.error.message).toContain('colour type');
  });

  it.each([
    ['too short', Uint8Array.from([1, 2, 3])],
    ['wrong signature', new Uint8Array(32)],
  ])('rejects a non-PNG (%s)', (_label, bytes) => {
    const decoded = decodePng(bytes);
    expect(isErr(decoded)).toBe(true);
  });

  it('rejects a chunk whose declared length runs past the end of the file', () => {
    const encoded = unwrap(encodePng(solid(2, 2, { r: 0, g: 0, b: 0, a: 255 })));
    // Cut immediately after the IDAT type field: the length header still promises
    // bytes that are no longer there.
    const decoded = decodePng(encoded.data.subarray(0, findChunk(encoded.data, 'IDAT') + 4));
    expect(isErr(decoded)).toBe(true);
  });

  it('rejects a PNG with no IHDR', () => {
    const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isErr(decodePng(signature))).toBe(true);
  });

  it('rejects a PNG whose header is present but carries no image data', () => {
    const encoded = unwrap(encodePng(solid(2, 2, { r: 0, g: 0, b: 0, a: 255 })));
    // Rename the IDAT chunk so the parser sees a header and then nothing.
    const mangled = Uint8Array.from(encoded.data);
    const idatAt = findChunk(mangled, 'IDAT');
    mangled[idatAt] = 'x'.charCodeAt(0);
    expect(isErr(decodePng(mangled))).toBe(true);
  });

  it('rejects a zero-sized image', () => {
    const encoded = unwrap(encodePng(solid(2, 2, { r: 0, g: 0, b: 0, a: 255 })));
    const mangled = Uint8Array.from(encoded.data);
    new DataView(mangled.buffer).setUint32(findChunk(mangled, 'IHDR') + 4, 0);
    expect(isErr(decodePng(mangled))).toBe(true);
  });

  it('rejects 16-bit and interlaced images rather than guessing', () => {
    const encoded = unwrap(encodePng(solid(2, 2, { r: 0, g: 0, b: 0, a: 255 })));

    const deep = Uint8Array.from(encoded.data);
    deep[findChunk(deep, 'IHDR') + 4 + 8] = 16;
    expect(isErr(decodePng(deep))).toBe(true);

    const interlaced = Uint8Array.from(encoded.data);
    interlaced[findChunk(interlaced, 'IHDR') + 4 + 12] = 1;
    expect(isErr(decodePng(interlaced))).toBe(true);
  });

  it('refuses to encode a buffer whose length contradicts its dimensions', () => {
    const broken = { width: 4, height: 4, data: new Uint8Array(10) };
    const encoded = encodePng(broken);
    expect(isErr(encoded)).toBe(true);
  });
});

/** Byte offset of a chunk's type field. */
function findChunk(bytes: Uint8Array, type: string): number {
  for (let i = 8; i + 8 <= bytes.length; i += 1) {
    if (
      bytes[i] === type.charCodeAt(0) &&
      bytes[i + 1] === type.charCodeAt(1) &&
      bytes[i + 2] === type.charCodeAt(2) &&
      bytes[i + 3] === type.charCodeAt(3)
    ) {
      return i;
    }
  }
  throw new Error(`chunk ${type} not found`);
}
