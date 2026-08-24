/**
 * The library list, as a read model rather than as a walk of the asset tree.
 *
 * `AssetRepository` is the registry's write-side port and is deliberately narrow: find
 * by key, find by id, create, append. It has nothing that lists, and adding one would
 * put a screen's pagination requirements into the port that guards non-negotiable #2.
 * So this is a read model, and it is a read model for two concrete reasons rather than
 * for tidiness:
 *
 * **The counts are the point of a row.** "Nothing is generated twice" is only visible if
 * a reader can see that an asset has two versions and four clips without opening it.
 * Loading the whole tree to count them means shipping every version's part list, rig and
 * clip set - megabytes - to draw a table of tens of rows. Four grouped counts answer it
 * in one round trip each.
 *
 * **`keyParts` is not on the `Asset` document.** The contract carries the composite key;
 * the four components that produced it live only in the `assets` table. They are the
 * only thing you can diff when a cache miss happens that should not have, which is
 * exactly what the library screen is for, so the read model reads the columns.
 *
 * Spend is summed from each version's `provenance.costNanoUsd` - the same number the
 * ledger recorded when the call was made - so "what has this asset cost" and "what did
 * the run spend" come from one figure rather than two that drift.
 */

import type {
  AssetArchetype,
  AssetId,
  AssetKey,
  AssetVersionId,
  AssetVersionStatus,
  IsoInstant,
  Provenance,
  SemanticKey,
  Sha256Hex,
  Slug,
} from '@rv/contracts';
import {
  assetVersions,
  assets,
  clips,
  parts,
  variants,
  type DatabaseHandle,
  type RivayatDatabase,
} from '@rv/persistence';
import {
  fromThrowable,
  toAppError,
  type AppError,
  type Logger,
  type Result,
} from '@rv/shared-kernel';
import { count, eq, like, or, sql } from 'drizzle-orm';

import { AssetLibraryEntry } from '../modules/assets/assets.contracts';

export interface AssetLibraryPageQuery {
  /** Substring over the semantic key, the label and the description. Case-insensitive. */
  readonly query?: string;
  readonly limit: number;
}

export interface AssetLibraryRows {
  readonly entries: readonly AssetLibraryEntry[];
  /** Assets in the library, before the filter. What the header counts. */
  readonly total: number;
}

export interface AssetLibraryQueryDeps {
  readonly database: DatabaseHandle;
  readonly logger: Logger;
}

export class AssetLibraryQuery {
  readonly #db: RivayatDatabase;
  readonly #logger: Logger;

  constructor(deps: AssetLibraryQueryDeps) {
    this.#db = deps.database.db;
    this.#logger = deps.logger.child({ component: 'asset-library' });
  }

  read(query: AssetLibraryPageQuery): Promise<Result<AssetLibraryRows, AppError>> {
    return Promise.resolve(
      fromThrowable(
        () => this.#read(query),
        (caught) => toAppError(caught, 'Could not read the asset library'),
      ),
    );
  }

  #read(query: AssetLibraryPageQuery): AssetLibraryRows {
    const term = query.query?.trim().toLowerCase() ?? '';
    // SQLite's `like` is case-insensitive for ASCII by default; the explicit `lower`
    // makes it so for the non-ASCII half of a Persian label too.
    const filter =
      term === ''
        ? undefined
        : or(
            like(sql`lower(${assets.semanticKey})`, `%${term}%`),
            like(sql`lower(${assets.label})`, `%${term}%`),
            like(sql`lower(${assets.description})`, `%${term}%`),
          );

    const total = this.#db.select({ value: count() }).from(assets).all().at(0)?.value ?? 0;

    const rows = this.#db
      .select({
        id: assets.id,
        key: assets.key,
        semanticKey: assets.semanticKey,
        styleChecksum: assets.styleChecksum,
        variantKey: assets.variantKey,
        specHash: assets.specHash,
        archetype: assets.archetype,
        label: assets.label,
        currentVersionId: assets.currentVersionId,
        updatedAt: assets.updatedAt,
      })
      .from(assets)
      .where(filter)
      .orderBy(sql`${assets.updatedAt} desc`)
      .limit(Math.max(1, query.limit))
      .all();

    const entries: AssetLibraryEntry[] = [];
    for (const row of rows) {
      const entry = this.#entry(row);
      if (entry !== null) entries.push(entry);
    }
    return { entries, total };
  }

  #entry(row: {
    readonly id: AssetId;
    readonly key: AssetKey;
    readonly semanticKey: SemanticKey;
    readonly styleChecksum: Sha256Hex;
    readonly variantKey: Slug;
    readonly specHash: Sha256Hex;
    readonly archetype: AssetArchetype;
    readonly label: string;
    readonly currentVersionId: AssetVersionId;
    readonly updatedAt: IsoInstant;
  }): AssetLibraryEntry | null {
    const versions = this.#db
      .select({
        id: assetVersions.id,
        status: assetVersions.status,
        provenance: assetVersions.provenance,
      })
      .from(assetVersions)
      .where(eq(assetVersions.assetId, row.id))
      .all();

    const current = versions.find((version) => version.id === row.currentVersionId);
    const spentNanoUsd = versions.reduce((total, version) => total + costOf(version.provenance), 0);

    const parsed = AssetLibraryEntry.safeParse({
      id: row.id,
      key: row.key,
      keyParts: {
        semanticKey: row.semanticKey,
        styleChecksum: row.styleChecksum,
        variantKey: row.variantKey,
        specHash: row.specHash,
      },
      semanticKey: row.semanticKey,
      archetype: row.archetype,
      label: row.label,
      currentVersionId: row.currentVersionId,
      // A row whose current version is missing is a broken write, not a state. Reporting
      // `failed` rather than guessing `ready` is the safe direction: it shows on the
      // screen instead of promising a version nothing can load.
      currentStatus: (current?.status ?? 'failed') satisfies AssetVersionStatus,
      versionCount: versions.length,
      variantCount: this.#countVariants(row.currentVersionId),
      clipCount: this.#countClips(row.currentVersionId),
      partCount: this.#countParts(row.currentVersionId),
      spentNanoUsd,
      updatedAt: row.updatedAt,
    });

    if (parsed.success) return parsed.data;
    this.#logger.warn('an asset row does not satisfy the library entry shape; skipping it', {
      assetId: row.id,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
    return null;
  }

  /**
   * Three counts, per **current version** rather than per asset.
   *
   * A library row describes what the asset is today. Summing the parts of every take
   * would tell a reader that a three-take asset has thirty-six parts, which is true of
   * the database and false of the thing.
   *
   * Written out three times rather than behind one generic helper: Drizzle's row type is
   * derived from the table object, and a parameter general enough to accept all three
   * loses it - which would trade three short methods for a cast.
   */
  #countParts(versionId: AssetVersionId): number {
    return (
      this.#db
        .select({ value: count() })
        .from(parts)
        .where(eq(parts.versionId, versionId))
        .all()
        .at(0)?.value ?? 0
    );
  }

  #countClips(versionId: AssetVersionId): number {
    return (
      this.#db
        .select({ value: count() })
        .from(clips)
        .where(eq(clips.versionId, versionId))
        .all()
        .at(0)?.value ?? 0
    );
  }

  #countVariants(versionId: AssetVersionId): number {
    return (
      this.#db
        .select({ value: count() })
        .from(variants)
        .where(eq(variants.versionId, versionId))
        .all()
        .at(0)?.value ?? 0
    );
  }
}

/** What a version cost, from the provenance the ledger wrote when the call was made. */
function costOf(provenance: Provenance): number {
  const cost = provenance.costNanoUsd;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : 0;
}
