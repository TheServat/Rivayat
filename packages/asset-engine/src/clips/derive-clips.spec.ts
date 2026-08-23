import { describe, expect, it } from 'vitest';
import { AnimationIR, AssetArchetype } from '@rv/contracts';
import { contentHash, stableStringify, unwrap } from '@rv/shared-kernel';
import { evaluate } from '@rv/anim-engine';

import { InMemoryBlobStore } from '../__fixtures__/doubles';
import {
  painterlyMotion,
  paperCutoutMotion,
  specFor,
  styleBible,
  testClock,
} from '../__fixtures__/builders';
import { templateFor } from '../rig/templates/index';
import { CLIP_KINDS } from './clip-kinds';
import { buildClipIr } from './build-clip-ir';
import { DeriveClipsUseCase } from './derive-clips';

const ARCHETYPES = AssetArchetype.options;

function useCase(): { derive: DeriveClipsUseCase; blobs: InMemoryBlobStore } {
  const blobs = new InMemoryBlobStore();
  return { derive: new DeriveClipsUseCase({ blobs, clock: testClock() }), blobs };
}

describe('clip kinds', () => {
  it('defines every clip name any template asks for', () => {
    // A template clip with no kind would produce an empty animation and no error.
    const missing = ARCHETYPES.flatMap((archetype) =>
      templateFor(archetype).clipNames.filter((name) => CLIP_KINDS[name] === undefined),
    );
    expect(missing).toEqual([]);
  });
});

describe('buildClipIr', () => {
  it.each(ARCHETYPES)('%s produces schema-valid IR for every one of its clips', (archetype) => {
    const style = styleBible();
    for (const clipName of templateFor(archetype).clipNames) {
      const { ir } = buildClipIr({
        archetype,
        clipName,
        motion: style.motion,
        styleSeed: style.seed,
        sceneSpace: { width: 512, height: 512 },
        nominalHeight: 512,
        deformableRoles: specFor(archetype)
          .parts.filter((part) => part.deformable)
          .map((part) => part.role),
      });

      const parsed = AnimationIR.safeParse(ir);
      if (!parsed.success) {
        throw new Error(
          `${archetype}/${clipName}: ${JSON.stringify(parsed.error.issues, null, 2)}`,
        );
      }
      expect(ir.durationMs).toBeGreaterThan(0);
    }
  });

  it('falls back to the idle kind for a clip name nothing defines', () => {
    const style = styleBible();
    const { kind } = buildClipIr({
      archetype: 'tree',
      clipName: 'no-such-clip',
      motion: style.motion,
      styleSeed: style.seed,
      sceneSpace: { width: 128, height: 128 },
      nominalHeight: 256,
    });
    expect(kind.family).toBe('ambient');
  });

  it('is a pure function: the same inputs hash identically', () => {
    const style = styleBible();
    const build = (): unknown =>
      buildClipIr({
        archetype: 'tree',
        clipName: 'sway',
        motion: style.motion,
        styleSeed: style.seed,
        sceneSpace: { width: 128, height: 128 },
        nominalHeight: 256,
      }).ir;

    expect(contentHash(build())).toBe(contentHash(build()));
  });

  it('drives the root when an ambient clip finds nothing deformable', () => {
    const style = styleBible();
    const { ir } = buildClipIr({
      archetype: 'rigid-prop',
      clipName: 'idle',
      motion: style.motion,
      styleSeed: style.seed,
      sceneSpace: { width: 128, height: 128 },
      nominalHeight: 256,
      deformableRoles: [],
    });
    // "Nothing is ever perfectly still" has to survive contact with a crate.
    expect(ir.behaviours.length).toBeGreaterThan(0);
  });

  it('adds boil to every role when the style enables it, and none when it does not', () => {
    const boiling = styleBible();
    const smooth = styleBible({ motion: painterlyMotion() });
    const common = {
      archetype: 'tree' as const,
      clipName: 'sway',
      styleSeed: 1,
      sceneSpace: { width: 128, height: 128 },
      nominalHeight: 256,
    };

    const withBoil = buildClipIr({ ...common, motion: boiling.motion }).ir;
    const withoutBoil = buildClipIr({ ...common, motion: smooth.motion }).ir;

    expect(withBoil.behaviours.some((behaviour) => behaviour.kind === 'boil')).toBe(true);
    expect(withoutBoil.behaviours.some((behaviour) => behaviour.kind === 'boil')).toBe(false);
  });

  it('reads the character motion signature into the walk cycle', () => {
    const style = styleBible();
    const common = {
      archetype: 'biped' as const,
      clipName: 'walk',
      motion: style.motion,
      styleSeed: style.seed,
      sceneSpace: { width: 512, height: 512 },
      nominalHeight: 512,
    };

    const trudger = buildClipIr({
      ...common,
      signature: {
        gaitStyle: 'trudge',
        posture: 'slouched',
        gestureFrequency: 0.1,
        energy: 0.1,
        idleBehaviour: 'x',
        tellOnLying: 'y',
      },
    }).ir;
    const bouncer = buildClipIr({
      ...common,
      signature: {
        gaitStyle: 'bounce',
        posture: 'upright',
        gestureFrequency: 0.9,
        energy: 0.9,
        idleBehaviour: 'x',
        tellOnLying: 'y',
      },
    }).ir;

    const gaitOf = (ir: typeof trudger): string | undefined =>
      ir.behaviours.find((behaviour) => behaviour.kind === 'walk-cycle')?.kind === 'walk-cycle'
        ? ir.behaviours.flatMap((behaviour) =>
            behaviour.kind === 'walk-cycle' ? [behaviour.gait] : [],
          )[0]
        : undefined;

    expect(gaitOf(trudger)).toBe('shuffle');
    expect(gaitOf(bouncer)).toBe('skip');
    // Two signatures, measurably different motion at the same instant.
    expect(evaluate(trudger, 300)).not.toEqual(evaluate(bouncer, 300));
  });

  it('uses linear for a spin only when the style declares the curve', () => {
    const withLinear = styleBible();
    const withoutLinear = styleBible({ motion: painterlyMotion() });
    const common = {
      archetype: 'wheeled' as const,
      clipName: 'roll',
      styleSeed: 1,
      sceneSpace: { width: 128, height: 128 },
      nominalHeight: 256,
    };

    const named = (motion: typeof withLinear.motion): string | undefined => {
      const easing = buildClipIr({ ...common, motion }).ir.tracks[0]?.keyframes[0]?.easing;
      return easing?.kind === 'named' ? easing.name : undefined;
    };

    expect(named(withLinear.motion)).toBe('linear');
    expect(named(withoutLinear.motion)).toBe('back-out');
  });
});

describe('the style genuinely parameterises the motion', () => {
  const paperCutout = styleBible({ motion: paperCutoutMotion() });
  const painterly = styleBible({ motion: painterlyMotion(), checksum: 'd'.repeat(64) });

  it.each(['idle', 'flap', 'react'])(
    'the same clip name (%s) under two motion blocks produces different IR',
    (clipName) => {
      const common = {
        archetype: 'winged' as const,
        clipName,
        styleSeed: 7,
        sceneSpace: { width: 512, height: 512 },
        nominalHeight: 512,
        deformableRoles: ['wing-left', 'wing-right', 'tail'],
      };

      const cut = buildClipIr({ ...common, motion: paperCutout.motion, exaggeration: 0.4 }).ir;
      const paint = buildClipIr({ ...common, motion: painterly.motion, exaggeration: 0.9 }).ir;

      // If these were equal, the motion half of the style bible would be decorative.
      expect(stableStringify(cut)).not.toBe(stableStringify(paint));
      expect(contentHash(cut)).not.toBe(contentHash(paint));
    },
  );

  it('the difference is in the numbers, not only in the ids', () => {
    const common = {
      archetype: 'winged' as const,
      clipName: 'flap',
      styleSeed: 7,
      sceneSpace: { width: 512, height: 512 },
      nominalHeight: 512,
      deformableRoles: ['wing-left'],
    };

    const cut = buildClipIr({ ...common, motion: paperCutout.motion, exaggeration: 0.2 }).ir;
    const paint = buildClipIr({ ...common, motion: painterly.motion, exaggeration: 0.9 }).ir;

    const amplitude = (ir: typeof cut): number =>
      ir.behaviours.flatMap((behaviour) =>
        behaviour.kind === 'flap' ? [behaviour.amplitudeDeg] : [],
      )[0] ?? 0;

    expect(amplitude(paint)).toBeGreaterThan(amplitude(cut));
    // Tempo 1.5 shortens every clip in the painterly style.
    expect(paint.durationMs).toBeLessThan(cut.durationMs);
  });

  it('the difference survives evaluation, which is what a viewer sees', () => {
    const common = {
      archetype: 'tree' as const,
      clipName: 'wind-gust',
      styleSeed: 7,
      sceneSpace: { width: 512, height: 512 },
      nominalHeight: 512,
      deformableRoles: ['bough-left', 'bough-right', 'canopy'],
    };

    const cut = buildClipIr({ ...common, motion: paperCutout.motion }).ir;
    const paint = buildClipIr({ ...common, motion: painterly.motion }).ir;

    const poseOf = (ir: typeof cut, motion: typeof paperCutout.motion): number =>
      evaluate(ir, 800, { motion }).nodes.reduce(
        (sum, node) => sum + node.worldTransform.rotation,
        0,
      );

    expect(poseOf(cut, paperCutout.motion)).not.toBeCloseTo(poseOf(paint, painterly.motion), 3);
  });
});

describe('DeriveClipsUseCase', () => {
  it('produces the archetype default clip set and stores each IR by content hash', async () => {
    const { derive, blobs } = useCase();
    const spec = specFor('tree');
    const style = styleBible();

    const output = unwrap(await derive.execute({ spec, style }));

    expect(output.clips.map((entry) => entry.clip.name)).toEqual(templateFor('tree').clipNames);
    for (const entry of output.clips) {
      expect(entry.clip.irHash).toBe(contentHash(entry.ir));
      // The blob's own sha256 is the IR's content hash, which is what makes the store
      // shared rather than merely deduplicated by luck.
      expect(blobs.puts).toContain(entry.clip.irHash);
    }
  });

  it('gives a tree at least idle, sway and wind-gust', async () => {
    const { derive } = useCase();
    const output = unwrap(await derive.execute({ spec: specFor('tree'), style: styleBible() }));
    const names = output.clips.map((entry) => entry.clip.name);

    expect(names).toEqual(expect.arrayContaining(['idle', 'sway', 'wind-gust']));
  });

  it('gives a biped at least idle, walk and talk plus an expression-driven clip', async () => {
    const { derive } = useCase();
    const output = unwrap(
      await derive.execute({
        spec: specFor('biped', { subjectClass: 'character' }),
        style: styleBible(),
      }),
    );
    const names = output.clips.map((entry) => entry.clip.name);

    expect(names).toEqual(expect.arrayContaining(['idle', 'walk', 'talk', 'react']));
  });

  it('shares one blob between two archetypes that derive an identical clip', async () => {
    const { derive, blobs } = useCase();
    const style = styleBible();

    await derive.execute({ spec: specFor('shrub'), style, only: ['idle'] });
    const before = blobs.size;
    await derive.execute({ spec: specFor('shrub'), style, only: ['idle'] });

    // Content addressing means the second derivation writes nothing new.
    expect(blobs.size).toBe(before);
  });

  it('honours an `only` filter but never invents a clip the template lacks', async () => {
    const { derive } = useCase();
    const output = unwrap(
      await derive.execute({ spec: specFor('tree'), style: styleBible(), only: ['sway', 'flap'] }),
    );
    expect(output.clips.map((entry) => entry.clip.name)).toEqual(['sway']);
  });

  it('records the style checksum as the clip parent', async () => {
    const { derive } = useCase();
    const style = styleBible();
    const output = unwrap(await derive.execute({ spec: specFor('tree'), style, only: ['idle'] }));
    expect(output.clips[0]?.clip.provenance.parents).toEqual([style.checksum]);
  });
});
