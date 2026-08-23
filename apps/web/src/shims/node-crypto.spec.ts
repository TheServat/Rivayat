import { describe, expect, it } from 'vitest';

import { createHash, getRandomValues } from './node-crypto';

describe('the browser node:crypto stand-in', () => {
  it('fills a buffer from Web Crypto', () => {
    const buffer = new Uint8Array(16);
    const returned = getRandomValues(buffer);
    expect(returned).toBe(buffer);
    expect(buffer.some((byte) => byte !== 0)).toBe(true);
  });

  /**
   * Hashing must fail loudly rather than return something plausible.
   *
   * A dedup key is `sha256(semanticKey ‖ styleChecksum ‖ variantKey ‖ specHash)`, and a
   * *wrong* one does not error - it misses the cache and pays for an asset that already
   * exists, or worse, collides. The studio has no business computing one, so the shim
   * refuses instead of guessing.
   */
  it('refuses to hash', () => {
    expect(() => createHash('sha256')).toThrow(/not available in the studio/);
  });
});
