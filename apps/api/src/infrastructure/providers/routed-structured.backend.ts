/**
 * `StructuredBackend`, over the router.
 *
 * Separate from `routed.ports.ts` because it is not one of `@rv/providers`' six ports:
 * `StructuredGenerationPort` deliberately does not exist there, and the interface
 * `StructuredCall` needs is declared by `@rv/prompt-kit`, in the layer that uses it.
 * The capability matrix already knows that - `PortByCapability['structured-generation']`
 * is `StructuredBackend` - so the wiring is the same, only the source of the type
 * differs.
 *
 * `id`, `enforcesSchema` and `dialect` are the awkward part: they are properties of a
 * *model*, and a router has a chain rather than a model. They are answered from the
 * chain's head, which is the model the next call will actually use. `enforcesSchema` is
 * additionally forced to `false` - it is advisory, `StructuredCall` validates and
 * repairs regardless (research §1), and claiming enforcement we cannot verify across a
 * failover is the one direction of error that loses data.
 */

import type { SchemaDialect, TaskKind } from '@rv/contracts';
import { modelRef } from '@rv/contracts';
import type { CapabilityMatrix, ModelRouter } from '@rv/providers';
import type { CompletionRequest, CompletionResponse, StructuredBackend } from '@rv/prompt-kit';
import type { AppError, Result } from '@rv/shared-kernel';
import { isErr, ok } from '@rv/shared-kernel';

/** The default task for a structured call made outside a named stage. */
const DEFAULT_TASK: TaskKind = 'prompt-compose';

export interface RoutedStructuredBackendDeps {
  readonly router: ModelRouter;
  readonly matrix: CapabilityMatrix;
}

export class RoutedStructuredBackend implements StructuredBackend {
  readonly #router: ModelRouter;
  readonly #matrix: CapabilityMatrix;

  constructor(deps: RoutedStructuredBackendDeps) {
    this.#router = deps.router;
    this.#matrix = deps.matrix;
  }

  /** The head of the current chain, or `router:none` when nothing can serve it. */
  get id(): string {
    const route = this.#router.route({ task: DEFAULT_TASK, tier: 'preview' });
    if (isErr(route)) return 'router:none';
    const head = route.value.chain[0];
    return head === undefined ? 'router:none' : modelRef(head.provider, head.model);
  }

  /**
   * Always false. See the file header.
   *
   * A field rather than a getter, because it is a constant: `StructuredCall` reads it
   * to decide how loudly to restate the schema in the prompt, and a value that could
   * vary per read would make that decision unrepeatable.
   */
  readonly enforcesSchema = false;

  get dialect(): SchemaDialect {
    const head = this.#head();
    return head?.dialect ?? 'plain';
  }

  async complete(request: CompletionRequest): Promise<Result<CompletionResponse, AppError>> {
    const route = this.#router.route({ task: DEFAULT_TASK, tier: 'preview' });
    if (isErr(route)) return route;

    const outcome = await this.#router.execute(route.value, async (binding) => {
      const backend = this.#matrix.resolve(
        modelRef(binding.provider, binding.model),
        'structured-generation',
      );
      if (isErr(backend)) return backend;
      // Re-dialect the schema per adapter: the chain can cross providers mid-call and
      // Gemini rejects the schema Ollama is happy with. The adapter knows its own
      // dialect, so the caller never has to.
      return backend.value.complete(request);
    });

    return isErr(outcome) ? outcome : ok(outcome.value.value);
  }

  #head(): StructuredBackend | undefined {
    const route = this.#router.route({ task: DEFAULT_TASK, tier: 'preview' });
    if (isErr(route)) return undefined;
    const binding = route.value.chain[0];
    if (binding === undefined) return undefined;
    const resolved = this.#matrix.resolve(
      modelRef(binding.provider, binding.model),
      'structured-generation',
    );
    return isErr(resolved) ? undefined : resolved.value;
  }
}
