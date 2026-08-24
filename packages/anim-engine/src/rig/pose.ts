/**
 * Posing a skeleton, and resolving the named points on it.
 *
 * The IR evaluator answers "where is this *node*". A rig answers "where is this
 * *bone*", and the two are not the same question: a clip fragment's nodes carry the
 * animation and nothing else - every one of them sits at the identity, because a
 * fragment is shared between every asset that plays it and cannot know any particular
 * skeleton's rest pose. The geometry lives on the rig. Combining them is this file.
 *
 * `ResolvedNode.bonePose` in the IR is the eventual home for the result, and it is
 * deliberately still empty: filling it would change `evaluate`'s output, and every
 * golden frame hash downstream is a hash of that output. Posing is a separate call
 * until there is a reason to pay that price.
 *
 * ## Why anchors, and why here
 *
 * An anchor is a named point in a bone's local space (§33). Two things need one, and
 * neither may name a bone:
 *
 *  - **Retargeting** measures a skeleton against its own anchors - the stature between
 *    `head` and `ground` is what a stride is proportional to.
 *  - **Props.** "Hold the lantern at `grip-right`" has to survive a rig being refitted,
 *    a template gaining a wrist bone, and a second character with different arms. A
 *    bone id in a shot description survives none of those.
 *
 * {@link anchorPoint} is the whole of that indirection: a name in, a world point out,
 * and a `NotFoundError` when the rig does not carry it - because an anchor that
 * silently resolves to the origin puts the sword on the floor and says nothing.
 */

import { NotFoundError, type AppError, type Result, err, must, ok } from '@rv/shared-kernel';
import type {
  AnchorRole,
  AnimationIR,
  BoneId,
  BoneRest,
  NodeAttachment,
  NodeId,
  Rig,
  RigAnchor,
  SceneSnapshot,
  Transform2D,
  Vec2,
} from '@rv/contracts';
import { anchorRoleOf } from '@rv/contracts';

import {
  composeTransform,
  decomposeTransform,
  identityTransform,
  transformPoint,
} from '../transform';

/** Where every bone of a rig ended up, in world space. */
export type RigPose = ReadonlyMap<BoneId, Transform2D>;

/**
 * A bone's rest pose as a transform.
 *
 * `length` is not part of it: a bone's length is how far it *reaches*, not how it
 * transforms its children, and folding it into the transform would scale every child
 * by the parent's length.
 */
function restLocal(rest: BoneRest): Transform2D {
  return {
    position: rest.position,
    rotation: rest.rotation,
    scale: rest.scale,
    skew: { x: 0, y: 0 },
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
  };
}

/**
 * Bones ordered so every parent precedes its children.
 *
 * The rig schema already rejects cycles and guarantees exactly one root, so this
 * terminates and reaches every bone.
 */
export function orderBonesParentFirst(rig: Rig): readonly Rig['bones'][number][] {
  const byParent = new Map<BoneId | null, Rig['bones'][number][]>();
  for (const bone of rig.bones) {
    const bucket = byParent.get(bone.parentId);
    if (bucket === undefined) byParent.set(bone.parentId, [bone]);
    else bucket.push(bone);
  }

  const ordered: Rig['bones'][number][] = [];
  const visit = (parentId: BoneId | null): void => {
    for (const bone of byParent.get(parentId) ?? []) {
      ordered.push(bone);
      visit(bone.id);
    }
  };
  visit(null);
  return ordered;
}

/**
 * The skeleton with no animation on it.
 *
 * The reference every proportion is measured from, and the pose an asset instance
 * draws when its `clipName` is omitted.
 */
export function restPose(rig: Rig): RigPose {
  return poseRig(rig, new Map());
}

/**
 * The skeleton with a per-role delta applied to each bone.
 *
 * The delta is composed **inside** the bone's rest frame - `rest ∘ delta` - so a
 * rotation turns the bone about its own origin and a translation runs along its own
 * axes. That is the standard skeletal semantics and it is what makes a clip authored on
 * one arm mean the same thing on another: the numbers are relative to the bone, not to
 * the canvas.
 *
 * A role with no delta is left at rest rather than skipped, which is what lets a clip
 * that drives four of a rig's fifteen bones play on it at all.
 */
export function poseRig(rig: Rig, deltasByRole: ReadonlyMap<string, Transform2D>): RigPose {
  const worlds = new Map<BoneId, Transform2D>();

  for (const bone of orderBonesParentFirst(rig)) {
    const delta = deltasByRole.get(bone.role);
    const rest = restLocal(bone.rest);
    const local = delta === undefined ? rest : composeTransform(rest, delta);
    const parent =
      bone.parentId === null
        ? identityTransform()
        : must(worlds, bone.parentId, 'parent bone pose');
    worlds.set(bone.id, composeTransform(parent, local));
  }

  return worlds;
}

/**
 * A clip's per-role animation deltas, recovered from an evaluated snapshot.
 *
 * The bridge between the two halves. `evaluate` hands back world transforms; a rig
 * needs locals, because rest and animation interleave down the chain. Recovering them
 * with {@link decomposeTransform} rather than adding a second evaluation path keeps one
 * set of accumulation rules - the exporters learned that lesson with the bezier solver.
 *
 * Keyed by **node name**, which in a clip fragment is the bone role it drives. That
 * convention is the entire binding between a fragment and a skeleton, and it is why a
 * fragment can be content-addressed and shared: it names roles, never bones.
 */
export function clipDeltasByRole(
  ir: AnimationIR,
  snapshot: SceneSnapshot,
): ReadonlyMap<string, Transform2D> {
  const worlds = new Map<NodeId, Transform2D>();
  for (const node of snapshot.nodes) worlds.set(node.nodeId, node.worldTransform);

  const deltas = new Map<string, Transform2D>();
  for (const node of ir.nodes) {
    // `evaluate` emits one resolved node per IR node, so both lookups are total. `must`
    // turns a mismatched (ir, snapshot) pair into a loud failure rather than a clip that
    // silently animates half a skeleton.
    const world = must(worlds, node.id, 'node world transform');
    const parent =
      node.parentId === null
        ? identityTransform()
        : must(worlds, node.parentId, 'parent node world transform');
    deltas.set(node.name, decomposeTransform(parent, world));
  }
  return deltas;
}

// ── anchors ─────────────────────────────────────────────────────────────────

/**
 * Where the named anchor is, in world space, for this pose.
 *
 * The point of the whole indirection: a shot says "hold the lantern at `grip-right`"
 * and never learns a bone id, so refitting the rig, renaming a bone or swapping the
 * character does not break the prop.
 */
export function anchorPoint(rig: Rig, pose: RigPose, name: string): Result<Vec2, AppError> {
  const frame = anchorTransform(rig, pose, name);
  return frame.ok ? ok(frame.value.position) : frame;
}

/**
 * The anchor's whole frame - position **and orientation** - for this pose.
 *
 * The form a held prop needs, and the reason the point alone is not enough: a sword whose
 * position follows the hand but whose angle does not is a sword sliding through a fist.
 * `RigAnchor.rotation` is the anchor's own offset from the bone, so a grip can be angled
 * across the palm without the bone being angled.
 *
 * This is what `NodeAttachment` in the IR resolves to. `inheritRotation: false` on the
 * attachment means the caller takes {@link anchorPoint} instead - which is what a speech
 * balloon over a tumbling character wants, since it must track a point and stay upright.
 */
export function anchorTransform(
  rig: Rig,
  pose: RigPose,
  name: string,
): Result<Transform2D, AppError> {
  const anchor = rig.anchors.find((candidate) => candidate.name === name);
  if (anchor === undefined) {
    return err(
      new NotFoundError('rig anchor', name, {
        context: { rigId: rig.id, available: rig.anchors.map((candidate) => candidate.name) },
      }),
    );
  }
  return ok(resolveAnchorFrame(pose, anchor));
}

/**
 * The same, addressed by the standard role rather than by the rig's own name for it.
 *
 * This is the form retargeting uses: `ground` means the same thing on every skeleton,
 * and `sole-of-left-boot` does not.
 */
export function anchorPointByRole(
  rig: Rig,
  pose: RigPose,
  role: AnchorRole,
): Result<Vec2, AppError> {
  const anchor = rig.anchors.find((candidate) => anchorRoleOf(candidate) === role);
  if (anchor === undefined) {
    return err(
      new NotFoundError('rig anchor role', role, {
        context: {
          rigId: rig.id,
          available: rig.anchors
            .map((candidate) => anchorRoleOf(candidate))
            .filter((candidate): candidate is AnchorRole => candidate !== undefined),
        },
      }),
    );
  }
  return ok(resolveAnchorFrame(pose, anchor).position);
}

function resolveAnchorFrame(pose: RigPose, anchor: RigAnchor): Transform2D {
  // No existence guard on the bone: `Rig` rejects an anchor hanging off a bone it does
  // not have, and `poseRig` reaches every bone. `must` turns a violation of either into
  // a loud failure rather than a prop silently landing at the origin.
  const bone = must(pose, anchor.boneId, 'anchor bone pose');
  return {
    ...bone,
    position: transformPoint(bone, anchor.offset),
    rotation: bone.rotation + anchor.rotation,
  };
}

/**
 * Where an attached node's own transform is composed from.
 *
 * The one line of arithmetic between `NodeAttachment` in the IR and a prop that stays in
 * a hand, and it is here rather than in the renderer because getting it wrong is easy and
 * silent: composing against the anchor's *point* while dropping its rotation gives a
 * sword that tracks the fist and never turns, which reads as a bug in the animation
 * rather than in the compositor.
 *
 * `inheritRotation: false` keeps the anchor's position and discards its orientation -
 * what a speech balloon over a tumbling character needs, since it must follow the mouth
 * and stay readable.
 */
export function attachmentFrame(
  rig: Rig,
  pose: RigPose,
  attachment: NodeAttachment,
): Result<Transform2D, AppError> {
  const frame = anchorTransform(rig, pose, attachment.anchor);
  if (!frame.ok) return frame;
  return ok(attachment.inheritRotation ? frame.value : { ...frame.value, rotation: 0 });
}
