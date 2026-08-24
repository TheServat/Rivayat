import { describe, expect, it } from 'vitest';
import { RigSignature, type Rig } from '@rv/contracts';

import { bipedRig, walkLibraryEntry } from '../__fixtures__/rigs';
import { checkClipCompatibility } from './compatibility';
import { rigSignature } from './signature';

function signatureOf(rig: Rig): RigSignature {
  const result = rigSignature(rig);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const target = signatureOf(bipedRig({ scale: 2, tag: 'understudy' }));

describe('what makes a clip fit a skeleton', () => {
  it('accepts a different asset with the same roles and different proportions', () => {
    // The case the library exists for. Different bone ids, different sizes, one shape -
    // and demanding an exact skeleton match would reject it, which would keep the library
    // permanently empty in a way that looks exactly like it working.
    expect(checkClipCompatibility(walkLibraryEntry(), target)).toEqual({
      compatible: true,
      archetypeMismatch: false,
      missingRoles: [],
      brokenAncestry: [],
      missingAnchors: [],
    });
  });

  it('refuses a different kind of thing outright', () => {
    const tree = RigSignature.parse({ ...target, archetype: 'tree' });
    const report = checkClipCompatibility(walkLibraryEntry(), tree);
    expect(report.compatible).toBe(false);
    expect(report.archetypeMismatch).toBe(true);
  });

  it('names the roles the skeleton is missing, so a rigging gap is actionable', () => {
    const armless = RigSignature.parse({
      ...target,
      bones: target.bones.filter(
        (bone) => !bone.role.startsWith('leg-') && !bone.role.startsWith('foot-'),
      ),
      anchors: target.anchors.filter((anchor) => anchor.role !== 'ground'),
    });
    const report = checkClipCompatibility(walkLibraryEntry({ alignsTo: [] }), armless);
    expect(report.compatible).toBe(false);
    expect(report.missingRoles).toEqual(['leg-left', 'leg-right']);
  });
});

describe('ancestry, not parenthood', () => {
  it('accepts a skeleton that inserts a bone between two the clip drives', () => {
    // A shoulder between the torso and the upper arm. The inserted bone is at rest, so
    // composing through it is the identity, and the clip reads exactly as authored. A
    // rule that demanded the same *parent* would reject this - and rejecting it is how a
    // library ends up unusable the first time a template gains a joint.
    const withPelvis = RigSignature.parse({
      ...target,
      bones: [
        ...target.bones.map((bone) =>
          bone.role.startsWith('leg-') ? { ...bone, parentRole: 'pelvis' } : bone,
        ),
        {
          role: 'pelvis',
          parentRole: 'hips',
          rest: { position: { x: 0, y: 0 }, rotation: 0, length: 4, scale: { x: 1, y: 1 } },
        },
      ],
    });
    expect(checkClipCompatibility(walkLibraryEntry(), withPelvis).compatible).toBe(true);
  });

  it('refuses a skeleton that re-parents a driven role somewhere else entirely', () => {
    // The case ancestry actually rules out: legs hanging off the torso rather than the
    // hips means the clip drives them from the wrong pivot, and nothing downstream says
    // so - the character simply walks wrong.
    const reparented = RigSignature.parse({
      ...target,
      bones: target.bones.map((bone) =>
        bone.role.startsWith('leg-') ? { ...bone, parentRole: 'torso' } : bone,
      ),
    });
    const report = checkClipCompatibility(walkLibraryEntry(), reparented);
    expect(report.compatible).toBe(false);
    expect(report.brokenAncestry).toEqual([
      { role: 'leg-left', expectedAncestor: 'hips' },
      { role: 'leg-right', expectedAncestor: 'hips' },
    ]);
  });

  it('asks nothing of a role that was the source root - there is no ancestry to keep', () => {
    const rootOnly = walkLibraryEntry({ drives: ['torso'], alignsTo: [] });
    expect(checkClipCompatibility(rootOnly, target).brokenAncestry).toEqual([]);
  });
});

describe('anchors the clip measures itself against', () => {
  it('refuses a skeleton with no ground plane for a clip that needs one', () => {
    // A walk cycle's stride and bounce only mean anything relative to the plane the feet
    // stand on. Without it there is nothing to keep the feet on.
    const floating = RigSignature.parse({
      ...target,
      anchors: target.anchors.filter((anchor) => anchor.role !== 'ground'),
    });
    const report = checkClipCompatibility(walkLibraryEntry(), floating);
    expect(report.compatible).toBe(false);
    expect(report.missingAnchors).toEqual(['ground']);
  });

  it('asks for no anchors at all when the clip aligns to nothing', () => {
    const floating = RigSignature.parse({ ...target, anchors: [] });
    expect(checkClipCompatibility(walkLibraryEntry({ alignsTo: [] }), floating).compatible).toBe(
      true,
    );
  });
});
