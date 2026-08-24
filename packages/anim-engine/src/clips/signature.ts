/**
 * Turning a rig into the address a clip is filed under, and measuring it.
 *
 * A `RigSignature` is a skeleton with the asset filed off: roles instead of bone ids,
 * rest poses instead of pixels, and the standard anchors. Deriving one is mechanical;
 * the interesting part is the two measurements taken from it, because they are what
 * retargeting multiplies by.
 *
 * ## Stature, and why the anchors do the measuring
 *
 * `head` to `ground` - and only geometry when a rig carries neither. That is the
 * §41 sentence "retargeting aligns to anchors" turned into arithmetic: a stride is
 * proportional to how far a figure stands above the plane it stands on, and every rig
 * that declares those two points agrees about what that means. Falling back to the
 * vertical extent of the bones is a proxy, not an equal: it includes a raised arm and a
 * trailing tail, so a rig with anchors measures better than one without. That is the
 * incentive, and it is deliberate.
 *
 * ## Frame length, and why a bone is measured by its parent
 *
 * A track's `position` value is a translation **in its parent's space**. The natural
 * yardstick in that space is the parent bone's own reach: a hand that swings 8 px from
 * a 40 px forearm should swing 16 px from an 80 px one. A root role has no parent, and
 * its translations are scene-space body carry - stride, bounce - so it is measured
 * against stature instead. A parent with no length falls back the same way, because a
 * zero-length bone carries no information and guessing from it would silently freeze
 * the motion.
 */

import {
  assertDefined,
  ValidationError,
  type AppError,
  type Result,
  err,
  ok,
} from '@rv/shared-kernel';
import type {
  AnchorRole,
  AnimationIR,
  BoneId,
  RigSignature,
  SignatureAnchor,
  SignatureBone,
  Transform2D,
  Vec2,
} from '@rv/contracts';
import { type Rig, anchorRoleOf } from '@rv/contracts';

import { composeTransform, identityTransform, transformPoint } from '../transform';

/**
 * The signature of a rig.
 *
 * Fails when two bones share a role. `Rig` guarantees unique bone *ids* and says
 * nothing about roles, and it is right not to - a role is a template label and the rig
 * is the fitted result. But a signature is addressed *by* role, and a role that
 * resolves to two bones resolves to neither: the clip would drive whichever one the
 * array happened to list first. Returning the failure rather than picking one is the
 * difference between "this rig cannot use the library" and a limb that animates at
 * random.
 */
export function rigSignature(rig: Rig): Result<RigSignature, AppError> {
  const roleOf = new Map<BoneId, string>();
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const bone of rig.bones) {
    if (seen.has(bone.role)) duplicates.push(bone.role);
    seen.add(bone.role);
    roleOf.set(bone.id, bone.role);
  }

  if (duplicates.length > 0) {
    return err(
      new ValidationError({
        message: `Rig ${rig.id} has ${String(duplicates.length)} bone role(s) used more than once, so it cannot be addressed by role`,
        context: { rigId: rig.id, duplicates },
      }),
    );
  }

  const bones: SignatureBone[] = rig.bones.map((bone) => ({
    role: bone.role,
    parentRole: bone.parentId === null ? null : roleFor(roleOf, bone.parentId),
    rest: bone.rest,
  }));

  // Anchors with no standard role are dropped rather than carried. A `saddle` is a real
  // anchor and means nothing to another skeleton, so putting it in a *comparison* key
  // would suggest a comparison that cannot be made.
  const anchors: SignatureAnchor[] = [];
  for (const anchor of rig.anchors) {
    const role = anchorRoleOf(anchor);
    if (role === undefined) continue;
    anchors.push({
      role,
      boneRole: roleFor(roleOf, anchor.boneId),
      offset: anchor.offset,
      rotation: anchor.rotation,
    });
  }

  return ok({ archetype: rig.archetype, bones, anchors });
}

function roleFor(roleOf: ReadonlyMap<BoneId, string>, boneId: BoneId): string {
  // `Rig` rejects a parent id and an anchor bone id that are not in the rig, so both
  // lookups are total. A violation is a programmer error, not a caller's problem.
  const role = roleOf.get(boneId);
  assertDefined(role, `role for bone ${boneId}`);
  return role;
}

// ── measuring a signature ───────────────────────────────────────────────────

export function boneByRole(signature: RigSignature, role: string): SignatureBone | undefined {
  return signature.bones.find((bone) => bone.role === role);
}

/** Every bone's rest transform in world space, keyed by role. */
export function signatureRestWorlds(signature: RigSignature): ReadonlyMap<string, Transform2D> {
  const worlds = new Map<string, Transform2D>();
  for (const bone of orderRolesParentFirst(signature)) {
    const local: Transform2D = {
      position: bone.rest.position,
      rotation: bone.rest.rotation,
      scale: bone.rest.scale,
      skew: { x: 0, y: 0 },
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    };
    let parent = identityTransform();
    if (bone.parentRole !== null) {
      const found = worlds.get(bone.parentRole);
      assertDefined(found, `parent rest world for ${bone.parentRole}`);
      parent = found;
    }
    worlds.set(bone.role, composeTransform(parent, local));
  }
  return worlds;
}

/**
 * Roles ordered so every parent precedes its children.
 *
 * Exported because compatibility needs the same walk to build ancestor sets, and a
 * second implementation of "parent first" is a second place to get a cycle guard wrong.
 */
export function orderRolesParentFirst(signature: RigSignature): readonly SignatureBone[] {
  const byParent = new Map<string | null, SignatureBone[]>();
  for (const bone of signature.bones) {
    const bucket = byParent.get(bone.parentRole);
    if (bucket === undefined) byParent.set(bone.parentRole, [bone]);
    else bucket.push(bone);
  }

  const ordered: SignatureBone[] = [];
  const visit = (parentRole: string | null): void => {
    for (const bone of byParent.get(parentRole) ?? []) {
      ordered.push(bone);
      visit(bone.role);
    }
  };
  visit(null);
  return ordered;
}

/** Where a standard anchor sits in the rest pose, or `undefined` if the rig has none. */
export function signatureAnchorPoint(signature: RigSignature, role: AnchorRole): Vec2 | undefined {
  const anchor = signature.anchors.find((candidate) => candidate.role === role);
  if (anchor === undefined) return undefined;
  const worlds = signatureRestWorlds(signature);
  const bone = worlds.get(anchor.boneRole);
  // `RigSignature` rejects an anchor on a role it does not have, and the walk above
  // reaches every role, so this is total.
  assertDefined(bone, `rest world for anchor bone role ${anchor.boneRole}`);
  return transformPoint(bone, anchor.offset);
}

/**
 * How tall the rig stands: `head` to `ground` where both are declared.
 *
 * Returns 0 for a skeleton with no measurable extent at all - a single zero-length
 * bone. That is a real answer and callers must branch on it rather than divide by it;
 * `retargetClip` refuses such a source explicitly.
 */
export function statureOf(signature: RigSignature): number {
  const worlds = signatureRestWorlds(signature);
  const extent = verticalExtent(worlds);

  const groundY = signatureAnchorPoint(signature, 'ground')?.y ?? extent.max;
  const crownY = signatureAnchorPoint(signature, 'head')?.y ?? extent.min;
  const span = Math.abs(groundY - crownY);
  if (span > 0) return span;

  // A flat or single-bone skeleton has no vertical extent. Its root bone's own reach is
  // the only length it carries.
  const root = signature.bones.find((bone) => bone.parentRole === null);
  assertDefined(root, 'root bone of the signature');
  return root.rest.length;
}

function verticalExtent(worlds: ReadonlyMap<string, Transform2D>): {
  readonly min: number;
  readonly max: number;
} {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const world of worlds.values()) {
    if (world.position.y < min) min = world.position.y;
    if (world.position.y > max) max = world.position.y;
  }
  return { min, max };
}

/**
 * The yardstick a translation on `role` is measured in.
 *
 * `undefined` when the signature has no such role, which is the caller's cue that the
 * clip does not fit at all rather than that it needs scaling by one.
 */
export function frameLengthOf(signature: RigSignature, role: string): number | undefined {
  const bone = boneByRole(signature, role);
  if (bone === undefined) return undefined;

  let parentLength = 0;
  if (bone.parentRole !== null) {
    const parent = boneByRole(signature, bone.parentRole);
    assertDefined(parent, `parent bone role ${bone.parentRole}`);
    parentLength = parent.rest.length;
  }

  return parentLength > 0 ? parentLength : statureOf(signature);
}

/**
 * Every role's complete ancestor set, computed in one parent-first pass.
 *
 * Built for the whole signature at once rather than walked per query: the walk-per-query
 * form needs a cycle guard and a missing-parent fallback on every hop, and both of those
 * are branches that a validated signature can never take - unreachable code in a package
 * that owes 100 %. One pass in dependency order needs neither.
 */
export function ancestorsByRole(signature: RigSignature): ReadonlyMap<string, ReadonlySet<string>> {
  const ancestors = new Map<string, ReadonlySet<string>>();
  for (const bone of orderRolesParentFirst(signature)) {
    if (bone.parentRole === null) {
      ancestors.set(bone.role, new Set<string>());
      continue;
    }
    const inherited = ancestors.get(bone.parentRole);
    assertDefined(inherited, `ancestors of ${bone.parentRole}`);
    ancestors.set(bone.role, new Set<string>([bone.parentRole, ...inherited]));
  }
  return ancestors;
}

// ── what a fragment asks of a skeleton ──────────────────────────────────────

/**
 * The bone roles a clip fragment actually animates, in document order.
 *
 * The derivation behind `ClipLibraryEntry.drives`, so the stored index can be checked
 * rather than trusted. A **disabled** behaviour drives nothing - nothing evaluates it -
 * which is the same call `detectIrFeatures` makes about the same records, and for the
 * same reason: a requirement nothing produces would make a clip unplayable on rigs it
 * would in fact have played on perfectly.
 */
export function clipDrivenRoles(ir: AnimationIR): readonly string[] {
  return rolesWithRecords(ir, false);
}

/**
 * Every role carrying a track or a behaviour record, enabled or not.
 *
 * What *retargeting* must rewrite, which is a wider set than what the clip drives. A
 * disabled `walk-cycle` contributes nothing today and is a stride length that will be
 * wrong the moment someone ticks the box - so it is rescaled with everything else, while
 * still being excluded from the compatibility requirements that decide whether the clip
 * is offered at all.
 */
export function clipAnimatedRoles(ir: AnimationIR): readonly string[] {
  return rolesWithRecords(ir, true);
}

function rolesWithRecords(ir: AnimationIR, includeDisabled: boolean): readonly string[] {
  const targeted = new Set<string>();
  for (const track of ir.tracks) targeted.add(track.nodeId);
  for (const behaviour of ir.behaviours) {
    if (includeDisabled || behaviour.enabled) targeted.add(behaviour.nodeId);
  }

  const roles: string[] = [];
  for (const node of ir.nodes) {
    if (!targeted.has(node.id)) continue;
    if (roles.includes(node.name)) continue;
    roles.push(node.name);
  }
  return roles;
}
