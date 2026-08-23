import { describe, expect, it } from 'vitest';

import { indexedFrame, solidFrame } from '../__fixtures__/doubles';
import { hashFrame, hashFrameSequence } from './frame-hash';

describe('hashFrame', () => {
  it('is stable for identical pixels', () => {
    expect(hashFrame(indexedFrame(8, 8, 3))).toBe(hashFrame(indexedFrame(8, 8, 3)));
  });

  it('separates frames that differ by one byte', () => {
    const left = solidFrame(4, 4, 0);
    const right = solidFrame(4, 4, 0);
    right.data[7] = 1;
    expect(hashFrame(left)).not.toBe(hashFrame(right));
  });

  it('separates two frames with the same bytes but different dimensions', () => {
    // A 100x50 and a 50x100 frame hold the same 20,000 bytes. Without the dimensions in
    // the digest they would be the same frame as far as the golden fixture is concerned.
    const wide = { width: 8, height: 2, data: new Uint8Array(64) };
    const tall = { width: 2, height: 8, data: new Uint8Array(64) };
    expect(hashFrame(wide)).not.toBe(hashFrame(tall));
  });
});

describe('hashFrameSequence', () => {
  it('depends on order', () => {
    const a = hashFrame(indexedFrame(4, 4, 0));
    const b = hashFrame(indexedFrame(4, 4, 1));
    expect(hashFrameSequence([a, b])).not.toBe(hashFrameSequence([b, a]));
  });

  it('is the same for the same run', () => {
    const hashes = [0, 1, 2].map((frame) => hashFrame(indexedFrame(4, 4, frame)));
    expect(hashFrameSequence(hashes)).toBe(hashFrameSequence([...hashes]));
  });
});
