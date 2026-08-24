/**
 * The media type is read from the bytes, and the bytes cannot be wrong about what they
 * are.
 *
 * `BlobStore` addresses content and deliberately records nothing about it, so there is no
 * stored type to serve. A caller-declared one would be a second source of truth that can
 * disagree with the file, and the way that disagreement shows up is a browser refusing to
 * paint a part that is on disk and correct.
 */

import { describe, expect, it } from 'vitest';

import { sniffMediaType } from './blobs.controller';

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe('sniffing a blob', () => {
  it('recognises the four image formats this system writes', () => {
    expect(sniffMediaType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe(
      'image/png',
    );
    expect(sniffMediaType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMediaType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif');
    expect(sniffMediaType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe(
      'image/webp',
    );
  });

  it('does not call a RIFF container that is not WEBP an image', () => {
    // `RIFF` alone is a WAV as often as a WebP. Answering `image/webp` would make a
    // browser try to paint an audio file and fail in a way nobody can trace back here.
    expect(sniffMediaType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45))).toBe(
      'application/octet-stream',
    );
  });

  it('recognises the atlas maps and step records, which have no magic number', () => {
    expect(sniffMediaType(new TextEncoder().encode('{"frames":[]}'))).toBe('application/json');
    expect(sniffMediaType(new TextEncoder().encode('[1,2,3]'))).toBe('application/json');
  });

  it('says it does not know rather than guessing', () => {
    // `application/octet-stream` is what "we do not know" means over HTTP. A plausible
    // guess is worse than none: a client that trusts it renders the wrong thing.
    expect(sniffMediaType(bytes(0x00, 0x01, 0x02, 0x03))).toBe('application/octet-stream');
    expect(sniffMediaType(new Uint8Array())).toBe('application/octet-stream');
  });
});
