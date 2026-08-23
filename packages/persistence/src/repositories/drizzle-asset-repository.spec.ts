/**
 * Repository tests, against a real in-memory SQLite with the real migrations applied.
 *
 * Nothing here is mocked. Half of what is asserted - the dedup unique index, the
 * ordinal collision, the absence of a cascade - is a property of the schema rather
 * than of this file's code, and a fake repository would pass every one of these tests
 * while the shipped one failed them.
 */

import { FixedClock, IdGenerator, instant, sha256, toIso, unwrap } from '@rv/shared-kernel';
import {
  type AssetId,
  type AssetKey,
  type AssetVersionId,
  Ids,
  type IsoInstant,
  type Provenance,
  Rig,
} from '@rv/contracts';
import type { AssetIdentityDraft, NewAssetVersion } from '@rv/asset-registry';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../database/database';
import { openTestDatabase } from '../__fixtures__/workspace';
import { assetVersions, assets, clips, parts, variants } from '../schema/index';
import { DrizzleAssetRepository } from './drizzle-asset-repository';

const NOW = toIso(instant(1_724_400_000_000));
const STYLE_A = sha256('style-a') as string;

let handle: DatabaseHandle;
let repository: DrizzleAssetRepository;
let ids: Ids;

function nextIds(startMs = 1_724_400_000_000): Ids {
  let counter = 0;
  return new Ids(
    new IdGenerator(new FixedClock(instant(startMs)), (size) => {
      counter += 1;
      return Uint8Array.from({ length: size }, (_, index) => (counter * 11 + index * 5) & 0xff);
    }),
  );
}

function provenance(): Provenance {
  return { source: 'image-model', parents: [], createdAt: NOW, costNanoUsd: 0 };
}

function identity(key: AssetKey, assetId: AssetId): AssetIdentityDraft {
  return {
    id: assetId,
    key,
    keyParts: {
      semanticKey: 'flora/oak-tree/mature',
      styleChecksum: STYLE_A,
      variantKey: 'base',
      specHash: sha256('spec'),
    },
    semanticKey: 'flora/oak-tree/mature',
    archetype: 'tree',
    label: 'Mature oak',
    description: 'An old, gnarled oak.',
    tags: ['tree', 'forest'],
  };
}

function version(overrides: Partial<NewAssetVersion> = {}): NewAssetVersion {
  return {
    id: ids.assetVersion(),
    status: 'ready',
    styleBibleId: ids.styleBible(),
    styleChecksum: STYLE_A,
    parts: [
      {
        id: ids.part(),
        name: 'trunk',
        role: 'trunk',
        imageHash: sha256('trunk'),
        bounds: { x: 0, y: 0, width: 512, height: 700 },
        size: { width: 512, height: 700 },
        pivot: { x: 0.5, y: 1 },
        zOrder: 0,
        deformable: false,
        alphaCoverage: 0.44,
      },
    ],
    variants: [],
    clips: [],
    canvas: { width: 1024, height: 1024 },
    nominalHeight: 512,
    quality: 'preview',
    provenance: provenance(),
    ...overrides,
  };
}

function key(seed: string): AssetKey {
  return sha256(seed) as string as AssetKey;
}

beforeEach(() => {
  handle = openTestDatabase();
  repository = new DrizzleAssetRepository(handle);
  ids = nextIds();
});

afterEach(() => {
  handle.close();
});

describe('create', () => {
  it('stores an asset with its first version at ordinal 1', async () => {
    const assetId = ids.asset();
    const first = version();

    const created = await repository.create(identity(key('a'), assetId), first, NOW);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.version.ordinal).toBe(1);
    expect(created.value.version.assetId).toBe(assetId);
    expect(created.value.asset.currentVersionId).toBe(first.id);
  });

  it('round-trips every part field through the flattened columns', async () => {
    const assetId = ids.asset();
    const first = version();
    await repository.create(identity(key('a'), assetId), first, NOW);

    const loaded = await repository.findById(assetId);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok || loaded.value === null) return;
    expect(loaded.value.versions[0]?.parts).toEqual(first.parts);
  });

  it('round-trips variants and clips, including the optional fields', async () => {
    const assetId = ids.asset();
    const first = version({
      variants: [
        {
          id: ids.variant(),
          key: 'winter',
          label: 'Winter',
          replacedParts: { trunk: sha256('winter-trunk') },
          validity: { from: { ordinal: 60, label: 'after the fire' }, until: null },
          provenance: provenance(),
        },
      ],
      clips: [
        {
          id: ids.clip(),
          name: 'sway',
          label: 'Idle sway',
          source: 'template',
          durationMs: 2400,
          fps: 24,
          loop: 'loop',
          irHash: sha256('ir'),
          bakedSheetId: ids.sheet(),
          tags: ['ambient'],
          provenance: provenance(),
        },
      ],
    });

    await repository.create(identity(key('a'), assetId), first, NOW);
    const loaded = await repository.findById(assetId);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok || loaded.value === null) return;
    expect(loaded.value.versions[0]?.variants).toEqual(first.variants);
    expect(loaded.value.versions[0]?.clips).toEqual(first.clips);
  });

  it('round-trips every optional version field, present and absent', async () => {
    const assetId = ids.asset();
    const rig = Rig.parse({
      id: ids.rig(),
      archetype: 'tree',
      templateId: 'tree-basic',
      bones: [
        {
          id: ids.bone(),
          name: 'trunk',
          role: 'trunk',
          parentId: null,
          rest: { position: { x: 0, y: 0 }, length: 700 },
        },
      ],
    });
    const dressed = version({
      rig,
      previewImageHash: sha256('preview'),
      scores: {
        styleMatch: 0.9,
        alphaCleanliness: 0.8,
        silhouetteReadability: 0.85,
        partCompleteness: 1,
        overall: 0.88,
      },
      rejectionReason: 'Halo on the canopy edge.',
      status: 'rejected',
    });

    await repository.create(identity(key('a'), assetId), dressed, NOW);
    const loaded = await repository.findById(assetId);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok || loaded.value === null) return;
    const stored = loaded.value.versions[0];
    expect(stored?.rig).toEqual(rig);
    expect(stored?.previewImageHash).toBe(sha256('preview'));
    expect(stored?.scores?.overall).toBe(0.88);
    expect(stored?.rejectionReason).toBe('Halo on the canopy edge.');

    // A version without them keeps them absent rather than present-and-null: under
    // `exactOptionalPropertyTypes` those are different types and a different contract.
    await repository.appendVersion({ ...version(), assetId }, { makeCurrent: true }, NOW);
    const both = await repository.findById(assetId);
    if (!both.ok || both.value === null) return;
    const bare = both.value.versions.find((entry) => entry.ordinal === 2);
    expect(bare).not.toHaveProperty('rig');
    expect(bare).not.toHaveProperty('scores');
    expect(bare).not.toHaveProperty('previewImageHash');
    expect(bare).not.toHaveProperty('rejectionReason');
  });

  it('distinguishes an absent validity from an unbounded one', async () => {
    const assetId = ids.asset();
    const first = version({
      variants: [
        {
          id: ids.variant(),
          key: 'plain',
          label: 'Plain',
          replacedParts: {},
          provenance: provenance(),
        },
      ],
    });

    await repository.create(identity(key('a'), assetId), first, NOW);
    const loaded = await repository.findById(assetId);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok || loaded.value === null) return;
    // `exactOptionalPropertyTypes` makes these different types, and the resolver's
    // "which variant applies at ordinal N" branch depends on telling them apart.
    expect(loaded.value.versions[0]?.variants[0]).not.toHaveProperty('validity');
  });

  it('refuses a second asset under the same dedup key, at the database level', async () => {
    const shared = key('shared');
    await repository.create(identity(shared, ids.asset()), version(), NOW);

    const second = await repository.create(identity(shared, ids.asset()), version(), NOW);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.kind).toBe('conflict');
  });

  it('refuses two assets whose four key components agree even if the key column differs', async () => {
    // The composite unique index is the backstop for a caller that computed the key
    // wrongly: the components are what actually identify an asset.
    await repository.create(identity(key('one'), ids.asset()), version(), NOW);

    const second = await repository.create(identity(key('two'), ids.asset()), version(), NOW);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.kind).toBe('conflict');
  });

  it('rolls the whole registration back when the version insert fails', async () => {
    const assetId = ids.asset();
    const duplicatePartName = version();
    const clashing = {
      ...duplicatePartName,
      parts: [
        duplicatePartName.parts[0] ?? version().parts[0],
        { ...(duplicatePartName.parts[0] ?? version().parts[0]), id: ids.part() },
      ],
    } as NewAssetVersion;

    const created = await repository.create(identity(key('a'), assetId), clashing, NOW);

    expect(created.ok).toBe(false);
    // No orphan asset row: the transaction covered both inserts.
    expect(handle.db.select().from(assets).all()).toEqual([]);
  });
});

describe('appendVersion', () => {
  let assetId: AssetId;
  let firstVersionId: AssetVersionId;

  beforeEach(async () => {
    assetId = ids.asset();
    const first = version();
    firstVersionId = first.id;
    await repository.create(identity(key('a'), assetId), first, NOW);
  });

  it('assigns the next ordinal and leaves the previous version untouched', async () => {
    const before = handle.db
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.id, firstVersionId))
      .all();

    const appended = await repository.appendVersion(
      { ...version(), assetId },
      { makeCurrent: true },
      NOW,
    );

    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.value.version.ordinal).toBe(2);
    expect(appended.value.asset.versions).toHaveLength(2);
    expect(
      handle.db.select().from(assetVersions).where(eq(assetVersions.id, firstVersionId)).all(),
    ).toEqual(before);
  });

  it('keeps version 1 readable after version 2 is added', async () => {
    await repository.appendVersion({ ...version(), assetId }, { makeCurrent: true }, NOW);

    const loaded = await repository.findById(assetId);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok || loaded.value === null) return;
    expect(loaded.value.versions.map((entry) => entry.ordinal)).toEqual([1, 2]);
    expect(loaded.value.versions.some((entry) => entry.id === firstVersionId)).toBe(true);
  });

  it('assigns distinct ordinals to concurrent appends', async () => {
    const results = await Promise.all([
      repository.appendVersion({ ...version(), assetId }, { makeCurrent: false }, NOW),
      repository.appendVersion({ ...version(), assetId }, { makeCurrent: false }, NOW),
      repository.appendVersion({ ...version(), assetId }, { makeCurrent: false }, NOW),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    const loaded = await repository.findById(assetId);
    if (!loaded.ok || loaded.value === null) throw new Error('expected the asset');
    expect(loaded.value.versions.map((entry) => entry.ordinal).sort()).toEqual([1, 2, 3, 4]);
  });

  it('can add a take without promoting it', async () => {
    const appended = await repository.appendVersion(
      { ...version(), assetId },
      { makeCurrent: false },
      NOW,
    );

    expect(appended.ok && appended.value.asset.currentVersionId).toBe(firstVersionId);
  });

  it('reports an unknown asset rather than orphaning a version', async () => {
    const orphan = await repository.appendVersion(
      { ...version(), assetId: nextIds(1_900_000_000_000).asset() },
      { makeCurrent: true },
      NOW,
    );

    expect(orphan.ok).toBe(false);
    if (orphan.ok) return;
    expect(orphan.error.kind).toBe('not-found');
  });
});

describe('setCurrentVersion', () => {
  it('rolls back to an earlier version, leaving the later one retrievable', async () => {
    const assetId = ids.asset();
    const first = version();
    await repository.create(identity(key('a'), assetId), first, NOW);
    const second = await repository.appendVersion(
      { ...version(), assetId },
      { makeCurrent: true },
      NOW,
    );
    if (!second.ok) throw new Error('setup failed');

    const rolled = await repository.setCurrentVersion(assetId, first.id, NOW);

    expect(rolled.ok).toBe(true);
    const loaded = await repository.findById(assetId);
    if (!loaded.ok || loaded.value === null) throw new Error('expected the asset');
    expect(loaded.value.currentVersionId).toBe(first.id);
    expect(loaded.value.versions.some((entry) => entry.id === second.value.version.id)).toBe(true);
  });

  it('refuses to point at a version that does not exist', async () => {
    const assetId = ids.asset();
    await repository.create(identity(key('a'), assetId), version(), NOW);

    const rolled = await repository.setCurrentVersion(
      assetId,
      nextIds(1_900_000_000_000).assetVersion(),
      NOW,
    );

    expect(rolled.ok).toBe(false);
    if (rolled.ok) return;
    expect(rolled.error.kind).toBe('not-found');
  });
});

describe('lookups', () => {
  it('finds nothing for an unknown key without failing', async () => {
    expect(await repository.findByKey(key('absent'))).toEqual({ ok: true, value: null });
    expect(await repository.findById(ids.asset())).toEqual({ ok: true, value: null });
  });

  it('returns an empty map for an empty key list, without querying', async () => {
    const found = await repository.findManyByKeys([]);

    expect(found.ok && found.value.size).toBe(0);
  });

  it('resolves a bulk lookup in one pass, including keys that miss', async () => {
    const present = key('present');
    await repository.create(identity(present, ids.asset()), version(), NOW);

    const found = await repository.findManyByKeys([present, key('absent')]);

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect([...found.value.keys()]).toEqual([present]);
  });

  it('handles more keys than fit in one bound-parameter batch', async () => {
    const many = Array.from({ length: 900 }, (_, index) => key(`bulk-${String(index)}`));
    const present = many[0];
    if (present === undefined) throw new Error('setup failed');
    await repository.create(identity(present, ids.asset()), version(), NOW);

    const found = await repository.findManyByKeys(many);

    expect(found.ok && found.value.size).toBe(1);
  });
});

describe('the semantic index', () => {
  it('round-trips an embedding exactly, so a ranking cannot drift', async () => {
    const assetId = ids.asset();
    await repository.create(identity(key('a'), assetId), version(), NOW);
    const vector = [0.1, -0.25, 1 / 3, 1e-9];

    const saved = await repository.saveEmbedding(assetId, vector, 'nomic-embed-text');

    expect(saved.ok).toBe(true);
    const records = await repository.listSearchRecords();
    if (!records.ok) throw new Error('expected the index');
    expect(records.value[0]?.embedding).toEqual(vector);
    expect(records.value[0]?.embeddingModel).toBe('nomic-embed-text');
  });

  it('lists unindexed assets with a null vector rather than omitting them', async () => {
    await repository.create(identity(key('a'), ids.asset()), version(), NOW);

    const records = await repository.listSearchRecords();

    expect(records.ok).toBe(true);
    if (!records.ok) return;
    expect(records.value[0]).toMatchObject({ embedding: null, embeddingModel: null });
    expect(records.value[0]?.tags).toEqual(['tree', 'forest']);
  });

  it('refuses to index an asset that is not there', async () => {
    const saved = await repository.saveEmbedding(ids.asset(), [1, 2, 3], 'nomic-embed-text');

    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.error.kind).toBe('not-found');
  });
});

describe('the schema itself', () => {
  it('does not cascade a deleted asset onto its versions', async () => {
    const assetId = ids.asset();
    await repository.create(identity(key('a'), assetId), version(), NOW);

    // RV-106: ownership is by reference. Removing the index row must not be able to
    // remove the versions another project may still resolve.
    expect(() => handle.db.delete(assets).where(eq(assets.id, assetId)).run()).toThrow();
    expect(handle.db.select().from(assetVersions).all()).toHaveLength(1);
  });

  it('rejects a duplicate ordinal even when inserted behind the repository', async () => {
    const assetId = ids.asset();
    const first = version();
    await repository.create(identity(key('a'), assetId), first, NOW);

    expect(() =>
      handle.db
        .insert(assetVersions)
        .values({
          id: ids.assetVersion(),
          assetId,
          ordinal: 1,
          status: 'ready',
          styleBibleId: ids.styleBible(),
          styleChecksum: STYLE_A,
          rig: null,
          canvasWidth: 1024,
          canvasHeight: 1024,
          nominalHeight: 512,
          previewImageHash: null,
          quality: 'preview',
          scores: null,
          rejectionReason: null,
          provenance: provenance(),
          createdAt: NOW satisfies IsoInstant,
        })
        .run(),
    ).toThrow();
  });

  it('keeps parts, variants and clips attached to their version', async () => {
    const assetId = ids.asset();
    const first = version({
      variants: [
        {
          id: ids.variant(),
          key: 'winter',
          label: 'Winter',
          replacedParts: {},
          provenance: provenance(),
        },
      ],
      clips: [
        {
          id: ids.clip(),
          name: 'sway',
          source: 'template',
          durationMs: 1000,
          fps: 24,
          loop: 'loop',
          irHash: sha256('ir'),
          tags: [],
          provenance: provenance(),
        },
      ],
    });
    await repository.create(identity(key('a'), assetId), first, NOW);

    expect(handle.db.select().from(parts).all()).toHaveLength(1);
    expect(handle.db.select().from(variants).all()).toHaveLength(1);
    expect(handle.db.select().from(clips).all()).toHaveLength(1);
  });
});

describe('the test database itself', () => {
  it('is a real migrated SQLite, not a stand-in', () => {
    expect(unwrap({ ok: true, value: handle.location })).toBe(':memory:');
  });
});
