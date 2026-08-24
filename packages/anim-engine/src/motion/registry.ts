/**
 * The registry that lets a request be refused before a provider is called.
 *
 * Modelled on `CapabilityMatrix` in `@rv/providers` deliberately rather than inventing a
 * second pattern: two invariants checked at **registration**, and a `Result` at
 * selection carrying the same `UnsupportedCapabilityError` the provider ports use.
 *
 *  1. A provider must declare something. A capability-less provider is invisible to the
 *     router, which looks exactly like "the provider is missing" and gets diagnosed as a
 *     wiring problem for an hour.
 *  2. A declared capability must correspond to a method that is really there. This is
 *     the only place the declaration and the implementation are compared.
 *
 * There is **no `switch` on a provider kind** anywhere in here. Kind to provider is a
 * `Map`, which is what makes adding a fifth motion source a registration rather than an
 * edit to core (CLAUDE.md §2, ADR-0008 consequences).
 */

import {
  NotFoundError,
  UnsupportedCapabilityError,
  ValidationError,
  type AppError,
  type Result,
  err,
  ok,
} from '@rv/shared-kernel';
import type {
  AuthoredMotion,
  MotionCapabilities,
  MotionProviderKind,
  MotionRequest,
} from '@rv/contracts';

import type { MotionProvider } from './port';
import { motionRequirements } from './requirements';

export class MotionProviderRegistry {
  readonly #byId = new Map<string, MotionProvider>();
  readonly #byKind = new Map<MotionProviderKind, MotionProvider[]>();

  /**
   * Adds a provider, or throws.
   *
   * Throws rather than returning a `Result` on purpose: a mis-declared provider is
   * programmer error, and the earliest possible failure is at wiring time rather than on
   * the first shot that needed it (CLAUDE.md: only programmer error throws).
   */
  register(provider: MotionProvider): void {
    if (this.#byId.has(provider.id)) {
      throw new ValidationError({
        message: `Motion provider "${provider.id}" is already registered`,
        context: { id: provider.id },
      });
    }

    if (!declaresAnything(provider.capabilities)) {
      throw new ValidationError({
        message: `Motion provider "${provider.id}" declared no capabilities, so nothing can ever route to it`,
        context: { id: provider.id, kind: provider.kind },
      });
    }

    if (typeof provider.author !== 'function') {
      throw new ValidationError({
        message: `Motion provider "${provider.id}" declares capabilities it cannot serve: it has no author()`,
        context: { id: provider.id, kind: provider.kind },
      });
    }

    this.#byId.set(provider.id, provider);
    const bucket = this.#byKind.get(provider.kind);
    if (bucket === undefined) this.#byKind.set(provider.kind, [provider]);
    else bucket.push(provider);
  }

  registerAll(providers: Iterable<MotionProvider>): void {
    for (const provider of providers) this.register(provider);
  }

  /** Every registered provider, in registration order. */
  providers(): readonly MotionProvider[] {
    return [...this.#byId.values()];
  }

  get(id: string): MotionProvider | undefined {
    return this.#byId.get(id);
  }

  /**
   * The first registered provider that serves this request in full.
   *
   * "In full" and not "partially": a provider that can author eight of a request's ten
   * behaviours would produce a document missing two, and nothing downstream distinguishes
   * a behaviour that was never asked for from one that was quietly dropped.
   */
  select(request: MotionRequest): Result<MotionProvider, AppError> {
    const candidates = this.#byKind.get(request.kind) ?? [];
    if (candidates.length === 0) {
      return err(
        new NotFoundError('motion provider', request.kind, {
          context: { registered: [...this.#byKind.keys()] },
        }),
      );
    }

    const needed = motionRequirements(request);
    const shortfalls: string[] = [];
    for (const provider of candidates) {
      const missing = shortfall(needed, provider.capabilities);
      if (missing.length === 0) return ok(provider);
      shortfalls.push(`${provider.id}: ${missing.join(', ')}`);
    }

    return err(new UnsupportedCapabilityError(request.kind, shortfalls.join('; ')));
  }

  /** Selects and calls, which is what a caller almost always wants. */
  async author(request: MotionRequest): Promise<Result<AuthoredMotion, AppError>> {
    const provider = this.select(request);
    if (!provider.ok) return provider;
    return provider.value.author(request);
  }
}

function declaresAnything(capabilities: MotionCapabilities): boolean {
  return capabilities.channels.length > 0 || capabilities.behaviours.length > 0;
}

/** What the request needs and the provider does not declare. */
function shortfall(needed: MotionCapabilities, declared: MotionCapabilities): readonly string[] {
  const channels = new Set<string>(declared.channels);
  const behaviours = new Set<string>(declared.behaviours);
  return [
    ...needed.channels.filter((channel) => !channels.has(channel)),
    ...needed.behaviours.filter((behaviour) => !behaviours.has(behaviour)),
  ];
}
