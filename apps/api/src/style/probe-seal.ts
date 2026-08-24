/**
 * Probing a style you have not locked yet - which is the entire point of probing.
 *
 * ## The conflict, and how it is resolved
 *
 * Two documents disagreed and the disagreement was load-bearing.
 *
 * `GenerateStyleProbeUseCase` calls `assertUsableForGeneration`, which refuses an
 * unlocked bible, and its header argues the flow is **lock → probe → fork**: one guard
 * in front of every image generation, and a probe is an image generation.
 *
 * `docs/06-screen-briefs.md`, RV-204 and the Style Lab screen all say **choose → probe
 * → lock**, and so does `materialiseStyleBible` in the same package: "locking is a
 * decision a human makes after looking at a probe sheet". `assertUsableForGeneration`'s
 * own error message says it too - "Approve the probe sheet before generating against
 * it" - which is impossible if the sheet requires the lock.
 *
 * Resolved in favour of the brief, because lock → probe → fork makes the user's first
 * irreversible action happen *before* they have seen anything. The lock is what forks
 * the asset library: every dedup key downstream contains the checksum, and a rejected
 * probe would leave a locked, checksummed, never-used bible behind on every attempt.
 *
 * ## What this does instead, and why the invariant survives
 *
 * It seals the candidate: `lock()` from `@rv/core-domain`, applied to an **in-memory
 * copy** that is never stored. The copy is what the probe draws against, so:
 *
 *  - The guard still runs. `GenerateStyleProbeUseCase` is unchanged, and there is still
 *    exactly one answer to "may this style be drawn against".
 *  - The pixels are still generated against a frozen document. What the invariant
 *    protects is "no pixel is generated against a moving target", and a content hash
 *    taken immediately before the call is exactly that guarantee.
 *  - **The sheet's checksum is the checksum the lock will write.** `computeStyleChecksum`
 *    is a pure function of the fields that change what is drawn, so sealing and locking
 *    produce the same hash for the same content. A user who probes and then locks
 *    without editing gets assets keyed to the checksum on the sheet they approved; a
 *    user who edits gets a different checksum, and the stale sheet says so.
 *  - Nothing is written. The stored bible stays unlocked until `POST /style/:id/lock`,
 *    so a rejected candidate leaves no locked row and no fork behind.
 *
 * An already-locked bible is passed through untouched - `lock()` refuses to re-lock,
 * correctly, and re-probing a locked style is a legitimate thing to want.
 */

import type { StyleBible } from '@rv/contracts';
import { isLocked, lock } from '@rv/core-domain';
import { type AppError, type Clock, type Result, ok, toIso } from '@rv/shared-kernel';

export interface SealedStyle {
  /** The document the probe generates against. Locked, and never persisted. */
  readonly bible: StyleBible;
  /**
   * Whether the seal was applied here rather than by a real lock.
   *
   * Carried so a caller can say "this sheet describes a candidate" rather than implying
   * the style is frozen. The API does not surface it today; a UI that wants to badge a
   * provisional sheet has the fact available rather than having to infer it.
   */
  readonly provisional: boolean;
}

/**
 * A candidate a probe may draw against, without committing to it.
 *
 * @param clock injected: the seal writes a `lockedAt`, and a replayed request has to
 * produce the same document it did the first time (non-negotiable #1). The value does
 * not reach the checksum - `StyleCheckpointInput` omits it - so it changes the record
 * and never the pixels.
 */
export function sealForProbe(bible: StyleBible, clock: Clock): Result<SealedStyle, AppError> {
  if (isLocked(bible)) return ok({ bible, provisional: false });

  const sealed = lock(bible, toIso(clock.now()));
  if (sealed.ok) return ok({ bible: sealed.value, provisional: true });
  return sealed;
}
