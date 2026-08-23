/**
 * Every interface the registry needs the outside world to provide.
 *
 * Adapters live in `@rv/persistence` and `@rv/providers` and depend on this package;
 * this package depends on neither. That is the dependency rule, and `pnpm arch:check`
 * fails the build if it is inverted.
 */

export type {
  AppendVersionOptions,
  AssetIdentityDraft,
  AssetRepository,
  AssetSearchRecord,
  AssetVersionDraft,
  NewAssetVersion,
  StoredAssetVersion,
} from './asset-repository';
export type { BlobPutResult, BlobStore } from './blob-store';
export type { EmbeddingPort } from './embedding-port';
export type { AssetCostEstimator } from './cost-estimator';
