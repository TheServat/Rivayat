/**
 * Rigs - the reason animation costs nothing per second.
 *
 * A generated image is a dead rectangle. A rig turns a set of transparent parts into
 * something that can be posed, so motion becomes arithmetic over bones instead of a
 * per-frame call to an image model. Every clip, every sprite sheet and every export
 * is downstream of this structure.
 *
 * Rigs are fitted from an **archetype template** rather than authored per asset: the
 * spec already named the parts and their roles, so binding a `tree` or a `winged`
 * template to them is mechanical.
 */

import { z } from 'zod';

import { BoneId, PartId, RigId } from '../primitives/ids';
import { Degrees, Label, Slug, Unit01, Vec2 } from '../primitives/common';
import { AssetArchetype } from './asset-spec';

/**
 * A bone's rest pose, expressed relative to its parent.
 *
 * Local rather than world, so moving a parent carries its children for free and a
 * sub-tree can be reused across assets that share a limb structure.
 */
export const BoneRest = z.object({
  position: Vec2.describe('Origin in the parent bone’s local space'),
  rotation: Degrees.default(0),
  length: z.number().nonnegative().describe('Used for IK and for drawing the bone in the editor'),
  scale: Vec2.default({ x: 1, y: 1 }),
});
export type BoneRest = z.infer<typeof BoneRest>;

/**
 * Limits on how a joint may move.
 *
 * Without these an LLM-authored or IK-solved pose will happily bend an elbow
 * backwards. Cheap to declare, and they turn a whole class of broken frames into an
 * impossible state.
 */
export const BoneConstraint = z.object({
  minRotation: Degrees.optional(),
  maxRotation: Degrees.optional(),
  /** Rotation is copied from another bone, scaled. Drives mirrored or geared parts. */
  copyRotationFrom: BoneId.optional(),
  copyRotationFactor: z.number().default(1),
  /** Spring-driven trailing motion: hair, cloth, tails, antennae. */
  springStiffness: Unit01.optional(),
  springDamping: Unit01.optional(),
});
export type BoneConstraint = z.infer<typeof BoneConstraint>;

export const Bone = z.object({
  id: BoneId,
  name: Slug,
  role: Slug.describe('Template role, e.g. "spine", "wing-l", "branch-2"'),
  parentId: BoneId.nullable().describe('null for the single root bone'),
  rest: BoneRest,
  /** Parts that move rigidly with this bone. Deformable parts bind via a mesh instead. */
  partIds: z.array(PartId).default([]),
  constraint: BoneConstraint.optional(),
  /** Draw order override for parts on this bone, when it must differ from the part's own. */
  zOrderBias: z.number().int().default(0),
});
export type Bone = z.infer<typeof Bone>;

/**
 * A weighted vertex of a deformation mesh.
 *
 * Weights must sum to 1 across the influences, otherwise the vertex shrinks toward the
 * origin as the rig moves - a subtle, maddening artefact. The schema enforces it.
 */
export const MeshVertex = z.object({
  /** Position in the part's own normalised space. */
  uv: Vec2,
  influences: z
    .array(z.object({ boneId: BoneId, weight: Unit01 }))
    .min(1)
    .max(4)
    .describe('Up to 4 bones per vertex; more buys nothing at 2D scale'),
});
export type MeshVertex = z.infer<typeof MeshVertex>;

export const DeformMesh = z
  .object({
    partId: PartId,
    /** Regular grid resolution used to seed the mesh before any hand editing. */
    rows: z.number().int().min(2).max(64),
    cols: z.number().int().min(2).max(64),
    vertices: z.array(MeshVertex).min(4),
    /** Triangle indices into `vertices`, three per face. */
    indices: z.array(z.number().int().nonnegative()),
  })
  .refine((mesh) => mesh.indices.length % 3 === 0, {
    message: 'indices must describe whole triangles (length divisible by 3)',
    path: ['indices'],
  })
  // An index past the end of `vertices` is a dangling reference into the mesh's own
  // array. The deformer would read `undefined` and emit NaN geometry - a frame of
  // nothing, several thousand frames into a render.
  .refine((mesh) => mesh.indices.every((index) => index < mesh.vertices.length), {
    message: 'every index must address a vertex this mesh actually has',
    path: ['indices'],
  })
  .refine(
    (mesh) =>
      mesh.vertices.every((vertex) => {
        const total = vertex.influences.reduce((sum, influence) => sum + influence.weight, 0);
        return Math.abs(total - 1) < 1e-4;
      }),
    {
      message: 'every vertex’s influence weights must sum to 1',
      path: ['vertices'],
    },
  );
export type DeformMesh = z.infer<typeof DeformMesh>;

/**
 * Inverse kinematics chain.
 *
 * Lets the choreographer say "put the hand here" instead of solving three rotations,
 * which is the difference between an LLM being able to author a pose and not.
 */
export const IkChain = z.object({
  id: Slug,
  rootBoneId: BoneId,
  endBoneId: BoneId,
  /** How many bones the solver may rotate. Guards against a chain reaching the root. */
  chainLength: z.number().int().min(2).max(8),
  iterations: z.number().int().min(1).max(32).default(8),
  /** Preferred bend direction, so an elbow does not flip between frames. */
  poleAngle: Degrees.default(0),
});
export type IkChain = z.infer<typeof IkChain>;

/**
 * The anchors that mean the same thing on every rig.
 *
 * An anchor's `name` is free-form on purpose - a rig may declare `lantern-hook` or
 * `saddle` and a shot may address it - but a *free-form* name is useless to anything
 * that has to compare two skeletons, which is exactly what retargeting does. A walk
 * cycle authored on one biped can only be measured against another if both agree on
 * where the ground is; "wherever this particular rig happened to call it" is not an
 * agreement.
 *
 * So the vocabulary is closed and small, and it is the *semantic* half of an anchor:
 * `ground` is the plane the feet stand on, `head` is the crown, and the distance
 * between the two is what a stride is proportional to. Everything else here exists
 * because a prop, a balloon or a gaze needs somewhere to hang.
 *
 * The design document (§33) spells these `left_hand` / `right_foot`. They are spelled
 * `grip-left` / `foot-left` here for two reasons: `Slug` is lowercase-hyphenated
 * throughout the system, and the rig blueprints already mint `grip-left`, `grip-right`,
 * `speech` and `eye-line` by those names - so every biped produced so far acquires its
 * roles for free through {@link anchorRoleOf} rather than needing a migration.
 */
export const AnchorRole = z.enum([
  'root',
  'head',
  'eye-line',
  'speech',
  'grip-left',
  'grip-right',
  'foot-left',
  'foot-right',
  'ground',
  /** The far end of a non-character rig: a branch tip, a flame tip, a wisp. */
  'tip',
]);
export type AnchorRole = z.infer<typeof AnchorRole>;

/**
 * A named attachment point.
 *
 * Where a prop goes in a hand, where a speech balloon anchors, where a particle
 * emitter sits. Declared on the rig so a shot can say "hold the lantern" without
 * knowing anything about bone indices.
 *
 * The offset is in the **named bone's local space**, which is what makes an anchor a
 * point on the asset rather than a point on the canvas: it rotates and travels with
 * the bone, so a sword held at `grip-right` stays in the hand for the whole clip
 * without a single line of code naming a bone.
 */
export const RigAnchor = z.object({
  name: Slug,
  /**
   * Which standard point this is, when it is one.
   *
   * Optional because most anchors are not standard - a `saddle` is a real anchor with
   * no cross-rig meaning - and because absent is the honest answer for a rig fitted
   * before the vocabulary existed. Retargeting reads this, not `name`.
   */
  role: AnchorRole.optional(),
  boneId: BoneId,
  offset: Vec2.default({ x: 0, y: 0 }).describe('In the named bone’s local space'),
  rotation: Degrees.default(0),
});
export type RigAnchor = z.infer<typeof RigAnchor>;

/**
 * The standard role this anchor fills, or `undefined` if it fills none.
 *
 * Falls back to reading the `name` as a role, which is what lets the rigs the
 * blueprints already produce - `speech`, `eye-line`, `grip-left`, `grip-right` - carry
 * their roles without being rewritten. An explicit `role` always wins, so a rig that
 * happens to call its saddle `head` is not silently reinterpreted.
 *
 * Exported because three packages need the same answer - the rig's own validation,
 * retargeting in `@rv/anim-engine`, and rig fitting in `@rv/asset-engine` - and a
 * second copy of this fallback is a second place for it to drift.
 */
export function anchorRoleOf(anchor: Pick<RigAnchor, 'name' | 'role'>): AnchorRole | undefined {
  if (anchor.role !== undefined) return anchor.role;
  const asRole = AnchorRole.safeParse(anchor.name);
  return asRole.success ? asRole.data : undefined;
}

export const Rig = z
  .object({
    id: RigId,
    archetype: AssetArchetype,
    /** Which template this was fitted from, for regeneration and upgrades. */
    templateId: Slug,
    bones: z.array(Bone).min(1),
    meshes: z.array(DeformMesh).default([]),
    ikChains: z.array(IkChain).default([]),
    anchors: z.array(RigAnchor).default([]),
    label: Label.optional(),
  })
  .superRefine((rig, ctx) => {
    const ids = new Set<string>();
    for (const bone of rig.bones) {
      if (ids.has(bone.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate bone id ${bone.id}`, path: ['bones'] });
      }
      ids.add(bone.id);
    }

    const roots = rig.bones.filter((bone) => bone.parentId === null);
    if (roots.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: `a rig must have exactly one root bone, found ${String(roots.length)}`,
        path: ['bones'],
      });
    }

    for (const bone of rig.bones) {
      if (bone.parentId !== null && !ids.has(bone.parentId)) {
        ctx.addIssue({
          code: 'custom',
          message: `bone ${bone.name} references unknown parent ${bone.parentId}`,
          path: ['bones'],
        });
      }
    }

    // Bones are not the only thing in a rig that points at a bone. Meshes bind
    // vertices to them, IK chains span them, anchors hang off them and a constraint can
    // copy one's rotation - and until now only `parentId` was checked, so every other
    // dangling reference survived validation and became a silent no-op in the poser: a
    // limb that never bends, a prop anchored to nothing.
    for (const [index, mesh] of rig.meshes.entries()) {
      for (const [vertexIndex, vertex] of mesh.vertices.entries()) {
        for (const influence of vertex.influences) {
          if (!ids.has(influence.boneId)) {
            ctx.addIssue({
              code: 'custom',
              message: `mesh vertex is weighted to unknown bone ${influence.boneId}`,
              path: ['meshes', index, 'vertices', vertexIndex, 'influences'],
            });
          }
        }
      }
    }

    for (const [index, chain] of rig.ikChains.entries()) {
      for (const end of ['rootBoneId', 'endBoneId'] as const) {
        if (!ids.has(chain[end])) {
          ctx.addIssue({
            code: 'custom',
            message: `ik chain ${chain.id} references unknown bone ${chain[end]}`,
            path: ['ikChains', index, end],
          });
        }
      }
    }

    // An anchor is *addressed by name* - "hold the lantern at `grip-right`" - and by
    // role once retargeting is involved. Both are lookups, and a lookup with two
    // answers has none: the prop lands on whichever anchor the array happened to list
    // first, and it changes the day a rig template is re-ordered. This is the same
    // class of bug as the dangling references below it - a reference that resolves to
    // nothing versus one that resolves to the wrong thing - and it is equally silent.
    const anchorNames = new Set<string>();
    const anchorRoles = new Set<string>();
    for (const [index, anchor] of rig.anchors.entries()) {
      if (!ids.has(anchor.boneId)) {
        ctx.addIssue({
          code: 'custom',
          message: `anchor ${anchor.name} hangs off unknown bone ${anchor.boneId}`,
          path: ['anchors', index, 'boneId'],
        });
      }

      if (anchorNames.has(anchor.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate anchor name ${anchor.name}`,
          path: ['anchors', index, 'name'],
        });
      }
      anchorNames.add(anchor.name);

      const role = anchorRoleOf(anchor);
      if (role !== undefined) {
        if (anchorRoles.has(role)) {
          ctx.addIssue({
            code: 'custom',
            message: `two anchors claim the ${role} role`,
            path: ['anchors', index, 'role'],
          });
        }
        anchorRoles.add(role);
      }
    }

    for (const [index, bone] of rig.bones.entries()) {
      const copyFrom = bone.constraint?.copyRotationFrom;
      if (copyFrom !== undefined && !ids.has(copyFrom)) {
        ctx.addIssue({
          code: 'custom',
          message: `bone ${bone.name} copies rotation from unknown bone ${copyFrom}`,
          path: ['bones', index, 'constraint', 'copyRotationFrom'],
        });
      }
    }

    // A cycle would make evaluation non-terminating, so it is rejected here rather
    // than discovered at render time.
    const parentOf = new Map(rig.bones.map((bone) => [bone.id, bone.parentId]));
    for (const bone of rig.bones) {
      const seen = new Set<string>([bone.id]);
      let cursor = bone.parentId;
      while (cursor !== null) {
        if (seen.has(cursor)) {
          ctx.addIssue({
            code: 'custom',
            message: `bone hierarchy contains a cycle through ${bone.name}`,
            path: ['bones'],
          });
          break;
        }
        seen.add(cursor);
        cursor = parentOf.get(cursor) ?? null;
      }
    }
  });
export type Rig = z.infer<typeof Rig>;

/**
 * The reusable skeleton for an archetype, before it is bound to real parts.
 *
 * `tree`, `biped`, `winged` and friends each ship one of these plus a default clip
 * set, which is why a newly generated asset is animatable within seconds of arriving
 * and without an LLM call.
 */
export const RigTemplate = z.object({
  id: Slug,
  archetype: AssetArchetype,
  label: Label,
  description: z.string(),
  /** Bones with roles but no ids; ids are minted when the template is instantiated. */
  bones: z.array(
    Bone.omit({ id: true, parentId: true, partIds: true }).extend({
      parentRole: Slug.nullable(),
    }),
  ),
  ikChains: z.array(
    IkChain.omit({ rootBoneId: true, endBoneId: true }).extend({
      rootRole: Slug,
      endRole: Slug,
    }),
  ),
  anchors: z.array(RigAnchor.omit({ boneId: true }).extend({ boneRole: Slug })),
  /** Clip names this template knows how to generate, e.g. ["idle", "sway", "gust"]. */
  clipNames: z.array(Slug).min(1),
});
export type RigTemplate = z.infer<typeof RigTemplate>;
