/**
 * The one product decision in S1's wiring, held to its promise.
 *
 * The promise is not "sealing works" - it is that **the checksum on a probe sheet is the
 * checksum the lock will write**. That is what makes choose → probe → lock safe: a user
 * who approves a sheet and then locks gets assets keyed to the checksum they approved,
 * and a user who edits first gets a different one and can be told the sheet is stale.
 */

import { StyleBible } from '@rv/contracts';
import { computeStyleChecksum, isLocked, lock } from '@rv/core-domain';
import { findPreset, materialiseStyleBible } from '@rv/style-engine';
import { FixedClock, instant, unwrap, type Clock } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { sealForProbe } from './probe-seal';

/** Fixed, because a seal writes a `lockedAt` and a replayed request must match. */
const clock: Clock = new FixedClock(instant(1_700_000_000_000));

function candidate(): StyleBible {
  const preset = unwrap(findPreset('paper-cutout'));
  return materialiseStyleBible({
    draft: preset.draft,
    id: 'sty_01J0000000000000000000000A',
    clock,
  });
}

describe('sealing a style for a probe', () => {
  it('lets an unlocked candidate be drawn against without storing a lock', () => {
    const bible = candidate();
    expect(isLocked(bible)).toBe(false);

    const sealed = unwrap(sealForProbe(bible, clock));

    // The guard in front of every image generation is satisfied by the *copy*...
    expect(isLocked(sealed.bible)).toBe(true);
    expect(sealed.provisional).toBe(true);
    // ...and the document the caller holds is untouched, so a rejected probe leaves no
    // locked, checksummed, never-used bible behind.
    expect(isLocked(bible)).toBe(false);
  });

  it('produces exactly the checksum the lock will write', () => {
    const bible = candidate();

    const sealed = unwrap(sealForProbe(bible, clock));
    const locked = unwrap(lock(bible, '2024-01-01T00:00:00.000Z'));

    // The whole promise of the ordering: content-derived, so sealing and locking cannot
    // disagree, and the lock timestamp is not part of it.
    expect(sealed.bible.checksum).toBe(locked.checksum);
    expect(sealed.bible.checksum).toBe(computeStyleChecksum(bible));
  });

  it('reports a different checksum once the candidate is edited, so a sheet can go stale', () => {
    const bible = candidate();
    const edited = StyleBible.parse({ ...bible, seed: bible.seed + 1 });

    const before = unwrap(sealForProbe(bible, clock));
    const after = unwrap(sealForProbe(edited, clock));

    expect(after.bible.checksum).not.toBe(before.bible.checksum);
  });

  it('passes an already-locked bible through untouched rather than re-locking it', () => {
    const locked = unwrap(lock(candidate(), '2024-01-01T00:00:00.000Z'));

    const sealed = unwrap(sealForProbe(locked, clock));

    // `lock` refuses a second lock, correctly - re-probing a locked style is a legitimate
    // thing to want, and it must not become a conflict.
    expect(sealed.provisional).toBe(false);
    expect(sealed.bible).toBe(locked);
  });

  it('hands a tampered locked bible on unchanged, so the engine is what catches it', () => {
    const locked = unwrap(lock(candidate(), '2024-01-01T00:00:00.000Z'));
    // A locked document whose content moved: the stored checksum no longer describes it.
    const tampered = StyleBible.parse({ ...locked, seed: locked.seed + 1 });

    const sealed = unwrap(sealForProbe(tampered, clock));

    // Not re-checksummed here. Sealing a stale document would *repair* it silently, and
    // "someone edited a frozen style behind our back" is exactly the data-integrity
    // failure `assertUsableForGeneration` distinguishes from "not locked yet". Adding a
    // second answer to that question is the thing this design refuses to do.
    expect(sealed.bible.checksum).toBe(tampered.checksum);
    expect(computeStyleChecksum(sealed.bible)).not.toBe(sealed.bible.checksum);
  });
});
