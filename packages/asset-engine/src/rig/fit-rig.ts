/**
 * Binding an archetype's template to the parts that actually came back (RV-126).
 *
 * The template supplies the topology: which bone parents which, where the IK chains
 * run, where a prop is held. The parts supply the geometry: a bone whose part exists is
 * placed at that part's **alpha centroid**, because a bounding-box centre puts a
 * crescent's pivot in the gap. A bone whose part did not come back keeps the template's
 * relative pose, so a rig with a missing optional wing is still a rig.
 *
 * The archetype comes from the `AssetSpec`, never from the pixels - RV-126 keeps a
 * source-scan test on exactly that. Everything measured here is measured from parts the
 * spec already named; nothing infers *what* a part is from how it looks.
 */

import { type AppError, type Result, ValidationError, err, ok } from '@rv/shared-kernel';
import {
  type AssetSpec,
  type Bone,
  type BoneId,
  type DeformMesh,
  type Ids,
  type Part,
  Rig,
  type RigTemplate,
  type Vec2,
} from '@rv/contracts';

import { type MeshBoneCandidate, buildDeformMesh } from './mesh';
import { templateFor } from './templates/index';

export interface FitRigInput {
  readonly spec: AssetSpec;
  readonly parts: readonly Part[];
  /**
   * Lets a rig be fitted to fewer parts than the plan asked for.
   *
   * The single-layer fallback of RV-125 needs it: one part, the whole template, still
   * animatable by mesh deform. Off by default, because outside that fallback a missing
   * required part means the split went wrong and a rig built over it hides the fault.
   */
  readonly allowMissingParts?: boolean;
  /** Mesh grid resolution for deformable parts. */
  readonly meshRows?: number;
  readonly meshCols?: number;
}

export interface FitRigDeps {
  readonly ids: Ids;
}

export class FitRigUseCase {
  readonly #ids: Ids;

  constructor(deps: FitRigDeps) {
    this.#ids = deps.ids;
  }

  execute(input: FitRigInput): Result<Rig, AppError> {
    const template = templateFor(input.spec.archetype);
    const partsByRole = new Map(input.parts.map((part) => [part.role, part]));

    const missing = input.spec.parts
      .filter((plan) => !plan.optional && !partsByRole.has(plan.role))
      .map((plan) => plan.name);
    if (missing.length > 0 && input.allowMissingParts !== true) {
      return err(
        new ValidationError({
          message: `cannot fit a ${input.spec.archetype} rig: required parts are missing`,
          context: { semanticKey: input.spec.semanticKey, missing },
          issues: missing.map((name) => `parts.${name}: planned and required, but not produced`),
        }),
      );
    }

    const { bones, worldByRole } = this.#placeBones(template, input, partsByRole);
    const boneIdByRole = new Map(bones.map((bone) => [bone.role, bone.id]));

    const meshes = this.#buildMeshes(input, partsByRole, boneIdByRole, worldByRole);

    const parsed = Rig.safeParse({
      id: this.#ids.rig(),
      archetype: input.spec.archetype,
      templateId: template.id,
      bones,
      meshes,
      ikChains: template.ikChains.flatMap((chain) => {
        const rootBoneId = boneIdByRole.get(chain.rootRole);
        const endBoneId = boneIdByRole.get(chain.endRole);
        if (rootBoneId === undefined || endBoneId === undefined) return [];
        return [
          {
            id: chain.id,
            rootBoneId,
            endBoneId,
            chainLength: chain.chainLength,
            iterations: chain.iterations,
            poleAngle: chain.poleAngle,
          },
        ];
      }),
      anchors: template.anchors.flatMap((anchor) => {
        const boneId = boneIdByRole.get(anchor.boneRole);
        if (boneId === undefined) return [];
        return [
          {
            name: anchor.name,
            boneId,
            offset: {
              x: anchor.offset.x * input.spec.canvas.width,
              y: anchor.offset.y * input.spec.canvas.height,
            },
            rotation: anchor.rotation,
          },
        ];
      }),
      label: template.label,
    });

    if (!parsed.success) {
      return err(
        new ValidationError({
          message: 'the fitted rig does not validate',
          context: { semanticKey: input.spec.semanticKey, templateId: template.id },
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        }),
      );
    }

    return ok(parsed.data);
  }

  /**
   * One parent-first pass that resolves every bone's world position, then its local one.
   *
   * Two coordinate systems meet here and the conversion is the whole job: the template
   * speaks in canvas fractions relative to a parent, a part's centroid is absolute
   * canvas pixels, and `BoneRest.position` must come out as pixels relative to the
   * parent. Doing it in one pass is what keeps a measured child of an unmeasured parent
   * correct.
   */
  #placeBones(
    template: RigTemplate,
    input: FitRigInput,
    partsByRole: ReadonlyMap<string, Part>,
  ): { bones: Bone[]; worldByRole: Map<string, Vec2> } {
    const canvas = input.spec.canvas;
    const idByRole = new Map<string, BoneId>();
    const worldByRole = new Map<string, Vec2>();
    const bones: Bone[] = [];

    for (const templateBone of template.bones) {
      const id = this.#ids.bone();
      idByRole.set(templateBone.role, id);

      const parentWorld =
        templateBone.parentRole === null
          ? { x: 0, y: 0 }
          : (worldByRole.get(templateBone.parentRole) ?? { x: 0, y: 0 });

      const part = partsByRole.get(templateBone.role);
      const world =
        part === undefined
          ? {
              x: parentWorld.x + templateBone.rest.position.x * canvas.width,
              y: parentWorld.y + templateBone.rest.position.y * canvas.height,
            }
          : centroidOf(part);
      worldByRole.set(templateBone.role, world);

      const parentId =
        templateBone.parentRole === null ? null : (idByRole.get(templateBone.parentRole) ?? null);

      bones.push({
        id,
        name: templateBone.name,
        role: templateBone.role,
        parentId,
        rest: {
          position: { x: world.x - parentWorld.x, y: world.y - parentWorld.y },
          rotation: templateBone.rest.rotation,
          // Lengths stay proportional to the canvas: an IK solver and the editor both
          // draw bones in pixels, and a template length of 0.16 means nothing there.
          length: templateBone.rest.length * canvas.height,
          scale: templateBone.rest.scale,
        },
        // A deformable part is bound by mesh weights instead, per `Bone.partIds`.
        partIds: part === undefined || part.deformable ? [] : [part.id],
        ...(templateBone.constraint === undefined ? {} : { constraint: templateBone.constraint }),
        zOrderBias: templateBone.zOrderBias,
      });
    }

    return { bones, worldByRole };
  }

  /**
   * A mesh per deformable part, weighted to its own bone and that bone's neighbours.
   *
   * Neighbours rather than every bone in the rig: a canopy blending into a foot is not
   * secondary motion, it is a bug, and restricting the candidate set is cheaper and
   * more predictable than tuning a falloff until it stops happening.
   */
  #buildMeshes(
    input: FitRigInput,
    partsByRole: ReadonlyMap<string, Part>,
    boneIdByRole: ReadonlyMap<string, BoneId>,
    worldByRole: ReadonlyMap<string, Vec2>,
  ): DeformMesh[] {
    const template = templateFor(input.spec.archetype);
    const parentOf = new Map(template.bones.map((bone) => [bone.role, bone.parentRole]));
    const childrenOf = new Map<string, string[]>();
    for (const bone of template.bones) {
      if (bone.parentRole === null) continue;
      const bucket = childrenOf.get(bone.parentRole);
      if (bucket === undefined) childrenOf.set(bone.parentRole, [bone.role]);
      else bucket.push(bone.role);
    }

    const meshes: DeformMesh[] = [];
    for (const [role, part] of partsByRole) {
      if (!part.deformable) continue;
      const ownBoneId = boneIdByRole.get(role);
      if (ownBoneId === undefined) continue;

      const neighbourRoles = [
        role,
        parentOf.get(role) ?? null,
        ...(childrenOf.get(role) ?? []),
      ].filter((candidate): candidate is string => candidate !== null);

      const bones: MeshBoneCandidate[] = [];
      for (const neighbour of neighbourRoles) {
        const boneId = boneIdByRole.get(neighbour);
        const world = worldByRole.get(neighbour);
        if (boneId === undefined || world === undefined) continue;
        bones.push({ boneId, worldPosition: world });
      }

      meshes.push(
        buildDeformMesh({
          partId: part.id,
          bounds: part.bounds,
          bones,
          rows: input.meshRows ?? 4,
          cols: input.meshCols ?? 4,
          maxInfluences: 2,
        }),
      );
    }

    return meshes;
  }
}

/** The part's pivot, in canvas pixels. Pivot is the alpha centroid the splitter measured. */
function centroidOf(part: Part): Vec2 {
  return {
    x: part.bounds.x + part.pivot.x * part.bounds.width,
    y: part.bounds.y + part.pivot.y * part.bounds.height,
  };
}
