import { describe, expect, it } from 'vitest';
import { AssetArchetype, type Ids, type Part, Rig } from '@rv/contracts';
import { isErr, unwrap } from '@rv/shared-kernel';

import { specFor, testIds } from '../__fixtures__/builders';
import { partPlansFor, templateFor } from './templates/index';
import { buildDeformMesh } from './mesh';
import { FitRigUseCase } from './fit-rig';

const ARCHETYPES = AssetArchetype.options;

/** One `Part` per planned part, laid out on a grid so centroids are distinguishable. */
function partsFor(archetype: AssetArchetype, ids: Ids, canvas = 256): Part[] {
  return partPlansFor(archetype, 'Subject').map((plan, index) => {
    const hint = plan.attachHint ?? { x: 0.5, y: 0.5 };
    const width = 24;
    const height = 24;
    return {
      id: ids.part(),
      name: plan.name,
      role: plan.role,
      imageHash: index.toString(16).padStart(2, '0').repeat(32),
      bounds: {
        x: Math.round(hint.x * canvas) - width / 2,
        y: Math.round(hint.y * canvas) - height / 2,
        width,
        height,
      },
      size: { width, height },
      pivot: { x: 0.5, y: 0.5 },
      zOrder: plan.zOrder,
      deformable: plan.deformable,
      alphaCoverage: 0.8,
    };
  });
}

describe('FitRigUseCase', () => {
  it.each(ARCHETYPES)('fits a schema-valid rig for %s', (archetype) => {
    const ids = testIds();
    const spec = specFor(archetype, { canvas: { width: 256, height: 256 } });
    const rig = unwrap(
      new FitRigUseCase({ ids }).execute({ spec, parts: partsFor(archetype, ids) }),
    );

    const parsed = Rig.safeParse(rig);
    expect(parsed.success).toBe(true);
    expect(rig.archetype).toBe(archetype);
    expect(rig.templateId).toBe(templateFor(archetype).id);
  });

  it.each(ARCHETYPES)('%s has one root, no cycles and no dangling reference', (archetype) => {
    const ids = testIds();
    const spec = specFor(archetype, { canvas: { width: 256, height: 256 } });
    const rig = unwrap(
      new FitRigUseCase({ ids }).execute({ spec, parts: partsFor(archetype, ids) }),
    );

    const boneIds = new Set(rig.bones.map((bone) => bone.id));
    expect(rig.bones.filter((bone) => bone.parentId === null)).toHaveLength(1);
    for (const bone of rig.bones) {
      if (bone.parentId !== null) expect(boneIds.has(bone.parentId)).toBe(true);
    }
    for (const chain of rig.ikChains) {
      expect(boneIds.has(chain.rootBoneId)).toBe(true);
      expect(boneIds.has(chain.endBoneId)).toBe(true);
    }
    for (const anchor of rig.anchors) expect(boneIds.has(anchor.boneId)).toBe(true);
    for (const mesh of rig.meshes) {
      for (const vertex of mesh.vertices) {
        for (const influence of vertex.influences) expect(boneIds.has(influence.boneId)).toBe(true);
      }
    }
  });

  it.each(ARCHETYPES)('%s weights every mesh vertex to exactly 1', (archetype) => {
    const ids = testIds();
    const spec = specFor(archetype, { canvas: { width: 256, height: 256 } });
    const rig = unwrap(
      new FitRigUseCase({ ids }).execute({ spec, parts: partsFor(archetype, ids) }),
    );

    for (const mesh of rig.meshes) {
      for (const vertex of mesh.vertices) {
        const total = vertex.influences.reduce((sum, influence) => sum + influence.weight, 0);
        expect(total).toBeCloseTo(1, 10);
      }
    }
  });

  it('places a bone at its part alpha centroid, not at the template default', () => {
    const ids = testIds();
    const spec = specFor('tree', { canvas: { width: 256, height: 256 } });
    const parts = partsFor('tree', ids);
    const rig = unwrap(new FitRigUseCase({ ids }).execute({ spec, parts }));

    const trunkPart = parts.find((part) => part.role === 'trunk');
    const trunkBone = rig.bones.find((bone) => bone.role === 'trunk');
    expect(trunkBone?.rest.position.x).toBeCloseTo((trunkPart?.bounds.x ?? 0) + 12, 5);
  });

  it('binds a rigid part to its bone and leaves a deformable one to the mesh', () => {
    const ids = testIds();
    const spec = specFor('tree', { canvas: { width: 256, height: 256 } });
    const parts = partsFor('tree', ids);
    const rig = unwrap(new FitRigUseCase({ ids }).execute({ spec, parts }));

    expect(rig.bones.find((bone) => bone.role === 'trunk')?.partIds).toHaveLength(1);
    // `Bone.partIds` is documented as rigid parts only; a canopy deforms.
    expect(rig.bones.find((bone) => bone.role === 'canopy')?.partIds).toHaveLength(0);
    expect(
      rig.meshes.some((mesh) => mesh.partId === parts.find((part) => part.role === 'canopy')?.id),
    ).toBe(true);
  });

  it('names the missing part rather than producing a broken rig', () => {
    const ids = testIds();
    const spec = specFor('biped', { canvas: { width: 256, height: 256 } });
    const parts = partsFor('biped', ids).filter((part) => part.role !== 'head');

    const failed = new FitRigUseCase({ ids }).execute({ spec, parts });
    expect(isErr(failed)).toBe(true);
    if (isErr(failed)) expect(failed.error.context.missing).toEqual(['head']);
  });

  it('tolerates missing parts on the single-layer fallback path', () => {
    const ids = testIds();
    const spec = specFor('biped', { canvas: { width: 256, height: 256 } });
    const parts = partsFor('biped', ids).slice(0, 1);

    const rig = unwrap(
      new FitRigUseCase({ ids }).execute({ spec, parts, allowMissingParts: true }),
    );
    // Every bone still exists, so the asset is animatable by transform and mesh.
    expect(rig.bones.length).toBe(templateFor('biped').bones.length);
    expect(Rig.safeParse(rig).success).toBe(true);
  });

  it('does not mind an absent optional part', () => {
    const ids = testIds();
    const spec = specFor('winged', { canvas: { width: 256, height: 256 } });
    // `leg-left` and `leg-right` are optional on the winged template.
    const parts = partsFor('winged', ids).filter((part) => !part.role.startsWith('leg'));

    expect(isErr(new FitRigUseCase({ ids }).execute({ spec, parts }))).toBe(false);
  });

  it('scales anchors and bone lengths into canvas pixels', () => {
    const ids = testIds();
    const spec = specFor('tree', { canvas: { width: 512, height: 512 } });
    const rig = unwrap(
      new FitRigUseCase({ ids }).execute({ spec, parts: partsFor('tree', ids, 512) }),
    );

    const trunk = rig.bones.find((bone) => bone.role === 'trunk');
    // 0.4 of the canvas height, not 0.4 pixels.
    expect(trunk?.rest.length).toBeCloseTo(0.4 * 512, 5);
    expect(rig.anchors.find((anchor) => anchor.name === 'base')?.offset.y).toBeCloseTo(
      0.4 * 512,
      5,
    );
  });

  it('reports a rig that fails its own schema instead of returning it', () => {
    const ids = testIds();
    const spec = specFor('tree', { canvas: { width: 256, height: 256 } });
    const parts = partsFor('tree', ids).map((part) =>
      part.role === 'canopy' ? { ...part, bounds: { ...part.bounds, width: Number.NaN } } : part,
    );

    const failed = new FitRigUseCase({ ids }).execute({ spec, parts });
    expect(isErr(failed)).toBe(true);
    if (isErr(failed)) expect(failed.error.message).toContain('does not validate');
  });
});

describe('buildDeformMesh', () => {
  const ids = testIds();
  const boneA = ids.bone();
  const boneB = ids.bone();

  it('produces whole triangles that index real vertices', () => {
    const mesh = buildDeformMesh({
      partId: ids.part(),
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      bones: [
        { boneId: boneA, worldPosition: { x: 0, y: 0 } },
        { boneId: boneB, worldPosition: { x: 100, y: 100 } },
      ],
      rows: 3,
      cols: 3,
    });

    expect(mesh.vertices).toHaveLength(9);
    expect(mesh.indices.length % 3).toBe(0);
    expect(Math.max(...mesh.indices)).toBeLessThan(mesh.vertices.length);
  });

  it('clamps the grid into the schema-legal range', () => {
    const mesh = buildDeformMesh({
      partId: ids.part(),
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      bones: [{ boneId: boneA, worldPosition: { x: 0, y: 0 } }],
      rows: 1,
      cols: 200,
    });
    expect(mesh.rows).toBe(2);
    expect(mesh.cols).toBe(64);
  });

  it('weights a vertex mostly to the bone it sits on', () => {
    const mesh = buildDeformMesh({
      partId: ids.part(),
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      bones: [
        { boneId: boneA, worldPosition: { x: 0, y: 0 } },
        { boneId: boneB, worldPosition: { x: 100, y: 100 } },
      ],
      rows: 2,
      cols: 2,
      maxInfluences: 2,
    });

    const topLeft = mesh.vertices[0];
    expect(topLeft?.influences[0]?.boneId).toBe(boneA);
    expect(topLeft?.influences[0]?.weight).toBeGreaterThan(0.9);
  });

  it('breaks a distance tie by bone id, so the mesh is reproducible', () => {
    const ordered = [
      { boneId: boneA, worldPosition: { x: 50, y: 50 } },
      { boneId: boneB, worldPosition: { x: 50, y: 50 } },
    ];
    const first = buildDeformMesh({
      partId: ids.part(),
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      bones: ordered,
      maxInfluences: 1,
    });
    const reversed = buildDeformMesh({
      partId: ids.part(),
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      bones: [...ordered].reverse(),
      maxInfluences: 1,
    });

    expect(first.vertices[0]?.influences[0]?.boneId).toBe(
      reversed.vertices[0]?.influences[0]?.boneId,
    );
  });

  it('refuses to build a mesh with no candidate bone', () => {
    expect(() =>
      buildDeformMesh({
        partId: ids.part(),
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        bones: [],
      }),
    ).toThrow(TypeError);
  });
});
