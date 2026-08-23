import { unwrap } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { indexedFrame, solidFrame } from '../__fixtures__/doubles';
import type { SharpInstanceLike, SharpLike } from '../ports/browser';
import type { FrameBuffer } from '../ports/frame-renderer';
import {
  SIGNATURE_SIZE,
  compareFrames,
  decodeWithSharp,
  perceptualDistance,
  perceptualSignature,
} from './perceptual-diff';

/** Half black, half white, split down the middle. */
function halves(width: number, height: number, flip = false): FrameBuffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const bright = flip ? x >= width / 2 : x < width / 2;
      const value = bright ? 255 : 0;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('perceptualSignature', () => {
  it('downscales to a fixed grid whatever the source size', () => {
    expect(perceptualSignature(solidFrame(200, 130, 255)).values).toHaveLength(
      SIGNATURE_SIZE * SIGNATURE_SIZE,
    );
    expect(perceptualSignature(solidFrame(9, 7, 255), 4).values).toHaveLength(16);
  });

  it('weights green far above blue, as the eye does', () => {
    const green = { width: 1, height: 1, data: new Uint8Array([0, 255, 0, 255]) };
    const blue = { width: 1, height: 1, data: new Uint8Array([0, 0, 255, 255]) };
    expect(perceptualSignature(green, 1).values[0]).toBeGreaterThan(
      (perceptualSignature(blue, 1).values[0] ?? 0) * 5,
    );
  });

  it('treats a transparent pixel as absent rather than as black', () => {
    // Two identical cut-outs on different backgrounds must not read as different.
    const transparent = { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 0]) };
    expect(perceptualSignature(transparent, 1).values[0]).toBe(0);
  });
});

describe('perceptualDistance', () => {
  it('is zero for identical frames', () => {
    const frame = indexedFrame(32, 32, 4);
    expect(unwrap(compareFrames(frame, frame))).toBe(0);
  });

  it('is small for a one-pixel change in a large frame', () => {
    // The reason a hash is the wrong tool for regression: this change matters to nobody.
    const left = solidFrame(64, 64, 128);
    const right = solidFrame(64, 64, 128);
    right.data[0] = 255;
    const distance = unwrap(compareFrames(left, right));
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(0.001);
  });

  it('is large when the structure moves', () => {
    expect(unwrap(compareFrames(halves(64, 64), halves(64, 64, true)))).toBeGreaterThan(0.5);
  });

  it('refuses to compare signatures of different sizes', () => {
    const result = perceptualDistance(
      perceptualSignature(solidFrame(8, 8, 0), 4),
      perceptualSignature(solidFrame(8, 8, 0), 8),
    );
    expect(result.ok).toBe(false);
  });
});

describe('decodeWithSharp', () => {
  /** A structurally-typed stand-in; the real module is injected by the composition root. */
  function fakeSharp(output: Uint8Array): SharpLike {
    const instance: SharpInstanceLike = {
      greyscale: () => instance,
      resize: () => instance,
      raw: () => instance,
      toBuffer: () => Promise.resolve(output),
    };
    return () => instance;
  }

  it('accepts four-channel output as it stands', async () => {
    const rgba = new Uint8Array(2 * 2 * 4).fill(7);
    const frame = unwrap(await decodeWithSharp(fakeSharp(rgba), new Uint8Array(), 2, 2));
    expect(frame.data).toEqual(rgba);
  });

  it('widens three-channel output rather than rejecting an opaque JPEG', () => {
    const rgb = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    return decodeWithSharp(fakeSharp(rgb), new Uint8Array(), 2, 2).then((result) => {
      const frame = unwrap(result);
      expect([...frame.data.slice(0, 4)]).toEqual([1, 2, 3, 255]);
      expect(frame.data.length).toBe(16);
    });
  });

  it('rejects output whose length matches neither layout', async () => {
    const result = await decodeWithSharp(fakeSharp(new Uint8Array(5)), new Uint8Array(), 2, 2);
    expect(result.ok).toBe(false);
  });

  it('turns a decode exception into a Result', async () => {
    const exploding: SharpLike = () => {
      throw new Error('unsupported image format');
    };
    const result = await decodeWithSharp(exploding, new Uint8Array(), 2, 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('unsupported image format');
  });
});
