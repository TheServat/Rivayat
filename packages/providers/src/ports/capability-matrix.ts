/**
 * The registry that lets the router refuse a route before anything is spent.
 *
 * Two invariants, both enforced at *registration* rather than at call time:
 *
 *  1. An adapter must declare at least one capability. A silently capability-less
 *     adapter is invisible to the router, which looks like "the provider is down"
 *     and is diagnosed as a network problem for an hour.
 *  2. A declared capability must correspond to a method that is really there. This is
 *     the only place the declaration and the implementation are compared, and it is
 *     what makes `UnsupportedCapabilityError` an alarm rather than routine control
 *     flow (architecture §5, RV-020).
 *
 * There is no `switch` on a provider name anywhere in here - capability to port method
 * is a lookup table, which is how new ports are added without touching the router.
 */

import type { Capability, ProviderKind } from '@rv/contracts';
import {
  type AppError,
  NotFoundError,
  type Result,
  UnsupportedCapabilityError,
  ValidationError,
  err,
  ok,
} from '@rv/shared-kernel';
import type { StructuredBackend } from '@rv/prompt-kit';

import type { EmbeddingPort } from './embedding';
import type { ImageEditPort } from './image-edit';
import type { ImageGenerationPort } from './image-generation';
import type { ProviderAdapter } from './provider-adapter';
import type { SpeechSynthesisPort } from './speech-synthesis';
import type { TextGenerationPort } from './text-generation';
import type { VisionScoringPort } from './vision-scoring';

/**
 * Capability to the port it is served through.
 *
 * `structured-generation` maps to `@rv/prompt-kit`'s `StructuredBackend` rather than a
 * port of our own: the interface is declared in the layer that uses it, and
 * re-declaring it here would give us two shapes to keep in step.
 */
export interface PortByCapability {
  'text-generation': TextGenerationPort;
  'structured-generation': StructuredBackend;
  'image-generation': ImageGenerationPort;
  'image-edit': ImageEditPort;
  'vision-scoring': VisionScoringPort;
  embedding: EmbeddingPort;
  'speech-synthesis': SpeechSynthesisPort;
}

/** The method each capability is served by. The registration check reads this. */
export const CAPABILITY_METHOD = {
  'text-generation': 'generateText',
  'structured-generation': 'complete',
  'image-generation': 'generateImage',
  'image-edit': 'editImage',
  'vision-scoring': 'score',
  embedding: 'embed',
  'speech-synthesis': 'synthesizeSpeech',
} as const satisfies Record<Capability, string>;

export type CapabilityMethod = (typeof CAPABILITY_METHOD)[Capability];

function hasMethod(target: object, method: string): boolean {
  return typeof (target as Record<string, unknown>)[method] === 'function';
}

export class CapabilityMatrix {
  readonly #byRef = new Map<string, ProviderAdapter>();

  /**
   * Adds an adapter, or throws.
   *
   * Throws rather than returning a `Result` on purpose: a mis-declared adapter is
   * programmer error, and the earliest possible failure is at wiring time rather than
   * on the first user-facing call (CLAUDE.md: only programmer error throws).
   */
  register(adapter: ProviderAdapter): void {
    if (adapter.capabilities.length === 0) {
      throw new ValidationError({
        message: `Adapter "${adapter.modelRef}" declared no capabilities`,
        context: { modelRef: adapter.modelRef },
      });
    }
    if (this.#byRef.has(adapter.modelRef)) {
      throw new ValidationError({
        message: `Adapter "${adapter.modelRef}" is already registered`,
        context: { modelRef: adapter.modelRef },
      });
    }

    const undeliverable = adapter.capabilities.filter(
      (capability) => !hasMethod(adapter, CAPABILITY_METHOD[capability]),
    );
    if (undeliverable.length > 0) {
      throw new ValidationError({
        message: `Adapter "${adapter.modelRef}" declares capabilities it cannot serve: ${undeliverable.join(', ')}`,
        context: { modelRef: adapter.modelRef, undeliverable },
      });
    }

    this.#byRef.set(adapter.modelRef, adapter);
  }

  registerAll(adapters: Iterable<ProviderAdapter>): void {
    for (const adapter of adapters) this.register(adapter);
  }

  /** True when a registered adapter for `modelRef` declares `capability`. */
  supports(modelRef: string, capability: Capability): boolean {
    return this.#byRef.get(modelRef)?.capabilities.includes(capability) ?? false;
  }

  /** Every registered `provider:model` that serves `capability`, in registration order. */
  refsFor(capability: Capability): readonly string[] {
    return [...this.#byRef.values()]
      .filter((adapter) => adapter.capabilities.includes(capability))
      .map((adapter) => adapter.modelRef);
  }

  /** Distinct provider kinds that serve `capability`. */
  providersFor(capability: Capability): readonly ProviderKind[] {
    const kinds = new Set<ProviderKind>();
    for (const adapter of this.#byRef.values()) {
      if (adapter.capabilities.includes(capability)) kinds.add(adapter.kind);
    }
    return [...kinds];
  }

  adapters(): readonly ProviderAdapter[] {
    return [...this.#byRef.values()];
  }

  get(modelRef: string): ProviderAdapter | undefined {
    return this.#byRef.get(modelRef);
  }

  /**
   * Narrows a registered adapter to the port for `capability`.
   *
   * The cast is safe because `register` already proved the method exists and the
   * `PortByCapability` map ties the capability to the port at the type level. This is
   * the single place the two are joined, which is why it is worth a cast here rather
   * than a `supports` check at every call site.
   */
  resolve<C extends Capability>(
    modelRef: string,
    capability: C,
  ): Result<PortByCapability[C], AppError> {
    const adapter = this.#byRef.get(modelRef);
    if (adapter === undefined) return err(new NotFoundError('provider adapter', modelRef));
    if (!adapter.capabilities.includes(capability)) {
      return err(new UnsupportedCapabilityError(modelRef, capability));
    }
    return ok(adapter as unknown as PortByCapability[C]);
  }
}
