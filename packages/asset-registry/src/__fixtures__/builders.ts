/**
 * Test material for the registry.
 *
 * Every builder returns a **parsed** value, not a schema input: the dedup key is
 * computed from the spec after Zod applies its defaults, so a fixture that skipped
 * parsing would let a test pass against a hash the production path never produces.
 *
 * Ids and clocks are deterministic. Two runs of the same test mint the same ids, which
 * is what lets a test assert on ordering and on a key rather than on "some string".
 */

import { FixedClock, IdGenerator, type Sha256, instant, sha256 } from '@rv/shared-kernel';
import {
  type Asset,
  type AssetId,
  type AssetSpec as AssetSpecType,
  AssetSpec,
  type AssetVariant,
  type AssetVersion,
  Ids,
  type Part,
  type Provenance,
  type StoryInterval,
} from '@rv/contracts';

import { deriveAssetKey } from '../asset-key';
import type { NewAssetVersion } from '../ports/index';

export const NOW_MS = 1_724_400_000_000;
export const NOW_ISO = new Date(NOW_MS).toISOString();

/** Two style checksums, so "a restyle forks the library" is one line in a test. */
export const STYLE_CHECKSUM_A = sha256('style-a');
export const STYLE_CHECKSUM_B = sha256('style-b');

export function fixedClock(atMs: number = NOW_MS): FixedClock {
  return new FixedClock(instant(atMs));
}

/**
 * A deterministic id source.
 *
 * `startMs` separates two sources that must not collide - a test needing "an id that
 * is definitely not in this document" reaches for a different start.
 */
export function testIds(startMs: number = NOW_MS): Ids {
  return new Ids(new IdGenerator(new FixedClock(instant(startMs)), fixedBytes()));
}

function fixedBytes(): (size: number) => Uint8Array {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, index) => (counter * 7 + index * 13) & 0xff);
  };
}

export function testHash(seed: string): Sha256 {
  return sha256(seed);
}

export function provenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    source: 'image-model',
    parents: [],
    createdAt: NOW_ISO,
    costNanoUsd: 0,
    ...overrides,
  };
}

export function assetSpec(overrides: Record<string, unknown> = {}): AssetSpecType {
  return AssetSpec.parse({
    semanticKey: 'flora/oak-tree/mature',
    archetype: 'tree',
    subjectClass: 'foliage',
    label: 'Mature oak',
    description: 'A broad, weather-worn oak with three main boughs.',
    tags: ['tree', 'forest'],
    canvas: { width: 1024, height: 1024 },
    nominalHeight: 512,
    parts: [
      { name: 'trunk', role: 'trunk', description: 'Thick furrowed trunk', zOrder: 0 },
      { name: 'canopy', role: 'canopy', description: 'Dense leaf mass', zOrder: 1 },
    ],
    variants: [],
    references: [],
    quality: 'preview',
    requireAlpha: true,
    ...overrides,
  });
}

export function part(ids: Ids, name: string, overrides: Partial<Part> = {}): Part {
  return {
    id: ids.part(),
    name,
    role: name,
    imageHash: testHash(`part:${name}`),
    bounds: { x: 0, y: 0, width: 512, height: 512 },
    size: { width: 512, height: 512 },
    pivot: { x: 0.5, y: 0.5 },
    zOrder: 0,
    deformable: false,
    alphaCoverage: 0.62,
    ...overrides,
  };
}

/** The smallest version that satisfies `AssetVersion`, minus the fields storage owns. */
export function newAssetVersion(
  ids: Ids,
  overrides: Partial<NewAssetVersion> = {},
): NewAssetVersion {
  return {
    id: ids.assetVersion(),
    status: 'ready',
    styleBibleId: ids.styleBible(),
    styleChecksum: STYLE_CHECKSUM_A,
    parts: [part(ids, 'trunk'), part(ids, 'canopy', { zOrder: 1 })],
    variants: [],
    clips: [],
    canvas: { width: 1024, height: 1024 },
    nominalHeight: 512,
    quality: 'preview',
    provenance: provenance(),
    ...overrides,
  };
}

export function variant(
  ids: Ids,
  key: string,
  validity: StoryInterval | null = null,
  overrides: Partial<AssetVariant> = {},
): AssetVariant {
  return {
    id: ids.variant(),
    key,
    label: key,
    replacedParts: { canopy: testHash(`variant:${key}:canopy`) },
    provenance: provenance({ source: 'derived' }),
    ...(validity === null ? {} : { validity }),
    ...overrides,
  };
}

export function assetVersion(
  ids: Ids,
  assetId: AssetId,
  ordinal: number,
  overrides: Partial<AssetVersion> = {},
): AssetVersion {
  return { ...newAssetVersion(ids), assetId, ordinal, ...overrides };
}

/** A whole, self-consistent `Asset` - one version, current, keyed from a real spec. */
export function asset(ids: Ids, overrides: Partial<Asset> = {}): Asset {
  const id = ids.asset();
  const spec = assetSpec();
  const { key } = deriveAssetKey(spec, { styleChecksum: STYLE_CHECKSUM_A });
  const version = assetVersion(ids, id, 1);
  return {
    id,
    key,
    semanticKey: spec.semanticKey,
    archetype: spec.archetype,
    label: spec.label,
    description: spec.description,
    tags: spec.tags,
    versions: [version],
    currentVersionId: version.id,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}
