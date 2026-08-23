/**
 * Small conversions every adapter needs and none of them should re-spell.
 *
 * Base64 lives here rather than in `@rv/shared-kernel` because it is an
 * infrastructure concern: it exists only because three provider wire formats carry
 * images as text, and the kernel has no business knowing that.
 */

import type { Clock } from '@rv/shared-kernel';

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}

/** Milliseconds since `startedAt`, floored at zero so a fixed clock cannot go negative. */
export function elapsedSince(clock: Clock, startedAt: number): number {
  return Math.max(0, clock.now() - startedAt);
}

/**
 * Reads a number a provider may or may not have sent.
 *
 * Token counts are routinely absent - Ollama omits them on a cached prompt, OpenRouter
 * omits `usage` entirely unless asked. Treating absent as zero is right for the ledger
 * (we did not learn of any tokens) and wrong to `throw` over.
 */
export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
