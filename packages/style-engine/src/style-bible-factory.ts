/**
 * Turning a draft into a real `StyleBible`.
 *
 * The identity fields - id, version, checksum, timestamps - are ours to assign, never
 * the model's and never the preset author's, which is exactly why `StyleBibleDraft`
 * omits them. This is the single place they get filled in, and the single place outside
 * `@rv/core-domain` that a checksum is written: it computes one with
 * `computeStyleChecksum` rather than accepting a caller's, because a hand-set checksum
 * is cache poisoning that shows up months later as two different oaks with the same key.
 */

import { computeStyleChecksum } from '@rv/core-domain';
import { StyleBible, type StyleBibleDraft, type StyleBibleId } from '@rv/contracts';
import type { Clock } from '@rv/shared-kernel';
import { toIso } from '@rv/shared-kernel';

/** Stand-in written only so the document parses before the real hash is computed. */
const PLACEHOLDER_CHECKSUM = '0'.repeat(64);

export interface MaterialiseStyleBibleInput {
  readonly draft: StyleBibleDraft;
  readonly id: StyleBibleId;
  /** Injected, never read from the wall clock - a replayed run must mint the same document. */
  readonly clock: Clock;
  /** Set when the draft came from forking an existing bible. */
  readonly parentId?: StyleBibleId;
  readonly version?: number;
}

/**
 * Produces an unlocked, checksummed bible.
 *
 * Unlocked deliberately: locking is a decision a human makes after looking at a probe
 * sheet, and a factory that produced locked documents would let a style reach the image
 * models without anyone having seen it.
 */
export function materialiseStyleBible(input: MaterialiseStyleBibleInput): StyleBible {
  const draft = input.draft;
  const candidate = StyleBible.parse({
    ...draft,
    id: input.id,
    version: input.version ?? 1,
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    checksum: PLACEHOLDER_CHECKSUM,
    lockedAt: null,
    createdAt: toIso(input.clock.now()),
  });
  return { ...candidate, checksum: computeStyleChecksum(candidate) };
}
