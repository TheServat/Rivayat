/**
 * `AssetRepository`, on SQLite.
 *
 * The interface it implements is declared in `@rv/asset-registry`, not here. That is
 * the whole ADR-0006 seam: the application layer names what it needs, infrastructure
 * satisfies it, and a Postgres deployment is a second class bound to a different URL
 * scheme rather than an edit to any use-case.
 *
 * Two things this class is responsible for that the interface can only describe in
 * prose:
 *
 * **The ordinal is assigned inside the transaction.** `appendVersion` reads
 * `max(ordinal)` and inserts in one `immediate` transaction, so the write lock is held
 * across both. A deferred transaction would take the lock only at the insert and let
 * two takes read the same maximum; SQLite would then raise the unique index as a
 * `SQLITE_BUSY`-shaped surprise instead of ordering the two writers. The unique index
 * on `(asset_id, ordinal)` is still there as the backstop.
 *
 * **Nothing here deletes or replaces a version.** There is no `update` on
 * `asset_versions`, `parts`, `variants` or `clips`, and no `delete` on any of them. A
 * source-scan test asserts that, because it is the kind of invariant that is one
 * convenient method away from being false.
 */

import {
  ConflictError,
  NotFoundError,
  type Result,
  UNIT,
  type Unit,
  err,
  ok,
  toAppError,
} from '@rv/shared-kernel';
import type { AppError } from '@rv/shared-kernel';
import type {
  AnimationClip,
  Asset,
  AssetId,
  AssetKey,
  AssetVariant,
  AssetVersion,
  AssetVersionId,
  IsoInstant,
  Part,
} from '@rv/contracts';
import type {
  AppendVersionOptions,
  AssetIdentityDraft,
  AssetRepository,
  AssetSearchRecord,
  AssetVersionDraft,
  NewAssetVersion,
  StoredAssetVersion,
} from '@rv/asset-registry';
import { type SQL, asc, eq, inArray, sql } from 'drizzle-orm';

import type { DatabaseHandle, RivayatDatabase } from '../database/database';
import {
  type AssetRow,
  type AssetVersionRow,
  type ClipRow,
  type NewClipRow,
  type NewPartRow,
  type NewVariantRow,
  type PartRow,
  type VariantRow,
  assetVersions,
  assets,
  clips,
  parts,
  variants,
} from '../schema/index';

/** Drizzle's transaction handle for this schema, without naming its generic soup. */
type Tx = Parameters<Parameters<RivayatDatabase['transaction']>[0]>[0];

/**
 * SQLite's bound-parameter limit is 32766 on modern builds and 999 on older ones.
 * Chunking at 400 keeps a bulk key lookup correct under either.
 */
const MAX_KEYS_PER_QUERY = 400;

export class DrizzleAssetRepository implements AssetRepository {
  readonly #db: RivayatDatabase;

  constructor(handle: DatabaseHandle) {
    this.#db = handle.db;
  }

  findByKey(key: AssetKey): Promise<Result<Asset | null>> {
    return Promise.resolve(
      attempt(`Could not look up asset by key ${key}`, () =>
        this.#db.transaction((tx) => loadWhere(tx, inArray(assets.key, [key]))[0] ?? null),
      ),
    );
  }

  findManyByKeys(keys: readonly AssetKey[]): Promise<Result<ReadonlyMap<AssetKey, Asset>>> {
    return Promise.resolve(
      attempt('Could not resolve asset keys in bulk', () => {
        const found = new Map<AssetKey, Asset>();
        if (keys.length === 0) return found;

        this.#db.transaction((tx) => {
          for (let start = 0; start < keys.length; start += MAX_KEYS_PER_QUERY) {
            const chunk = keys.slice(start, start + MAX_KEYS_PER_QUERY);
            for (const asset of loadWhere(tx, inArray(assets.key, [...chunk]))) {
              found.set(asset.key, asset);
            }
          }
        });

        return found;
      }),
    );
  }

  findById(id: AssetId): Promise<Result<Asset | null>> {
    return Promise.resolve(
      attempt(`Could not load asset ${id}`, () =>
        this.#db.transaction((tx) => loadWhere(tx, eq(assets.id, id))[0] ?? null),
      ),
    );
  }

  create(
    identity: AssetIdentityDraft,
    firstVersion: NewAssetVersion,
    now: IsoInstant,
  ): Promise<Result<StoredAssetVersion>> {
    return Promise.resolve(
      attempt(
        `Could not register asset ${identity.semanticKey}`,
        () =>
          this.#db.transaction(
            (tx) => {
              tx.insert(assets)
                .values({
                  id: identity.id,
                  key: identity.key,
                  semanticKey: identity.keyParts.semanticKey,
                  styleChecksum: identity.keyParts.styleChecksum,
                  variantKey: identity.keyParts.variantKey,
                  specHash: identity.keyParts.specHash,
                  archetype: identity.archetype,
                  label: identity.label,
                  description: identity.description,
                  tags: [...identity.tags],
                  currentVersionId: firstVersion.id,
                  createdAt: now,
                  updatedAt: now,
                })
                .run();

              insertVersion(tx, { ...firstVersion, assetId: identity.id }, 1, now);
              return loadOne(tx, identity.id);
            },
            { behavior: 'immediate' },
          ),
        (caught) => duplicateKey(caught, identity.key),
      ),
    );
  }

  appendVersion(
    draft: AssetVersionDraft,
    options: AppendVersionOptions,
    now: IsoInstant,
  ): Promise<Result<StoredAssetVersion>> {
    return Promise.resolve(
      attempt(`Could not append a version to asset ${draft.assetId}`, () =>
        this.#db.transaction(
          (tx) => {
            const highest = tx
              .select({ ordinal: sql<number | null>`max(${assetVersions.ordinal})` })
              .from(assetVersions)
              .where(eq(assetVersions.assetId, draft.assetId))
              .get();

            // `max()` over no rows yields one row holding `null`, so this is the same
            // question as "does the asset exist?" without a second query.
            if (highest?.ordinal == null) throw new NotFoundError('Asset', draft.assetId);

            insertVersion(tx, draft, highest.ordinal + 1, now);

            tx.update(assets)
              .set(
                options.makeCurrent
                  ? { currentVersionId: draft.id, updatedAt: now }
                  : { updatedAt: now },
              )
              .where(eq(assets.id, draft.assetId))
              .run();

            return loadOne(tx, draft.assetId);
          },
          { behavior: 'immediate' },
        ),
      ),
    );
  }

  setCurrentVersion(
    assetId: AssetId,
    versionId: AssetVersionId,
    now: IsoInstant,
  ): Promise<Result<Unit>> {
    return Promise.resolve(
      attempt(`Could not set the current version of asset ${assetId}`, () =>
        this.#db.transaction(
          (tx) => {
            const owned = tx
              .select({ id: assetVersions.id })
              .from(assetVersions)
              .where(eq(assetVersions.id, versionId))
              .get();

            if (owned === undefined) throw new NotFoundError('AssetVersion', versionId);

            tx.update(assets)
              .set({ currentVersionId: versionId, updatedAt: now })
              .where(eq(assets.id, assetId))
              .run();

            return UNIT;
          },
          { behavior: 'immediate' },
        ),
      ),
    );
  }

  listSearchRecords(): Promise<Result<readonly AssetSearchRecord[]>> {
    return Promise.resolve(
      attempt('Could not read the semantic index', () =>
        this.#db
          .select({
            assetId: assets.id,
            key: assets.key,
            semanticKey: assets.semanticKey,
            label: assets.label,
            description: assets.description,
            tags: assets.tags,
            embedding: assets.embedding,
            embeddingModel: assets.embeddingModel,
          })
          .from(assets)
          .orderBy(asc(assets.id))
          .all(),
      ),
    );
  }

  saveEmbedding(
    assetId: AssetId,
    embedding: readonly number[],
    model: string,
  ): Promise<Result<Unit>> {
    return Promise.resolve(
      attempt(`Could not index asset ${assetId}`, () => {
        const changed = this.#db
          .update(assets)
          .set({ embedding: [...embedding], embeddingModel: model })
          .where(eq(assets.id, assetId))
          .run();
        if (changed.changes === 0) throw new NotFoundError('Asset', assetId);
        return UNIT;
      }),
    );
  }
}

// ── writes ──────────────────────────────────────────────────────────────────

function insertVersion(tx: Tx, draft: AssetVersionDraft, ordinal: number, now: IsoInstant): void {
  tx.insert(assetVersions)
    .values({
      id: draft.id,
      assetId: draft.assetId,
      ordinal,
      status: draft.status,
      styleBibleId: draft.styleBibleId,
      styleChecksum: draft.styleChecksum,
      rig: draft.rig ?? null,
      canvasWidth: draft.canvas.width,
      canvasHeight: draft.canvas.height,
      nominalHeight: draft.nominalHeight,
      previewImageHash: draft.previewImageHash ?? null,
      quality: draft.quality,
      scores: draft.scores ?? null,
      rejectionReason: draft.rejectionReason ?? null,
      provenance: draft.provenance,
      createdAt: now,
    })
    .run();

  const partRows: NewPartRow[] = draft.parts.map((part) => ({
    id: part.id,
    versionId: draft.id,
    name: part.name,
    role: part.role,
    imageHash: part.imageHash,
    boundsX: part.bounds.x,
    boundsY: part.bounds.y,
    boundsWidth: part.bounds.width,
    boundsHeight: part.bounds.height,
    sizeWidth: part.size.width,
    sizeHeight: part.size.height,
    pivotX: part.pivot.x,
    pivotY: part.pivot.y,
    zOrder: part.zOrder,
    deformable: part.deformable,
    alphaCoverage: part.alphaCoverage,
  }));
  if (partRows.length > 0) tx.insert(parts).values(partRows).run();

  const variantRows: NewVariantRow[] = draft.variants.map((variant) => ({
    id: variant.id,
    versionId: draft.id,
    key: variant.key,
    label: variant.label,
    replacedParts: variant.replacedParts,
    validity: variant.validity ?? null,
    validFromOrdinal: variant.validity?.from?.ordinal ?? null,
    validUntilOrdinal: variant.validity?.until?.ordinal ?? null,
    provenance: variant.provenance,
  }));
  if (variantRows.length > 0) tx.insert(variants).values(variantRows).run();

  const clipRows: NewClipRow[] = draft.clips.map((clip) => ({
    id: clip.id,
    versionId: draft.id,
    name: clip.name,
    label: clip.label ?? null,
    source: clip.source,
    durationMs: clip.durationMs,
    fps: clip.fps,
    loop: clip.loop,
    irHash: clip.irHash,
    bakedSheetId: clip.bakedSheetId ?? null,
    tags: clip.tags,
    provenance: clip.provenance,
  }));
  if (clipRows.length > 0) tx.insert(clips).values(clipRows).run();
}

// ── reads ───────────────────────────────────────────────────────────────────

/**
 * Loads whole assets in four queries regardless of how many matched.
 *
 * A 40-spec episode plan is on the hot path of a screen someone is waiting on, so the
 * obvious per-asset recursion would be 160 round trips for no reason.
 */
function loadWhere(tx: Tx, where: SQL): Asset[] {
  const assetRows = tx.select().from(assets).where(where).all();
  if (assetRows.length === 0) return [];

  const assetIds = assetRows.map((row) => row.id);
  const versionRows = tx
    .select()
    .from(assetVersions)
    .where(inArray(assetVersions.assetId, assetIds))
    .orderBy(asc(assetVersions.ordinal))
    .all();

  const versionIds = versionRows.map((row) => row.id);
  const partRows =
    versionIds.length === 0
      ? []
      : tx
          .select()
          .from(parts)
          .where(inArray(parts.versionId, versionIds))
          .orderBy(asc(parts.zOrder), asc(parts.name))
          .all();
  const variantRows =
    versionIds.length === 0
      ? []
      : tx
          .select()
          .from(variants)
          .where(inArray(variants.versionId, versionIds))
          .orderBy(asc(variants.key), asc(variants.id))
          .all();
  const clipRows =
    versionIds.length === 0
      ? []
      : tx
          .select()
          .from(clips)
          .where(inArray(clips.versionId, versionIds))
          .orderBy(asc(clips.name))
          .all();

  const partsByVersion = groupBy(partRows, (row) => row.versionId);
  const variantsByVersion = groupBy(variantRows, (row) => row.versionId);
  const clipsByVersion = groupBy(clipRows, (row) => row.versionId);
  const versionsByAsset = groupBy(versionRows, (row) => row.assetId);

  return assetRows.map((row) =>
    toAsset(
      row,
      (versionsByAsset.get(row.id) ?? []).map((version) =>
        toVersion(
          version,
          partsByVersion.get(version.id) ?? [],
          variantsByVersion.get(version.id) ?? [],
          clipsByVersion.get(version.id) ?? [],
        ),
      ),
    ),
  );
}

function loadOne(tx: Tx, assetId: AssetId): StoredAssetVersion {
  const asset = loadWhere(tx, eq(assets.id, assetId))[0];
  if (asset === undefined) throw new NotFoundError('Asset', assetId);

  // The version just written is the highest ordinal, which is also the one the caller
  // is asking about. Reading it back rather than echoing the draft is deliberate: the
  // ordinal was decided by the database, not by us.
  const version = asset.versions.reduce((highest, candidate) =>
    candidate.ordinal > highest.ordinal ? candidate : highest,
  );
  return { asset, version };
}

function toAsset(row: AssetRow, versions: AssetVersion[]): Asset {
  return {
    id: row.id,
    key: row.key,
    semanticKey: row.semanticKey,
    archetype: row.archetype,
    label: row.label,
    description: row.description,
    tags: row.tags,
    versions,
    currentVersionId: row.currentVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVersion(
  row: AssetVersionRow,
  partRows: PartRow[],
  variantRows: VariantRow[],
  clipRows: ClipRow[],
): AssetVersion {
  return {
    id: row.id,
    assetId: row.assetId,
    ordinal: row.ordinal,
    status: row.status,
    styleBibleId: row.styleBibleId,
    styleChecksum: row.styleChecksum,
    parts: partRows.map(toPart),
    variants: variantRows.map(toVariant),
    clips: clipRows.map(toClip),
    canvas: { width: row.canvasWidth, height: row.canvasHeight },
    nominalHeight: row.nominalHeight,
    quality: row.quality,
    provenance: row.provenance,
    // `exactOptionalPropertyTypes`: an absent field and a field set to `undefined` are
    // different types, and the contract means the former.
    ...(row.rig === null ? {} : { rig: row.rig }),
    ...(row.previewImageHash === null ? {} : { previewImageHash: row.previewImageHash }),
    ...(row.scores === null ? {} : { scores: row.scores }),
    ...(row.rejectionReason === null ? {} : { rejectionReason: row.rejectionReason }),
  };
}

function toPart(row: PartRow): Part {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    imageHash: row.imageHash,
    bounds: {
      x: row.boundsX,
      y: row.boundsY,
      width: row.boundsWidth,
      height: row.boundsHeight,
    },
    size: { width: row.sizeWidth, height: row.sizeHeight },
    pivot: { x: row.pivotX, y: row.pivotY },
    zOrder: row.zOrder,
    deformable: row.deformable,
    alphaCoverage: row.alphaCoverage,
  };
}

function toVariant(row: VariantRow): AssetVariant {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    replacedParts: row.replacedParts,
    provenance: row.provenance,
    ...(row.validity === null ? {} : { validity: row.validity }),
  };
}

function toClip(row: ClipRow): AnimationClip {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    durationMs: row.durationMs,
    fps: row.fps,
    loop: row.loop,
    irHash: row.irHash,
    tags: row.tags,
    provenance: row.provenance,
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.bakedSheetId === null ? {} : { bakedSheetId: row.bakedSheetId }),
  };
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(key(row));
    if (bucket === undefined) grouped.set(key(row), [row]);
    else bucket.push(row);
  }
  return grouped;
}

// ── error handling ──────────────────────────────────────────────────────────

/**
 * Runs a synchronous better-sqlite3 call and converts anything thrown into a `Result`.
 *
 * The conversion happens exactly once, here at the boundary, which is the rule for
 * adapters: nothing above this line ever sees a driver exception.
 */
function attempt<T>(
  message: string,
  body: () => T,
  mapCaught?: (caught: unknown) => AppError | null,
): Result<T> {
  try {
    return ok(body());
  } catch (caught) {
    const mapped = mapCaught?.(caught) ?? null;
    return err(mapped ?? toAppError(caught, message));
  }
}

/** A unique-index violation on the dedup key is a conflict, not an internal error. */
function duplicateKey(caught: unknown, key: AssetKey): AppError | null {
  if (!isConstraintViolation(caught)) return null;
  return new ConflictError({
    message: 'An asset is already registered under this dedup key.',
    context: { assetKey: key },
    cause: caught,
  });
}

function isConstraintViolation(caught: unknown): boolean {
  return (
    caught instanceof Error &&
    'code' in caught &&
    typeof caught.code === 'string' &&
    caught.code.startsWith('SQLITE_CONSTRAINT')
  );
}
