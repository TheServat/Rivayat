/**
 * Which representation an asset actually has.
 *
 * `docs/universal_ai_animation_system.md` §3 and §5 make the point that matters here:
 * an asset is not necessarily a PNG, and *representation* ("how is it built and
 * animated") is independent of *style* ("how does it look"). A flat 2D image, a cutout
 * rig and a 2.5D stack of depth-separated layers are three different things, and a
 * library that draws them identically implies they are one.
 *
 * **Nothing is invented here.** `AssetVersion` carries no `representation` field today,
 * so this derives one from what the version genuinely holds - the part count, whether
 * any part is mesh-deformable, whether a rig with more than a root bone exists - and
 * marks the answer as *derived*. The screen says so, in as many words.
 *
 * When the contract gains a declared representation, this function becomes a read of
 * that field and the two call sites do not change. That is the whole reason it is a
 * function and not an inline ternary in a table cell: the cheap decision now is a seam,
 * and the expensive one later would be finding every place that assumed "cutout".
 *
 * `2.5D` is deliberately **not** derivable. Depth separation needs a per-layer depth
 * the schema does not carry, and guessing it from `zOrder` would be exactly the kind of
 * confident wrong answer this file exists to avoid.
 */

import type { AssetVersion } from '@rv/contracts';

export type RepresentationKind = 'flat' | 'cutout' | 'cutout-mesh' | 'unknown';

export interface Representation {
  readonly kind: RepresentationKind;
  /**
   * `false` once the contract declares it.
   *
   * Surfaced in the UI rather than kept as a comment: a reader deciding whether an
   * asset can be re-rigged should know whether the answer was stated or inferred.
   */
  readonly derived: true;
}

/** The message key for each kind. One table, so a new kind is one row in two files. */
export const REPRESENTATION_KEYS: Readonly<Record<RepresentationKind, string>> = {
  flat: 'assets.representation.flat',
  cutout: 'assets.representation.cutout',
  'cutout-mesh': 'assets.representation.cutout-mesh',
  unknown: 'assets.representation.unknown',
};

export function representationOf(version: AssetVersion | undefined): Representation {
  if (version === undefined) return { kind: 'unknown', derived: true };
  if (version.parts.some((part) => part.deformable)) return { kind: 'cutout-mesh', derived: true };
  // One part and at most a root bone is a picture that can be moved, not a rig that can
  // be posed - which is precisely the flat-2D case the design document separates out.
  if (version.parts.length <= 1 && (version.rig?.bones.length ?? 0) <= 1) {
    return { kind: 'flat', derived: true };
  }
  return { kind: 'cutout', derived: true };
}

/**
 * The same answer from a library row, which carries counts instead of the parts.
 *
 * The list endpoint does not send part records - it sends how many there are - so the
 * row can distinguish flat from cutout and cannot see a mesh. It says `cutout` in that
 * case rather than guessing, and the detail panel refines it once the parts arrive.
 */
export function representationFromCounts(partCount: number): Representation {
  return { kind: partCount <= 1 ? 'flat' : 'cutout', derived: true };
}
