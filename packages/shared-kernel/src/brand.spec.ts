import { describe, expect, it } from 'vitest';

import { defineBrand, type Brand } from './brand';

type SlugBase = string;
const Slug = defineBrand(
  'Slug',
  (value): value is SlugBase => typeof value === 'string' && /^[a-z0-9-]+$/.test(value),
);

describe('defineBrand', () => {
  it('exposes the brand name', () => {
    expect(Slug.brand).toBe('Slug');
  });

  it('parse returns a branded value for valid input', () => {
    expect(Slug.parse('oak-tree')).toBe('oak-tree');
  });

  it('parse returns undefined for invalid input instead of throwing', () => {
    expect(Slug.parse('Oak Tree')).toBeUndefined();
    expect(Slug.parse('')).toBeUndefined();
  });

  it('is narrows unknown values', () => {
    const value: unknown = 'oak-tree';
    expect(Slug.is(value)).toBe(true);
    expect(Slug.is(42)).toBe(false);
    if (Slug.is(value)) {
      // Compiles only because `is` narrowed to the branded type.
      const branded: Brand<string, 'Slug'> = value;
      expect(branded).toBe('oak-tree');
    }
  });

  it('unsafe brands without validating - the documented escape hatch', () => {
    expect(Slug.unsafe('NOT A SLUG')).toBe('NOT A SLUG');
  });

  it('branding is erased at runtime', () => {
    const branded = Slug.parse('a-b');
    expect(typeof branded).toBe('string');
    expect(JSON.stringify({ s: branded })).toBe('{"s":"a-b"}');
  });
});
