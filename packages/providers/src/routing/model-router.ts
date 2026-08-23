/**
 * The cost/quality brain: `(task, tier, policy)` in, an ordered chain of models out.
 *
 * Four responsibilities, in the order they are applied, because the order *is* the
 * policy:
 *
 *  1. **A user's per-stage pin wins.** "The story model is selectable" is the owner's
 *     stated requirement, generalised by architecture §5 to every stage - only the
 *     author can decide that S3 Cast needs the strong cloud model and S6 Produce does
 *     not. A `pinned` override fails rather than quietly running somewhere else.
 *  2. **The capability matrix filters.** A model that cannot do the job never enters
 *     the chain, so `UnsupportedCapabilityError` comes back *before* any network call.
 *  3. **The policy orders what is left.** `cheapest` by estimated nano-dollars,
 *     `best` by the reverse, `balanced` free-first then cheapest.
 *  4. **`execute` walks the chain**, retrying in place while `AppError.retryable` says
 *     it is worth it and failing over when the error kind is in `failoverOn`.
 *
 * There is no `switch` on a provider name anywhere in this file. Provider-specific
 * behaviour lives in the adapter; the router only ever sees capabilities and prices.
 */

import type {
  Capability,
  FailoverPolicy,
  ModelBinding,
  ModelDescriptor,
  PipelineStageKey,
  QualityTier,
  RouterConfig,
  RoutingPolicy,
  TaskKind,
} from '@rv/contracts';
import { KNOWN_MODELS, modelRef } from '@rv/contracts';
import {
  type AppError,
  type Logger,
  NoopLogger,
  type Result,
  type Rng,
  UnsupportedCapabilityError,
  err,
  isErr,
  ok,
} from '@rv/shared-kernel';

import type { CapabilityMatrix } from '../ports/capability-matrix';
import { priceCall } from '../cost/pricing';
import { withRetry } from './retry';
import { capabilityForTask } from './task-capability';

export interface RouteRequest {
  readonly task: TaskKind;
  readonly tier: QualityTier;
  /** Falls back to `RouterConfig.defaultPolicy`. */
  readonly policy?: RoutingPolicy;
  /** Enables the per-stage override. Absent means "not on behalf of a stage". */
  readonly stage?: PipelineStageKey;
}

/** Where the chain came from. Recorded so a surprising route can be explained. */
export type RouteSource = 'stage-override' | 'task-override' | 'rule' | 'catalogue';

export interface ResolvedRoute {
  readonly task: TaskKind;
  readonly tier: QualityTier;
  readonly policy: RoutingPolicy;
  readonly capability: Capability;
  readonly source: RouteSource;
  /** Non-empty and already filtered by capability. `chain[0]` is the primary. */
  readonly chain: readonly ModelBinding[];
}

/** One link that was tried and failed, for the failover record. */
export interface FailoverStep {
  readonly modelRef: string;
  readonly errorCode: string;
  readonly retryable: boolean;
}

export interface RoutedOutcome<T> {
  readonly value: T;
  readonly binding: ModelBinding;
  /** Bindings tried before this one succeeded. Empty on a first-try success. */
  readonly failedOver: readonly FailoverStep[];
}

export interface ModelRouterDeps {
  readonly config: RouterConfig;
  readonly matrix: CapabilityMatrix;
  /** Seeded. Retry jitter must be replayable (CLAUDE.md #1). */
  readonly rng: Rng;
  /** Defaults to `KNOWN_MODELS`. */
  readonly catalogue?: readonly ModelDescriptor[];
  readonly logger?: Logger;
}

export interface ExecuteOptions {
  readonly signal?: AbortSignal;
  /** Injected so tests do not spend real seconds in backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Nominal workloads used only to *order* candidates.
 *
 * Deliberately coarse. The comparison only has to get the ranking right, and a
 * precise-looking estimate here would be mistaken for the budget guard's number - which
 * is computed from the real request, not from this.
 */
const NOMINAL_TOKENS = { input: 2_000, output: 1_000, cached: 0, reasoning: 0 } as const;
const NOMINAL_IMAGE_SIZE: Record<QualityTier, { width: number; height: number }> = {
  draft: { width: 512, height: 512 },
  preview: { width: 768, height: 768 },
  final: { width: 1024, height: 1024 },
};

export class ModelRouter {
  readonly #config: RouterConfig;
  readonly #matrix: CapabilityMatrix;
  readonly #catalogue: readonly ModelDescriptor[];
  readonly #rng: Rng;
  readonly #logger: Logger;

  constructor(deps: ModelRouterDeps) {
    this.#config = deps.config;
    this.#matrix = deps.matrix;
    this.#catalogue = deps.catalogue ?? KNOWN_MODELS;
    this.#rng = deps.rng;
    this.#logger = deps.logger ?? new NoopLogger();
  }

  /** Resolves the ordered chain, or explains why nothing can serve the task. */
  route(request: RouteRequest): Result<ResolvedRoute, AppError> {
    const capability = capabilityForTask(request.task);
    const policy = request.policy ?? this.#config.defaultPolicy;

    const pinned = this.#stageOverride(request, capability);
    if (pinned !== undefined) return pinned;

    const candidates: ModelBinding[] = [];
    let source: RouteSource = 'rule';

    const stageBinding = this.#stageBinding(request);
    if (stageBinding !== undefined) {
      candidates.push(stageBinding);
      source = 'stage-override';
    }

    const taskOverride = this.#config.taskOverrides[request.task];
    if (taskOverride !== undefined) {
      candidates.push(taskOverride);
      if (source === 'rule') source = 'task-override';
    }

    const rule = this.#config.rules.find(
      (candidate) =>
        candidate.task === request.task &&
        candidate.tier === request.tier &&
        candidate.policy === policy,
    );
    if (rule !== undefined) candidates.push(...rule.chain);

    if (candidates.length === 0) {
      const fromCatalogue = this.#fromCatalogue(request, capability, policy);
      candidates.push(...fromCatalogue);
      if (fromCatalogue.length > 0) source = 'catalogue';
    }

    const capable = this.#filterCapable(candidates, capability);
    const affordable =
      rule?.maxCostPerCallNanoUsd == null
        ? capable
        : capable.filter(
            (binding) => this.#estimate(binding, capability) <= (rule.maxCostPerCallNanoUsd ?? 0),
          );

    if (affordable.length === 0) {
      return err(
        new UnsupportedCapabilityError(
          'router',
          `${capability} for task "${request.task}" at tier "${request.tier}" - no registered adapter can serve it`,
        ),
      );
    }

    return ok({
      task: request.task,
      tier: request.tier,
      policy,
      capability,
      source,
      chain: dedupe(affordable),
    });
  }

  /**
   * Walks the chain until something succeeds.
   *
   * `run` receives one binding and returns a `Result`; it never throws, and this does
   * not catch, because an adapter that throws has broken the contract the shared suite
   * enforces and hiding it here would make that undetectable.
   */
  async execute<T>(
    route: ResolvedRoute,
    run: (binding: ModelBinding) => Promise<Result<T, AppError>>,
    options: ExecuteOptions = {},
  ): Promise<Result<RoutedOutcome<T>, AppError>> {
    const failover: FailoverPolicy = this.#config.failover;
    const failedOver: FailoverStep[] = [];
    let last: AppError | undefined;

    for (const binding of route.chain) {
      const outcome = await withRetry((): Promise<Result<T, AppError>> => run(binding), {
        maxAttempts: failover.maxAttemptsPerModel,
        initialBackoffMs: failover.initialBackoffMs,
        backoffMultiplier: failover.backoffMultiplier,
        maxBackoffMs: failover.maxBackoffMs,
        jitter: failover.jitter,
        rng: this.#rng,
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });

      if (!isErr(outcome)) return ok({ value: outcome.value, binding, failedOver });

      last = outcome.error;
      const reference = modelRef(binding.provider, binding.model);
      failedOver.push({
        modelRef: reference,
        errorCode: outcome.error.code,
        retryable: outcome.error.retryable,
      });

      // `failoverOn` is about error *kinds*, and it is the only thing consulted:
      // string-matching a provider message here would defeat the whole taxonomy.
      const kinds: readonly string[] = failover.failoverOn;
      if (!kinds.includes(outcome.error.kind)) {
        this.#logger.warn('router: not failing over', {
          model: reference,
          kind: outcome.error.kind,
          code: outcome.error.code,
        });
        return err(outcome.error);
      }
      this.#logger.warn('router: failing over', { from: reference, code: outcome.error.code });
    }

    // The chain is non-empty by construction, so `last` is always set here.
    return err(
      last ?? new UnsupportedCapabilityError('router', `${route.capability} - the chain was empty`),
    );
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * A `pinned: true` stage override, resolved on its own.
   *
   * Returned early - and as a failure when the pinned model cannot serve the task -
   * because the point of pinning is that the stage fails rather than silently runs on
   * a model the author did not choose.
   */
  #stageOverride(
    request: RouteRequest,
    capability: Capability,
  ): Result<ResolvedRoute, AppError> | undefined {
    const binding = this.#stageBinding(request);
    if (binding === undefined) return undefined;
    const stage = request.stage;
    if (stage === undefined) return undefined;
    if (this.#config.stageOverrides[stage]?.pinned !== true) return undefined;

    if (!this.#matrix.supports(modelRef(binding.provider, binding.model), capability)) {
      return err(
        new UnsupportedCapabilityError(
          modelRef(binding.provider, binding.model),
          `${capability} - the stage "${stage}" is pinned to this model and it cannot serve the task`,
        ),
      );
    }

    return ok({
      task: request.task,
      tier: binding.tier,
      policy: request.policy ?? this.#config.defaultPolicy,
      capability,
      source: 'stage-override',
      chain: [binding],
    });
  }

  #stageBinding(request: RouteRequest): ModelBinding | undefined {
    const stage = request.stage;
    if (stage === undefined) return undefined;
    const override = this.#config.stageOverrides[stage];
    if (override === undefined) return undefined;
    return {
      task: request.task,
      tier: override.tier ?? request.tier,
      provider: override.provider,
      model: override.model,
      params: override.params ?? {},
    };
  }

  #filterCapable(
    bindings: readonly ModelBinding[],
    capability: Capability,
  ): readonly ModelBinding[] {
    return bindings.filter((binding) =>
      this.#matrix.supports(modelRef(binding.provider, binding.model), capability),
    );
  }

  /**
   * Last resort: build a chain from the catalogue.
   *
   * Only models that are both in the catalogue *and* registered as adapters qualify -
   * a price without an implementation is not a route.
   */
  #fromCatalogue(
    request: RouteRequest,
    capability: Capability,
    policy: RoutingPolicy,
  ): readonly ModelBinding[] {
    const bindings = this.#catalogue
      .filter((descriptor) => descriptor.capabilities.includes(capability))
      .filter((descriptor) =>
        this.#matrix.supports(modelRef(descriptor.provider, descriptor.id), capability),
      )
      .map<ModelBinding>((descriptor) => ({
        task: request.task,
        tier: request.tier,
        provider: descriptor.provider,
        model: descriptor.id,
        params: {},
      }));

    return this.#orderByPolicy(bindings, capability, policy);
  }

  #orderByPolicy(
    bindings: readonly ModelBinding[],
    capability: Capability,
    policy: RoutingPolicy,
  ): readonly ModelBinding[] {
    const priced = bindings.map((binding) => ({
      binding,
      cost: this.#estimate(binding, capability),
    }));

    const orderings: Record<RoutingPolicy, (a: number, b: number) => number> = {
      cheapest: (a, b) => a - b,
      best: (a, b) => b - a,
      // Free first, then cheapest among the rest: the free lane is the whole reason
      // the tier system exists (research §0), so it should not need a policy of its own.
      balanced: (a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b),
    };

    return [...priced].sort((a, b) => orderings[policy](a.cost, b.cost)).map((it) => it.binding);
  }

  /** Nominal cost of one call on this binding, in nano-dollars. Ordering only. */
  #estimate(binding: ModelBinding, capability: Capability): number {
    const descriptor = this.#catalogue.find(
      (candidate) => candidate.provider === binding.provider && candidate.id === binding.model,
    );
    if (descriptor === undefined) return Number.MAX_SAFE_INTEGER;

    const producesImages = capability === 'image-generation' || capability === 'image-edit';
    return priceCall(descriptor.pricing, {
      tokens: producesImages ? { input: 0, output: 0, cached: 0, reasoning: 0 } : NOMINAL_TOKENS,
      images: producesImages
        ? { count: 1, resolution: NOMINAL_IMAGE_SIZE[binding.tier] }
        : { count: 0, resolution: null },
      latencyMs: 0,
    });
  }
}

/** Keeps the first occurrence of each `provider:model`, preserving order. */
function dedupe(bindings: readonly ModelBinding[]): readonly ModelBinding[] {
  const seen = new Set<string>();
  const out: ModelBinding[] = [];
  for (const binding of bindings) {
    const reference = modelRef(binding.provider, binding.model);
    if (seen.has(reference)) continue;
    seen.add(reference);
    out.push(binding);
  }
  return out;
}
