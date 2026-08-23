/**
 * The asset registry over HTTP - the one bounded context whose use-cases are real.
 *
 * `POST /api/assets/resolve` is S5 and the most important route in the API: it is the
 * screen the user approves before any money moves. It writes nothing and calls no
 * provider, which is a property `@rv/asset-registry` asserts directly, so it is safe to
 * call repeatedly while somebody decides.
 *
 * `POST /api/assets/search` is "find it before you make it". It *does* call a provider -
 * one embedding of the query string - so unlike resolve it is not free, and it returns
 * an empty list rather than the least-bad match when nothing clears the similarity
 * floor. A confident wrong suggestion costs more than no suggestion, because someone
 * accepts it and generates against it.
 */

import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type {
  FindSimilarAssetsUseCase,
  ResolveAssetDemandUseCase,
  SimilarAsset,
} from '@rv/asset-registry';
import type { Asset, AssetDemandPlan, AssetId } from '@rv/contracts';
import { NotFoundError, type Result, err, isErr, nanoUsd, ok } from '@rv/shared-kernel';
import type { AssetRepository } from '@rv/asset-registry';

import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ASSET_REPOSITORY } from '../../tokens';
import { FIND_SIMILAR_ASSETS_USE_CASE, RESOLVE_ASSET_DEMAND_USE_CASE } from '../module-tokens';
import { AssetIdParam, ResolveAssetsBody, SearchAssetsBody } from './assets.contracts';

@Controller('assets')
export class AssetsController {
  readonly #resolve: ResolveAssetDemandUseCase;
  readonly #search: FindSimilarAssetsUseCase;
  readonly #repository: AssetRepository;

  constructor(
    @Inject(RESOLVE_ASSET_DEMAND_USE_CASE) resolve: ResolveAssetDemandUseCase,
    @Inject(FIND_SIMILAR_ASSETS_USE_CASE) search: FindSimilarAssetsUseCase,
    @Inject(ASSET_REPOSITORY) repository: AssetRepository,
  ) {
    this.#resolve = resolve;
    this.#search = search;
    this.#repository = repository;
  }

  @Post('resolve')
  resolveDemand(
    @Body(new ZodValidationPipe(ResolveAssetsBody)) body: ResolveAssetsBody,
  ): Promise<Result<AssetDemandPlan>> {
    // Built conditionally rather than spread wholesale: `exactOptionalPropertyTypes` is
    // on, and `{ variantKey: undefined }` is a different type from `{}` - one of which
    // the use-case accepts.
    return this.#resolve.execute({
      specs: body.specs,
      styleBibleId: body.styleBibleId,
      styleChecksum: body.styleChecksum,
      ...(body.variantKey === undefined ? {} : { variantKey: body.variantKey }),
      // `NanoUsdAmount` is a plain integer on the wire and `NanoUsd` is branded inside;
      // `nanoUsd()` is the sanctioned crossing, and it rejects a non-finite amount.
      ...(body.budgetNanoUsd === undefined ? {} : { budgetNanoUsd: nanoUsd(body.budgetNanoUsd) }),
      ...(body.confirmationThresholdNanoUsd === undefined
        ? {}
        : { confirmationThresholdNanoUsd: nanoUsd(body.confirmationThresholdNanoUsd) }),
    });
  }

  @Post('search')
  searchSimilar(
    @Body(new ZodValidationPipe(SearchAssetsBody)) body: SearchAssetsBody,
  ): Promise<Result<readonly SimilarAsset[]>> {
    return this.#search.execute({
      query: body.query,
      limit: body.limit,
      ...(body.minSimilarity === undefined ? {} : { minSimilarity: body.minSimilarity }),
    });
  }

  @Get(':id')
  async findOne(
    @Param('id', new ZodValidationPipe(AssetIdParam)) id: AssetId,
  ): Promise<Result<Asset>> {
    const found = await this.#repository.findById(id);
    if (isErr(found)) return found;
    return found.value === null ? err(new NotFoundError('asset', id)) : ok(found.value);
  }
}
