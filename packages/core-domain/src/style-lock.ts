/**
 * Style locking.
 *
 * A `StyleBible` is the input to every image generation, so it has to be frozen before
 * anything is spent against it - otherwise half the library is drawn against one set
 * of rules and half against another, and nothing in the data says which.
 *
 * The freeze is a **content hash of exactly the fields that change what is drawn**.
 * That hash then participates in every asset dedup key, so:
 *
 *  - renaming a style is not a restyle, and costs nothing;
 *  - changing its palette *is* a restyle, and forks the library rather than corrupting
 *    it - season 1 stays renderable after a season 2 restyle.
 */

import {
  ConflictError,
  type Result,
  ValidationError,
  contentHash,
  err,
  ok,
} from '@rv/shared-kernel';
import { StyleCheckpointInput, type StyleBible } from '@rv/contracts';

/**
 * The checksum type as the rest of the system sees it.
 *
 * `@rv/shared-kernel` brands its hashes `Sha256` and `@rv/contracts` brands the same
 * hex string `Sha256Hex`. Both are correct in their own layer, and converting is a
 * no-op at runtime - but the domain speaks the *contract's* dialect, because that is
 * what gets stored and passed around. Deriving the alias from the field itself means
 * it cannot drift.
 */
type StyleChecksum = StyleBible['checksum'];

/**
 * The checksum for a bible's current content.
 *
 * Computed from the parsed `StyleCheckpointInput` projection rather than from the whole
 * object, so identity and bookkeeping fields cannot perturb it. Parsing first also
 * normalises defaults, so a bible that omits `line` and one that spells out the same
 * defaults hash identically.
 */
export function computeStyleChecksum(bible: StyleBible): StyleChecksum {
  const canonical = StyleCheckpointInput.parse(bible);
  return contentHash(canonical);
}

export function isLocked(bible: StyleBible): boolean {
  return bible.lockedAt !== null;
}

/**
 * Whether the stored checksum still matches the content.
 *
 * A mismatch on a locked bible means someone edited it in place - which silently
 * invalidates every asset generated against it. Worth detecting loudly.
 */
export function isChecksumValid(bible: StyleBible): boolean {
  return bible.checksum === computeStyleChecksum(bible);
}

/**
 * Freezes a bible so it may be used for generation.
 *
 * Recomputes the checksum rather than trusting the incoming one: a hand-set checksum is
 * cache poisoning, and this is the only place it is written.
 */
export function lock(bible: StyleBible, at: string): Result<StyleBible, ConflictError> {
  if (isLocked(bible)) {
    return err(
      new ConflictError({
        message: `Style "${bible.name}" is already locked; fork it instead of re-locking`,
        context: { styleBibleId: bible.id, lockedAt: bible.lockedAt },
      }),
    );
  }
  return ok({ ...bible, checksum: computeStyleChecksum(bible), lockedAt: at });
}

/**
 * Produces the next version of a locked bible.
 *
 * Editing in place is refused; a locked style is forked. The fork records its parent,
 * so the asset library can explain why two versions of the same tree exist.
 */
export function fork(
  bible: StyleBible,
  changes: Partial<Pick<StyleBible, 'visual' | 'motion' | 'render' | 'prompts' | 'seed' | 'name'>>,
  newId: StyleBible['id'],
  at: string,
): StyleBible {
  const next: StyleBible = {
    ...bible,
    ...changes,
    id: newId,
    parentId: bible.id,
    origin: 'forked',
    version: bible.version + 1,
    lockedAt: null,
    createdAt: at,
    checksum: bible.checksum,
  };
  return { ...next, checksum: computeStyleChecksum(next) };
}

/**
 * Guards generation.
 *
 * Called before any asset is produced. Two failure modes, deliberately distinguished:
 * an unlocked style is a workflow error the user can fix by approving the probe sheet;
 * a stale checksum is a data-integrity error that means something edited a frozen
 * style behind our back.
 */
export function assertUsableForGeneration(
  bible: StyleBible,
): Result<StyleChecksum, ValidationError> {
  if (!isLocked(bible)) {
    return err(
      new ValidationError({
        message: `Style "${bible.name}" is not locked. Approve the probe sheet before generating against it.`,
        context: { styleBibleId: bible.id },
      }),
    );
  }
  if (!isChecksumValid(bible)) {
    return err(
      new ValidationError({
        message: `Style "${bible.name}" was modified after locking; its checksum no longer matches its content.`,
        context: {
          styleBibleId: bible.id,
          stored: bible.checksum,
          actual: computeStyleChecksum(bible),
        },
      }),
    );
  }
  return ok(bible.checksum);
}
