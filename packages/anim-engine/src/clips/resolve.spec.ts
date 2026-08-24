import { describe, expect, it } from 'vitest';
import { AnimationClip, RigSignature, type Rig } from '@rv/contracts';

import { bipedRig, walkLibraryEntry } from '../__fixtures__/rigs';
import { resolveClip } from './resolve';

/** The same clip name, stored on the asset the old way. */
function assetClip(name: string): AnimationClip {
  return AnimationClip.parse({
    id: `clp_${'0'.repeat(24)}A1`,
    name,
    source: 'authored',
    durationMs: 900,
    fps: 24,
    irHash: 'd'.repeat(64),
    tags: [],
    provenance: {
      source: 'author',
      parents: [],
      createdAt: '2026-08-24T00:00:00.000Z',
      costNanoUsd: 0,
    },
  });
}

const rig: Rig = bipedRig({ scale: 2, tag: 'understudy' });

describe('the asset’s own clip always wins', () => {
  // The migration guarantee (ADR-0008 §5): existing per-asset clips must keep resolving
  // while the library fills, and moving a clip into the library must never change what an
  // already-produced asset plays.
  it('prefers it even when the library has a compatible clip of the same name', () => {
    const own = assetClip('walk');
    const resolved = resolveClip({
      name: 'walk',
      rig,
      assetClips: [own],
      library: [walkLibraryEntry()],
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.value.origin).toBe('asset');
    expect(resolved.ok && resolved.value.origin === 'asset' && resolved.value.clip).toEqual(own);
  });

  it('hands it back untouched, so the dedup key cannot move under it', () => {
    const own = assetClip('walk');
    const resolved = resolveClip({ name: 'walk', rig, assetClips: [own], library: [] });
    expect(resolved.ok && resolved.value.origin === 'asset' && resolved.value.clip.irHash).toBe(
      own.irHash,
    );
  });
});

describe('falling through to the library', () => {
  it('returns the entry with both signatures, which is everything retargeting needs', () => {
    const entry = walkLibraryEntry();
    const resolved = resolveClip({ name: 'walk', rig, assetClips: [], library: [entry] });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.value.origin !== 'library')
      throw new Error('expected a library hit');
    expect(resolved.value.entry.id).toBe(entry.id);
    expect(resolved.value.source).toEqual(entry.sourceRig);
    expect(resolved.value.target.archetype).toBe('biped');
  });

  it('ignores entries filed under another name', () => {
    const resolved = resolveClip({
      name: 'walk',
      rig,
      assetClips: [],
      library: [walkLibraryEntry({ name: 'idle' })],
    });
    expect(resolved.ok).toBe(false);
  });

  it('takes the first compatible entry, so registration order is the tie-break', () => {
    const first = walkLibraryEntry();
    const second = walkLibraryEntry({ id: `clp_${'0'.repeat(24)}A2` });
    const resolved = resolveClip({
      name: 'walk',
      rig,
      assetClips: [],
      library: [first, second],
    });
    expect(resolved.ok && resolved.value.origin === 'library' && resolved.value.entry.id).toBe(
      first.id,
    );
  });
});

describe('when nothing fits', () => {
  it('reports why each candidate was rejected, not merely that none matched', () => {
    // "No walk cycle fits this rig" is a shrug. "It is missing `leg-right`" is a rigging
    // bug someone can go and fix.
    const legless = bipedRig({ tag: 'stump' });
    const trimmed: Rig = {
      ...legless,
      bones: legless.bones.filter((bone) => !bone.role.startsWith('leg-right')),
      anchors: legless.anchors.filter((anchor) => anchor.name !== 'sole'),
    };
    // `foot-right` hangs off `leg-right`; drop it too so the rig itself stays valid.
    const valid: Rig = {
      ...trimmed,
      bones: trimmed.bones.filter((bone) => bone.role !== 'foot-right'),
    };

    const resolved = resolveClip({
      name: 'walk',
      rig: valid,
      assetClips: [],
      library: [walkLibraryEntry()],
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('expected a miss');
    const rejected = resolved.error.context.rejected;
    expect(Array.isArray(rejected) && rejected).toHaveLength(1);
    expect(resolved.error.context).toMatchObject({ archetype: 'biped' });
    expect(JSON.stringify(rejected)).toContain('leg-right');
  });

  it('fails with an empty library rather than inventing a clip', () => {
    const resolved = resolveClip({ name: 'walk', rig, assetClips: [], library: [] });
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error.kind).toBe('not-found');
  });

  it('propagates a rig that cannot be addressed by role at all', () => {
    // A rig with two bones in one role has no signature, so no library lookup is even
    // meaningful. The failure is the signature's, and it is passed through rather than
    // being flattened into "no clip found".
    const base = bipedRig();
    const [torso, head] = base.bones;
    if (torso === undefined || head === undefined) throw new Error('fixture');
    const clashing: Rig = {
      ...base,
      bones: [torso, { ...head, role: 'torso' }, ...base.bones.slice(2)],
    };

    const resolved = resolveClip({
      name: 'walk',
      rig: clashing,
      assetClips: [],
      library: [walkLibraryEntry()],
    });
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error.kind).toBe('validation');
  });
});

describe('the resolution shape', () => {
  it('makes forgetting to retarget impossible to do silently', () => {
    // A clip plus a nullable signature would let a caller skip retargeting and get a
    // plausible-looking, wrongly-proportioned animation. The union forces the branch.
    const resolved = resolveClip({
      name: 'walk',
      rig,
      assetClips: [],
      library: [walkLibraryEntry()],
    });
    if (!resolved.ok) throw new Error('expected a hit');
    const value = resolved.value;
    if (value.origin === 'asset') throw new Error('expected the library');
    expect(RigSignature.safeParse(value.source).success).toBe(true);
    expect(RigSignature.safeParse(value.target).success).toBe(true);
  });
});
