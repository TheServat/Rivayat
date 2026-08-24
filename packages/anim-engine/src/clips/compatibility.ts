/**
 * Whether a library clip fits a skeleton.
 *
 * The question the whole library turns on, and the one place a wrong answer is
 * expensive in both directions. Too strict and the library is permanently empty, which
 * looks exactly like it working; too loose and a walk cycle drives an arm from the hips
 * and nothing says so.
 *
 * Four conditions, and each rules out a specific way of being wrong:
 *
 *  1. **The archetype matches.** The coarse gate. A `biped` walk on a `tree` shares no
 *     vocabulary at all, and nothing further down would catch it, because the roles
 *     might coincidentally overlap.
 *  2. **The rig has every role the clip drives.** Role, not bone name: bone ids are
 *     minted per asset, names are per-asset slugs, and `role` is the template label
 *     that two rigs can actually agree on.
 *  3. **Ancestry survives.** For every driven role, the role that was its *parent* on
 *     the source skeleton must still be an *ancestor* on the target. Ancestor, not
 *     parent, and that relaxation is the whole reason this is not "an exact skeleton
 *     match": a target rig may insert a shoulder between the torso and the upper arm,
 *     and rotating the upper arm still swings the arm from the shoulder because the
 *     inserted bone is at rest and composing through it is the identity. What ancestry
 *     rules out is the case that actually breaks: an arm parented to the hips.
 *  4. **The rig carries every anchor the clip measures itself against.** A walk cycle
 *     aligns to `ground`; a rig with no ground plane has nothing to keep the feet on.
 *
 * The report is structured rather than a boolean because the interesting use is a
 * human asking *why* a clip they expected did not appear.
 */

import { assertDefined, must } from '@rv/shared-kernel';
import type { AnchorRole, ClipLibraryEntry, RigSignature } from '@rv/contracts';

import { ancestorsByRole, boneByRole } from './signature';

/** A driven role whose parent on the source is no longer above it on the target. */
export interface BrokenAncestry {
  readonly role: string;
  /** The role that was this one's parent where the clip was authored. */
  readonly expectedAncestor: string;
}

export interface ClipCompatibility {
  readonly compatible: boolean;
  /** True when the clip was authored for a different kind of thing entirely. */
  readonly archetypeMismatch: boolean;
  /** Driven roles the target skeleton does not have. */
  readonly missingRoles: readonly string[];
  readonly brokenAncestry: readonly BrokenAncestry[];
  /** Standard anchors the clip measures against and the target does not declare. */
  readonly missingAnchors: readonly AnchorRole[];
}

export function checkClipCompatibility(
  entry: ClipLibraryEntry,
  target: RigSignature,
): ClipCompatibility {
  const source = entry.sourceRig;
  const archetypeMismatch = source.archetype !== target.archetype;

  const missingRoles: string[] = [];
  const brokenAncestry: BrokenAncestry[] = [];
  const targetAncestors = ancestorsByRole(target);

  for (const role of entry.drives) {
    if (boneByRole(target, role) === undefined) {
      missingRoles.push(role);
      continue;
    }

    // `ClipLibraryEntry` rejects a driven role its own source rig lacks, so the source
    // bone is always there. Its *parent* legitimately may not be: a clip that drives the
    // source root has no ancestry to preserve, and demanding one would reject every
    // clip that animates a body.
    const sourceBone = boneByRole(source, role);
    assertDefined(sourceBone, `source bone for driven role ${role}`);
    const expected = sourceBone.parentRole;
    if (expected === null) continue;

    if (!must(targetAncestors, role, 'target ancestors').has(expected)) {
      brokenAncestry.push({ role, expectedAncestor: expected });
    }
  }

  const declared = new Set<string>(target.anchors.map((anchor) => anchor.role));
  const missingAnchors = entry.alignsTo.filter((role) => !declared.has(role));

  return {
    compatible:
      !archetypeMismatch &&
      missingRoles.length === 0 &&
      brokenAncestry.length === 0 &&
      missingAnchors.length === 0,
    archetypeMismatch,
    missingRoles,
    brokenAncestry,
    missingAnchors,
  };
}
