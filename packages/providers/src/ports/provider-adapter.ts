/**
 * What every adapter declares about itself, regardless of which ports it implements.
 *
 * Kept out of the ports themselves so the ports stay at one method each (ISP,
 * architecture §5). An adapter implements `ProviderAdapter` *and* the subset of ports
 * it can actually serve; the capability matrix is the only thing that reads both.
 */

import type { Capability, ProviderKind } from '@rv/contracts';

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  /**
   * `provider:model`. Doubles as the registry key and the ledger key.
   *
   * Per-model rather than per-provider because two Ollama models are two different
   * cost/latency/quality propositions, and a router that cannot tell them apart
   * cannot honour "the story model is selectable per stage".
   */
  readonly modelRef: string;
  /**
   * The ports this instance actually implements.
   *
   * A claim, checked at registration against the methods that are really present -
   * see `CapabilityMatrix.register`. An adapter that declares a capability it cannot
   * serve is a routing hole, and the whole matrix exists to close it.
   */
  readonly capabilities: readonly Capability[];
}

/** True when the adapter says it serves `capability`. Says nothing about whether it can. */
export function declaresCapability(adapter: ProviderAdapter, capability: Capability): boolean {
  return adapter.capabilities.includes(capability);
}
