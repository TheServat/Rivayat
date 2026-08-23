/**
 * A PNG codec with no dependencies, because the alternative is an architecture
 * violation.
 *
 * Architecture §1 puts `sharp` in the infrastructure row and
 * `.dependency-cruiser.cjs` enforces it: `packages/asset-engine/src` importing `sharp`
 * fails `pnpm arch:check`. The engine still has to read the bytes an image model
 * returned and write the bytes an atlas is made of, so the decode/encode pair lives
 * here, over `node:zlib` - a core module, which the same rule permits.
 *
 * Two consequences worth stating, because both are load-bearing rather than
 * incidental:
 *
 * - **It is deterministic.** Every row is written with filter type 0 and one fixed
 *   deflate level, so the same pixels produce the same bytes. `sharp` optimises its
 *   filter choice per row and its output is therefore a function of its libvips
 *   version - which would make the content-addressed store's atlas hashes move under a
 *   dependency bump (CLAUDE.md #1, and RV-129's "rebuild and the bytes hash
 *   identically").
 * - **It reads more than it writes.** Decoding accepts the 8-bit non-interlaced colour
 *   types a generator or `sharp` will actually hand us; encoding only ever emits RGBA.
 *   Anything else is a typed failure rather than a guess, because a silently
 *   mis-decoded image becomes a wrong alpha mask and then a wrong rig.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { type AppError, type Result, ValidationError, err, ok } from '@rv/shared-kernel';

import type { EncodedImage, RgbaImage } from '../ports/raster-port';
import { at32, px } from './pixels';

export const PNG_MIME = 'image/png';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Deflate level 9.
 *
 * Part of the determinism key, not a tuning choice: the level selects the match
 * search, so changing it changes every atlas hash in the store.
 */
const DEFLATE_LEVEL = 9;

/** Bytes per pixel for each supported colour type, at 8 bits per sample. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

// ── decode ──────────────────────────────────────────────────────────────────

export function decodePng(bytes: Uint8Array): Result<RgbaImage, AppError> {
  if (bytes.length < SIGNATURE.length) {
    return err(new ValidationError({ message: 'not a PNG: shorter than the signature' }));
  }
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) {
      return err(new ValidationError({ message: 'not a PNG: bad signature' }));
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = SIGNATURE.length;
  let header: PngHeader | null = null;
  const idat: Uint8Array[] = [];

  while (cursor + 8 <= bytes.length) {
    const length = view.getUint32(cursor);
    const type = String.fromCharCode(
      view.getUint8(cursor + 4),
      view.getUint8(cursor + 5),
      view.getUint8(cursor + 6),
      view.getUint8(cursor + 7),
    );
    const start = cursor + 8;
    const end = start + length;
    if (end + 4 > bytes.length) {
      return err(new ValidationError({ message: `truncated PNG chunk "${type}"` }));
    }

    if (type === 'IHDR') {
      const parsed = readHeader(view, start);
      if (!parsed.ok) return parsed;
      header = parsed.value;
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }

    cursor = end + 4;
  }

  if (header === null) return err(new ValidationError({ message: 'PNG has no IHDR chunk' }));
  if (idat.length === 0) return err(new ValidationError({ message: 'PNG has no image data' }));

  const channels = CHANNELS[header.colorType];
  if (channels === undefined) {
    return err(
      new ValidationError({
        message: `unsupported PNG colour type ${String(header.colorType)}; expected 0, 2, 4 or 6`,
        context: { colorType: header.colorType },
      }),
    );
  }

  const raw = inflateSync(concat(idat));
  const stride = header.width * channels;
  if (raw.length < (stride + 1) * header.height) {
    return err(
      new ValidationError({ message: 'PNG image data is shorter than its header claims' }),
    );
  }

  const planes = unfilter(raw, header.width, header.height, channels);
  return ok({ width: header.width, height: header.height, data: toRgba(planes, header, channels) });
}

interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly colorType: number;
}

function readHeader(view: DataView, at: number): Result<PngHeader, AppError> {
  const width = view.getUint32(at);
  const height = view.getUint32(at + 4);
  const bitDepth = view.getUint8(at + 8);
  const colorType = view.getUint8(at + 9);
  const interlace = view.getUint8(at + 12);

  if (width === 0 || height === 0) {
    return err(new ValidationError({ message: 'PNG has a zero dimension' }));
  }
  if (bitDepth !== 8) {
    return err(
      new ValidationError({
        message: `unsupported PNG bit depth ${String(bitDepth)}; only 8-bit is read`,
        context: { bitDepth },
      }),
    );
  }
  if (interlace !== 0) {
    return err(new ValidationError({ message: 'interlaced PNGs are not read' }));
  }
  return ok({ width, height, colorType });
}

/**
 * Reverses the per-scanline filters.
 *
 * All five are implemented rather than only the one we emit: the input side reads
 * whatever a model or `sharp` produced, and every real encoder picks filters per row.
 */
function unfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);

  for (let y = 0; y < height; y += 1) {
    const filter = px(raw, y * (stride + 1));
    const from = y * (stride + 1) + 1;
    const to = y * stride;
    const above = to - stride;

    for (let x = 0; x < stride; x += 1) {
      const value = px(raw, from + x);
      const left = x >= channels ? px(out, to + x - channels) : 0;
      const up = y > 0 ? px(out, above + x) : 0;
      const upLeft = y > 0 && x >= channels ? px(out, above + x - channels) : 0;

      let restored: number;
      switch (filter) {
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          restored = value;
      }
      out[to + x] = restored & 0xff;
    }
  }

  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Widens any supported colour type to straight RGBA. */
function toRgba(planes: Uint8Array, header: PngHeader, channels: number): Uint8Array {
  const pixels = header.width * header.height;
  const rgba = new Uint8Array(pixels * 4);

  for (let i = 0; i < pixels; i += 1) {
    const s = i * channels;
    const d = i * 4;
    const c0 = px(planes, s);

    if (channels === 1) {
      rgba[d] = c0;
      rgba[d + 1] = c0;
      rgba[d + 2] = c0;
      rgba[d + 3] = 255;
    } else if (channels === 2) {
      rgba[d] = c0;
      rgba[d + 1] = c0;
      rgba[d + 2] = c0;
      rgba[d + 3] = px(planes, s + 1);
    } else {
      rgba[d] = c0;
      rgba[d + 1] = px(planes, s + 1);
      rgba[d + 2] = px(planes, s + 2);
      rgba[d + 3] = channels === 4 ? px(planes, s + 3) : 255;
    }
  }

  return rgba;
}

// ── encode ──────────────────────────────────────────────────────────────────

export function encodePng(image: RgbaImage): Result<EncodedImage, AppError> {
  const expected = image.width * image.height * 4;
  if (image.data.length !== expected) {
    return err(
      new ValidationError({
        message: 'RGBA buffer length does not match its declared dimensions',
        context: { expected, actual: image.data.length },
      }),
    );
  }

  const stride = image.width * 4;
  const raw = new Uint8Array((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    // Filter type 0 on every row. Not a performance choice - a fixed filter is what
    // makes the output a pure function of the pixels.
    raw[y * (stride + 1)] = 0;
    raw.set(image.data.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, image.width);
  ihdrView.setUint32(4, image.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10 = compression, 11 = filter, 12 = interlace; all zero already.

  const body = concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: DEFLATE_LEVEL }))),
    chunk('IEND', new Uint8Array(0)),
  ]);

  return ok({ mimeType: PNG_MIME, data: body });
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = at32(CRC_TABLE, (crc ^ byte) & 0xff) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
