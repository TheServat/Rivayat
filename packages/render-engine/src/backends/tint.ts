/**
 * Colour multiply, applied to pixels once instead of to frames repeatedly.
 *
 * A tint in this IR is a *fixed* property of an asset instance, so the correct place to
 * apply it is at upload time. Doing it here also keeps it out of the backends: a
 * `globalCompositeOperation: 'multiply'` pass is one of the few canvas operations whose
 * rounding genuinely differs between Skia and Chromium, and that difference would show
 * up as a golden-hash mismatch nobody could explain.
 *
 * Alpha is left alone. A tint says "this fox is bluer", never "this fox is fainter" -
 * opacity is `Transform2D.opacity`, and conflating the two makes a tinted node
 * mysteriously translucent.
 */

import { ValidationError } from '@rv/shared-kernel';

import type { FrameBuffer } from '../ports/frame-renderer';

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Parses `#rgb`, `#rrggbb` and `#rrggbbaa`. Throws: a bad colour is a schema failure. */
export function parseHexColour(hex: string): Rgba {
  const body = hex.startsWith('#') ? hex.slice(1) : hex;
  const expand = (value: string): number => Number.parseInt(value.repeat(2), 16);

  if (body.length === 3) {
    const [r, g, b] = [...body];
    if (r === undefined || g === undefined || b === undefined) {
      throw new ValidationError({ message: `not a hex colour: ${hex}` });
    }
    return { r: expand(r), g: expand(g), b: expand(b), a: 255 };
  }
  if (body.length === 6 || body.length === 8) {
    const value = (offset: number): number => Number.parseInt(body.slice(offset, offset + 2), 16);
    const parsed = {
      r: value(0),
      g: value(2),
      b: value(4),
      a: body.length === 8 ? value(6) : 255,
    };
    if (Number.isNaN(parsed.r + parsed.g + parsed.b + parsed.a)) {
      throw new ValidationError({ message: `not a hex colour: ${hex}` });
    }
    return parsed;
  }
  throw new ValidationError({ message: `not a hex colour: ${hex}` });
}

/** A copy of `buffer` with each colour channel multiplied by the tint. */
export function applyTint(buffer: FrameBuffer, tint: string): FrameBuffer {
  const { r, g, b } = parseHexColour(tint);
  const data = new Uint8Array(buffer.data.length);
  for (let i = 0; i < buffer.data.length; i += 4) {
    data[i] = Math.round(((buffer.data[i] ?? 0) * r) / 255);
    data[i + 1] = Math.round(((buffer.data[i + 1] ?? 0) * g) / 255);
    data[i + 2] = Math.round(((buffer.data[i + 2] ?? 0) * b) / 255);
    data[i + 3] = buffer.data[i + 3] ?? 0;
  }
  return { width: buffer.width, height: buffer.height, data };
}
