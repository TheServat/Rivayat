/**
 * The asset registry over HTTP - the one bounded context whose use-cases are all real.
 *
 * ## Route order is load-bearing here, and was a real bug
 *
 * `@Get(':id')` matches **any** single segment under `/assets`, so `GET /assets/plan`
 * came back as a *400 about a malformed AssetId* rather than a 404, and the screen showed
 * a red banner about a server that merely lacked a route. Nest matches in declaration
 * order, so every literal path is declared **before** the parameterised one below, and the
 * collection plan lives at `/assets/demand/plan` - two segments, which `:id` cannot swallow
 * even if someone reorders this file. Belt and braces, because the failure is silent and
 * points at the client.
 *
 * ## What each route costs
 *
 * - `GET /assets` and `GET /assets/:id` read rows. Free.
 * - `GET /assets/demand/plan` and `POST /assets/resolve` read the dedup index and price
 *   the misses. They write nothing and call no provider - `@rv/asset-registry` asserts
 *   that property directly - so they are safe to poll while somebody decides.
 * - `POST /assets/search` embeds the query string: **one provider call per request**. It
 *   is submit-driven rather than keystroke-driven for that reason, and it returns an empty
 *   list rather than the least-bad match when nothing clears the similarity floor. A
 *   confident wrong suggestion costs more than no suggestion, because someone accepts it
 *   and generates against it.
 * - `POST /assets/:id/regenerate` is the only route here that spends money on purpose, and
 *   it is the only one that takes a `RegenerateIntent`.
 */

import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type {
  AssetRepository,
  FindSimilarAssetsUseCase,
  ResolveAssetDemandUseCase,
  SimilarAsset,
} from '@rv/asset-registry';
import {
  RegenerateIntent,
  type Asset,
  type AssetDemandPlan,
  type AssetId,
  type AssetVersionId,
} from '@rv/contracts';
import { NotFoundError, type Result, err, isErr, nanoUsd, ok } from '@rv/shared-kernel';

import type { AssetDemandService } from '../../assets/asset-demand.service';
import type { AssetLibraryQuery } from '../../assets/asset-library.query';
import type { ProduceRecordStore } from '../../assets/produce-record.store';
import type { RegenerateAssetVersionUseCase } from '../../assets/regenerate-asset.use-case';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ASSET_REPOSITORY } from '../../tokens';
import {
  ASSET_DEMAND_SERVICE,
  ASSET_LIBRARY_QUERY,
  FIND_SIMILAR_ASSETS_USE_CASE,
  PRODUCE_RECORD_STORE,
  REGENERATE_ASSET_USE_CASE,
  RESOLVE_ASSET_DEMAND_USE_CASE,
} from '../module-tokens';
import {
  AssetIdParam,
  AssetVersionIdParam,
  ListAssetsQuery,
  RegenerateAssetBody,
  ResolveAssetsBody,
  SearchAssetsBody,
  type AssetLibraryPage,
  type AssetProduceReport,
  type RegenerateOutcome,
} from './assets.contracts';

@Controller('assets')
export class AssetsController {
  readonly #resolve: ResolveAssetDemandUseCase;
  readonly #search: FindSimilarAssetsUseCase;
  readonly #repository: AssetRepository;
  readonly #library: AssetLibraryQuery;
  readonly #demand: AssetDemandService;
  readonly #records: ProduceRecordStore;
  readonly #regenerate: RegenerateAssetVersionUseCase;

  constructor(
    @Inject(RESOLVE_ASSET_DEMAND_USE_CASE) resolve: ResolveAssetDemandUseCase,
    @Inject(FIND_SIMILAR_ASSETS_USE_CASE) search: FindSimilarAssetsUseCase,
    @Inject(ASSET_REPOSITORY) repository: AssetRepository,
    @Inject(ASSET_LIBRARY_QUERY) library: AssetLibraryQuery,
    @Inject(ASSET_DEMAND_SERVICE) demand: AssetDemandService,
    @Inject(PRODUCE_RECORD_STORE) records: ProduceRecordStore,
    @Inject(REGENERATE_ASSET_USE_CASE) regenerate: RegenerateAssetVersionUseCase,
  ) {
    this.#resolve = resolve;
    this.#search = search;
    this.#repository = repository;
    this.#library = library;
    this.#demand = demand;
    this.#records = records;
    this.#regenerate = regenerate;
  }

  /**
   * The library, plus the takes that never joined it.
   *
   * `incomplete` is not an error channel. A take that stopped at `matte` is a real thing
   * that happened, it cost real money, and it is the only place the user can learn *why*
   * the asset they asked for is not in the list.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(ListAssetsQuery)) query: ListAssetsQuery,
  ): Promise<Result<AssetLibraryPage>> {
    const rows = await this.#library.read({
      limit: query.limit,
      ...(query.query === undefined ? {} : { query: query.query }),
    });
    if (isErr(rows)) return rows;

    const records = await this.#records.list(query.limit);
    if (isErr(records)) return records;

    // The *latest* take decides. A key whose first take failed and whose second
    // registered is not incomplete - it is in the list above, and listing it in both
    // would tell the user an asset they can see is missing.
    const incomplete = records.value
      .map((record) => record.takes.at(-1))
      .filter(
        (take): take is AssetProduceReport => take !== undefined && take.versionId === undefined,
      );

    return ok({ assets: [...rows.value.entries], total: rows.value.total, incomplete });
  }

  /**
   * Two path segments, deliberately: see the file header.
   *
   * Declared before `:id` as well, so the order is right even for a reader who does not
   * know why the path is shaped this way.
   */
  @Get('demand/plan')
  plan(): Promise<Result<AssetDemandPlan>> {
    return this.#demand.plan();
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

  /**
   * Where one take stopped in the eight-step produce chain, and why.
   *
   * Addressed by version because that is what a take *is*: an asset with three takes has
   * three reports, and the one you want is the one attached to the version you are
   * looking at. A version this build did not produce has no report and answers 404, which
   * is the truthful answer rather than eight empty steps.
   */
  @Get(':id/versions/:versionId/produce')
  async produceReport(
    @Param('id', new ZodValidationPipe(AssetIdParam)) id: AssetId,
    @Param('versionId', new ZodValidationPipe(AssetVersionIdParam)) versionId: AssetVersionId,
  ): Promise<Result<AssetProduceReport>> {
    const asset = await this.#repository.findById(id);
    if (isErr(asset)) return asset;
    if (asset.value === null) return err(new NotFoundError('asset', id));

    const record = await this.#records.find(asset.value.key);
    if (isErr(record)) return record;

    const take = record.value?.takes.find((candidate) => candidate.versionId === versionId);
    return take === undefined ? err(new NotFoundError('produce report', versionId)) : ok(take);
  }

  /**
   * A deliberate second take.
   *
   * The body is a `RegenerateIntent` - the contract schema whose `keepPrevious` is a
   * `z.literal(true)` precisely so that an attempt to make regeneration destructive is a
   * visible diff rather than a silent overwrite. The response names both version ids, so
   * a client can show that the previous take is still addressable rather than assert it.
   */
  @Post(':id/regenerate')
  regenerateAsset(
    @Param('id', new ZodValidationPipe(AssetIdParam)) id: AssetId,
    @Body(new ZodValidationPipe(RegenerateAssetBody)) body: RegenerateAssetBody,
  ): Promise<Result<RegenerateOutcome>> {
    // Re-parsed through the contract schema rather than passed as-is: the body carries
    // two ledger fields the registry must never see, and `RegenerateIntent.parse` is
    // what strips them - and re-checks `keepPrevious` on the way.
    const intent = RegenerateIntent.parse(body);
    return this.#regenerate.execute({
      assetId: id,
      intent,
      ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
      ...(body.budgetNanoUsd === undefined ? {} : { budgetNanoUsd: body.budgetNanoUsd }),
    });
  }

  /** Declared last: `:id` matches any single segment, so every literal above wins. */
  @Get(':id')
  async findOne(
    @Param('id', new ZodValidationPipe(AssetIdParam)) id: AssetId,
  ): Promise<Result<Asset>> {
    const found = await this.#repository.findById(id);
    if (isErr(found)) return found;
    return found.value === null ? err(new NotFoundError('asset', id)) : ok(found.value);
  }
}
