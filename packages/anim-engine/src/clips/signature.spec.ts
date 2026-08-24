import { describe, expect, it } from 'vitest';
import { RigSignature, type Rig } from '@rv/contracts';

import { bipedRig, walkClipIr } from '../__fixtures__/rigs';
import {
  ancestorsByRole,
  boneByRole,
  clipAnimatedRoles,
  clipDrivenRoles,
  frameLengthOf,
  orderRolesParentFirst,
  rigSignature,
  signatureAnchorPoint,
  signatureRestWorlds,
  statureOf,
} from './signature';

function unwrap(rig: Rig): RigSignature {
  const result = rigSignature(rig);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** A signature built by hand, for the degenerate shapes no real rig produces. */
function bare(
  bones: readonly { role: string; parentRole: string | null; y?: number; length?: number }[],
  anchors: readonly { role: string; boneRole: string; y?: number }[] = [],
): RigSignature {
  return RigSignature.parse({
    archetype: 'rigid-prop',
    bones: bones.map((bone) => ({
      role: bone.role,
      parentRole: bone.parentRole,
      rest: {
        position: { x: 0, y: bone.y ?? 0 },
        rotation: 0,
        length: bone.length ?? 0,
        scale: { x: 1, y: 1 },
      },
    })),
    anchors: anchors.map((anchor) => ({
      role: anchor.role,
      boneRole: anchor.boneRole,
      offset: { x: 0, y: anchor.y ?? 0 },
    })),
  });
}

describe('rigSignature - filing the asset off a skeleton', () => {
  it('keeps the roles, the topology and the rest geometry', () => {
    const signature = unwrap(bipedRig());
    expect(signature.archetype).toBe('biped');
    expect(boneByRole(signature, 'leg-left')?.parentRole).toBe('hips');
    expect(boneByRole(signature, 'torso')?.parentRole).toBeNull();
    expect(boneByRole(signature, 'leg-left')?.rest.length).toBe(70);
  });

  it('keeps only the anchors that mean something on another skeleton', () => {
    // `saddle` is a real anchor with no cross-rig meaning; carrying it into a
    // *comparison* key would suggest a comparison that cannot be made.
    const signature = unwrap(bipedRig());
    expect(signature.anchors.map((anchor) => anchor.role)).toEqual(['head', 'ground', 'grip-left']);
  });

  it('refuses a rig whose bones share a role, rather than picking one', () => {
    // `Rig` guarantees unique bone *ids* and says nothing about roles - correctly, since
    // a role is a template label. But a signature is addressed by role, so a role with
    // two bones would drive whichever the array listed first.
    const rig = bipedRig();
    const [torso, head] = rig.bones;
    if (torso === undefined || head === undefined) throw new Error('fixture');
    const clashing: Rig = {
      ...rig,
      bones: [torso, { ...head, role: 'torso' }, ...rig.bones.slice(2)],
    };

    const result = rigSignature(clashing);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.context).toMatchObject({ duplicates: ['torso'] });
  });

  it('produces a signature that parses, so the schema’s invariants really hold', () => {
    expect(RigSignature.safeParse(unwrap(bipedRig())).success).toBe(true);
  });
});

describe('rest geometry', () => {
  it('composes the skeleton parent-first', () => {
    const worlds = signatureRestWorlds(unwrap(bipedRig()));
    expect(worlds.get('foot-left')?.position).toEqual({ x: -10, y: 150 });
  });

  it('orders roles parent-first', () => {
    const signature = unwrap(bipedRig());
    const seen = new Set<string>();
    for (const bone of orderRolesParentFirst(signature)) {
      if (bone.parentRole !== null) expect(seen.has(bone.parentRole), bone.role).toBe(true);
      seen.add(bone.role);
    }
    expect(seen.size).toBe(signature.bones.length);
  });

  it('gives every role its full ancestor set in one pass', () => {
    const ancestors = ancestorsByRole(unwrap(bipedRig()));
    expect(ancestors.get('torso')).toEqual(new Set());
    expect(ancestors.get('foot-left')).toEqual(new Set(['leg-left', 'hips', 'torso']));
  });

  it('locates a standard anchor, and reports the absence of one', () => {
    const signature = unwrap(bipedRig());
    expect(signatureAnchorPoint(signature, 'ground')).toEqual({ x: -10, y: 165 });
    expect(signatureAnchorPoint(signature, 'foot-right')).toBeUndefined();
  });
});

describe('stature - what a stride is proportional to', () => {
  it('measures head to ground when the rig declares both', () => {
    expect(statureOf(unwrap(bipedRig()))).toBe(220);
  });

  it('scales exactly with the rig', () => {
    expect(statureOf(unwrap(bipedRig({ scale: 2 })))).toBe(440);
    expect(statureOf(unwrap(bipedRig({ scale: 0.5 })))).toBe(110);
  });

  it('falls back to the bones’ own vertical extent when there are no anchors', () => {
    // A proxy, not an equal: it includes a raised arm and a trailing tail. Declaring the
    // anchors measures better, which is the incentive.
    const anchorless: Rig = { ...bipedRig(), anchors: [] };
    expect(statureOf(unwrap(anchorless))).toBe(180);
  });

  it('falls back to the root bone’s own reach when the skeleton is flat', () => {
    expect(statureOf(bare([{ role: 'body', parentRole: null, length: 42 }]))).toBe(42);
  });

  it('is zero for a skeleton with no measurable extent at all', () => {
    // A real answer rather than a guess. Callers must branch on it instead of dividing
    // by it, which is exactly what `retargetClip` does.
    expect(statureOf(bare([{ role: 'body', parentRole: null }]))).toBe(0);
  });
});

describe('frame length - the yardstick a translation is measured in', () => {
  const signature = unwrap(bipedRig());

  it('measures a bone by its parent’s reach, because that is the space it moves in', () => {
    expect(frameLengthOf(signature, 'leg-left')).toBe(20);
    expect(frameLengthOf(signature, 'foot-left')).toBe(70);
  });

  it('measures a root by stature, because its translation is scene-space body carry', () => {
    expect(frameLengthOf(signature, 'torso')).toBe(220);
  });

  it('falls back to stature when the parent bone carries no length', () => {
    const jointed = bare([
      { role: 'body', parentRole: null, length: 40, y: 0 },
      { role: 'pivot', parentRole: 'body', length: 0, y: 40 },
      { role: 'arm', parentRole: 'pivot', length: 30, y: 0 },
    ]);
    // stature falls back to the vertical extent, 40.
    expect(frameLengthOf(jointed, 'arm')).toBe(40);
  });

  it('has no answer for a role the skeleton does not have', () => {
    expect(frameLengthOf(signature, 'wing-left')).toBeUndefined();
  });
});

describe('what a fragment asks of a skeleton', () => {
  it('names the roles a clip animates, in document order', () => {
    expect(clipDrivenRoles(walkClipIr())).toEqual(['torso', 'leg-left', 'leg-right']);
  });

  it('leaves out a disabled behaviour, which nothing evaluates', () => {
    // Requiring a role nothing produces would make a clip unplayable on rigs it would
    // have played on perfectly - the same call `detectIrFeatures` makes.
    const ir = walkClipIr({ carry: false });
    const onlyDisabled = {
      ...ir,
      tracks: [],
      behaviours: ir.behaviours.filter((behaviour) => behaviour.kind === 'walk-cycle'),
    };
    expect(clipDrivenRoles(onlyDisabled)).toEqual([]);
  });

  it('still counts a disabled behaviour as something retargeting must rewrite', () => {
    // A disabled `walk-cycle` is a stride length that will be wrong the moment someone
    // ticks the box.
    const ir = walkClipIr({ carry: false });
    const onlyDisabled = {
      ...ir,
      tracks: [],
      behaviours: ir.behaviours.filter((behaviour) => behaviour.kind === 'walk-cycle'),
    };
    expect(clipAnimatedRoles(onlyDisabled)).toEqual(['torso']);
  });

  it('names a role once even when two animated nodes carry it', () => {
    // Node names are not unique in the IR, and a role listed twice would be measured
    // twice and scaled twice.
    const ir = walkClipIr();
    const doubled = {
      ...ir,
      nodes: ir.nodes.map((node) =>
        node.name === 'leg-right' ? { ...node, name: 'leg-left' } : node,
      ),
    };
    expect(clipDrivenRoles(doubled)).toEqual(['torso', 'leg-left']);
  });
});
