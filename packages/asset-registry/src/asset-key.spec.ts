import { createRng } from '@rv/shared-kernel';
import { AssetSpec, type AssetKeyParts } from '@rv/contracts';
import { describe, expect, it } from 'vitest';

import {
  BASE_VARIANT_KEY,
  SPEC_FIELDS_ALREADY_IN_KEY,
  computeAssetKey,
  computeSpecHash,
  deriveAssetKey,
  deriveAssetKeyParts,
} from './asset-key';
import { STYLE_CHECKSUM_A, STYLE_CHECKSUM_B, assetSpec } from './__fixtures__/builders';

const CONTEXT = { styleChecksum: STYLE_CHECKSUM_A };

describe('computeSpecHash', () => {
  it('ignores the order the spec fields were written in', () => {
    const written = AssetSpec.parse({
      semanticKey: 'flora/oak-tree/mature',
      archetype: 'tree',
      subjectClass: 'foliage',
      label: 'Mature oak',
      description: 'A broad, weather-worn oak.',
      parts: [{ name: 'trunk', role: 'trunk', description: 'Trunk', zOrder: 0 }],
    });
    const reordered = AssetSpec.parse({
      parts: [{ zOrder: 0, description: 'Trunk', role: 'trunk', name: 'trunk' }],
      description: 'A broad, weather-worn oak.',
      label: 'Mature oak',
      subjectClass: 'foliage',
      archetype: 'tree',
      semanticKey: 'flora/oak-tree/mature',
    });

    expect(computeSpecHash(reordered)).toBe(computeSpecHash(written));
  });

  it('treats tags as a set: order and duplicates do not fork the key', () => {
    const a = assetSpec({ tags: ['forest', 'tree'] });
    const b = assetSpec({ tags: ['tree', 'forest', 'tree'] });

    expect(computeSpecHash(b)).toBe(computeSpecHash(a));
  });

  it('treats parts, variants and references as sets', () => {
    const parts = [
      { name: 'trunk', role: 'trunk', description: 'Trunk', zOrder: 0 },
      { name: 'canopy', role: 'canopy', description: 'Canopy', zOrder: 1 },
    ];
    const variants = [
      { key: 'winter', label: 'Winter', instruction: 'Bare branches' },
      { key: 'night', label: 'Night', instruction: 'Moonlit' },
    ];
    const references = [
      { imageHash: 'a'.repeat(64), role: 'style-anchor' },
      { imageHash: 'b'.repeat(64), role: 'identity-anchor' },
    ];

    const forwards = assetSpec({ parts, variants, references });
    const backwards = assetSpec({
      parts: [...parts].reverse(),
      variants: [...variants].reverse(),
      references: [...references].reverse(),
    });

    expect(computeSpecHash(backwards)).toBe(computeSpecHash(forwards));
  });

  it('excludes semanticKey, and only semanticKey', () => {
    expect(SPEC_FIELDS_ALREADY_IN_KEY).toEqual(['semanticKey']);

    const base = assetSpec();
    const renamed = assetSpec({ semanticKey: 'flora/birch-tree/young' });
    expect(computeSpecHash(renamed)).toBe(computeSpecHash(base));
  });

  it('moves when any other field moves', () => {
    // Enumerated from the schema rather than listed by hand: a field added to
    // `AssetSpec` later must either change the hash or be added to the exclusion list
    // deliberately. Omitting one silently serves an asset built from a different
    // request, which is the failure this test exists to make impossible.
    const perturbations: Record<string, Record<string, unknown>> = {
      archetype: { archetype: 'shrub' },
      subjectClass: { subjectClass: 'prop' },
      label: { label: 'Ancient oak' },
      description: { description: 'A completely different tree.' },
      tags: { tags: ['tree', 'winter'] },
      canvas: { canvas: { width: 2048, height: 1024 } },
      nominalHeight: { nominalHeight: 640 },
      parts: {
        parts: [{ name: 'trunk', role: 'trunk', description: 'A thinner trunk', zOrder: 0 }],
      },
      variants: {
        variants: [{ key: 'winter', label: 'Winter', instruction: 'Bare branches' }],
      },
      references: { references: [{ imageHash: 'c'.repeat(64), role: 'style-anchor' }] },
      quality: { quality: 'final' },
      requireAlpha: { requireAlpha: false },
    };

    const covered = new Set([...Object.keys(perturbations), ...SPEC_FIELDS_ALREADY_IN_KEY]);
    expect([...Object.keys(AssetSpec.shape)].filter((field) => !covered.has(field))).toEqual([]);

    const base = computeSpecHash(assetSpec());
    for (const [field, override] of Object.entries(perturbations)) {
      expect(computeSpecHash(assetSpec(override)), `${field} must move the spec hash`).not.toBe(
        base,
      );
    }
  });
});

describe('deriveAssetKeyParts', () => {
  it('defaults the variant key to "base"', () => {
    expect(deriveAssetKeyParts(assetSpec(), CONTEXT).variantKey).toBe(BASE_VARIANT_KEY);
  });

  it('carries the four components as data, so an unexpected miss can be diffed', () => {
    const spec = assetSpec();
    const parts = deriveAssetKeyParts(spec, {
      styleChecksum: STYLE_CHECKSUM_B,
      variantKey: 'winter',
    });

    expect(parts).toEqual({
      semanticKey: spec.semanticKey,
      styleChecksum: STYLE_CHECKSUM_B,
      variantKey: 'winter',
      specHash: computeSpecHash(spec),
    });
  });
});

describe('computeAssetKey', () => {
  const base: AssetKeyParts = {
    semanticKey: 'flora/oak-tree/mature',
    styleChecksum: STYLE_CHECKSUM_A,
    variantKey: 'base',
    specHash: 'd'.repeat(64),
  };

  it('is a lowercase sha256 hex digest', () => {
    expect(computeAssetKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['semanticKey', { semanticKey: 'flora/birch-tree/young' }],
    ['styleChecksum', { styleChecksum: STYLE_CHECKSUM_B }],
    ['variantKey', { variantKey: 'winter' }],
    ['specHash', { specHash: 'e'.repeat(64) }],
  ])('changes when %s changes', (_field, override) => {
    expect(computeAssetKey({ ...base, ...override })).not.toBe(computeAssetKey(base));
  });

  it('cannot be collided by shifting a boundary between components', () => {
    // The classic concatenation bug: `"ab"+"c"` and `"a"+"bc"` are the same string.
    // `compositeHash` length-prefixes, so these two must not agree - if they did, one
    // asset would be served in place of another.
    const left: AssetKeyParts = {
      semanticKey: 'ab',
      styleChecksum: 'c',
      variantKey: 'd',
      specHash: 'e',
    };
    const right: AssetKeyParts = {
      semanticKey: 'a',
      styleChecksum: 'bc',
      variantKey: 'd',
      specHash: 'e',
    };

    expect(computeAssetKey(right)).not.toBe(computeAssetKey(left));
  });
});

describe('key uniqueness over generated specs', () => {
  it('produces no collisions across 400 distinct specs', () => {
    const rng = createRng('rivayat-asset-key-property');
    const archetypes = ['tree', 'shrub', 'biped', 'quadruped', 'rigid-prop'] as const;
    const qualities = ['draft', 'preview', 'final'] as const;

    const seen = new Map<string, string>();
    let generated = 0;

    for (let index = 0; index < 400; index += 1) {
      const spec = assetSpec({
        semanticKey: `flora/species-${String(index % 37)}/stage-${String(index % 11)}`,
        archetype: archetypes[index % archetypes.length],
        quality: qualities[index % qualities.length],
        nominalHeight: 128 + (index % 9) * 64,
        tags: [`tag-${String(rng.int(0, 50))}`, `tag-${String(rng.int(0, 50))}`],
        canvas: { width: 512 + (index % 4) * 256, height: 512 + (index % 3) * 256 },
        parts: [
          {
            name: 'trunk',
            role: 'trunk',
            description: `Trunk variation ${String(index)}`,
            zOrder: 0,
          },
        ],
      });

      const styleChecksum = index % 2 === 0 ? STYLE_CHECKSUM_A : STYLE_CHECKSUM_B;
      const variantKey = index % 3 === 0 ? 'base' : `variant-${String(index % 5)}`;
      const { key } = deriveAssetKey(spec, { styleChecksum, variantKey });

      // Two specs that really are identical must share a key; that is the point. The
      // identity string is what "identical" means, so a collision is a key clash
      // between two *different* identities.
      const identity = `${spec.semanticKey}|${styleChecksum}|${variantKey}|${computeSpecHash(spec)}`;
      const previous = seen.get(key);
      if (previous === undefined) {
        seen.set(key, identity);
        generated += 1;
      } else {
        expect(previous, `key collision between two different specs: ${key}`).toBe(identity);
      }
    }

    expect(generated).toBeGreaterThan(300);
  });
});
