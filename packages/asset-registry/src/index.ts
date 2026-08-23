/**
 * `@rv/asset-registry` - the package that owns "no asset is generated twice".
 *
 * It holds the dedup key, the ports its storage must satisfy, and the five use-cases
 * that between them decide whether anything gets generated at all. It depends on
 * `@rv/contracts` and `@rv/shared-kernel` and on nothing else: the SQLite index and
 * the content-addressed store implement its ports from `@rv/persistence`, and the
 * embedding model implements one from `@rv/providers`.
 */

export {
  BASE_VARIANT_KEY,
  SPEC_FIELDS_ALREADY_IN_KEY,
  canonicalSpecBody,
  computeAssetKey,
  computeSpecHash,
  deriveAssetKey,
  deriveAssetKeyParts,
} from './asset-key';
export type { AssetKeyContext, DerivedAssetKey } from './asset-key';

export { assetEmbeddingText, cosineSimilarity } from './semantic-text';
export type { SemanticTextInput } from './semantic-text';

export { DEFAULT_PART_RATES, FlatRateAssetCostEstimator } from './cost/flat-rate-estimator';

export * from './ports/index';
export * from './use-cases/index';
