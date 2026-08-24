/**
 * "Give me another take" - the only sanctioned way to spend money on something we
 * already have.
 *
 * `RegisterAssetVersionUseCase` already owns the rule: registering against an existing
 * dedup key is a `ConflictError` unless the caller presents a `RegenerateIntent`, and a
 * presented intent *appends* a version rather than replacing one. What that rule does
 * not do on its own is get a second take *made*, because two things in the chain are
 * built to make a second take unnecessary:
 *
 *  1. `ResolveAssetDemandUseCase` resolves the key to a `cache-hit`, so the batch plan
 *     lists nothing to do;
 *  2. `GenerateAssetVersionUseCase` re-checks the same key and short-circuits.
 *
 * Both are correct - they are the machinery of non-negotiable #2 - and both are exactly
 * what a deliberate regeneration is asking to be excused from. So this use-case wraps the
 * two ports rather than reaching past them:
 *
 * - {@link RegeneratingDemandPlanner} turns the *one* named key's `cache-hit` into a
 *   `miss`, priced by the same estimator the plan uses, and leaves every other key alone.
 *   The estimate the caller is given is therefore the real one for this take.
 * - {@link IntentfulRegistrar} supplies the user's `RegenerateIntent` at the door. The
 *   registry still parses it - `keepPrevious` is `z.literal(true)`, so an attempt to make
 *   regeneration destructive fails there and not here - and still appends.
 *
 * Nothing is bypassed. The dedup key is unchanged, the previous version keeps its ordinal
 * and its row, and the response returns both ids so a client can *show* that the old take
 * is still addressable rather than assert it in a sentence.
 *
 * **The spec has to be the original, byte for byte.** `specHash` is a component of the
 * key, so a take built from a reconstructed spec would derive a *different* key, miss,
 * and create a second asset - non-negotiable #2 broken by a helpful guess. The registry
 * does not store specs, so this reads the one S6 recorded when it produced the asset, and
 * refuses by name when there is none.
 *
 * **A regeneration is a run.** It creates a `runs` row before it spends anything, because
 * `usage_records.run_id` references it and because "what did this cost" has to be
 * answerable afterwards from the same ledger every other spend lands in.
 */

import {
  ProduceAssetsUseCase,
  type AssetVersionRegistrarPort,
  type DemandPlannerPort,
  type MattingPort,
  type ProduceLanes,
  type RasterPort,
} from '@rv/asset-engine';
import type {
  AssetCostEstimator,
  AssetRepository,
  BlobStore,
  RegisterAssetVersionUseCase,
} from '@rv/asset-registry';
import type {
  Asset,
  AssetDemandPlan,
  AssetId,
  AssetKey,
  AssetVersion,
  Ids,
  NanoUsdAmount,
  ProjectId,
  RegenerateIntent,
  RunId,
  StyleBible,
} from '@rv/contracts';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  err,
  isErr,
  nanoUsd,
  ok,
  toIso,
  type AppError,
  type Clock,
  type Logger,
  type Result,
} from '@rv/shared-kernel';

import type { ProjectRepository, RunRepository } from '../application/ports/repository.ports';
import { RunSummary } from '../application/resources';
import type { RegenerateOutcome } from '../modules/assets/assets.contracts';
import { ProduceCostAdapter, type ProduceCostDeps } from './produce-cost';
import { ProduceProgressLog, buildProduceReport } from './produce-report';
import type { ProduceRecord, ProduceRecordStore } from './produce-record.store';
import type { StyleBibleRepository } from '../style/style-bible.repository';

/**
 * A planner that is allowed to say "yes, again", for one key and no others.
 *
 * It wraps rather than replaces: every key it was not told about is resolved by the real
 * planner and keeps whatever answer the registry gave it. The forced key is re-priced by
 * the same estimator the plan uses, so the number the user approves is the number the
 * plan would have quoted had the asset not existed.
 */
export class RegeneratingDemandPlanner implements DemandPlannerPort {
  readonly #inner: DemandPlannerPort;
  readonly #estimator: AssetCostEstimator;
  readonly #forced: ReadonlySet<AssetKey>;

  constructor(deps: {
    readonly inner: DemandPlannerPort;
    readonly estimator: AssetCostEstimator;
    readonly forced: ReadonlySet<AssetKey>;
  }) {
    this.#inner = deps.inner;
    this.#estimator = deps.estimator;
    this.#forced = deps.forced;
  }

  async execute(
    input: Parameters<DemandPlannerPort['execute']>[0],
  ): Promise<Result<AssetDemandPlan, AppError>> {
    const planned = await this.#inner.execute(input);
    if (isErr(planned)) return planned;

    let hitCount = 0;
    let missCount = 0;
    let total = 0;

    const resolutions = planned.value.resolutions.map((resolution) => {
      const forced = this.#forced.has(resolution.key) && resolution.outcome === 'cache-hit';
      if (!forced) {
        if (resolution.outcome === 'cache-hit') hitCount += 1;
        if (resolution.outcome === 'miss') {
          missCount += 1;
          total += resolution.estimatedCostNanoUsd;
        }
        return resolution;
      }

      const estimate = this.#estimator.estimateNanoUsd(resolution.spec);
      missCount += 1;
      total += estimate;
      // `existingAssetId` and `existingVersionId` are dropped: they describe a *hit*, and
      // leaving them on a miss would let a reader believe the plan is about to reuse
      // something it is about to pay to replace.
      return {
        key: resolution.key,
        spec: resolution.spec,
        outcome: 'miss' as const,
        styleBibleId: resolution.styleBibleId,
        estimatedCostNanoUsd: estimate,
        reason: 'A regeneration was requested for this key; a new take will be generated.',
      };
    });

    return ok({
      resolutions,
      hitCount,
      missCount,
      totalEstimatedNanoUsd: total,
      requiresConfirmation: planned.value.requiresConfirmation,
    });
  }
}

/**
 * The registrar, with the user's intent attached.
 *
 * Typed against the concrete `RegisterAssetVersionUseCase` rather than against the
 * engine's narrower port, because `intent` is the one field the port deliberately does
 * not expose - S6 must not be able to supply one, and this is the only caller that may.
 * The intent is passed straight through, so the guarantee that a second take appends is
 * still enforced by the registry and not by this file.
 */
export class IntentfulRegistrar implements AssetVersionRegistrarPort {
  readonly #inner: RegisterAssetVersionUseCase;
  readonly #intent: RegenerateIntent;

  constructor(inner: RegisterAssetVersionUseCase, intent: RegenerateIntent) {
    this.#inner = inner;
    this.#intent = intent;
  }

  execute(
    input: Parameters<AssetVersionRegistrarPort['execute']>[0],
  ): ReturnType<AssetVersionRegistrarPort['execute']> {
    return this.#inner.execute({ ...input, intent: this.#intent });
  }
}

export interface RegenerateAssetVersionDeps {
  readonly assets: AssetRepository;
  readonly resolver: DemandPlannerPort;
  readonly registrar: RegisterAssetVersionUseCase;
  readonly estimator: AssetCostEstimator;
  readonly lanes: ProduceLanes;
  readonly raster: RasterPort;
  readonly matting: MattingPort;
  readonly blobs: BlobStore;
  readonly records: ProduceRecordStore;
  readonly styles: StyleBibleRepository;
  readonly runs: RunRepository;
  /** Only to resolve "which project" when the caller did not say. See `#project`. */
  readonly projects: ProjectRepository;
  readonly cost: ProduceCostDeps;
  readonly ids: Ids;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface RegenerateAssetVersionInput {
  readonly assetId: AssetId;
  readonly intent: RegenerateIntent;
  /**
   * Whose ledger this lands in. The asset library is project-wide; the money is not.
   *
   * Optional only because the studio does not send it yet. Absent resolves to the sole
   * project when there is exactly one, and **refuses by name** when there are none or
   * several - picking one would put a real spend on a project nobody chose.
   */
  readonly projectId?: ProjectId;
  readonly budgetNanoUsd?: NanoUsdAmount;
  readonly signal?: AbortSignal;
}

export class RegenerateAssetVersionUseCase {
  readonly #deps: RegenerateAssetVersionDeps;

  constructor(deps: RegenerateAssetVersionDeps) {
    this.#deps = deps;
  }

  async execute(input: RegenerateAssetVersionInput): Promise<Result<RegenerateOutcome, AppError>> {
    const projectId = await this.#project(input.projectId);
    if (isErr(projectId)) return projectId;

    const asset = await this.#deps.assets.findById(input.assetId);
    if (isErr(asset)) return asset;
    if (asset.value === null) return err(new NotFoundError('asset', input.assetId));

    const record = await this.#deps.records.find(asset.value.key);
    if (isErr(record)) return record;
    if (record.value === null) {
      return err(
        new ValidationError({
          message:
            `This build has no record of the spec that produced ${asset.value.semanticKey}, and a ` +
            'second take must use the original spec verbatim - a reconstructed one hashes ' +
            'differently and would create a second asset rather than a new version. Produce it ' +
            'through S6 once, and regeneration becomes available.',
          context: { assetId: input.assetId, assetKey: asset.value.key },
        }),
      );
    }

    const style = await this.#deps.styles.find(record.value.styleBibleId);
    if (isErr(style)) return style;
    if (style.value === null) {
      return err(
        new ValidationError({
          message: `The style bible ${record.value.styleBibleId} this asset was made under is no longer stored.`,
          context: { assetId: input.assetId, styleBibleId: record.value.styleBibleId },
        }),
      );
    }

    const previous = currentVersion(asset.value);
    if (previous === null) {
      return err(
        new ValidationError({
          message: `Asset ${input.assetId} has no current version to regenerate from.`,
          context: { assetId: input.assetId },
        }),
      );
    }

    const shareable = clipCollision(asset.value);
    if (shareable !== null) return err(shareable);

    const run = await this.#openRun(projectId.value, input);
    if (isErr(run)) return run;

    const produced = await this.#produce(
      projectId.value,
      input,
      record.value,
      style.value,
      run.value,
    );
    const finishedAt = toIso(this.#deps.clock.now());

    if (isErr(produced)) {
      await this.#deps.runs.setStatus(run.value, 'failed', finishedAt, produced.error.code);
      return produced;
    }

    await this.#deps.runs.setStatus(run.value, 'succeeded', finishedAt, null);

    const reloaded = await this.#deps.assets.findById(input.assetId);
    if (isErr(reloaded)) return reloaded;
    const next = reloaded.value === null ? null : currentVersion(reloaded.value);
    if (next === null || next.id === previous.id) {
      return err(
        new ValidationError({
          message:
            'The regeneration finished without registering a new version. Its take is recorded ' +
            'under the asset key; open the produce report to see which step stopped it.',
          context: { assetId: input.assetId, previousVersionId: previous.id },
        }),
      );
    }

    this.#deps.logger.info('asset regenerated; the previous take is still addressable', {
      assetId: input.assetId,
      previousVersionId: previous.id,
      newVersionId: next.id,
      ordinal: next.ordinal,
      reason: input.intent.reason,
    });

    return ok({
      assetId: input.assetId,
      previousVersionId: previous.id,
      newVersionId: next.id,
      ordinal: next.ordinal,
      estimatedNanoUsd: produced.value,
    });
  }

  /**
   * Runs the chain for exactly one spec, and returns what it estimated.
   *
   * `approved: true` because the `RegenerateIntent` *is* the approval: it is the contract
   * schema whose whole purpose is "why we are deliberately paying for something we may
   * already have", and it cannot be constructed by accident. The guard still runs before
   * the first image request - `ProduceAssetsUseCase` calls `budget.check` with the batch
   * total immediately after planning - so a regeneration past the run or project ceiling
   * is refused with nothing spent.
   *
   * No checkpoint store is wired. A checkpoint's `inputHash` covers the spec, the style
   * and the lane, all of which are identical to the take being replaced - so a resumed
   * step would hand back the *first* take's image and the "new" version would be the old
   * one with a new id, which is the one outcome a regeneration must not produce.
   */
  async #produce(
    projectId: ProjectId,
    input: RegenerateAssetVersionInput,
    record: ProduceRecord,
    style: StyleBible,
    runId: RunId,
  ): Promise<Result<number, AppError>> {
    const money = new ProduceCostAdapter(this.#deps.cost, {
      projectId,
      budget: { runId, perRunNanoUsd: input.budgetNanoUsd ?? null },
    });

    const log = new ProduceProgressLog();
    const useCase = new ProduceAssetsUseCase({
      resolver: new RegeneratingDemandPlanner({
        inner: this.#deps.resolver,
        estimator: this.#deps.estimator,
        forced: new Set([record.key]),
      }),
      registrar: new IntentfulRegistrar(this.#deps.registrar, input.intent),
      budget: money,
      lanes: this.#deps.lanes,
      raster: this.#deps.raster,
      matting: this.#deps.matting,
      blobs: this.#deps.blobs,
      ids: this.#deps.ids,
      clock: this.#deps.clock,
      ledger: money,
      pricer: money,
      logger: this.#deps.logger,
    });

    const produced = await useCase.execute({
      specs: [record.spec],
      style,
      runId,
      approved: true,
      concurrency: 1,
      ...(record.variantKey === undefined ? {} : { variantKey: record.variantKey }),
      ...(input.budgetNanoUsd === undefined ? {} : { budgetNanoUsd: nanoUsd(input.budgetNanoUsd) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onProgress: (event) => {
        log.record(event);
      },
    });
    if (isErr(produced)) return produced;

    const outcome = produced.value;
    // Indexed rather than `at()`: `at` throws on a miss, and "nothing was registered" is
    // the normal shape of a take the quality gate rejected.
    const registered = outcome.registered[0];
    const failure = outcome.failed[0];

    // Recorded whichever way it went: the take that failed cost real money, and the
    // report is the only place a user can find out which of the eight steps stopped it.
    const report = buildProduceReport(
      {
        key: record.key,
        semanticKey: record.spec.semanticKey,
        label: record.spec.label,
        spentNanoUsd: registered?.costNanoUsd ?? failure?.costNanoUsd ?? 0,
        ...(registered === undefined
          ? {}
          : { assetId: registered.assetId, versionId: registered.versionId }),
        ...(failure === undefined || failure.step === 'plan' ? {} : { failedStep: failure.step }),
      },
      log.stepsFor(record.spec.semanticKey),
    );

    if (report !== null) {
      const written = await this.#deps.records.append(
        {
          key: record.key,
          spec: record.spec,
          styleBibleId: style.id,
          styleChecksum: style.checksum,
          ...(record.variantKey === undefined ? {} : { variantKey: record.variantKey }),
        },
        report,
        toIso(this.#deps.clock.now()),
      );
      if (isErr(written)) {
        this.#deps.logger.warn('regeneration take not recorded', {
          assetKey: record.key,
          code: written.error.code,
        });
      }
    }

    if (failure !== undefined && registered === undefined) return err(failure.error);
    return ok(outcome.ledger.estimatedNanoUsd);
  }

  /**
   * The run a regeneration is billed to.
   *
   * Opened before anything is spent, because `usage_records.run_id` references `runs.id`
   * and a ledger row with nowhere to go is a spend that never appears in the project's
   * cost report. It also gives the operator something to point at: "which run was that
   * $0.004" has an answer.
   */
  async #openRun(
    projectId: ProjectId,
    input: RegenerateAssetVersionInput,
  ): Promise<Result<RunId, AppError>> {
    const startedAt = toIso(this.#deps.clock.now());
    const summary = RunSummary.parse({
      id: this.#deps.ids.run(),
      projectId,
      seriesId: null,
      status: 'running',
      requestedStages: ['produce'],
      currentStage: 'produce',
      stages: [],
      // The run is one deliberate act, not a replayable pipeline: its seed is the intent's
      // own, and nothing in the chain below draws a random number.
      seed: 0,
      budgetNanoUsd: input.budgetNanoUsd ?? null,
      spentNanoUsd: 0,
      errorCode: null,
      startedAt,
      finishedAt: null,
    });

    const created = await this.#deps.runs.create(summary);
    if (isErr(created)) return created;
    return ok(created.value.id);
  }

  /**
   * Whose money this is.
   *
   * A regeneration is a real spend and a ledger row has to name a project. When the
   * caller says which, that is the answer. When it does not, the sole project is the only
   * unambiguous reading - and zero or several is a refusal that names the field, because
   * billing an arbitrary project is worse than failing.
   */
  async #project(declared: ProjectId | undefined): Promise<Result<ProjectId, AppError>> {
    if (declared !== undefined) return ok(declared);

    const projects = await this.#deps.projects.list();
    if (isErr(projects)) return projects;

    const only = projects.value.length === 1 ? projects.value[0] : undefined;
    if (only !== undefined) return ok(only.id);

    return err(
      new ValidationError({
        message:
          'A regeneration spends money, so it has to name the project whose budget it is ' +
          `spending. There ${projects.value.length === 0 ? 'are no projects' : `are ${String(projects.value.length)} projects`}, ` +
          'so send `projectId` in the request body.',
        context: { projectCount: projects.value.length },
      }),
    );
  }
}

/** The version an asset serves today, or `null` if its pointer names nothing. */
function currentVersion(asset: Asset): AssetVersion | null {
  return asset.versions.find((version) => version.id === asset.currentVersionId) ?? null;
}

/**
 * The one thing that stops a second take from being storable today, checked before a
 * penny is spent.
 *
 * Two upstream facts collide here, and both are individually correct:
 *
 * - `DeriveClipsUseCase` mints a clip id with `contentId('clp', archetype:name:irHash)`,
 *   **deliberately** - "the same motion under the same style is the same clip wherever it
 *   turns up, which is what makes the sharing visible rather than merely true on disk".
 * - `clips.id` in `@rv/persistence` is a bare primary key on a table whose rows are owned
 *   by one `version_id`.
 *
 * A second take of an unchanged spec under an unchanged style derives the same clip set -
 * the generation seed and the prompt are pure functions of `(style, spec)`, by design - so
 * `appendVersion` tries to insert a clip row whose id already exists and SQLite refuses.
 * The transaction rolls back, so nothing is half-written; what the caller gets without
 * this check is a 500 carrying a SQL string.
 *
 * So it is refused here instead, as a conflict, before the image is generated. The rest of
 * this use-case is unchanged and correct: the moment `clips` is keyed `(version_id, id)` -
 * or clips become a shared table with a join - this check can go and regeneration works.
 *
 * The second half of the same problem is named in the message rather than checked, because
 * it has no seam to check *at*: with the seed and the prompt derived purely from the style
 * and the spec, an unvaried second take reproduces the first byte for byte. "Give me
 * another take" needs a variation input on `ProduceAssetsInput`; the engine already has the
 * mechanism (`repairClause`, `attempt`) and does not expose it.
 */
function clipCollision(asset: Asset): ConflictError | null {
  const clipped = asset.versions.find((version) => version.clips.length > 0);
  if (clipped === undefined) return null;

  return new ConflictError({
    message:
      `Version ${clipped.id} of this asset already carries ${String(clipped.clips.length)} ` +
      'content-addressed clips, and a second take of an unchanged spec derives the same ids. ' +
      '`clips.id` is a per-version primary key in @rv/persistence, so appending would collide ' +
      'on it. Two upstream changes unblock this: key `clips` by `(version_id, id)`, and give ' +
      '`ProduceAssetsInput` a variation input so a second take is a different take rather than ' +
      'a byte-identical one.',
    context: {
      assetId: asset.id,
      collidingVersionId: clipped.id,
      clipIds: clipped.clips.map((clip) => clip.id),
    },
  });
}
