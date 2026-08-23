/**
 * `@rv/persistence` - infrastructure, and the only package that knows SQLite exists.
 *
 * Three things live here, and the split is ADR-0006's: metadata in a single SQLite
 * file through Drizzle, binaries in a content-addressed directory, and the repository
 * adapters that join the two behind interfaces declared in `@rv/asset-registry`.
 *
 * Nothing in the domain or application layers may import this package.
 * `.dependency-cruiser.cjs` enforces that in CI; the reason is that a Postgres or S3
 * deployment must be a different binding of the same ports, not a different codebase.
 */

export { createDatabase, migrationsFolder } from './database/database';
export type { CreateDatabaseOptions, DatabaseHandle, RivayatDatabase } from './database/database';

export * from './schema/index';

export { FsBlobStore } from './blob-store/fs-blob-store';
export type {
  BlobGcOptions,
  BlobGcReport,
  BlobVerifyReport,
  CorruptBlob,
  FsBlobStoreOptions,
} from './blob-store/fs-blob-store';

export { DrizzleAssetRepository } from './repositories/drizzle-asset-repository';
