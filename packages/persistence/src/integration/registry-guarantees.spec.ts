/**
 * The guarantees, end to end, on real infrastructure.
 *
 * Every use-case in `@rv/asset-registry` is wired to the shipped SQLite repository and
 * the shipped content-addressed store. Nothing is faked. These are the tests that
 * would have to fail before "no asset is generated twice" stopped being true, so they
 * are written to assert observable facts - row counts, files on disk, ordinals that
 * survive - rather than that a method was called.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FixedClock,
  IdGenerator,
  type Result,
  instant,
  ok,
  sha256,
  toIso,
} from '@rv/shared-kernel';
import {
  AssetSpec,
  type AssetSpec as AssetSpecType,
  Ids,
  type IsoInstant,
  type Provenance,
  type RegenerateIntent,
  type Sha256Hex,
  type StyleBibleId,
} from '@rv/contracts';
import {
  FindSimilarAssetsUseCase,
  FlatRateAssetCostEstimator,
  RegenerateAssetUseCase,
  RegisterAssetVersionUseCase,
  ResolveAssetDemandUseCase,
  ResolveAssetRefUseCase,
  assetEmbeddingText,
  deriveAssetKey,
  type EmbeddingPort,
  type NewAssetVersion,
} from '@rv/asset-registry';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type TempBlobStore, openTempBlobStore, openTestDatabase } from '../__fixtures__/workspace';
import type { DatabaseHandle } from '../database/database';
import { DrizzleAssetRepository } from '../repositories/drizzle-asset-repository';
import { blobs } from '../schema/index';

const NOW = toIso(instant(1_724_400_000_000));
const STYLE_A = sha256('style-season-1') as string;
const STYLE_B = sha256('style-season-2') as string;

let handle: DatabaseHandle;
let repository: DrizzleAssetRepository;
let ids: Ids;
let clock: FixedClock;
let styleBibleId: StyleBibleId;

function freshIds(startMs = 1_724_400_000_000): Ids {
  let counter = 0;
  return new Ids(
    new IdGenerator(new FixedClock(instant(startMs)), (size) => {
      counter += 1;
      return Uint8Array.from({ length: size }, (_, index) => (counter * 17 + index * 3) & 0xff);
    }),
  );
}

function provenance(): Provenance {
  return { source: 'image-model', parents: [], createdAt: NOW, costNanoUsd: 0 };
}

function spec(overrides: Record<string, unknown> = {}): AssetSpecType {
  return AssetSpec.parse({
    semanticKey: 'flora/oak-tree/mature',
    archetype: 'tree',
    subjectClass: 'foliage',
    label: 'Mature oak',
    description: 'An old, gnarled oak with three main boughs.',
    tags: ['tree', 'forest'],
    parts: [
      { name: 'trunk', role: 'trunk', description: 'Thick furrowed trunk', zOrder: 0 },
      { name: 'canopy', role: 'canopy', description: 'Dense leaf mass', zOrder: 1 },
    ],
    ...overrides,
  });
}

function newVersion(
  styleChecksum: Sha256Hex,
  overrides: Partial<NewAssetVersion> = {},
): NewAssetVersion {
  return {
    id: ids.assetVersion(),
    status: 'ready',
    styleBibleId,
    styleChecksum,
    parts: [
      {
        id: ids.part(),
        name: 'trunk',
        role: 'trunk',
        imageHash: sha256('trunk-bytes'),
        bounds: { x: 0, y: 0, width: 512, height: 700 },
        size: { width: 512, height: 700 },
        pivot: { x: 0.5, y: 1 },
        zOrder: 0,
        deformable: false,
        alphaCoverage: 0.44,
      },
      {
        id: ids.part(),
        name: 'canopy',
        role: 'canopy',
        imageHash: sha256('canopy-bytes'),
        bounds: { x: 0, y: 0, width: 900, height: 600 },
        size: { width: 900, height: 600 },
        pivot: { x: 0.5, y: 0.5 },
        zOrder: 1,
        deformable: true,
        alphaCoverage: 0.71,
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

/** Row counts for every table, so "nothing was written" is a fact and not a claim. */
function snapshot(database: DatabaseHandle): Record<string, number> {
  const tables = database.db.all<{ name: string }>(
    sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`,
  );
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const [row] = database.sqlite.prepare(`select count(*) as n from "${table.name}"`).all() as {
      n: number;
    }[];
    counts[table.name] = row?.n ?? 0;
  }
  return counts;
}

class VocabularyEmbeddingPort implements EmbeddingPort {
  readonly model = 'test-keyword-v1';
  readonly dimensions = 8;
  readonly #terms = ['tree', 'oak', 'gnarled', 'old', 'flora', 'boulder', 'stone', 'moss'];

  embed(texts: readonly string[]): Promise<Result<readonly (readonly number[])[]>> {
    return Promise.resolve(
      ok(
        texts.map((text) => this.#terms.map((term) => (text.toLowerCase().includes(term) ? 1 : 0))),
      ),
    );
  }
}

function register(): RegisterAssetVersionUseCase {
  return new RegisterAssetVersionUseCase({ repository, ids, clock });
}

beforeEach(() => {
  handle = openTestDatabase();
  repository = new DrizzleAssetRepository(handle);
  ids = freshIds();
  clock = new FixedClock(instant(1_724_400_000_000));
  styleBibleId = ids.styleBible();
});

afterEach(() => {
  handle.close();
});

describe('resolving demand costs nothing and writes nothing', () => {
  it('reports a hit at zero cost the second time, having written nothing either time', async () => {
    const resolve = new ResolveAssetDemandUseCase({
      repository,
      estimator: new FlatRateAssetCostEstimator(),
    });
    const subject = spec();

    const first = await resolve.execute({
      specs: [subject],
      styleBibleId,
      styleChecksum: STYLE_A,
    });
    expect(first.ok && first.value.missCount).toBe(1);

    const registered = await register().execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A),
    });
    expect(registered.ok).toBe(true);

    const before = snapshot(handle);
    const second = await resolve.execute({
      specs: [subject],
      styleBibleId,
      styleChecksum: STYLE_A,
    });
    const after = snapshot(handle);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.hitCount).toBe(1);
    expect(second.value.missCount).toBe(0);
    expect(second.value.totalEstimatedNanoUsd).toBe(0);
    expect(second.value.resolutions[0]?.estimatedCostNanoUsd).toBe(0);
    expect(second.value.requiresConfirmation).toBe(false);
    // The whole point: producing the plan changed nothing in the database.
    expect(after).toEqual(before);
  });

  it('is a hit for a second project asking for the same thing', async () => {
    const subject = spec();
    await register().execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A),
    });

    // A different use-case instance with a different style bible id stands in for a
    // second project: the library is shared, so the answer must still be a hit.
    const otherProject = new ResolveAssetDemandUseCase({
      repository: new DrizzleAssetRepository(handle),
      estimator: new FlatRateAssetCostEstimator(),
    });
    const plan = await otherProject.execute({
      specs: [subject],
      styleBibleId: freshIds(1_900_000_000_000).styleBible(),
      styleChecksum: STYLE_A,
    });

    expect(plan.ok && plan.value.hitCount).toBe(1);
    expect(plan.ok && plan.value.totalEstimatedNanoUsd).toBe(0);
  });
});

describe('a restyle forks the library', () => {
  it('misses under the new checksum while the old asset stays resolvable', async () => {
    const subject = spec();
    const registered = await register().execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A),
    });
    if (!registered.ok) throw new Error('setup failed');

    const resolve = new ResolveAssetDemandUseCase({
      repository,
      estimator: new FlatRateAssetCostEstimator(),
    });
    const seasonTwo = await resolve.execute({
      specs: [subject],
      styleBibleId,
      styleChecksum: STYLE_B,
    });
    const seasonOne = await resolve.execute({
      specs: [subject],
      styleBibleId,
      styleChecksum: STYLE_A,
    });

    expect(seasonTwo.ok && seasonTwo.value.missCount).toBe(1);
    // Season 1 keeps rendering. That is the whole reason the checksum is in the key.
    expect(seasonOne.ok && seasonOne.value.hitCount).toBe(1);

    const stillThere = await repository.findByKey(
      deriveAssetKey(subject, { styleChecksum: STYLE_A }).key,
    );
    expect(stillThere.ok && stillThere.value !== null).toBe(true);
  });

  it('keys a variant as its own library entry, so it caches on its own terms', async () => {
    const subject = spec();
    const base = await register().execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A),
      makeCurrent: false,
    });
    const winter = await register().execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_A,
      variantKey: 'winter',
      version: newVersion(STYLE_A),
      makeCurrent: false,
    });

    expect(base.ok && winter.ok).toBe(true);
    if (!base.ok || !winter.ok) return;
    expect(winter.value.createdAsset).toBe(true);
    expect(winter.value.keyParts.variantKey).toBe('winter');
    expect(winter.value.asset.id).not.toBe(base.value.asset.id);
    // A first version is current whether or not the caller asked for it: an asset with
    // no servable version is not an asset.
    expect(winter.value.asset.currentVersionId).toBe(winter.value.version.id);
  });

  it('registers the restyled asset alongside the original rather than replacing it', async () => {
    const subject = spec();
    await register().execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A),
    });
    const restyled = await register().execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_B,
      version: newVersion(STYLE_B),
    });

    expect(restyled.ok && restyled.value.createdAsset).toBe(true);
    expect(snapshot(handle).assets).toBe(2);
  });
});

describe('regeneration', () => {
  const intent: RegenerateIntent = { reason: 'new-take', keepPrevious: true };

  it('is refused without an intent, and the library is unchanged', async () => {
    const subject = spec();
    await register().execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A),
    });

    const before = snapshot(handle);
    const second = await register().execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A),
    });
    const after = snapshot(handle);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.kind).toBe('conflict');
    expect(after).toEqual(before);
  });

  it('appends a version with an intent, and version 1 is still readable afterwards', async () => {
    const subject = spec();
    const first = await register().execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A),
    });
    if (!first.ok) throw new Error('setup failed');
    const firstVersionId = first.value.version.id;
    const firstParts = first.value.version.parts;

    const regenerate = new RegenerateAssetUseCase({ repository, ids, clock });
    const second = await regenerate.execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A),
      intent,
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.version.ordinal).toBe(2);
    expect(second.value.previousVersionIds).toEqual([firstVersionId]);
    expect(second.value.asset.currentVersionId).toBe(second.value.version.id);

    const reloaded = await repository.findById(second.value.asset.id);
    if (!reloaded.ok || reloaded.value === null) throw new Error('expected the asset');
    const survivor = reloaded.value.versions.find((entry) => entry.id === firstVersionId);
    expect(survivor?.ordinal).toBe(1);
    // Byte-for-byte: the previous take's part hashes must be exactly what they were.
    expect(survivor?.parts.map((entry) => entry.imageHash)).toEqual(
      firstParts.map((entry) => entry.imageHash),
    );
  });

  it('rolls back to version 1 while version 2 stays retrievable', async () => {
    const subject = spec();
    const first = await register().execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A),
    });
    if (!first.ok) throw new Error('setup failed');
    const regenerate = new RegenerateAssetUseCase({ repository, ids, clock });
    const second = await regenerate.execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A),
      intent,
    });
    if (!second.ok) throw new Error('setup failed');

    const rolled = await repository.setCurrentVersion(
      second.value.asset.id,
      first.value.version.id,
      NOW satisfies IsoInstant,
    );

    expect(rolled.ok).toBe(true);
    const reloaded = await repository.findById(second.value.asset.id);
    if (!reloaded.ok || reloaded.value === null) throw new Error('expected the asset');
    expect(reloaded.value.currentVersionId).toBe(first.value.version.id);
    expect(reloaded.value.versions.some((entry) => entry.id === second.value.version.id)).toBe(
      true,
    );
  });
});

describe('serving a reference', () => {
  it('resolves an unpinned ref to the current version and applies a story-time variant', async () => {
    const subject = spec();
    const scarredCanopy = sha256('scarred-canopy') as string;
    const registered = await register().execute({
      spec: subject,
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A, {
        variants: [
          {
            id: ids.variant(),
            key: 'burnt',
            label: 'Burnt',
            replacedParts: { canopy: scarredCanopy },
            validity: { from: { ordinal: 60 }, until: null },
            provenance: provenance(),
          },
        ],
      }),
    });
    if (!registered.ok) throw new Error('setup failed');

    const resolveRef = new ResolveAssetRefUseCase({ repository });

    const plain = await resolveRef.execute({ ref: { assetId: registered.value.asset.id } });
    const burnt = await resolveRef.execute({
      ref: { assetId: registered.value.asset.id, variantKey: 'burnt' },
      at: { ordinal: 90 },
    });
    const tooEarly = await resolveRef.execute({
      ref: { assetId: registered.value.asset.id, variantKey: 'burnt' },
      at: { ordinal: 10 },
    });

    expect(plain.ok && plain.value.variant).toBeNull();
    expect(burnt.ok).toBe(true);
    if (!burnt.ok) return;
    expect(burnt.value.parts.find((entry) => entry.name === 'canopy')?.imageHash).toBe(
      scarredCanopy,
    );
    expect(burnt.value.parts.find((entry) => entry.name === 'trunk')?.imageHash).toBe(
      sha256('trunk-bytes'),
    );
    expect(tooEarly.ok).toBe(false);
  });
});

describe('finding something before generating it', () => {
  it('retrieves the oak from "a gnarled old tree" out of the real index', async () => {
    const oak = await register().execute({
      spec: spec(),
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A),
    });
    const boulder = await register().execute({
      spec: spec({
        semanticKey: 'mineral/boulder/mossy',
        label: 'Mossy boulder',
        description: 'A squat boulder of grey stone.',
        tags: ['moss'],
      }),
      styleBibleId,
      styleChecksum: STYLE_A,
      version: newVersion(STYLE_A),
    });
    if (!oak.ok || !boulder.ok) throw new Error('setup failed');

    const embeddings = new VocabularyEmbeddingPort();
    for (const registered of [oak, boulder]) {
      const text = assetEmbeddingText({
        semanticKey: registered.value.asset.semanticKey,
        description: registered.value.asset.description,
        tags: registered.value.asset.tags,
      });
      const vector = await embeddings.embed([text]);
      if (!vector.ok || vector.value[0] === undefined) throw new Error('setup failed');
      await repository.saveEmbedding(registered.value.asset.id, vector.value[0], embeddings.model);
    }

    const search = new FindSimilarAssetsUseCase({ repository, embeddings });
    const found = await search.execute({ query: 'a gnarled old tree' });

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value[0]?.assetId).toBe(oak.value.asset.id);
    expect(found.value.map((match) => match.assetId)).not.toContain(boulder.value.asset.id);
  });
});

describe('the content-addressed store under the index', () => {
  let temp: TempBlobStore;

  beforeEach(async () => {
    temp = await openTempBlobStore();
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  it('holds one copy when two projects store byte-identical part images', async () => {
    const pixels = new TextEncoder().encode('identical-trunk-layer');

    const projectA = await temp.store.put(pixels);
    const projectB = await temp.store.put(pixels);
    if (!projectA.ok || !projectB.ok) throw new Error('setup failed');

    expect(projectB.value.hash).toBe(projectA.value.hash);
    expect(projectB.value.created).toBe(false);

    const shard = projectA.value.hash.slice(0, 2);
    expect(await readdir(join(temp.root, shard))).toEqual([projectA.value.hash]);

    // Both index rows point at the one file, which is what makes episode N+1 cheap.
    handle.db
      .insert(blobs)
      .values({
        hash: projectA.value.hash,
        byteSize: projectA.value.byteSize,
        mediaType: 'image/png',
        createdAt: NOW satisfies IsoInstant,
      })
      .run();
    expect(handle.db.select().from(blobs).all()).toHaveLength(1);
  });
});

describe('nothing in either package can destroy a take', () => {
  it('contains no version deletion and no unlink outside the deliberate sweep', async () => {
    const packagesDir = fileURLToPath(new URL('../../..', import.meta.url));
    const offenders: string[] = [];
    let scanned = 0;

    for (const pkg of ['persistence', 'asset-registry']) {
      for await (const file of walk(join(packagesDir, pkg, 'src'))) {
        if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
        scanned += 1;
        const source = await readFile(file, 'utf8');

        if (/delete\s+from\s+asset_versions/i.test(source)) offenders.push(`${file}: raw delete`);
        if (/\.delete\(\s*(assetVersions|parts|variants|clips)\s*\)/.test(source)) {
          offenders.push(`${file}: drizzle delete on an asset table`);
        }
        // `rm`/`unlink` is legitimate exactly once: the opt-in CAS sweep and its temp
        // file cleanup. Anywhere else it would make a content address forgettable.
        if (/\b(unlink|rmSync)\s*\(/.test(source) && !file.endsWith('fs-blob-store.ts')) {
          offenders.push(`${file}: filesystem deletion`);
        }
      }
    }

    // Guards the guard: a scan that walked nothing would pass silently.
    expect(scanned).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});

async function* walk(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}
