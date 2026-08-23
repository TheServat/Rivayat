/**
 * RV-130 - the command that turns a list of `AssetSpec` into registered
 * `AssetVersion`s: resolve, generate, matte, split, fit a rig, derive clips, bake a
 * sheet, register.
 *
 * Every link already existed and none of them were joined. What this adds is not glue
 * but five properties that only exist at the seam, and each one is a decision:
 *
 *  1. **Resolve first, spend second.** The demand plan runs once for the whole batch,
 *     the estimate is returned before anything is generated, and `BudgetGuard` sees
 *     the total *before* the first provider call. A run whose plan is entirely cache
 *     hits calls the image port **zero** times, and the test asserts the call count
 *     rather than the cost, because "we didn't spend anything" is only true if no call
 *     was made.
 *  2. **Resumable per asset per step.** Each step writes a `StageCheckpoint` whose
 *     `inputHash` covers what that step consumed. Killing a run and resuming it skips
 *     what already ran *on these inputs* and produces the same result - and a step
 *     whose inputs changed re-runs, which is the half that is easy to lose.
 *  3. **Partial success is the normal case.** Forty specs where three fail yield
 *     thirty-seven registered versions and three named failures, via `partition`.
 *     There is no path on which one bad prompt discards thirty-nine good assets.
 *  4. **Bounded concurrency, defaulting low.** The local lane is one 6 GB card
 *     (research §2); twelve concurrent generations on it are slower than two, and
 *     1024² already sits at 95 % of the card.
 *  5. **Cancelled is not failed.** An `AbortSignal` stops the run between steps, the
 *     status says `cancelled`, and the assets that never started are listed as
 *     `skipped` rather than counted as errors.
 *
 * Routing is `produce/lanes.ts` plus `generate/decomposition-policy.ts`, both tables:
 * props take the free local parts-sheet lane, characters take the multi-reference
 * cloud lane and are decomposed by segmentation afterwards (research §3). Nothing here
 * branches on a subject class.
 *
 * Dedup is **not** implemented here. `@rv/asset-registry` owns it, this calls it
 * twice - once for the batch plan and once per asset inside
 * `GenerateAssetVersionUseCase` - and registers exclusively through
 * `RegisterAssetVersionUseCase`, which refuses a second take without a
 * `RegenerateIntent`.
 */

import {
  type AppError,
  type Clock,
  type Logger,
  type NanoUsd,
  NoopLogger,
  type Result,
  ValidationError,
  ZERO_USD,
  assertDefined,
  at,
  contentHash,
  err,
  isErr,
  nanoUsd,
  must,
  ok,
  partition,
  toIso,
} from '@rv/shared-kernel';
import type { z } from 'zod';
import {
  type AnimationClip,
  type AnimationIR,
  type ArtifactRef,
  type AssetDemandPlan,
  type AssetId,
  type AssetKey,
  type AssetResolution,
  type AssetSpec,
  type AssetVersionId,
  type Ids,
  type Part,
  type PipelineStageKey,
  type ProviderKind,
  type QualityScores,
  type QualityTier,
  type Rig,
  type Sha256Hex,
  type Slug,
  type StageCheckpoint,
  type StyleBible,
  type RunId,
} from '@rv/contracts';
import type { BlobStore, NewAssetVersion } from '@rv/asset-registry';
import type { ProviderUsage, VisionScoringPort } from '@rv/providers';

import { BakeSheetUseCase, type BakeSheetSettings } from '../bake/bake-sheet';
import { DeriveClipsUseCase } from '../clips/derive-clips';
import type {
  BudgetCheckPort,
  DemandResolverPort,
  GenerateAssetVersionInput,
} from '../generate/generate-asset-version';
import { GenerateAssetVersionUseCase } from '../generate/generate-asset-version';
import type { DecompositionStrategy, GenerationLane } from '../generate/decomposition-policy';
import { MatteCanvasUseCase } from '../matte/matte-canvas';
import { SplitPartsUseCase } from '../parts/split-parts';
import type { MattingPort } from '../ports/matting-port';
import type { EncodedImage, RasterPort, RgbaImage } from '../ports/raster-port';
import {
  DEFAULT_THRESHOLDS,
  QualityGateUseCase,
  type QualityThresholds,
} from '../quality/quality-gate';
import { FitRigUseCase } from '../rig/fit-rig';
import {
  PRODUCE_STEPS,
  type ProduceCheckpointStore,
  type ProduceStep,
  produceStageCheckpoint,
  stageCheckpoint,
  stepInputHash,
} from './checkpoints';
import { GENERATION_LANES, type LaneBinding, type ProduceLanes, resolveLane } from './lanes';
import {
  BakeRecord,
  ClipsRecord,
  GenerateRecord,
  MatteRecord,
  RegisterRecord,
  RigRecord,
  ScoreRecord,
  type SheetRecord,
  SplitRecord,
  readRecord,
  writeRecord,
} from './records';

// ── ports this use-case needs ───────────────────────────────────────────────

/**
 * The registry's batch planner. `ResolveAssetDemandUseCase` satisfies it as written.
 *
 * A structural subset rather than the class, for the same reason the rest of this
 * package uses one: a test refuses or approves a plan in ten lines, and the engine
 * does not construct a repository it has no opinion about.
 */
export interface DemandPlannerPort {
  execute(input: {
    readonly specs: readonly AssetSpec[];
    readonly styleBibleId: StyleBible['id'];
    readonly styleChecksum: Sha256Hex;
    readonly variantKey?: Slug;
    readonly budgetNanoUsd?: NanoUsd;
    readonly confirmationThresholdNanoUsd?: NanoUsd;
  }): Promise<Result<AssetDemandPlan, AppError>>;
}

/**
 * The only door into the library. `RegisterAssetVersionUseCase` satisfies it.
 *
 * Deliberately the *use-case* and not the repository: the conflict-on-existing-key
 * rule and the `RegenerateIntent` requirement live in the use-case, and a port shaped
 * like the repository would let a caller walk around both.
 */
export interface AssetVersionRegistrarPort {
  execute(input: {
    readonly spec: AssetSpec;
    readonly styleBibleId: StyleBible['id'];
    readonly styleChecksum: Sha256Hex;
    readonly variantKey?: Slug;
    readonly version: NewAssetVersion;
  }): Promise<
    Result<
      {
        readonly asset: { readonly id: AssetId };
        readonly version: { readonly id: AssetVersionId };
        readonly key: AssetKey;
        readonly createdAsset: boolean;
      },
      AppError
    >
  >;
}

/** The ledger. `CostMeter` satisfies it as written. */
export interface ProduceLedgerPort {
  record(input: {
    readonly runId: RunId;
    readonly stage: PipelineStageKey;
    readonly provider: ProviderKind;
    readonly model: string;
    readonly task: 'image-draft' | 'image-final' | 'vision-score';
    readonly tier: QualityTier;
    readonly usage: ProviderUsage;
    readonly outcome: 'success' | 'failure';
    readonly cacheHit?: boolean;
  }): unknown;
}

/**
 * Prices a call without recording it. `CostMeter.price` satisfies it.
 *
 * Separate from the ledger because the run ledger has to attribute spend **per step**,
 * including on assets the quality gate later rejected, and `record` returns whatever
 * the implementation feels like. Absent, every step is priced at zero - which is the
 * truth on the free local lane and a visible gap on any other, rather than an invented
 * number.
 */
export interface UsagePricerPort {
  price(provider: ProviderKind, model: string, usage: ProviderUsage): NanoUsd;
}

// ── inputs and outputs ──────────────────────────────────────────────────────

export interface ProduceAssetsDeps {
  readonly resolver: DemandPlannerPort;
  readonly registrar: AssetVersionRegistrarPort;
  readonly budget: BudgetCheckPort;
  readonly lanes: ProduceLanes;
  readonly raster: RasterPort;
  readonly matting: MattingPort;
  readonly blobs: BlobStore;
  readonly ids: Ids;
  readonly clock: Clock;
  /** Absent means a run that cannot be resumed. Every step then always runs. */
  readonly checkpoints?: ProduceCheckpointStore;
  readonly ledger?: ProduceLedgerPort;
  readonly pricer?: UsagePricerPort;
  /** Absent switches the quality gate off; every take that splits is registered. */
  readonly vision?: VisionScoringPort;
  readonly visionBinding?: { readonly provider: ProviderKind; readonly model: string };
  readonly thresholds?: QualityThresholds;
  readonly logger?: Logger;
}

export interface BakePlan {
  /** Clip names to bake. `'all'` bakes the archetype's whole set, `[]` bakes none. */
  readonly clips?: readonly string[] | 'all';
  readonly settings?: BakeSheetSettings;
}

export interface ProduceProgress {
  readonly semanticKey: string;
  readonly step: ProduceStep;
  readonly attempt: number;
  readonly phase: 'ran' | 'resumed' | 'failed';
  readonly durationMs: number;
  readonly detail: string | undefined;
}

export interface ProduceAssetsInput {
  readonly specs: readonly AssetSpec[];
  readonly style: StyleBible;
  readonly runId: RunId;
  readonly variantKey?: Slug;
  readonly budgetNanoUsd?: NanoUsd;
  readonly confirmationThresholdNanoUsd?: NanoUsd;
  /**
   * The human "yes" to the estimate.
   *
   * Absent is refusal, not permission: `AssetDemandPlan.requiresConfirmation` defaults
   * to "any spend at all is confirmed", and a pipeline that treated a missing approval
   * as consent would spend money nobody was shown a number for.
   */
  readonly approved?: boolean;
  /** Defaults to {@link DEFAULT_CONCURRENCY}. */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly bake?: BakePlan;
  readonly onProgress?: (event: ProduceProgress) => void;
}

export interface ProducedAsset {
  readonly key: AssetKey;
  readonly semanticKey: string;
  readonly assetId: AssetId;
  readonly versionId: AssetVersionId;
  readonly lane: GenerationLane;
  readonly decomposition: DecompositionStrategy;
  readonly sourceImageHash: Sha256Hex;
  readonly matteImageHash: Sha256Hex;
  readonly matteEngine: string;
  readonly parts: readonly Part[];
  readonly plannedParts: number;
  readonly foundParts: number;
  readonly unfilled: readonly string[];
  readonly rig: Rig;
  readonly clips: readonly AnimationClip[];
  readonly sheets: readonly SheetRecord[];
  readonly scores: QualityScores | undefined;
  readonly degraded: readonly string[];
  /** Steps that were skipped because a checkpoint already covered these inputs. */
  readonly resumed: readonly ProduceStep[];
  readonly attempts: number;
  readonly costNanoUsd: NanoUsd;
  readonly durationMs: number;
}

export interface ReusedAsset {
  readonly key: AssetKey;
  readonly semanticKey: string;
  readonly assetId: AssetId | undefined;
  readonly versionId: AssetVersionId | undefined;
  readonly reason: string;
}

/** A take the gate refused. Not registered - and the money it cost is still counted. */
export interface RejectedAsset {
  readonly key: AssetKey;
  readonly semanticKey: string;
  readonly scores: QualityScores;
  readonly failures: readonly { readonly key: string; readonly score: number }[];
  readonly attempts: number;
  readonly costNanoUsd: NanoUsd;
}

export interface ProduceFailure {
  readonly key: AssetKey | undefined;
  readonly semanticKey: string;
  readonly step: ProduceStep | 'plan';
  readonly error: AppError;
  readonly costNanoUsd: NanoUsd;
}

export interface SkippedAsset {
  readonly key: AssetKey;
  readonly semanticKey: string;
  readonly reason: 'cancelled';
}

export interface StepTally {
  /** Times the step actually executed in this process. */
  readonly ran: number;
  /** Times a checkpoint made it unnecessary. */
  readonly resumed: number;
  readonly costNanoUsd: number;
  readonly durationMs: number;
}

export interface ProduceLedgerSummary {
  readonly estimatedNanoUsd: NanoUsd;
  /** Priced from real usage, this process only. Includes rejected takes. */
  readonly spentNanoUsd: NanoUsd;
  /** Carried forward from checkpoints written by an earlier process. */
  readonly resumedNanoUsd: NanoUsd;
  readonly byStep: Readonly<Record<ProduceStep, StepTally>>;
}

export type ProduceStatus = 'produced' | 'awaiting-approval' | 'cancelled';

export interface ProduceAssetsOutput {
  readonly status: ProduceStatus;
  readonly plan: AssetDemandPlan;
  readonly registered: readonly ProducedAsset[];
  readonly reused: readonly ReusedAsset[];
  readonly rejected: readonly RejectedAsset[];
  readonly failed: readonly ProduceFailure[];
  readonly skipped: readonly SkippedAsset[];
  readonly ledger: ProduceLedgerSummary;
  /** The stage's own checkpoint, for `PipelineRun.checkpoints`. */
  readonly checkpoint: StageCheckpoint;
}

/**
 * Two, because the local lane is one 6 GB card.
 *
 * Research §2 measured 1024² at 5839 MiB - 95 % of the card - so a second concurrent
 * generation at that size does not fit, and at 512² the sampler is already saturating
 * the SMs. Firing twelve at it is slower than firing two, and the CPU-side steps
 * (matte, split, bake) overlap with the GPU-side one at this width anyway.
 */
export const DEFAULT_CONCURRENCY = 2;

/** Baked by default. One clip, because a sheet is derived and rebuildable at any time. */
const DEFAULT_BAKE_CLIPS: readonly string[] = ['idle'];

type AssetSuccess =
  | { readonly kind: 'registered'; readonly asset: ProducedAsset }
  | { readonly kind: 'reused'; readonly asset: ReusedAsset }
  | { readonly kind: 'rejected'; readonly asset: RejectedAsset }
  | { readonly kind: 'skipped'; readonly asset: SkippedAsset };

interface StepRun<T> {
  readonly value: T;
  readonly outputs: readonly ArtifactRef[];
  readonly costNanoUsd?: number;
}

/** Everything one asset's steps need, threaded through instead of re-derived. */
interface AssetContext {
  readonly spec: AssetSpec;
  readonly resolution: AssetResolution;
  readonly key: AssetKey;
  readonly style: StyleBible;
  readonly runId: RunId;
  readonly binding: LaneBinding;
  readonly lane: GenerationLane;
  readonly decomposition: DecompositionStrategy;
  readonly variantKey: Slug | undefined;
  readonly signal: AbortSignal | undefined;
  readonly bake: BakePlan;
  readonly onProgress: ((event: ProduceProgress) => void) | undefined;
  readonly resumed: ProduceStep[];
  readonly outputs: ArtifactRef[];
  cost: number;
}

export class ProduceAssetsUseCase {
  readonly #deps: ProduceAssetsDeps;
  readonly #logger: Logger;
  readonly #generators: Map<GenerationLane, GenerateAssetVersionUseCase>;
  readonly #matte: MatteCanvasUseCase;
  readonly #split: SplitPartsUseCase;
  readonly #rig: FitRigUseCase;
  readonly #clips: DeriveClipsUseCase;
  readonly #sheets: BakeSheetUseCase;
  readonly #gate: QualityGateUseCase | undefined;
  readonly #thresholds: QualityThresholds;
  #tally: Record<ProduceStep, StepTally>;
  #spent = 0;
  #resumedSpend = 0;

  constructor(deps: ProduceAssetsDeps) {
    this.#deps = deps;
    this.#logger = deps.logger ?? new NoopLogger();
    this.#thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS;
    this.#tally = emptyTally();

    // One generator per lane, built once. `GenerateAssetVersionUseCase` takes its
    // image port at construction, and building it per call would rebuild the whole
    // dependency set forty times for no gain.
    this.#generators = new Map();
    for (const lane of GENERATION_LANES) {
      const binding = deps.lanes.byLane[lane];
      if (binding === undefined) continue;
      this.#generators.set(
        lane,
        new GenerateAssetVersionUseCase({
          resolver: deps.resolver satisfies DemandResolverPort,
          budget: deps.budget,
          images: binding.images,
          blobs: deps.blobs,
          ...(deps.ledger === undefined ? {} : { ledger: deps.ledger }),
          logger: this.#logger,
        }),
      );
    }

    this.#matte = new MatteCanvasUseCase({
      raster: deps.raster,
      matting: deps.matting,
      blobs: deps.blobs,
    });
    this.#split = new SplitPartsUseCase({ raster: deps.raster, blobs: deps.blobs, ids: deps.ids });
    this.#rig = new FitRigUseCase({ ids: deps.ids });
    this.#clips = new DeriveClipsUseCase({ blobs: deps.blobs, clock: deps.clock });
    this.#sheets = new BakeSheetUseCase({
      raster: deps.raster,
      blobs: deps.blobs,
      clock: deps.clock,
    });
    this.#gate =
      deps.vision === undefined
        ? undefined
        : new QualityGateUseCase({ vision: deps.vision, thresholds: this.#thresholds });
  }

  async execute(input: ProduceAssetsInput): Promise<Result<ProduceAssetsOutput, AppError>> {
    this.#tally = emptyTally();
    this.#spent = 0;
    this.#resumedSpend = 0;

    const planned = await this.#deps.resolver.execute({
      specs: input.specs,
      styleBibleId: input.style.id,
      styleChecksum: input.style.checksum,
      ...(input.variantKey === undefined ? {} : { variantKey: input.variantKey }),
      ...(input.budgetNanoUsd === undefined ? {} : { budgetNanoUsd: input.budgetNanoUsd }),
      ...(input.confirmationThresholdNanoUsd === undefined
        ? {}
        : { confirmationThresholdNanoUsd: input.confirmationThresholdNanoUsd }),
    });
    if (isErr(planned)) return planned;
    const plan = planned.value;

    // Nothing below this line may run before the estimate has been shown and the
    // ceiling checked. Both refusals return the plan, so the caller can render the
    // number that was refused rather than a bare error.
    if (plan.requiresConfirmation && input.approved !== true) {
      this.#logger.info('produce: waiting for approval of the estimate', {
        totalEstimatedNanoUsd: plan.totalEstimatedNanoUsd,
        misses: plan.missCount,
      });
      return ok(this.#empty('awaiting-approval', plan, input));
    }

    const guarded = this.#deps.budget.check({
      runId: input.runId,
      projectedNanoUsd: nanoUsd(plan.totalEstimatedNanoUsd),
    });
    if (isErr(guarded)) return guarded;

    const reused: ReusedAsset[] = [];
    const failed: ProduceFailure[] = [];
    const work: AssetResolution[] = [];

    for (const resolution of plan.resolutions) {
      if (resolution.outcome === 'cache-hit') {
        reused.push({
          key: resolution.key,
          semanticKey: resolution.spec.semanticKey,
          assetId: resolution.existingAssetId,
          versionId: resolution.existingVersionId,
          reason: resolution.reason ?? 'already in the library for this style',
        });
        continue;
      }
      if (resolution.outcome === 'blocked-by-budget') {
        failed.push({
          key: resolution.key,
          semanticKey: resolution.spec.semanticKey,
          step: 'plan',
          error: new ValidationError({
            message: 'blocked-by-budget',
            context: {
              semanticKey: resolution.spec.semanticKey,
              estimatedCostNanoUsd: resolution.estimatedCostNanoUsd,
            },
          }),
          costNanoUsd: ZERO_USD,
        });
        continue;
      }
      work.push(resolution);
    }

    const outcomes = await mapWithConcurrency(
      work,
      Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY),
      (resolution) => this.#produceOne(resolution, input),
    );

    const { values, errors } = partition(outcomes);
    failed.push(...errors);

    const registered: ProducedAsset[] = [];
    const rejected: RejectedAsset[] = [];
    const skipped: SkippedAsset[] = [];
    for (const success of values) {
      if (success.kind === 'registered') registered.push(success.asset);
      else if (success.kind === 'reused') reused.push(success.asset);
      else if (success.kind === 'rejected') rejected.push(success.asset);
      else skipped.push(success.asset);
    }

    const status: ProduceStatus =
      input.signal?.aborted === true || skipped.length > 0 ? 'cancelled' : 'produced';

    this.#logger.info('produce: finished', {
      status,
      registered: registered.length,
      reused: reused.length,
      rejected: rejected.length,
      failed: failed.length,
      skipped: skipped.length,
      spentNanoUsd: this.#spent,
    });

    return ok({
      status,
      plan,
      registered,
      reused,
      rejected,
      failed,
      skipped,
      ledger: this.#summary(plan),
      checkpoint: this.#stageCheckpoint(input, registered),
    });
  }

  // ── one asset ─────────────────────────────────────────────────────────────

  async #produceOne(
    resolution: AssetResolution,
    input: ProduceAssetsInput,
  ): Promise<Result<AssetSuccess, ProduceFailure>> {
    const spec = resolution.spec;
    const startedAt = this.#deps.clock.now();

    const lane = resolveLane(spec, this.#deps.lanes);
    if (isErr(lane)) {
      return err(this.#failure(resolution, 'generate', lane.error, 0));
    }

    const ctx: AssetContext = {
      spec,
      resolution,
      key: resolution.key,
      style: input.style,
      runId: input.runId,
      binding: lane.value.binding,
      lane: lane.value.lane,
      decomposition: lane.value.route.decomposition,
      variantKey: input.variantKey,
      signal: input.signal,
      bake: input.bake ?? {},
      onProgress: input.onProgress,
      resumed: [],
      outputs: [],
      cost: 0,
    };

    const produced = await this.#runChain(ctx);
    if (isErr(produced)) {
      return err(this.#failure(resolution, produced.error.step, produced.error.error, ctx.cost));
    }
    if (produced.value.kind !== 'registered') return ok(produced.value);

    return ok({
      kind: 'registered',
      asset: {
        ...produced.value.asset,
        durationMs: Math.max(0, this.#deps.clock.now() - startedAt),
      },
    });
  }

  /**
   * Everything after a take has been accepted: rig, clips, sheet, register.
   *
   * Split from the repair loop because the two have different shapes - the loop may
   * end four ways (a take, a cache hit, a rejection, a cancellation) and this only
   * ever ends two. Threading a `Take | undefined` through both would put an
   * unreachable "the loop ended without a take" branch in the middle of the chain.
   */
  async #runChain(ctx: AssetContext): Promise<Result<AssetSuccess, StepError>> {
    const accepted = await this.#acceptedTake(ctx);
    if (isErr(accepted)) return err(accepted.error);
    if (accepted.value.kind === 'other') return ok(accepted.value.success);
    const { take, score, attempts } = accepted.value;

    if (isCancelled(ctx)) return ok(skipped(ctx));
    const rig = await this.#rigStep(ctx, take);
    if (isErr(rig)) return err(rig.error);

    if (isCancelled(ctx)) return ok(skipped(ctx));
    const clips = await this.#clipsStep(ctx);
    if (isErr(clips)) return err(clips.error);

    if (isCancelled(ctx)) return ok(skipped(ctx));
    const sheets = await this.#bakeStep(ctx, take, clips.value);
    if (isErr(sheets)) return err(sheets.error);

    if (isCancelled(ctx)) return ok(skipped(ctx));
    const registered = await this.#registerStep(
      ctx,
      take,
      rig.value,
      clips.value,
      sheets.value,
      score,
    );
    if (isErr(registered)) return err(registered.error);

    return ok({
      kind: 'registered',
      asset: {
        key: ctx.key,
        semanticKey: ctx.spec.semanticKey,
        assetId: registered.value.assetId,
        versionId: registered.value.versionId,
        lane: ctx.lane,
        decomposition: take.split.decomposition,
        sourceImageHash: take.generate.imageHash,
        matteImageHash: take.matte.imageHash,
        matteEngine: take.matte.engine,
        parts: take.split.parts,
        plannedParts: take.split.plannedParts,
        foundParts: take.split.foundParts,
        unfilled: take.split.unfilled,
        rig: rig.value,
        clips: clips.value,
        sheets: sheets.value,
        scores: score?.scores,
        degraded: take.generate.degraded,
        resumed: [...ctx.resumed],
        attempts,
        costNanoUsd: nanoUsd(ctx.cost),
        durationMs: 0,
      },
    });
  }

  /**
   * generate → matte → split → score, repeated while the gate says to repair.
   *
   * Only these four repeat: a take that failed the gate must not be rigged, clipped or
   * baked, and those three are most of the work. The bound is the gate's own
   * `repairsRemaining`, so "how many retries" is configured in one place
   * (`QualityThresholds.maxRepairs`) rather than duplicated here.
   */
  async #acceptedTake(ctx: AssetContext): Promise<Result<TakeOutcome, StepError>> {
    const gate = this.#gate;
    let attempt = 0;
    let repairClause: string | undefined;

    for (;;) {
      if (isCancelled(ctx)) return ok(other(skipped(ctx)));

      const generated = await this.#generate(ctx, attempt, repairClause);
      if (isErr(generated)) return err(generated.error);
      if (generated.value.kind === 'cache-hit') {
        return ok(other({ kind: 'reused', asset: generated.value.reused }));
      }

      if (isCancelled(ctx)) return ok(other(skipped(ctx)));
      const matted = await this.#matteStep(ctx, attempt, generated.value.record);
      if (isErr(matted)) return err(matted.error);

      if (isCancelled(ctx)) return ok(other(skipped(ctx)));
      const split = await this.#splitStep(ctx, attempt, matted.value);
      if (isErr(split)) return err(split.error);

      const take: Take = {
        generate: generated.value.record,
        matte: matted.value.record,
        split: split.value.record,
      };
      if (gate === undefined) {
        return ok({ kind: 'take', take, score: undefined, attempts: attempt + 1 });
      }

      if (isCancelled(ctx)) return ok(other(skipped(ctx)));
      const scored = await this.#scoreStep(ctx, attempt, take, matted.value.image, gate);
      if (isErr(scored)) return err(scored.error);
      const score = scored.value;

      if (score.verdict === 'accepted') {
        return ok({ kind: 'take', take, score, attempts: attempt + 1 });
      }
      if (score.repairClause === undefined) {
        return ok(
          other({
            kind: 'rejected',
            asset: {
              key: ctx.key,
              semanticKey: ctx.spec.semanticKey,
              scores: score.scores,
              failures: score.failures,
              attempts: attempt + 1,
              costNanoUsd: nanoUsd(ctx.cost),
            },
          }),
        );
      }
      repairClause = score.repairClause;
      attempt += 1;
    }
  }

  // ── the steps ─────────────────────────────────────────────────────────────

  async #generate(
    ctx: AssetContext,
    attempt: number,
    repairClause: string | undefined,
  ): Promise<
    Result<
      { kind: 'generated'; record: GenerateRecord } | { kind: 'cache-hit'; reused: ReusedAsset },
      StepError
    >
  > {
    // `resolveLane` already refused an unbound lane, and both maps are built from the
    // same object - so a miss here is a programmer error, not a run-time situation.
    const generator = must(this.#generators, ctx.lane, 'image generator for lane');

    let cacheHit: ReusedAsset | undefined;
    const record = await this.#step(
      ctx,
      'generate',
      attempt,
      {
        specHash: contentHash(ctx.spec),
        styleChecksum: ctx.style.checksum,
        variantKey: ctx.variantKey ?? null,
        lane: ctx.lane,
        encoder: ctx.binding.promptEncoder ?? 'long',
        repairClause: repairClause ?? null,
      },
      GenerateRecord,
      async () => {
        const request: GenerateAssetVersionInput = {
          spec: ctx.spec,
          style: ctx.style,
          runId: ctx.runId,
          ...(ctx.variantKey === undefined ? {} : { variantKey: ctx.variantKey }),
          ...(this.#deps.lanes.policy === undefined ? {} : { policy: this.#deps.lanes.policy }),
          ...(repairClause === undefined ? {} : { repairClause }),
          ...(ctx.binding.promptEncoder === undefined
            ? {}
            : { encoder: ctx.binding.promptEncoder }),
          binding: { provider: ctx.binding.provider, model: ctx.binding.model },
          stage: 'produce',
          // A repair is a deliberate second spend on the same key, and the registry
          // must be told so rather than short-circuited past.
          ...(attempt === 0
            ? {}
            : { regenerate: { reason: `quality-gate repair attempt ${String(attempt)}` } }),
        };
        const generated = await generator.execute(request);
        if (isErr(generated)) return generated;

        if (generated.value.outcome === 'cache-hit') {
          cacheHit = {
            key: generated.value.key,
            semanticKey: ctx.spec.semanticKey,
            assetId: generated.value.assetId,
            versionId: generated.value.versionId,
            reason: 'the registry resolved this key to an existing version before generating',
          };
          return err(CACHE_HIT_SENTINEL);
        }

        const cost = this.#price(ctx.binding, generated.value.usage);
        const record: GenerateRecord = {
          imageHash: generated.value.imageHash,
          mimeType: generated.value.image.mimeType,
          lane: ctx.lane,
          decomposition: generated.value.request.route.decomposition,
          seed: generated.value.request.seed,
          promptHash: generated.value.request.promptHash,
          degraded: [...generated.value.degraded],
          costNanoUsd: cost,
        };
        const reference = await writeRecord(this.#deps.blobs, 'generate', record);
        if (isErr(reference)) return reference;
        return ok({
          value: record,
          outputs: [
            reference.value,
            {
              kind: 'asset-source-image',
              ref: record.imageHash,
              contentHash: record.imageHash,
            } satisfies ArtifactRef,
          ],
          costNanoUsd: cost,
        });
      },
    );

    if (isErr(record)) {
      if (cacheHit !== undefined) return ok({ kind: 'cache-hit', reused: cacheHit });
      return err(record.error);
    }
    return ok({ kind: 'generated', record: record.value });
  }

  async #matteStep(
    ctx: AssetContext,
    attempt: number,
    generate: GenerateRecord,
  ): Promise<Result<{ record: MatteRecord; image: RgbaImage }, StepError>> {
    const record = await this.#step(
      ctx,
      'matte',
      attempt,
      { sourceImageHash: generate.imageHash, engine: this.#deps.matting.engine },
      MatteRecord,
      async () => {
        const source = await this.#load(generate.imageHash, generate.mimeType);
        if (isErr(source)) return source;
        const matted = await this.#matte.execute({
          source: source.value,
          subject: ctx.spec.subjectClass,
          ...(ctx.binding.backgroundHint === undefined
            ? {}
            : { backgroundHint: ctx.binding.backgroundHint }),
        });
        if (isErr(matted)) return matted;
        // `store` is left at its default, so the hash is always present. Asserted
        // rather than branched on: a `Result` here would be a failure path no input
        // can reach.
        assertDefined(matted.value.imageHash, 'the stored matte hash');
        const record: MatteRecord = {
          imageHash: matted.value.imageHash,
          engine: matted.value.engine,
          fallbacks: matted.value.fallbacks.map((entry) => ({ ...entry })),
          coverage: matted.value.coverage,
          cleanliness: matted.value.cleanliness,
          cornersTransparent: matted.value.cornersTransparent,
        };
        const reference = await writeRecord(this.#deps.blobs, 'matte', record);
        if (isErr(reference)) return reference;
        return ok({
          value: record,
          outputs: [
            reference.value,
            {
              kind: 'asset-matte-image',
              ref: record.imageHash,
              contentHash: record.imageHash,
            } satisfies ArtifactRef,
          ],
        });
      },
    );
    if (isErr(record)) return err(record.error);

    const image = await this.#decode(record.value.imageHash);
    if (isErr(image)) return err({ step: 'matte', error: image.error });
    return ok({ record: record.value, image: image.value });
  }

  async #splitStep(
    ctx: AssetContext,
    attempt: number,
    matted: { record: MatteRecord; image: RgbaImage },
  ): Promise<Result<{ record: SplitRecord }, StepError>> {
    const record = await this.#step(
      ctx,
      'split',
      attempt,
      { matteImageHash: matted.record.imageHash, decomposition: ctx.decomposition },
      SplitRecord,
      async () => {
        const split = await this.#split.execute({
          spec: ctx.spec,
          image: matted.image,
          decomposition: ctx.decomposition,
        });
        if (isErr(split)) return split;
        const record: SplitRecord = {
          parts: [...split.value.parts],
          decomposition: split.value.decomposition,
          plannedParts: ctx.spec.parts.length,
          foundParts: split.value.parts.length,
          unmatchedComponents: split.value.report.unmatched.length,
          discardedComponents: split.value.discardedComponents,
          unfilled: split.value.report.unfilled.map((plan) => plan.name),
          complete: split.value.report.complete,
        };
        const reference = await writeRecord(this.#deps.blobs, 'split', record);
        if (isErr(reference)) return reference;
        return ok({
          value: record,
          outputs: [
            reference.value,
            ...record.parts.map((part): ArtifactRef => ({
              kind: 'asset-part',
              ref: part.name,
              contentHash: part.imageHash,
            })),
          ],
        });
      },
    );
    if (isErr(record)) return err(record.error);
    return ok({ record: record.value });
  }

  async #scoreStep(
    ctx: AssetContext,
    attempt: number,
    take: Take,
    matteImage: RgbaImage,
    gate: QualityGateUseCase,
  ): Promise<Result<ScoreRecord, StepError>> {
    const record = await this.#step(
      ctx,
      'score',
      attempt,
      { matteImageHash: take.matte.imageHash, partsComplete: take.split.complete },
      ScoreRecord,
      async () => {
        const encoded = this.#deps.raster.encode(matteImage);
        if (isErr(encoded)) return encoded;
        const scored = await gate.execute({
          spec: ctx.spec,
          style: ctx.style,
          attempt: {
            image: { mimeType: encoded.value.mimeType, data: encoded.value.data },
            measured: {
              alphaCleanliness: take.matte.cleanliness,
              // Measured, not asked of the model: the splitter counted the parts, and
              // a vision model's opinion about completeness is strictly worse. The
              // divisor cannot be zero - `AssetSpec.parts` is `min(1)`.
              partCompleteness: take.split.foundParts / take.split.plannedParts,
            },
          },
          repairsSoFar: attempt,
        });
        if (isErr(scored)) return scored;
        this.#meterVision(ctx);
        const record: ScoreRecord = {
          verdict: scored.value.verdict,
          scores: scored.value.scores,
          failures: scored.value.failures.map((failure) => ({ ...failure })),
          ...(scored.value.repairClause === undefined
            ? {}
            : { repairClause: scored.value.repairClause }),
          repairsRemaining: scored.value.repairsRemaining,
        };
        const reference = await writeRecord(this.#deps.blobs, 'score', record);
        if (isErr(reference)) return reference;
        return ok({ value: record, outputs: [reference.value] });
      },
    );
    if (isErr(record)) return err(record.error);
    return ok(record.value);
  }

  async #rigStep(ctx: AssetContext, take: Take): Promise<Result<Rig, StepError>> {
    const record = await this.#step(
      ctx,
      'rig',
      0,
      { parts: take.split.parts.map((part) => `${part.role}:${part.imageHash}`).sort() },
      RigRecord,
      async () => {
        const fitted = this.#rig.execute({
          spec: ctx.spec,
          parts: take.split.parts,
          // The single-layer fallback of RV-125 produces one part for a multi-part
          // plan, and refusing to rig it would throw away the asset the fallback exists
          // to save. Anything else must have every required part.
          allowMissingParts: take.split.decomposition === 'single-layer',
        });
        if (isErr(fitted)) return fitted;
        const record: RigRecord = { rig: fitted.value };
        const reference = await writeRecord(this.#deps.blobs, 'rig', record);
        if (isErr(reference)) return reference;
        return ok({
          value: record,
          outputs: [
            reference.value,
            { kind: 'asset-rig', ref: fitted.value.id, contentHash: null } satisfies ArtifactRef,
          ],
        });
      },
    );
    if (isErr(record)) return err(record.error);
    return ok(record.value.rig);
  }

  async #clipsStep(ctx: AssetContext): Promise<Result<readonly AnimationClip[], StepError>> {
    const record = await this.#step(
      ctx,
      'clips',
      0,
      { archetype: ctx.spec.archetype, styleChecksum: ctx.style.checksum },
      ClipsRecord,
      async () => {
        const derived = await this.#clips.execute({ spec: ctx.spec, style: ctx.style });
        if (isErr(derived)) return derived;
        const record: ClipsRecord = { clips: derived.value.clips.map((entry) => entry.clip) };
        const reference = await writeRecord(this.#deps.blobs, 'clips', record);
        if (isErr(reference)) return reference;
        return ok({
          value: record,
          outputs: [
            reference.value,
            ...record.clips.map((clip): ArtifactRef => ({
              kind: 'animation-ir',
              ref: clip.name,
              contentHash: clip.irHash,
            })),
          ],
        });
      },
    );
    if (isErr(record)) return err(record.error);
    return ok(record.value.clips);
  }

  async #bakeStep(
    ctx: AssetContext,
    take: Take,
    clips: readonly AnimationClip[],
  ): Promise<Result<readonly SheetRecord[], StepError>> {
    const wanted = this.#clipsToBake(ctx, clips);
    const record = await this.#step(
      ctx,
      'bake',
      0,
      {
        clips: wanted.map((clip) => `${clip.name}:${clip.irHash}`),
        parts: take.split.parts.map((part) => part.imageHash).sort(),
        settings: ctx.bake.settings ?? null,
      },
      BakeRecord,
      async () => {
        if (wanted.length === 0) {
          const record: BakeRecord = { sheets: [] };
          const reference = await writeRecord(this.#deps.blobs, 'bake', record);
          if (isErr(reference)) return reference;
          return ok({ value: record, outputs: [reference.value] });
        }

        const images = await this.#loadPartImages(take.split.parts);
        if (isErr(images)) return images;

        const sheets: SheetRecord[] = [];
        const outputs: ArtifactRef[] = [];
        for (const clip of wanted) {
          const ir = await this.#loadIr(clip.irHash);
          if (isErr(ir)) return ir;
          const baked = await this.#sheets.execute({
            clip,
            ir: ir.value,
            parts: take.split.parts,
            images: images.value,
            canvas: ctx.spec.canvas,
            motion: ctx.style.motion,
            ...(ctx.bake.settings === undefined ? {} : { settings: ctx.bake.settings }),
          });
          if (isErr(baked)) return baked;
          for (const page of baked.value.pages) {
            sheets.push({
              id: page.id,
              clipId: clip.id,
              clipName: clip.name,
              atlasImageHash: page.atlasImageHash,
              atlasJsonHash: page.atlasJsonHash,
              frameCount: page.frameCount,
              fps: page.fps,
              atlasSize: page.atlasSize,
            });
            outputs.push({
              kind: 'sprite-sheet',
              ref: `${clip.name}:${page.id}`,
              contentHash: page.atlasImageHash,
            });
          }
        }
        const record: BakeRecord = { sheets };
        const reference = await writeRecord(this.#deps.blobs, 'bake', record);
        if (isErr(reference)) return reference;
        return ok({ value: record, outputs: [reference.value, ...outputs] });
      },
    );
    if (isErr(record)) return err(record.error);
    return ok(record.value.sheets);
  }

  async #registerStep(
    ctx: AssetContext,
    take: Take,
    rig: Rig,
    clips: readonly AnimationClip[],
    sheets: readonly SheetRecord[],
    score: ScoreRecord | undefined,
  ): Promise<Result<RegisterRecord, StepError>> {
    const sheetByClip = new Map(sheets.map((sheet) => [sheet.clipId, sheet.id]));
    const record = await this.#step(
      ctx,
      'register',
      0,
      {
        rigId: rig.id,
        parts: take.split.parts.map((part) => part.imageHash).sort(),
        clips: clips.map((clip) => clip.irHash).sort(),
        sheets: sheets.map((sheet) => sheet.atlasImageHash).sort(),
      },
      RegisterRecord,
      async () => {
        const version: NewAssetVersion = {
          id: this.#deps.ids.assetVersion(),
          status: 'ready',
          styleBibleId: ctx.style.id,
          styleChecksum: ctx.style.checksum,
          parts: [...take.split.parts],
          rig,
          variants: [],
          clips: clips.map((clip) => {
            const sheetId = sheetByClip.get(clip.id);
            return sheetId === undefined ? clip : { ...clip, bakedSheetId: sheetId };
          }),
          canvas: ctx.spec.canvas,
          nominalHeight: ctx.spec.nominalHeight,
          previewImageHash: take.matte.imageHash,
          quality: ctx.spec.quality,
          ...(score === undefined ? {} : { scores: score.scores }),
          provenance: {
            source: 'image-model',
            model: `${ctx.binding.provider}:${ctx.binding.model}`,
            promptHash: take.generate.promptHash,
            seed: take.generate.seed,
            parents: [ctx.style.checksum, take.generate.imageHash],
            createdAt: toIso(this.#deps.clock.now()),
            costNanoUsd: ctx.cost,
          },
        };

        const registered = await this.#deps.registrar.execute({
          spec: ctx.spec,
          styleBibleId: ctx.style.id,
          styleChecksum: ctx.style.checksum,
          ...(ctx.variantKey === undefined ? {} : { variantKey: ctx.variantKey }),
          version,
        });
        if (isErr(registered)) return registered;

        const record: RegisterRecord = {
          assetId: registered.value.asset.id,
          versionId: registered.value.version.id,
          createdAsset: registered.value.createdAsset,
        };
        const reference = await writeRecord(this.#deps.blobs, 'register', record);
        if (isErr(reference)) return reference;
        return ok({
          value: record,
          outputs: [
            reference.value,
            {
              kind: 'asset-version',
              ref: record.versionId,
              contentHash: null,
            } satisfies ArtifactRef,
          ],
        });
      },
    );
    if (isErr(record)) return err(record.error);
    return ok(record.value);
  }

  // ── the resume/run seam ───────────────────────────────────────────────────

  /**
   * Runs a step, or proves it does not need running.
   *
   * The order is the point. The hash is computed from the step's declared inputs
   * *before* anything is read, the stored checkpoint is compared against it, and only
   * a match skips - so "already ran" never stands in for "already ran on this". A
   * checkpoint whose record has gone missing from the store falls through to a re-run
   * rather than failing, because a missing blob is a recoverable situation and a
   * half-resumed asset is not.
   */
  async #step<T>(
    ctx: AssetContext,
    step: ProduceStep,
    attempt: number,
    inputs: unknown,
    schema: z.ZodType<T>,
    run: () => Promise<Result<StepRun<T>, AppError>>,
  ): Promise<Result<T, StepError>> {
    const startedAt = this.#deps.clock.now();
    const inputHash = stepInputHash(step, ctx.key, attempt, inputs);
    const store = this.#deps.checkpoints;

    if (store !== undefined) {
      const found = await store.read({ runId: ctx.runId, assetKey: ctx.key, step, attempt });
      if (isErr(found)) return err({ step, error: found.error });
      const checkpoint = found.value;
      if (checkpoint !== null && checkpoint.inputHash === inputHash) {
        const record = await readRecord(this.#deps.blobs, step, checkpoint.outputs, schema);
        if (record !== null) {
          ctx.resumed.push(step);
          ctx.outputs.push(...checkpoint.outputs);
          ctx.cost += checkpoint.costNanoUsd;
          this.#resumedSpend += checkpoint.costNanoUsd;
          this.#count(step, 'resumed', checkpoint.costNanoUsd, 0);
          this.#report(ctx, step, attempt, 'resumed', startedAt, undefined);
          return ok(record);
        }
        this.#logger.warn('produce: checkpoint matched but its record is gone; re-running', {
          step,
          semanticKey: ctx.spec.semanticKey,
        });
      }
    }

    const outcome = await run();
    if (isErr(outcome)) {
      // A cache hit is not a failed step - it is the step deciding there is nothing to
      // do - so it is neither tallied nor reported. See {@link CACHE_HIT_SENTINEL}.
      if (outcome.error !== CACHE_HIT_SENTINEL) {
        this.#count(step, 'ran', 0, this.#deps.clock.now() - startedAt);
        this.#report(ctx, step, attempt, 'failed', startedAt, outcome.error.code);
      }
      return err({ step, error: outcome.error });
    }

    const cost = outcome.value.costNanoUsd ?? 0;
    ctx.cost += cost;
    ctx.outputs.push(...outcome.value.outputs);
    this.#spent += cost;
    this.#count(step, 'ran', cost, this.#deps.clock.now() - startedAt);

    if (store !== undefined) {
      const written = await store.write(
        { runId: ctx.runId, assetKey: ctx.key, step, attempt },
        stageCheckpoint(this.#deps.clock, inputHash, {
          outputs: outcome.value.outputs,
          costNanoUsd: cost,
        }),
      );
      // A checkpoint that could not be written costs a re-run next time and nothing
      // else. Failing the asset over it would be strictly worse.
      if (isErr(written)) {
        this.#logger.warn('produce: could not write a checkpoint', {
          step,
          code: written.error.code,
        });
      }
    }

    this.#report(ctx, step, attempt, 'ran', startedAt, undefined);
    return ok(outcome.value.value);
  }

  // ── small helpers ─────────────────────────────────────────────────────────

  #clipsToBake(ctx: AssetContext, clips: readonly AnimationClip[]): readonly AnimationClip[] {
    const wanted = ctx.bake.clips ?? DEFAULT_BAKE_CLIPS;
    if (wanted === 'all') return clips;
    const names = new Set(wanted);
    return clips.filter((clip) => names.has(clip.name));
  }

  async #load(hash: Sha256Hex, mimeType: string): Promise<Result<EncodedImage, AppError>> {
    const bytes = await this.#deps.blobs.get(hash);
    if (isErr(bytes)) return bytes;
    return ok({ mimeType, data: bytes.value });
  }

  async #decode(hash: Sha256Hex): Promise<Result<RgbaImage, AppError>> {
    const bytes = await this.#deps.blobs.get(hash);
    if (isErr(bytes)) return bytes;
    return this.#deps.raster.decode({ mimeType: 'image/png', data: bytes.value });
  }

  async #loadPartImages(
    parts: readonly Part[],
  ): Promise<Result<ReadonlyMap<Sha256Hex, RgbaImage>, AppError>> {
    const images = new Map<Sha256Hex, RgbaImage>();
    for (const part of parts) {
      if (images.has(part.imageHash)) continue;
      const decoded = await this.#decode(part.imageHash);
      if (isErr(decoded)) return decoded;
      images.set(part.imageHash, decoded.value);
    }
    return ok(images);
  }

  /** The IR fragment a clip points at, read back from the store it was written to. */
  async #loadIr(hash: Sha256Hex): Promise<Result<AnimationIR, AppError>> {
    const bytes = await this.#deps.blobs.get(hash);
    if (isErr(bytes)) return bytes;
    try {
      return ok(JSON.parse(new TextDecoder().decode(bytes.value)) as AnimationIR);
    } catch (caught) {
      return err(
        new ValidationError({
          message: 'the stored animation IR is not readable JSON',
          context: { irHash: hash },
          cause: caught,
        }),
      );
    }
  }

  #price(binding: LaneBinding, usage: ProviderUsage): number {
    const pricer = this.#deps.pricer;
    if (pricer === undefined) return 0;
    return pricer.price(binding.provider, binding.model, usage);
  }

  #meterVision(ctx: AssetContext): void {
    const ledger = this.#deps.ledger;
    const binding = this.#deps.visionBinding;
    if (ledger === undefined || binding === undefined) return;
    ledger.record({
      runId: ctx.runId,
      stage: 'produce',
      provider: binding.provider,
      model: binding.model,
      task: 'vision-score',
      tier: ctx.spec.quality,
      usage: {
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: 1, resolution: ctx.spec.canvas },
        latencyMs: 0,
      },
      outcome: 'success',
    });
  }

  #count(step: ProduceStep, which: 'ran' | 'resumed', cost: number, durationMs: number): void {
    const previous = this.#tally[step];
    this.#tally = {
      ...this.#tally,
      [step]: {
        ran: previous.ran + (which === 'ran' ? 1 : 0),
        resumed: previous.resumed + (which === 'resumed' ? 1 : 0),
        costNanoUsd: previous.costNanoUsd + cost,
        durationMs: previous.durationMs + Math.max(0, durationMs),
      },
    };
  }

  #report(
    ctx: AssetContext,
    step: ProduceStep,
    attempt: number,
    phase: ProduceProgress['phase'],
    startedAt: number,
    detail: string | undefined,
  ): void {
    ctx.onProgress?.({
      semanticKey: ctx.spec.semanticKey,
      step,
      attempt,
      phase,
      durationMs: Math.max(0, this.#deps.clock.now() - startedAt),
      detail,
    });
  }

  #failure(
    resolution: AssetResolution,
    step: ProduceStep | 'plan',
    error: AppError,
    cost: number,
  ): ProduceFailure {
    this.#logger.warn('produce: asset failed', {
      semanticKey: resolution.spec.semanticKey,
      step,
      code: error.code,
    });
    return {
      key: resolution.key,
      semanticKey: resolution.spec.semanticKey,
      step,
      error,
      costNanoUsd: nanoUsd(cost),
    };
  }

  #summary(plan: AssetDemandPlan): ProduceLedgerSummary {
    return {
      estimatedNanoUsd: nanoUsd(plan.totalEstimatedNanoUsd),
      spentNanoUsd: nanoUsd(this.#spent),
      resumedNanoUsd: nanoUsd(this.#resumedSpend),
      byStep: this.#tally,
    };
  }

  #empty(
    status: ProduceStatus,
    plan: AssetDemandPlan,
    input: ProduceAssetsInput,
  ): ProduceAssetsOutput {
    return {
      status,
      plan,
      registered: [],
      reused: [],
      rejected: [],
      failed: [],
      skipped: [],
      ledger: this.#summary(plan),
      checkpoint: this.#stageCheckpoint(input, []),
    };
  }

  /**
   * The single checkpoint the *run* carries for this stage.
   *
   * Its `inputHash` covers the specs and the style checksum rather than the per-asset
   * steps, because that is the question a run asks: has S6 already run on this world
   * and this style? The per-asset rows answer the finer question and are keyed
   * separately, since `PipelineRun.checkpoints` allows exactly one entry per stage.
   */
  #stageCheckpoint(
    input: ProduceAssetsInput,
    registered: readonly ProducedAsset[],
  ): StageCheckpoint {
    return produceStageCheckpoint({
      clock: this.#deps.clock,
      specHashes: input.specs.map((spec) => contentHash(spec)),
      styleChecksum: input.style.checksum,
      variantKey: input.variantKey,
      outputs: registered.map((asset): ArtifactRef => ({
        kind: 'asset-version',
        ref: asset.versionId,
        contentHash: asset.matteImageHash,
      })),
      costNanoUsd: this.#spent + this.#resumedSpend,
    });
  }
}

// ── module-private helpers ──────────────────────────────────────────────────

interface Take {
  readonly generate: GenerateRecord;
  readonly matte: MatteRecord;
  readonly split: SplitRecord;
}

/**
 * How the repair loop ended: with a take to finish, or with the asset's whole answer.
 *
 * The second case covers a cache hit, a rejection and a cancellation - three outcomes
 * that all mean "nothing further happens to this asset" and none of which are errors.
 */
type TakeOutcome =
  | {
      readonly kind: 'take';
      readonly take: Take;
      readonly score: ScoreRecord | undefined;
      readonly attempts: number;
    }
  | { readonly kind: 'other'; readonly success: AssetSuccess };

function other(success: AssetSuccess): TakeOutcome {
  return { kind: 'other', success };
}

interface StepError {
  readonly step: ProduceStep;
  readonly error: AppError;
}

/**
 * A cache hit unwinding the generate step, expressed as an error the caller swallows.
 *
 * Not a failure: `#step` has one success channel and the hit is not a step result, so
 * it leaves through the error channel and is converted back immediately. The
 * alternative - a three-way return type threaded through every step - would complicate
 * seven call sites to simplify one.
 */
const CACHE_HIT_SENTINEL = new ValidationError({ message: 'cache-hit' });

function isCancelled(ctx: AssetContext): boolean {
  return ctx.signal?.aborted === true;
}

function skipped(ctx: AssetContext): AssetSuccess {
  return {
    kind: 'skipped',
    asset: { key: ctx.key, semanticKey: ctx.spec.semanticKey, reason: 'cancelled' },
  };
}

function emptyTally(): Record<ProduceStep, StepTally> {
  return Object.fromEntries(
    PRODUCE_STEPS.map((step) => [step, { ran: 0, resumed: 0, costNanoUsd: 0, durationMs: 0 }]),
  ) as Record<ProduceStep, StepTally>;
}

/**
 * A fixed pool of workers pulling from one cursor.
 *
 * Not `Promise.all` over chunks: a chunked run waits for the slowest member of each
 * chunk before starting the next, which on a queue of forty assets with one slow
 * generation idles the GPU repeatedly. Results are collected with their index and
 * re-ordered afterwards so the output order matches the input regardless of who
 * finished first.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const collected: { index: number; value: R }[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      collected.push({ index, value: await run(at(items, index, 'work item')) });
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return collected.sort((left, right) => left.index - right.index).map((entry) => entry.value);
}
