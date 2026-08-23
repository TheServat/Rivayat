/**
 * `@rv/providers`' embedding port, adapted to the one `@rv/asset-registry` declares.
 *
 * Two interfaces for the same capability is not duplication - it is the dependency rule
 * working. `asset-registry` declares the narrow shape *it* needs (`model`, `dimensions`,
 * `embed(texts)`) in the layer that needs it, and refuses to import an infrastructure
 * package to get one. Something has to join them, and the composition root is the only
 * layer allowed to know both. This is that joint.
 *
 * `model` and `dimensions` are answered from the last successful call and from
 * configuration before that. They exist because vectors from two models share a number
 * space but not a meaning: an index that mixes them does not fail, it silently returns
 * confident nonsense.
 */

import type { EmbeddingPort as ProvidersEmbeddingPort } from '@rv/providers';
import type { EmbeddingPort as RegistryEmbeddingPort } from '@rv/asset-registry';
import type { Result } from '@rv/shared-kernel';
import { isErr, ok } from '@rv/shared-kernel';

export interface RegistryEmbeddingAdapterOptions {
  readonly port: ProvidersEmbeddingPort;
  /** `provider:model`, from configuration. Replaced by whatever the call reports. */
  readonly model: string;
  /** Nominal dimension, until a call tells us the real one. */
  readonly dimensions: number;
}

export class RegistryEmbeddingAdapter implements RegistryEmbeddingPort {
  readonly #port: ProvidersEmbeddingPort;
  #model: string;
  #dimensions: number;

  constructor(options: RegistryEmbeddingAdapterOptions) {
    this.#port = options.port;
    this.#model = options.model;
    this.#dimensions = options.dimensions;
  }

  get model(): string {
    return this.#model;
  }

  get dimensions(): number {
    return this.#dimensions;
  }

  async embed(texts: readonly string[]): Promise<Result<readonly (readonly number[])[]>> {
    const outcome = await this.#port.embed({ texts });
    if (isErr(outcome)) return outcome;

    // The router may have failed over to a different model than the configured one, and
    // the vectors are attributed to whatever actually produced them - not to what we
    // asked for. Storing the wrong attribution is worse than storing none.
    this.#model = outcome.value.modelRef;
    this.#dimensions = outcome.value.dimensions;
    return ok(outcome.value.vectors);
  }
}
