/**
 * The only place in this package that spends money.
 *
 * Three things happen in a fixed order, and the order is the whole design:
 *
 *  1. **Resolve through the registry.** `@rv/asset-registry` owns "no asset is
 *     generated twice" (CLAUDE.md #2) - the dedup key, the version log, the refusal to
 *     overwrite. This use-case calls it; it does not re-derive a key of its own. A hit
 *     returns immediately, having written nothing and, crucially, having touched no
 *     provider: the test for that asserts the fake image port received **zero** calls,
 *     because "we didn't spend anything" is only true if no call was made.
 *  2. **Check the budget.** CLAUDE.md #3: the guard runs *before* the call. A check
 *     afterwards is a receipt.
 *  3. **Generate**, with the style anchors and identity anchors attached as reference
 *     images. Research §2/§3: Gemini image models are `text+image -> text+image`, and
 *     multi-reference conditioning is what buys character consistency without training
 *     a LoRA. When a reference cannot be loaded the run says so in `degraded` rather
 *     than quietly producing a different-looking character.
 */

import {
  type AppError,
  type BudgetExceededError,
  InternalError,
  type Logger,
  NoopLogger,
  type NanoUsd,
  ProviderError,
  type Result,
  type Unit,
  ZERO_USD,
  err,
  isErr,
  ok,
} from '@rv/shared-kernel';
import type {
  AssetDemandPlan,
  AssetId,
  AssetKey,
  AssetReference,
  AssetResolution,
  AssetSpec,
  AssetVersionId,
  PipelineStageKey,
  ProviderKind,
  QualityTier,
  RunId,
  Sha256Hex,
  Slug,
  StyleBible,
} from '@rv/contracts';
import type { BlobStore } from '@rv/asset-registry';
import type {
  ImageArtifact,
  ImageGenerationPort,
  ImagePayload,
  ProviderUsage,
} from '@rv/providers';

import {
  type DecompositionPolicy,
  DEFAULT_DECOMPOSITION_POLICY,
  routeSubject,
} from './decomposition-policy';
import {
  type ComposedRequest,
  type PromptEncoder,
  composeGenerationRequest,
} from './request-composer';

/**
 * The budget guard, as this use-case needs it.
 *
 * A structural subset rather than the class, so a test can refuse a spend in three
 * lines and so this package does not construct a `BudgetPolicy` it has no opinion
 * about. `BudgetGuard` from `@rv/providers` satisfies it as written.
 */
export interface BudgetCheckPort {
  check(request: {
    readonly runId: RunId;
    readonly projectedNanoUsd: NanoUsd;
  }): Result<Unit, BudgetExceededError>;
}

/** The ledger, as this use-case needs it. `CostMeter` satisfies it as written. */
export interface CallLedgerPort {
  record(input: {
    readonly runId: RunId;
    readonly stage: PipelineStageKey;
    readonly provider: ProviderKind;
    readonly model: string;
    readonly task: 'image-draft' | 'image-final';
    readonly tier: QualityTier;
    readonly usage: ProviderUsage;
    readonly outcome: 'success' | 'failure';
    readonly cacheHit?: boolean;
  }): unknown;
}

/** The registry's demand planner, as this use-case needs it. */
export interface DemandResolverPort {
  execute(input: {
    readonly specs: readonly AssetSpec[];
    readonly styleBibleId: StyleBible['id'];
    readonly styleChecksum: Sha256Hex;
    readonly variantKey?: Slug;
  }): Promise<Result<AssetDemandPlan, AppError>>;
}

export interface GenerateAssetVersionDeps {
  readonly resolver: DemandResolverPort;
  readonly budget: BudgetCheckPort;
  readonly images: ImageGenerationPort;
  readonly blobs: BlobStore;
  readonly ledger?: CallLedgerPort;
  readonly logger?: Logger;
}

export interface GenerateAssetVersionInput {
  readonly spec: AssetSpec;
  readonly style: StyleBible;
  readonly runId: RunId;
  readonly variantKey?: Slug;
  readonly policy?: DecompositionPolicy;
  /** Identity turnarounds and style anchors the caller resolved. */
  readonly extraReferences?: readonly AssetReference[];
  /** The quality gate's repair channel. Appended verbatim to the prompt. */
  readonly repairClause?: string;
  /**
   * Forces a generation past a cache hit.
   *
   * Deliberately a whole object rather than a boolean: `RegenerateIntent` carries the
   * reason and is what `RegisterAssetVersionUseCase` will demand at the far end, so a
   * caller that can produce one has already decided it is spending money on purpose.
   */
  readonly regenerate?: { readonly reason: string };
  /** Which model the router picked. Only needed to write a ledger row. */
  readonly binding?: { readonly provider: ProviderKind; readonly model: string };
  /**
   * The text encoder the chosen model actually has.
   *
   * Passed through to the composer, which reorders and trims for `clip-77`. Absent
   * means `long`, which is the shape every caller had before lanes existed.
   */
  readonly encoder?: PromptEncoder;
  readonly stage?: PipelineStageKey;
}

export interface CacheHitOutcome {
  readonly outcome: 'cache-hit';
  readonly key: AssetKey;
  readonly assetId: AssetId | undefined;
  readonly versionId: AssetVersionId | undefined;
  readonly costNanoUsd: NanoUsd;
}

export interface GeneratedOutcome {
  readonly outcome: 'generated';
  readonly key: AssetKey;
  readonly image: ImageArtifact;
  readonly imageHash: Sha256Hex;
  readonly request: ComposedRequest;
  readonly usage: ProviderUsage;
  /**
   * What the run could not do that it was asked to do.
   *
   * Non-empty means the asset was produced in a degraded mode - a missing identity
   * anchor, a provider that ignored references. RV-121 requires this to be explicit in
   * the result metadata rather than inferred later from a drifting face.
   */
  readonly degraded: readonly string[];
}

export type GenerateAssetVersionOutput = CacheHitOutcome | GeneratedOutcome;

export class GenerateAssetVersionUseCase {
  readonly #deps: GenerateAssetVersionDeps;

  constructor(deps: GenerateAssetVersionDeps) {
    this.#deps = deps;
  }

  async execute(
    input: GenerateAssetVersionInput,
  ): Promise<Result<GenerateAssetVersionOutput, AppError>> {
    const logger = this.#deps.logger ?? new NoopLogger();

    const planned = await this.#deps.resolver.execute({
      specs: [input.spec],
      styleBibleId: input.style.id,
      styleChecksum: input.style.checksum,
      ...(input.variantKey === undefined ? {} : { variantKey: input.variantKey }),
    });
    if (isErr(planned)) return planned;

    const resolution = planned.value.resolutions[0];
    if (resolution === undefined) {
      return err(
        new InternalError({
          message: 'the registry planned zero resolutions for one spec',
          context: { semanticKey: input.spec.semanticKey },
        }),
      );
    }

    if (resolution.outcome === 'cache-hit' && input.regenerate === undefined) {
      logger.debug('asset-engine: cache hit, spending nothing', {
        semanticKey: input.spec.semanticKey,
        key: resolution.key,
      });
      return ok(cacheHit(resolution));
    }

    const route = routeSubject(input.spec, input.policy ?? DEFAULT_DECOMPOSITION_POLICY);
    const composed = composeGenerationRequest({
      spec: input.spec,
      style: input.style,
      route,
      ...(input.extraReferences === undefined ? {} : { extraReferences: input.extraReferences }),
      ...(input.repairClause === undefined ? {} : { repairClause: input.repairClause }),
      ...(input.encoder === undefined ? {} : { encoder: input.encoder }),
    });
    if (isErr(composed)) return composed;

    const guarded = this.#deps.budget.check({
      runId: input.runId,
      projectedNanoUsd: resolution.estimatedCostNanoUsd as NanoUsd,
    });
    if (isErr(guarded)) return guarded;

    const loaded = await this.#loadReferences(composed.value.references);

    const generated = await this.#deps.images.generateImage({
      prompt: composed.value.prompt,
      negativePrompt: composed.value.negativePrompt,
      size: composed.value.size,
      seed: composed.value.seed,
      count: 1,
      references: loaded.payloads,
    });

    if (isErr(generated)) {
      this.#meter(input, failureUsage(), 'failure');
      return generated;
    }

    const image = generated.value.images[0];
    if (image === undefined) {
      this.#meter(input, generated.value.usage, 'failure');
      return err(
        new ProviderError({
          message: 'image provider returned no images',
          provider: generated.value.modelRef,
          retryable: true,
        }),
      );
    }

    const stored = await this.#deps.blobs.put(image.data);
    if (isErr(stored)) return stored;

    this.#meter(input, generated.value.usage, 'success');

    return ok({
      outcome: 'generated',
      key: resolution.key,
      image,
      imageHash: stored.value.hash,
      request: composed.value,
      usage: generated.value.usage,
      degraded: loaded.degraded,
    });
  }

  /**
   * Loads reference bytes, reporting what it could not load rather than throwing.
   *
   * A missing anchor is a real, recoverable situation - the blob may not have been
   * synced yet - and the right response is to generate anyway and mark the result
   * degraded. Failing the whole run would be worse; silently dropping it would be much
   * worse.
   */
  async #loadReferences(
    references: readonly AssetReference[],
  ): Promise<{ payloads: ImagePayload[]; degraded: string[] }> {
    const payloads: ImagePayload[] = [];
    const degraded: string[] = [];

    for (const reference of references) {
      const bytes = await this.#deps.blobs.get(reference.imageHash);
      if (isErr(bytes)) {
        degraded.push(`missing ${reference.role} ${reference.imageHash.slice(0, 12)}`);
        continue;
      }
      payloads.push({ mimeType: 'image/png', data: bytes.value });
    }

    return { payloads, degraded };
  }

  #meter(
    input: GenerateAssetVersionInput,
    usage: ProviderUsage,
    outcome: 'success' | 'failure',
  ): void {
    const ledger = this.#deps.ledger;
    const binding = input.binding;
    if (ledger === undefined || binding === undefined) return;
    ledger.record({
      runId: input.runId,
      stage: input.stage ?? 'produce',
      provider: binding.provider,
      model: binding.model,
      task: input.spec.quality === 'final' ? 'image-final' : 'image-draft',
      tier: input.spec.quality,
      usage,
      outcome,
    });
  }
}

function cacheHit(resolution: AssetResolution): CacheHitOutcome {
  return {
    outcome: 'cache-hit',
    key: resolution.key,
    assetId: resolution.existingAssetId,
    versionId: resolution.existingVersionId,
    costNanoUsd: ZERO_USD,
  };
}

/** A call that never reached the provider still consumed nothing but must be recorded. */
function failureUsage(): ProviderUsage {
  return {
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    images: { count: 0, resolution: null },
    latencyMs: 0,
  };
}
