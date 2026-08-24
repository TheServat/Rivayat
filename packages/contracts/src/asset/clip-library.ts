/**
 * Clips, addressed by the rigs they fit rather than by the asset they were drawn on.
 *
 * `AnimationClip` belongs to an `AssetVersion`, which was the right shape for one
 * asset and is the wrong shape for a series. A walk cycle is not a property of a
 * particular fox; it is a property of *four-legged things of roughly these
 * proportions*, and authoring it once per character is the production cost this whole
 * project exists to remove (ADR-0008 §5).
 *
 * ## The migration, and what it must not break
 *
 * A {@link ClipLibraryEntry} **extends** `AnimationClip` rather than replacing it. That
 * is deliberate and load-bearing:
 *
 *  - Every per-asset clip already stored keeps resolving, because `AssetVersion.clips`
 *    is untouched and a resolver prefers the asset's own clip over anything in the
 *    library. A clip authored *on* this rig needs no retargeting and is always the
 *    better answer.
 *  - The dedup key does not move. `id`, `name` and `irHash` are the same fields with
 *    the same values; promoting a clip into the library adds an address, it does not
 *    mint a new artefact. A migration that silently invalidated every cached asset
 *    would cost more than the duplication it set out to remove.
 *
 * ## What "compatible" means
 *
 * Not bone names: two rigs can share every name and parent them differently, and the
 * clip then drives an arm from the hips. Not an exact skeleton: bone ids are minted per
 * asset and rest poses are fitted from each asset's own alpha, so "identical" is a
 * condition no two real rigs ever meet - it would make the library permanently empty,
 * which is the failure that looks like success.
 *
 * The address is a {@link RigSignature}: the archetype, the bone graph expressed in
 * **template roles**, each role's rest pose, and the anchors. A clip fits a rig when
 * the rig has every role the clip drives, parents those roles the same way *up to
 * intervening bones*, and carries every anchor the clip measures itself against. The
 * arithmetic that follows from that - and the ancestry rule in particular - lives in
 * `@rv/anim-engine/clips`.
 */

import { z } from 'zod';

import { Slug } from '../primitives/common';
import { AssetArchetype } from './asset-spec';
import { AnchorRole, BoneRest, RigAnchor } from './rig';
import { AnimationClip } from './asset';

/**
 * One bone of a skeleton, named by the role it plays rather than by its id.
 *
 * `rest` is the same `BoneRest` the rig itself carries, not a copy of its fields: the
 * signature has to reproduce the rig's rest geometry exactly or every proportion
 * derived from it is subtly wrong, and two spellings of one shape is how that starts.
 */
export const SignatureBone = z.object({
  role: Slug.describe('Template role, e.g. "torso", "leg-lower-left"'),
  parentRole: Slug.nullable().describe('null for the single root bone'),
  rest: BoneRest,
});
export type SignatureBone = z.infer<typeof SignatureBone>;

/**
 * A standard anchor, as the signature sees it.
 *
 * Only anchors with a {@link AnchorRole} appear: a `saddle` is a real anchor and means
 * nothing to another rig, so carrying it here would suggest a comparison that cannot
 * be made.
 */
export const SignatureAnchor = RigAnchor.omit({ boneId: true, name: true }).extend({
  role: AnchorRole,
  boneRole: Slug,
});
export type SignatureAnchor = z.infer<typeof SignatureAnchor>;

/**
 * The compatibility address of a skeleton.
 *
 * Everything needed to decide whether a clip fits, and to rescale it if it does, with
 * nothing that identifies the asset it came from. That absence is the point: a
 * signature is shared by every biped fitted from the same template at the same
 * proportions, so a library keyed by it is a library that fills up.
 */
export const RigSignature = z
  .object({
    archetype: AssetArchetype,
    bones: z.array(SignatureBone).min(1),
    anchors: z.array(SignatureAnchor).default([]),
  })
  .superRefine((signature, ctx) => {
    const roles = new Set<string>();
    for (const [index, bone] of signature.bones.entries()) {
      if (roles.has(bone.role)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate bone role ${bone.role}`,
          path: ['bones', index, 'role'],
        });
      }
      roles.add(bone.role);
    }

    const roots = signature.bones.filter((bone) => bone.parentRole === null);
    if (roots.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: `a signature must have exactly one root bone, found ${String(roots.length)}`,
        path: ['bones'],
      });
    }

    for (const [index, bone] of signature.bones.entries()) {
      if (bone.parentRole !== null && !roles.has(bone.parentRole)) {
        ctx.addIssue({
          code: 'custom',
          message: `bone ${bone.role} references unknown parent role ${bone.parentRole}`,
          path: ['bones', index, 'parentRole'],
        });
      }
    }

    // Same reasoning as the rig's own cycle check: composing rest poses walks the
    // parent chain, and a cycle would not terminate. Rejected here so a hand-written or
    // machine-derived signature cannot hang the retargeter.
    const parentOf = new Map(signature.bones.map((bone) => [bone.role, bone.parentRole]));
    for (const bone of signature.bones) {
      const seen = new Set<string>([bone.role]);
      let cursor = bone.parentRole;
      while (cursor !== null) {
        if (seen.has(cursor)) {
          ctx.addIssue({
            code: 'custom',
            message: `bone role hierarchy contains a cycle through ${bone.role}`,
            path: ['bones'],
          });
          break;
        }
        seen.add(cursor);
        cursor = parentOf.get(cursor) ?? null;
      }
    }

    const anchorRoles = new Set<string>();
    for (const [index, anchor] of signature.anchors.entries()) {
      if (!roles.has(anchor.boneRole)) {
        ctx.addIssue({
          code: 'custom',
          message: `anchor ${anchor.role} hangs off unknown bone role ${anchor.boneRole}`,
          path: ['anchors', index, 'boneRole'],
        });
      }
      if (anchorRoles.has(anchor.role)) {
        ctx.addIssue({
          code: 'custom',
          message: `two anchors claim the ${anchor.role} role`,
          path: ['anchors', index, 'role'],
        });
      }
      anchorRoles.add(anchor.role);
    }
  });
export type RigSignature = z.infer<typeof RigSignature>;

/**
 * A clip in the library: the clip record, plus the skeleton it means something on.
 *
 * `drives` and `alignsTo` are **stored derivations**, which `features.ts` argues
 * against at length and which is worth defending here rather than assuming. The
 * argument there is that a derived copy goes stale the first time the source is edited
 * without it - true, and it does not apply: the source is the IR fragment at `irHash`,
 * and a content-addressed document cannot be edited in place. A new fragment is a new
 * hash and therefore a new entry.
 *
 * What they buy is the reason a library is a library at all: resolving "which clips fit
 * this rig" must not read every fragment in the store. `drives` is the index that makes
 * the search a comparison of two small arrays instead of N document loads.
 * `clipDrivenRoles` in `@rv/anim-engine` derives the same list from a fragment, so the
 * stored value can be checked rather than trusted.
 */
export const ClipLibraryEntry = AnimationClip.extend({
  /** The skeleton the fragment was authored against. Retargeting measures against it. */
  sourceRig: RigSignature,
  /** Bone roles the fragment actually animates. A rig missing one of these cannot play it. */
  drives: z.array(Slug).min(1),
  /**
   * Anchors the motion is measured against.
   *
   * A walk cycle aligns to `ground`: its stride and its bounce only mean anything
   * relative to the plane the feet stand on. A `talk` clip aligns to nothing and fits
   * any rig with the roles.
   */
  alignsTo: z.array(AnchorRole).default([]),
}).superRefine((entry, ctx) => {
  // A clip that drives a role its own source rig does not have, or measures itself
  // against an anchor that rig does not carry, is unretargetable to *anything*: there
  // is no source proportion to scale from. It is the same dangling reference the rig
  // rejects, one level up, and it is just as silent - the clip is simply never selected.
  const roles = new Set(entry.sourceRig.bones.map((bone) => bone.role));
  for (const [index, role] of entry.drives.entries()) {
    if (!roles.has(role)) {
      ctx.addIssue({
        code: 'custom',
        message: `clip drives role ${role}, which its source rig does not have`,
        path: ['drives', index],
      });
    }
  }

  const anchors = new Set<string>(entry.sourceRig.anchors.map((anchor) => anchor.role));
  for (const [index, role] of entry.alignsTo.entries()) {
    if (!anchors.has(role)) {
      ctx.addIssue({
        code: 'custom',
        message: `clip aligns to the ${role} anchor, which its source rig does not have`,
        path: ['alignsTo', index],
      });
    }
  }
});
export type ClipLibraryEntry = z.infer<typeof ClipLibraryEntry>;
