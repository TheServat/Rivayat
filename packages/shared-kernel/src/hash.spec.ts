import { describe, expect, it } from 'vitest';

import { ValidationError } from './errors';
import { compositeHash, contentHash, shardPath, sha256, shortHash, stableStringify } from './hash';

describe('sha256', () => {
  it('matches the known digest of the empty string', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes bytes and the equivalent string identically', () => {
    expect(sha256(new TextEncoder().encode('abc'))).toBe(sha256('abc'));
  });
});

describe('stableStringify - the dedup guarantee', () => {
  it('is insensitive to key insertion order', () => {
    // This is the whole point: without it, an identical asset spec built in a
    // different order would miss the cache and cost money.
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('sorts keys recursively', () => {
    expect(stableStringify({ z: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it('preserves array order, which is semantic', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it('treats an absent member and an explicitly-undefined member as identical', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('encodes undefined inside an array as null, keeping positions stable', () => {
    expect(stableStringify([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('normalises -0 to 0 so the two cannot fork the cache', () => {
    expect(stableStringify(-0)).toBe(stableStringify(0));
  });

  it('serialises Date as ISO and Uint8Array as hex', () => {
    expect(stableStringify(new Date('2026-08-23T00:00:00.000Z'))).toBe(
      '"2026-08-23T00:00:00.000Z"',
    );
    expect(stableStringify(new Uint8Array([0, 15, 255]))).toBe('"000fff"');
  });

  it('handles the primitive leaves', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(false)).toBe('false');
    expect(stableStringify('a"b')).toBe('"a\\"b"');
    expect(stableStringify(10n)).toBe('"10n"');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses non-finite number %s rather than coercing it', (_label, value) => {
    expect(() => stableStringify(value)).toThrow(ValidationError);
  });

  it('refuses top-level undefined, functions and symbols', () => {
    expect(() => stableStringify(undefined)).toThrow(ValidationError);
    expect(() => stableStringify(() => 0)).toThrow(ValidationError);
    expect(() => stableStringify(Symbol('s'))).toThrow(ValidationError);
  });

  it('refuses a circular structure instead of hanging', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(() => stableStringify(circular)).toThrow(/circular/i);
  });

  it('allows the same object to appear twice in a tree (shared, not circular)', () => {
    const shared = { v: 1 };
    expect(stableStringify({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });

  it('reports the path of the offending node', () => {
    expect(() => stableStringify({ outer: { inner: [1, Number.NaN] } })).toThrow(
      /\$\.outer\.inner\[1\]/,
    );
  });
});

describe('contentHash', () => {
  it('is stable across key order', () => {
    expect(contentHash({ style: 'ink', seed: 1 })).toBe(contentHash({ seed: 1, style: 'ink' }));
  });

  it('differs when any value differs', () => {
    expect(contentHash({ seed: 1 })).not.toBe(contentHash({ seed: 2 }));
  });
});

describe('compositeHash', () => {
  it('is not vulnerable to the concatenation collision', () => {
    // Without length prefixing, "ab"+"c" and "a"+"bc" would collide - and these are
    // exactly the shapes that make up an asset key (semanticKey, style, variant).
    expect(compositeHash('ab', 'c')).not.toBe(compositeHash('a', 'bc'));
  });

  it('is order-sensitive', () => {
    expect(compositeHash('a', 'b')).not.toBe(compositeHash('b', 'a'));
  });

  it('is deterministic', () => {
    expect(compositeHash('a', 'b')).toBe(compositeHash('a', 'b'));
  });
});

describe('store layout helpers', () => {
  it('shortHash truncates to the requested length', () => {
    const hash = sha256('x');
    expect(shortHash(hash)).toHaveLength(12);
    expect(shortHash(hash, 6)).toBe(hash.slice(0, 6));
  });

  it('shardPath prefixes with the first two hex characters', () => {
    const hash = sha256('x');
    expect(shardPath(hash)).toBe(`${hash.slice(0, 2)}/${hash}`);
  });
});
