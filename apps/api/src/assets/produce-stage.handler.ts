/**
 * S6 Produce, wired for real over `ProduceAssetsUseCase`.
 *
 * The chain itself - resolve, generate, matte, split, score, rig, clip, bake, register -
 * is `@rv/asset-engine`'s and is not re-implemented here. This is the joint, and its job
 * is to keep two properties true across it, both of which are non-negotiables rather than
 * preferences:
 *
 * **Resolve first, spend second (#3).** The engine plans the whole batch, prices it, and
 * only then calls `budget.check` with the total - before the first image request. A batch
 * whose plan is not approved comes back `awaiting-approval` after **zero** provider calls,
 * and this stage turns that into a failure carrying the estimate rather than a success
 * carrying nothing. The test asserts the call count on a fake image port, not the cost,
 * because "we did not spend anything" is only true if no call was made.
 *
 * **No asset is generated twice (#2).** Every registration goes through
 * `RegisterAssetVersionUseCase`, which refuses a second take on an existing key without a
 * `RegenerateIntent`. This stage never supplies one - it is a *first* take by definition -
 * so a spec whose key is already in the library comes back as `reused` and costs nothing.
 * The deliberate second take is `POST /api/assets/:id/regenerate`, which is a different
 * use-case in a different file for exactly that reason.
 *
 * The run id is the *run's* id, which is what makes a killed produce run resumable: the
 * checkpoint key is `(runId, assetKey, step, attempt)`, so a second process that claims
 * the same run skips the steps whose inputs have not moved. A stage that minted its own
 * id would look resumable in a test and regenerate everything in practice.
 *
 * Partial success is the normal case and is not an error: forty specs where three fail
 * yield thirty-seven registered versions and three named failures. The stage succeeds,
 * names the failures in its artifacts, and records what each one did step by step so the
 * Assets screen can say where each stopped.
 */

import {
  ProduceAssetsUseCase,
  PRODUCE_STEPS,
  type AssetVersionRegistrarPort,
  type DemandPlannerPort,
  type MattingPort,
  type ProduceAssetsOutput,
  type ProduceCheckpointStore,
  type ProduceLanes,
  type ProduceProgress,
  type ProduceStep,
  type RasterPort,
} from '@rv/asset-engine';
import type { BlobStore } from '@rv/asset-registry';
import type { AssetKey, AssetSpec, Ids, PipelineStageKey, StyleBible } from '@rv/contracts';
import {
  ValidationError,
  err,
  isErr,
  nanoUsd,
  ok,
  toIso,
  toUsd,
  type AppError,
  type Clock,
  type Logger,
  type Result,
} from '@rv/shared-kernel';

import { toValidationError } from '../common/zod-validation.pipe';
import type { AssetProduceReport } from '../modules/assets/assets.contracts';
import type { StageContext, StageHandler, StageOutput } from '../pipeline/stage';
import { upstreamStyleBibleId } from '../style/style-artifacts';
import type { StyleBibleRepository } from '../style/style-bible.repository';
import { ProduceCostAdapter, type ProduceCostDeps } from './produce-cost';
import type { ProduceRecordStore } from './produce-record.store';
import { ProduceProgressLog, buildProduceReport } from './produce-report';
import { ProduceStageRequest } from './produce-stage.contracts';

export interface ProduceStageHandlerDeps {
  readonly resolver: DemandPlannerPort;
  readonly registrar: AssetVersionRegistrarPort;
  /**
   * Which port draws which lane.
   *
   * Built by the composition root from the registered adapters, so a machine with no
   * ComfyUI has an empty map and a prop spec fails by *naming the lane* rather than
   * being quietly generated somewhere else.
   */
  readonly lanes: ProduceLanes;
  readonly raster: RasterPort;
  readonly matting: MattingPort;
  readonly blobs: BlobStore;
  readonly checkpoints: ProduceCheckpointStore;
  readonly styles: StyleBibleRepository;
  readonly records: ProduceRecordStore;
  readonly cost: ProduceCostDeps;
  readonly ids: Ids;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class ProduceStageHandler implements StageHandler {
  readonly stage: PipelineStageKey = 'produce';
  readonly implemented = true;
  readonly #deps: ProduceStageHandlerDeps;

  constructor(deps: ProduceStageHandlerDeps) {
    this.#deps = deps;
  }

  async execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    const request = ProduceStageRequest.safeParse(context.job.payload.produce);
    if (!request.success) return err(toValidationError(request.error, 'run.payload.produce'));
    const payload = request.data;

    // The payload wins. A run that names its style is making a claim about which checksum
    // every asset key in it will contain, and substituting another - even one this run
    // made - would fork the library behind the operator's back.
    const styleBibleId = payload.styleBibleId ?? upstreamStyleBibleId(context.run);
    if (styleBibleId === null) {
      return err(
        new ValidationError({
          message:
            'S6 has no style to generate against: the payload names no `styleBibleId` and no ' +
            'earlier stage of this run established one. Run S1 first, or name a bible.',
          context: { stages: context.run.stages.map((stage) => stage.stage) },
        }),
      );
    }

    const style = await this.#style(styleBibleId);
    if (isErr(style)) return style;

    const money = new ProduceCostAdapter(this.#deps.cost, {
      projectId: context.run.projectId,
      budget: { runId: context.run.id, perRunNanoUsd: context.run.budgetNanoUsd },
    });

    const log = new ProduceProgressLog();
    const useCase = new ProduceAssetsUseCase({
      resolver: this.#deps.resolver,
      registrar: this.#deps.registrar,
      budget: money,
      lanes: this.#deps.lanes,
      raster: this.#deps.raster,
      matting: this.#deps.matting,
      blobs: this.#deps.blobs,
      ids: this.#deps.ids,
      clock: this.#deps.clock,
      checkpoints: this.#deps.checkpoints,
      ledger: money,
      pricer: money,
      logger: this.#deps.logger,
    });

    context.reportProgress({
      progress: 0.02,
      detail:
        `planning ${String(payload.specs.length)} specs against ` +
        `${style.value.checksum.slice(0, 12)}`,
    });

    // Ticks over the whole batch, so the bar moves on step boundaries rather than only
    // when an asset finishes. Eight steps per spec is the ceiling, not the certainty -
    // a cache hit uses none of them - which is why it is clamped rather than trusted.
    const totalTicks = payload.specs.length * PRODUCE_STEPS.length;
    let ticks = 0;

    const produced = await useCase.execute({
      specs: payload.specs,
      style: style.value,
      runId: context.run.id,
      approved: payload.approved,
      concurrency: payload.concurrency,
      bake: { clips: payload.bake.clips, settings: { frames: payload.bake.frames } },
      signal: context.signal,
      ...(payload.variantKey === undefined ? {} : { variantKey: payload.variantKey }),
      ...(context.run.budgetNanoUsd === null
        ? {}
        : { budgetNanoUsd: nanoUsd(context.run.budgetNanoUsd) }),
      ...(payload.confirmationThresholdNanoUsd === undefined
        ? {}
        : { confirmationThresholdNanoUsd: nanoUsd(payload.confirmationThresholdNanoUsd) }),
      onProgress: (event: ProduceProgress) => {
        log.record(event);
        ticks += 1;
        report(
          context,
          event,
          Math.min(0.98, ticks / Math.max(1, totalTicks)),
          payload.specs.length,
        );
      },
    });
    if (isErr(produced)) return produced;
    const outcome = produced.value;

    if (outcome.status === 'awaiting-approval') return this.#refuse(context, outcome);

    await this.#recordTakes(payload, style.value, outcome, log);

    const artifacts = [
      ...outcome.registered.map((asset) => `asset-version:${asset.versionId}`),
      ...outcome.reused.map((asset) => `asset-reused:${asset.semanticKey}`),
      ...outcome.rejected.map((asset) => `asset-rejected:${asset.semanticKey}`),
      ...outcome.failed.map((failure) => `asset-failed:${failure.semanticKey}@${failure.step}`),
      `produce-estimate:${String(outcome.ledger.estimatedNanoUsd)}`,
      `produce-spend:${String(outcome.ledger.spentNanoUsd)}`,
    ];

    this.#deps.logger.info('produce complete', {
      runId: context.run.id,
      status: outcome.status,
      registered: outcome.registered.length,
      reused: outcome.reused.length,
      rejected: outcome.rejected.length,
      failed: outcome.failed.length,
      skipped: outcome.skipped.length,
      estimatedNanoUsd: outcome.ledger.estimatedNanoUsd,
      spentNanoUsd: outcome.ledger.spentNanoUsd,
    });

    context.reportProgress({
      progress: 1,
      detail:
        `${String(outcome.registered.length)} registered, ` +
        `${String(outcome.reused.length)} reused, ` +
        `${String(outcome.failed.length)} failed, ` +
        `$${toUsd(nanoUsd(outcome.ledger.spentNanoUsd)).toFixed(4)} spent`,
    });

    // A cancelled run is not a failed one: the assets that never started are listed as
    // skipped, and the ones that finished are registered and keyed. Failing the stage
    // over a cancellation would throw away work that is already in the library.
    return ok({ artifacts });
  }

  /**
   * The estimate, refused.
   *
   * A failure rather than a success, because the run did not produce the assets the next
   * stage will look for, and a "succeeded" stage that produced none is exactly the shape
   * of report that gets believed. The numbers go in the error context *and* on the run's
   * event stream, so a client that is watching sees the figure without polling for the
   * failure.
   */
  #refuse(context: StageContext, outcome: ProduceAssetsOutput): Result<StageOutput, AppError> {
    const usd = toUsd(nanoUsd(outcome.plan.totalEstimatedNanoUsd)).toFixed(4);
    this.#deps.cost.events.publish({
      type: 'issue-raised',
      runId: context.run.id,
      stage: 'produce',
      severity: 'warning',
      code: 'APPROVAL_REQUIRED',
      message:
        `${String(outcome.plan.missCount)} assets would cost $${usd}. ` +
        'Re-run with `payload.produce.approved: true` to spend it.',
    });

    return err(
      new ValidationError({
        message:
          `S6 stopped before spending anything: ${String(outcome.plan.missCount)} assets are ` +
          `estimated at $${usd} and the payload does not approve it.`,
        context: {
          missCount: outcome.plan.missCount,
          hitCount: outcome.plan.hitCount,
          totalEstimatedNanoUsd: outcome.plan.totalEstimatedNanoUsd,
          requiresConfirmation: outcome.plan.requiresConfirmation,
        },
      }),
    );
  }

  async #style(id: StyleBible['id']): Promise<Result<StyleBible, AppError>> {
    const found = await this.#deps.styles.find(id);
    if (isErr(found)) return found;
    if (found.value !== null) return ok(found.value);
    return err(
      new ValidationError({
        message:
          `No style bible is stored under ${id}. Create one with POST /api/style/from-preset ` +
          'and lock it before producing against it.',
        context: { styleBibleId: id },
      }),
    );
  }

  /**
   * Writes what happened to every take, registered or not.
   *
   * Two things depend on this and neither can be derived afterwards: the Assets screen's
   * "why is the asset I asked for not here" list, and `POST /assets/:id/regenerate`,
   * which needs the spec verbatim - a reconstructed one hashes differently and would
   * create a second asset instead of appending a version.
   *
   * A failure to record is logged and not fatal. The assets are already in the library,
   * and refusing the stage over its own bookkeeping would throw away real work.
   */
  async #recordTakes(
    payload: ProduceStageRequest,
    style: StyleBible,
    outcome: ProduceAssetsOutput,
    log: ProduceProgressLog,
  ): Promise<void> {
    const specByKey = new Map<AssetKey, AssetSpec>();
    for (const resolution of outcome.plan.resolutions) {
      specByKey.set(resolution.key, resolution.spec);
    }

    const takes: { readonly key: AssetKey; readonly report: AssetProduceReport }[] = [];

    for (const asset of outcome.registered) {
      const report = buildProduceReport(
        {
          key: asset.key,
          semanticKey: asset.semanticKey,
          label: specByKey.get(asset.key)?.label ?? asset.semanticKey,
          assetId: asset.assetId,
          versionId: asset.versionId,
          spentNanoUsd: asset.costNanoUsd,
        },
        log.stepsFor(asset.semanticKey),
      );
      if (report !== null) takes.push({ key: asset.key, report });
    }

    for (const failure of outcome.failed) {
      const key = failure.key;
      if (key === undefined) continue;
      const spec = specByKey.get(key);
      if (spec === undefined) continue;

      const steps = log.stepsFor(failure.semanticKey).map((record) =>
        // The engine's own detail on a failed step is the error *code*; the message is
        // the prose a user can act on, and this is the only place both are in scope.
        record.step === failure.step
          ? { ...record, outcome: 'failed' as const, detail: failure.error.message }
          : record,
      );

      const report = buildProduceReport(
        {
          key,
          semanticKey: spec.semanticKey,
          label: spec.label,
          spentNanoUsd: failure.costNanoUsd,
          // `plan` is not one of the eight steps: the take failed before any of them ran,
          // so no step is named and every one reads `not-reached`, which is true.
          ...(failure.step === 'plan' ? {} : { failedStep: failure.step satisfies ProduceStep }),
        },
        steps,
      );
      if (report !== null) takes.push({ key, report });
    }

    const at = toIso(this.#deps.clock.now());
    for (const take of takes) {
      const spec = specByKey.get(take.key);
      if (spec === undefined) continue;
      const written = await this.#deps.records.append(
        {
          key: take.key,
          spec,
          styleBibleId: style.id,
          styleChecksum: style.checksum,
          ...(payload.variantKey === undefined ? {} : { variantKey: payload.variantKey }),
        },
        take.report,
        at,
      );
      if (isErr(written)) {
        this.#deps.logger.warn('produce take not recorded; regeneration will refuse this key', {
          assetKey: take.key,
          code: written.error.code,
        });
      }
    }
  }
}

/**
 * One engine tick to one run event.
 *
 * `item` carries the semantic key rather than only the fraction, because "street lamp,
 * splitting" is what a progress list renders and a fraction is what a bar renders, and a
 * UI shows both.
 */
function report(
  context: StageContext,
  tick: ProduceProgress,
  fraction: number,
  total: number,
): void {
  context.reportProgress({
    progress: fraction,
    detail: `${tick.semanticKey}: ${tick.step} ${tick.phase}`,
    item: { kind: 'asset', key: tick.semanticKey, index: null, total },
  });
}
