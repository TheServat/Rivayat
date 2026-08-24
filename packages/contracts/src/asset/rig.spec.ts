import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { foreignIds, rig, testIds } from '../__fixtures__/builders';
import { AnchorRole, DeformMesh, IkChain, Rig, RigAnchor, anchorRoleOf } from './rig';

describe('Rig skeleton integrity', () => {
  it('accepts the fixture', () => {
    const result = Rig.safeParse(rig());
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  it('requires exactly one root bone', () => {
    const base = rig();
    const [trunk, canopy] = base.bones;

    const noRoot = Rig.safeParse({
      ...base,
      bones: [{ ...trunk!, parentId: canopy!.id }, canopy!],
    });
    expect(noRoot.success).toBe(false);

    const twoRoots = Rig.safeParse({
      ...base,
      bones: [trunk!, { ...canopy!, parentId: null }],
    });
    expect(twoRoots.success).toBe(false);
    expect(z.prettifyError(twoRoots.error!)).toMatch(/exactly one root bone, found 2/);
  });

  it('rejects a duplicate bone id', () => {
    const base = rig();
    const trunk = base.bones[0]!;
    const result = Rig.safeParse({ ...base, bones: [trunk, { ...trunk, name: 'clone' }] });
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/duplicate bone id/);
  });

  it('rejects a parent that is not in the rig', () => {
    const base = rig();
    const result = Rig.safeParse({
      ...base,
      bones: [base.bones[0]!, { ...base.bones[1]!, parentId: foreignIds().bone() }],
    });
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/unknown parent/);
  });

  it('rejects a cycle, which would make pose evaluation non-terminating', () => {
    const base = rig();
    const [trunk, canopy] = base.bones;
    const result = Rig.safeParse({
      ...base,
      bones: [
        { ...trunk!, parentId: canopy!.id },
        { ...canopy!, parentId: trunk!.id },
      ],
    });
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/cycle/);
  });

  it('requires at least one bone', () => {
    expect(Rig.safeParse(rig({ bones: [] })).success).toBe(false);
  });
});

describe('DeformMesh', () => {
  const ids = testIds();
  const boneId = ids.bone();
  const partId = ids.part();

  function mesh(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      partId,
      rows: 2,
      cols: 2,
      vertices: [
        { uv: { x: 0, y: 0 }, influences: [{ boneId, weight: 1 }] },
        { uv: { x: 1, y: 0 }, influences: [{ boneId, weight: 1 }] },
        { uv: { x: 1, y: 1 }, influences: [{ boneId, weight: 1 }] },
        { uv: { x: 0, y: 1 }, influences: [{ boneId, weight: 1 }] },
      ],
      indices: [0, 1, 2, 0, 2, 3],
      ...overrides,
    };
  }

  it('accepts a well-formed quad', () => {
    expect(DeformMesh.safeParse(mesh()).success).toBe(true);
  });

  it('rejects an index list that does not describe whole triangles', () => {
    const result = DeformMesh.safeParse(mesh({ indices: [0, 1, 2, 0] }));
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/whole triangles/);
  });

  it('requires vertex influence weights to sum to 1', () => {
    // Weights that do not sum to 1 shrink the vertex toward the origin as the rig
    // moves - a subtle artefact that is far cheaper to reject than to debug.
    const secondBone = ids.bone();
    const bad = mesh({
      vertices: [
        {
          uv: { x: 0, y: 0 },
          influences: [
            { boneId, weight: 0.5 },
            { boneId: secondBone, weight: 0.2 },
          ],
        },
        { uv: { x: 1, y: 0 }, influences: [{ boneId, weight: 1 }] },
        { uv: { x: 1, y: 1 }, influences: [{ boneId, weight: 1 }] },
        { uv: { x: 0, y: 1 }, influences: [{ boneId, weight: 1 }] },
      ],
    });
    const result = DeformMesh.safeParse(bad);
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/sum to 1/);
  });

  it('accepts weights that sum to 1 across several bones', () => {
    const secondBone = ids.bone();
    const good = mesh({
      vertices: [
        {
          uv: { x: 0, y: 0 },
          influences: [
            { boneId, weight: 0.6 },
            { boneId: secondBone, weight: 0.4 },
          ],
        },
        { uv: { x: 1, y: 0 }, influences: [{ boneId, weight: 1 }] },
        { uv: { x: 1, y: 1 }, influences: [{ boneId, weight: 1 }] },
        { uv: { x: 0, y: 1 }, influences: [{ boneId, weight: 1 }] },
      ],
    });
    expect(DeformMesh.safeParse(good).success).toBe(true);
  });

  it('caps influences per vertex at 4 - more buys nothing in 2D', () => {
    const bones = [ids.bone(), ids.bone(), ids.bone(), ids.bone(), ids.bone()];
    const tooMany = mesh({
      vertices: [
        {
          uv: { x: 0, y: 0 },
          influences: bones.map((id) => ({ boneId: id, weight: 0.2 })),
        },
        { uv: { x: 1, y: 0 }, influences: [{ boneId, weight: 1 }] },
        { uv: { x: 1, y: 1 }, influences: [{ boneId, weight: 1 }] },
        { uv: { x: 0, y: 1 }, influences: [{ boneId, weight: 1 }] },
      ],
    });
    expect(DeformMesh.safeParse(tooMany).success).toBe(false);
  });

  it('requires at least four vertices and a grid of at least 2x2', () => {
    expect(DeformMesh.safeParse(mesh({ vertices: [] })).success).toBe(false);
    expect(DeformMesh.safeParse(mesh({ rows: 1 })).success).toBe(false);
  });
});

describe('IkChain', () => {
  const ids = testIds();
  const base = {
    id: 'arm-left',
    rootBoneId: ids.bone(),
    endBoneId: ids.bone(),
    chainLength: 3,
  };

  it('defaults the solver iterations', () => {
    expect(IkChain.parse(base).iterations).toBe(8);
  });

  it('requires a chain of at least two bones', () => {
    expect(IkChain.safeParse({ ...base, chainLength: 1 }).success).toBe(false);
  });

  it('caps the chain so a solver cannot walk to the root of the skeleton', () => {
    expect(IkChain.safeParse({ ...base, chainLength: 9 }).success).toBe(false);
  });
});

// ── every other reference into the skeleton ─────────────────────────────────
//
// `parentId` was the only bone reference the rig checked. A mesh weight, an IK chain,
// an anchor and a copy-rotation constraint all name a bone too, and a dangling one is
// not an error at pose time - it is a silent no-op: a limb that never bends, a lantern
// anchored to nothing, a mirrored ear that stops mirroring.

describe('Rig internal references', () => {
  const stranger = foreignIds().bone();

  function withBones(overrides: Record<string, unknown>): Record<string, unknown> {
    return { ...rig(), ...overrides };
  }

  function paths(value: Record<string, unknown>): string[] {
    const result = Rig.safeParse(value);
    return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
  }

  function quadMesh(boneId: string): Record<string, unknown> {
    const base = rig();
    const partId = testIds().part();
    return {
      partId,
      rows: 2,
      cols: 2,
      vertices: [
        { uv: { x: 0, y: 0 }, influences: [{ boneId: base.bones[0]!.id, weight: 1 }] },
        { uv: { x: 1, y: 0 }, influences: [{ boneId, weight: 1 }] },
        { uv: { x: 1, y: 1 }, influences: [{ boneId: base.bones[0]!.id, weight: 1 }] },
        { uv: { x: 0, y: 1 }, influences: [{ boneId: base.bones[0]!.id, weight: 1 }] },
      ],
      indices: [0, 1, 2, 0, 2, 3],
    };
  }

  it('accepts a mesh, chain, anchor and constraint that all name real bones', () => {
    const base = rig();
    const [trunk, canopy] = base.bones;
    const result = Rig.safeParse(
      withBones({
        bones: [trunk!, { ...canopy!, constraint: { copyRotationFrom: trunk!.id } }],
        meshes: [quadMesh(trunk!.id)],
        ikChains: [{ id: 'bough', rootBoneId: trunk!.id, endBoneId: canopy!.id, chainLength: 2 }],
        anchors: [{ name: 'nest', boneId: canopy!.id }],
      }),
    );
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  it('rejects a mesh vertex weighted to a bone that is not in the rig', () => {
    expect(paths(withBones({ meshes: [quadMesh(stranger)] }))).toEqual([
      'meshes.0.vertices.1.influences',
    ]);
  });

  it('rejects an IK chain spanning bones that are not in the rig, naming both ends', () => {
    expect(
      paths(
        withBones({
          ikChains: [{ id: 'ghost', rootBoneId: stranger, endBoneId: stranger, chainLength: 2 }],
        }),
      ),
    ).toEqual(['ikChains.0.rootBoneId', 'ikChains.0.endBoneId']);
  });

  it('rejects an anchor hanging off a bone that is not in the rig', () => {
    expect(paths(withBones({ anchors: [{ name: 'nest', boneId: stranger }] }))).toEqual([
      'anchors.0.boneId',
    ]);
  });

  it('rejects a constraint copying rotation from a bone that is not in the rig', () => {
    const base = rig();
    const [trunk, canopy] = base.bones;
    expect(
      paths(
        withBones({ bones: [trunk!, { ...canopy!, constraint: { copyRotationFrom: stranger } }] }),
      ),
    ).toEqual(['bones.1.constraint.copyRotationFrom']);
  });

  it('leaves a constraint with no copy target alone', () => {
    const base = rig();
    const [trunk, canopy] = base.bones;
    expect(
      Rig.safeParse(
        withBones({ bones: [trunk!, { ...canopy!, constraint: { minRotation: -20 } }] }),
      ).success,
    ).toBe(true);
  });
});

describe('DeformMesh indices address real vertices', () => {
  const ids = testIds();
  const boneId = ids.bone();

  function mesh(indices: number[]): Record<string, unknown> {
    return {
      partId: ids.part(),
      rows: 2,
      cols: 2,
      vertices: [
        { uv: { x: 0, y: 0 }, influences: [{ boneId, weight: 1 }] },
        { uv: { x: 1, y: 0 }, influences: [{ boneId, weight: 1 }] },
        { uv: { x: 1, y: 1 }, influences: [{ boneId, weight: 1 }] },
        { uv: { x: 0, y: 1 }, influences: [{ boneId, weight: 1 }] },
      ],
      indices,
    };
  }

  it('rejects a triangle pointing past the end of the vertex list', () => {
    const result = DeformMesh.safeParse(mesh([0, 1, 4]));
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toEqual(['indices']);
  });

  it('accepts the last vertex, which is in range', () => {
    expect(DeformMesh.safeParse(mesh([0, 1, 3])).success).toBe(true);
  });

  it('accepts a mesh that draws no triangles at all', () => {
    expect(DeformMesh.safeParse(mesh([])).success).toBe(true);
  });
});

// ── anchors: the named points retargeting aligns to and props hang off ──────
//
// An anchor's second job - "hold the lantern at `grip-right`" - is a *lookup by name*,
// and its first - align this walk cycle to the ground - is a lookup by role. A lookup
// with two answers has none: the prop lands on whichever anchor the array happened to
// list first, and it moves the day a template is re-ordered. Same class of silent
// failure as the dangling references above, from the other direction.

describe('RigAnchor', () => {
  const ids = testIds();

  it('places the offset in the bone’s own local space, so it travels with the bone', () => {
    const anchor = RigAnchor.parse({ name: 'saddle', boneId: ids.bone() });
    expect(anchor.offset).toEqual({ x: 0, y: 0 });
    expect(anchor.rotation).toBe(0);
  });

  it('leaves the standard role absent, because most anchors have no cross-rig meaning', () => {
    expect(RigAnchor.parse({ name: 'saddle', boneId: ids.bone() }).role).toBeUndefined();
    expect(anchorRoleOf({ name: 'saddle' })).toBeUndefined();
  });

  it('reads a name that is itself a role, so rigs fitted before the vocabulary carry theirs', () => {
    // The biped blueprint already mints `grip-left`, `grip-right`, `speech` and
    // `eye-line`. They acquire their roles here rather than through a migration.
    for (const name of ['grip-left', 'grip-right', 'speech', 'eye-line'] as const) {
      expect(anchorRoleOf({ name }), name).toBe(name);
    }
  });

  it('lets an explicit role win, so a rig calling its saddle "head" is not reinterpreted', () => {
    expect(anchorRoleOf({ name: 'head', role: 'saddle' as AnchorRole })).toBe('saddle');
    expect(anchorRoleOf({ name: 'nest', role: 'tip' })).toBe('tip');
  });

  it('rejects a role outside the closed vocabulary', () => {
    expect(AnchorRole.safeParse('left_hand').success).toBe(false);
    expect(AnchorRole.safeParse('grip-left').success).toBe(true);
  });
});

describe('Rig anchor uniqueness', () => {
  function paths(anchors: readonly Record<string, unknown>[]): string[] {
    const result = Rig.safeParse({ ...rig(), anchors });
    return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
  }

  const bones = rig().bones as Record<string, unknown>[];
  const trunk = bones[0]!.id as string;
  const canopy = bones[1]!.id as string;

  it('accepts distinct names and distinct roles', () => {
    const result = Rig.safeParse({
      ...rig(),
      anchors: [
        { name: 'nest', boneId: canopy, role: 'tip' },
        { name: 'roots', boneId: trunk, role: 'ground' },
        { name: 'plaque', boneId: trunk },
      ],
    });
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  it('rejects two anchors with one name, because "hold the lantern there" must resolve', () => {
    expect(
      paths([
        { name: 'nest', boneId: canopy },
        { name: 'nest', boneId: trunk },
      ]),
    ).toEqual(['anchors.1.name']);
  });

  it('rejects two anchors claiming one role, because retargeting would align to either', () => {
    expect(
      paths([
        { name: 'sole', boneId: trunk, role: 'ground' },
        { name: 'roots', boneId: trunk, role: 'ground' },
      ]),
    ).toEqual(['anchors.1.role']);
  });

  it('catches a role collision between an explicit role and a name that is one', () => {
    expect(
      paths([
        { name: 'ground', boneId: trunk },
        { name: 'sole', boneId: trunk, role: 'ground' },
      ]),
    ).toEqual(['anchors.1.role']);
  });

  it('does not confuse two roleless anchors for a collision', () => {
    expect(
      paths([
        { name: 'plaque', boneId: trunk },
        { name: 'saddle', boneId: canopy },
      ]),
    ).toEqual([]);
  });
});
