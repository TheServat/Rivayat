/**
 * One class per use-case, one `execute()` each.
 *
 * Ordered as the pipeline uses them: resolve what is needed, register what is made,
 * regenerate on request, search before deciding to make anything, and resolve a
 * reference at draw time.
 */

export { ResolveAssetDemandUseCase } from './resolve-asset-demand';
export type { ResolveAssetDemandDeps, ResolveAssetDemandInput } from './resolve-asset-demand';

export { RegisterAssetVersionUseCase } from './register-asset-version';
export type {
  RegisterAssetVersionDeps,
  RegisterAssetVersionInput,
  RegisterAssetVersionOutput,
} from './register-asset-version';

export { RegenerateAssetUseCase } from './regenerate-asset';
export type {
  RegenerateAssetDeps,
  RegenerateAssetInput,
  RegenerateAssetOutput,
} from './regenerate-asset';

export { DEFAULT_MIN_SIMILARITY, FindSimilarAssetsUseCase } from './find-similar-assets';
export type {
  FindSimilarAssetsDeps,
  FindSimilarAssetsInput,
  SimilarAsset,
} from './find-similar-assets';

export { ResolveAssetRefUseCase } from './resolve-asset-ref';
export type {
  ResolveAssetRefDeps,
  ResolveAssetRefInput,
  ResolvedAssetRef,
} from './resolve-asset-ref';
