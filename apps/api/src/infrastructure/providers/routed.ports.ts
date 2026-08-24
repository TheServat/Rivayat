/**
 * Each provider port, bound to the router rather than to one adapter.
 *
 * The alternative - picking an adapter at wiring time and injecting it - throws away
 * everything the router exists for: the per-stage pin the owner asked for, the
 * capability filter that refuses before the network, the cost ordering, and the
 * failover chain. So the token resolves to a *routing facade*: one object per port
 * that, on every call, asks `ModelRouter` for a chain and walks it.
 *
 * There is no `switch` on a provider name here. Task to capability is a table in
 * `@rv/providers`, capability to port is another, and this file only ever holds a
 * `Capability` and a `TaskKind`.
 *
 * A port with no registered adapter is not a null binding: it is a facade whose every
 * call returns `UnsupportedCapabilityError`, which the router produces on its own when
 * nothing can serve the task. That is the truth - "no provider is configured for this"
 * is not an internal error - and it maps to the same 501 a scaffolded engine produces.
 */

import type { Capability, QualityTier, TaskKind } from '@rv/contracts';
import { modelRef } from '@rv/contracts';
import type {
  CapabilityMatrix,
  EmbeddingPort,
  EmbeddingRequest,
  EmbeddingResult,
  ImageCostQuote,
  ImageCostRequest,
  ImageEditPort,
  ImageEditRequest,
  ImageGenerationPort,
  ImageGenerationRequest,
  ImageResult,
  ModelRouter,
  PortByCapability,
  TextGenerationPort,
  TextGenerationRequest,
  TextGenerationResult,
  VisionScoringPort,
  VisionScoringRequest,
  VisionScoringResult,
} from '@rv/providers';
import type { AppError, Result } from '@rv/shared-kernel';
import { isErr, ok } from '@rv/shared-kernel';

/**
 * The model reference used when there is no model.
 *
 * A quote must name something, and naming a real provider that was never selected would
 * put a fictional row in the audit trail. This is deliberately not a valid provider.
 */
const UNROUTED = 'unrouted:none';

export interface RoutedPortDeps {
  readonly router: ModelRouter;
  readonly matrix: CapabilityMatrix;
  /** Default quality tier when a caller does not pin one. */
  readonly tier?: QualityTier;
}

/**
 * Route, resolve, call.
 *
 * Generic in the capability, so `PortByCapability` gives `invoke` the right port type
 * and there is no cast at any call site below. `matrix.resolve` is the single place
 * the capability and the port type are joined - see its TSDoc for why the one cast in
 * the system lives there.
 */
async function through<C extends Capability, T>(
  deps: RoutedPortDeps,
  task: TaskKind,
  capability: C,
  invoke: (port: PortByCapability[C]) => Promise<Result<T, AppError>>,
): Promise<Result<T, AppError>> {
  const route = deps.router.route({ task, tier: deps.tier ?? 'preview' });
  if (isErr(route)) return route;

  const outcome = await deps.router.execute(route.value, async (binding) => {
    const port = deps.matrix.resolve(modelRef(binding.provider, binding.model), capability);
    if (isErr(port)) return port;
    return invoke(port.value);
  });

  return isErr(outcome) ? outcome : ok(outcome.value.value);
}

export class RoutedTextGenerationPort implements TextGenerationPort {
  readonly #deps: RoutedPortDeps;

  constructor(deps: RoutedPortDeps) {
    this.#deps = deps;
  }

  generateText(request: TextGenerationRequest): Promise<Result<TextGenerationResult, AppError>> {
    return through(this.#deps, 'scene-write', 'text-generation', (port) =>
      port.generateText(request),
    );
  }
}

export class RoutedImageGenerationPort implements ImageGenerationPort {
  readonly #deps: RoutedPortDeps;

  constructor(deps: RoutedPortDeps) {
    this.#deps = deps;
  }

  generateImage(request: ImageGenerationRequest): Promise<Result<ImageResult, AppError>> {
    // `image-draft` rather than `image-final`: the tier decides quality, and defaulting
    // to the paid lane is how a free-lane-first architecture quietly stops being one.
    return through(this.#deps, 'image-draft', 'image-generation', (port) =>
      port.generateImage(request),
    );
  }

  /**
   * The price of the call the router would actually make, from the head of the chain.
   *
   * The head rather than a survey of the chain: the guard has to answer "what will this
   * cost", and what it will cost is what the first binding charges. A failover to the
   * second is a *different* call, and pricing the chain's maximum would refuse batches
   * that will never be that expensive.
   *
   * When nothing can serve the task there is no model and therefore no price, which is
   * `unpriced` rather than `free`. Collapsing the two would make an unconfigured
   * workspace look like the cheapest possible one to the budget guard - the most
   * expensive way to be wrong (see the port's own note on the three arms).
   */
  quoteImage(request: ImageCostRequest): ImageCostQuote {
    const route = this.#deps.router.route({
      task: 'image-draft',
      tier: this.#deps.tier ?? 'preview',
    });
    if (isErr(route)) {
      return {
        kind: 'unpriced',
        modelRef: UNROUTED,
        reason: `no image-generation provider is configured: ${route.error.code}`,
      };
    }

    const head = route.value.chain[0];
    if (head === undefined) {
      return { kind: 'unpriced', modelRef: UNROUTED, reason: 'the routing chain is empty' };
    }

    const ref = modelRef(head.provider, head.model);
    const port = this.#deps.matrix.resolve(ref, 'image-generation');
    if (isErr(port)) {
      return { kind: 'unpriced', modelRef: ref, reason: port.error.code };
    }
    return port.value.quoteImage(request);
  }
}

export class RoutedImageEditPort implements ImageEditPort {
  readonly #deps: RoutedPortDeps;

  constructor(deps: RoutedPortDeps) {
    this.#deps = deps;
  }

  editImage(request: ImageEditRequest): Promise<Result<ImageResult, AppError>> {
    return through(this.#deps, 'image-edit', 'image-edit', (port) => port.editImage(request));
  }
}

export class RoutedVisionScoringPort implements VisionScoringPort {
  readonly #deps: RoutedPortDeps;

  constructor(deps: RoutedPortDeps) {
    this.#deps = deps;
  }

  score(request: VisionScoringRequest): Promise<Result<VisionScoringResult, AppError>> {
    return through(this.#deps, 'vision-score', 'vision-scoring', (port) => port.score(request));
  }
}

export class RoutedEmbeddingPort implements EmbeddingPort {
  readonly #deps: RoutedPortDeps;

  constructor(deps: RoutedPortDeps) {
    this.#deps = deps;
  }

  embed(request: EmbeddingRequest): Promise<Result<EmbeddingResult, AppError>> {
    return through(this.#deps, 'embed', 'embedding', (port) => port.embed(request));
  }
}
