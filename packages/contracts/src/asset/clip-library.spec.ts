import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { HASHES, provenance, testIds } from '../__fixtures__/builders';
import { ClipLibraryEntry, RigSignature, SignatureAnchor } from './clip-library';

const ids = testIds();

/** A three-bone biped stub: torso, one leg, one foot. Enough to have proportions. */
function signature(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    archetype: 'biped',
    bones: [
      {
        role: 'torso',
        parentRole: null,
        rest: { position: { x: 0, y: 0 }, rotation: 0, length: 100, scale: { x: 1, y: 1 } },
      },
      {
        role: 'leg-left',
        parentRole: 'torso',
        rest: { position: { x: 0, y: 100 }, rotation: 0, length: 120, scale: { x: 1, y: 1 } },
      },
      {
        role: 'foot-left',
        parentRole: 'leg-left',
        rest: { position: { x: 0, y: 120 }, rotation: 0, length: 20, scale: { x: 1, y: 1 } },
      },
    ],
    anchors: [
      { role: 'ground', boneRole: 'foot-left', offset: { x: 0, y: 20 } },
      { role: 'head', boneRole: 'torso', offset: { x: 0, y: -30 } },
    ],
    ...overrides,
  };
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ids.clip(),
    name: 'walk',
    source: 'template',
    durationMs: 1000,
    fps: 24,
    irHash: HASHES.a,
    tags: [],
    provenance: provenance(),
    sourceRig: signature(),
    drives: ['torso', 'leg-left'],
    alignsTo: ['ground'],
    ...overrides,
  };
}

function issuePaths(result: z.ZodSafeParseResult<unknown>): string[] {
  return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

describe('RigSignature - the address a clip is filed under', () => {
  it('accepts the fixture', () => {
    const result = RigSignature.safeParse(signature());
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  it('defaults to no anchors, which is a rig nothing can align to', () => {
    const parsed = RigSignature.parse({ archetype: 'tree', bones: signature().bones });
    expect(parsed.anchors).toEqual([]);
  });

  it('rejects a duplicate bone role - a role that resolves twice resolves to neither', () => {
    const bones = signature().bones as Record<string, unknown>[];
    const first = bones[0];
    expect(issuePaths(RigSignature.safeParse(signature({ bones: [first, first] })))).toContain(
      'bones.1.role',
    );
  });

  it('requires exactly one root, like the rig it was derived from', () => {
    const bones = signature().bones as Record<string, unknown>[];
    const twoRoots = bones.map((bone) => ({ ...bone, parentRole: null }));
    expect(RigSignature.safeParse(signature({ bones: twoRoots })).success).toBe(false);

    expect(RigSignature.safeParse(signature({ bones: [] })).success).toBe(false);
  });

  it('rejects a parent role the signature does not have', () => {
    const bones = signature().bones as Record<string, unknown>[];
    const orphaned = [bones[0], { ...bones[1], parentRole: 'pelvis' }, bones[2]];
    expect(issuePaths(RigSignature.safeParse(signature({ bones: orphaned })))).toContain(
      'bones.1.parentRole',
    );
  });

  it('rejects a cycle, which would make composing the rest pose non-terminating', () => {
    const bones = signature().bones as Record<string, unknown>[];
    const looped = [{ ...bones[0], parentRole: 'foot-left' }, bones[1], bones[2]];
    const result = RigSignature.safeParse(signature({ bones: looped }));
    expect(result.success).toBe(false);
    expect(z.prettifyError(result.error!)).toMatch(/cycle/);
  });

  it('rejects an anchor hanging off a bone role that is not in the signature', () => {
    expect(
      issuePaths(
        RigSignature.safeParse(signature({ anchors: [{ role: 'ground', boneRole: 'tail' }] })),
      ),
    ).toContain('anchors.0.boneRole');
  });

  it('rejects two anchors claiming one role - retargeting would measure against either', () => {
    expect(
      issuePaths(
        RigSignature.safeParse(
          signature({
            anchors: [
              { role: 'ground', boneRole: 'foot-left' },
              { role: 'ground', boneRole: 'torso' },
            ],
          }),
        ),
      ),
    ).toContain('anchors.1.role');
  });

  it('gives a signature anchor the same offset defaults the rig anchor has', () => {
    const parsed = SignatureAnchor.parse({ role: 'tip', boneRole: 'torso' });
    expect(parsed.offset).toEqual({ x: 0, y: 0 });
    expect(parsed.rotation).toBe(0);
  });
});

describe('ClipLibraryEntry - a clip plus the skeleton it means something on', () => {
  it('accepts the fixture', () => {
    const result = ClipLibraryEntry.safeParse(entry());
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  it('is still an AnimationClip, so a stored per-asset clip keeps its identity', () => {
    // The migration guarantee: promoting a clip into the library adds an address, it
    // does not mint a new artefact. Same id, same name, same content hash - so nothing
    // downstream of the dedup key can tell the difference.
    const source = entry();
    const parsed = ClipLibraryEntry.parse(source);
    expect(parsed.id).toBe(source.id);
    expect(parsed.name).toBe(source.name);
    expect(parsed.irHash).toBe(source.irHash);
    expect(parsed.loop).toBe('loop');
  });

  it('defaults to aligning to nothing - a talk clip has no ground contact to keep', () => {
    const { alignsTo: _dropped, ...rest } = entry();
    expect(ClipLibraryEntry.parse(rest).alignsTo).toEqual([]);
  });

  it('requires the clip to drive something', () => {
    expect(ClipLibraryEntry.safeParse(entry({ drives: [] })).success).toBe(false);
  });

  it('rejects a clip driving a role its own source rig lacks', () => {
    // Unretargetable to anything: there is no source proportion to scale from, so the
    // entry can never be selected and nothing says why.
    expect(
      issuePaths(ClipLibraryEntry.safeParse(entry({ drives: ['torso', 'wing-left'] }))),
    ).toContain('drives.1');
  });

  it('rejects a clip aligning to an anchor its own source rig lacks', () => {
    expect(issuePaths(ClipLibraryEntry.safeParse(entry({ alignsTo: ['grip-left'] })))).toContain(
      'alignsTo.0',
    );
  });
});
