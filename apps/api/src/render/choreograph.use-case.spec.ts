/**
 * What a shot list has to become, and what it must refuse to become.
 *
 * The assertions are about the *document*: a node per performance, a stepped cut, a
 * camera that ends up where the framing says, motion authored through the providers,
 * and the same bytes for the same input. A test that only checked "it produced an IR"
 * would still pass with every translation inverted.
 */

import { evaluate } from '@rv/anim-engine';
import { isErr } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { defaultMotionProviders } from './choreograph-stage.handler';
import { ChoreographShotsUseCase, type ChoreographInput } from './choreograph.use-case';
import { SCENE, action, placed, shot, shotId } from './__fixtures__/shots';
import { biped, walkEntry, walkFragment } from './__fixtures__/rigs';

const MOTION = {
  fps: 24,
  stepMode: 'smooth' as const,
  easings: [
    { name: 'linear', p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 } },
    { name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } },
  ],
  defaultEasing: 'ease-in-out',
  principles: {
    squashStretch: 0.3,
    anticipation: 0.4,
    followThrough: 0.4,
    overshoot: 0.25,
    secondaryMotion: 0.5,
    arcBias: 0.6,
    holdBias: 0.3,
    weight: 0.5,
  },
  boil: { enabled: true, amplitude: 0.15, hz: 8, affectsFills: false },
  ambient: {
    windHz: 0.3,
    windAmplitude: 0.25,
    windGustiness: 0.4,
    breathHz: 0.25,
    blinkIntervalMs: 4200,
    blinkVarianceMs: 1800,
    idleAmplitude: 0.2,
    phaseByDepth: 0.5,
  },
  camera: {
    panEase: 'ease-in-out',
    parallaxStrength: 0.5,
    parallaxCurve: 'exponential' as const,
    shakeAmplitude: 0.05,
    defaultShotMs: 3000,
    cutRhythm: 'measured' as const,
    allowZoom: true,
    allowRoll: false,
  },
  tempo: 1,
};

function input(overrides: Partial<ChoreographInput> = {}): ChoreographInput {
  return {
    shots: [shot()],
    fps: 24,
    seed: 7,
    name: 'a cut',
    ambient: [],
    speakers: [],
    rigs: [],
    library: [],
    variants: [],
    ...overrides,
  };
}

function useCase(): ChoreographShotsUseCase {
  return new ChoreographShotsUseCase(defaultMotionProviders());
}

async function compile(overrides: Partial<ChoreographInput> = {}) {
  const outcome = await useCase().execute(input(overrides));
  if (isErr(outcome)) throw outcome.error;
  return outcome.value;
}

describe('ChoreographShotsUseCase', () => {
  it('gives every placed instance a node and every shot a group', async () => {
    const compiled = await compile();

    const groups = compiled.ir.nodes.filter((node) => node.kind === 'group');
    const instances = compiled.ir.nodes.filter((node) => node.kind === 'asset-instance');
    expect(groups).toHaveLength(1);
    expect(instances.map((node) => node.name)).toEqual(['0-sky', '0-hero']);

    // Emitted back to front: the renderer breaks depth ties by authored order, so band
    // order in the document *is* paint order.
    expect(compiled.ir.durationMs).toBe(2000);
    expect(compiled.ir.sceneSpace).toEqual({ ...SCENE });
  });

  it('turns a shot boundary into a stepped cut, not a fade', async () => {
    const compiled = await compile({
      shots: [shot(), shot({ id: shotId('0B'), index: 1, durationMs: 1000 })],
    });

    expect(compiled.ir.durationMs).toBe(3000);

    // The second shot's group is invisible before its start, visible on the frame the
    // cut lands, and invisible after: a discontinuity at both ends.
    const second = compiled.ir.nodes.find((node) => node.name === 'shot-1');
    expect(second).toBeDefined();
    if (second === undefined) return;

    const opacityAt = (timeMs: number): number =>
      evaluate(compiled.ir, timeMs).nodes.find((node) => node.nodeId === second.id)?.worldTransform
        .opacity ?? -1;

    expect(opacityAt(1999)).toBe(0);
    expect(opacityAt(2000)).toBe(1);
    expect(opacityAt(2999)).toBe(1);
    expect(opacityAt(3000)).toBe(0);
  });

  it('compiles one instance playing two clips into two nodes, one visible at a time', async () => {
    const compiled = await compile({
      shots: [shot({ blocking: [action()] })],
    });

    const hero = compiled.ir.nodes.filter((node) => node.name.startsWith('0-hero'));
    // rest, walk, rest.
    expect(hero).toHaveLength(3);
    expect(
      hero.map((node) => (node.kind === 'asset-instance' ? (node.clipName ?? null) : null)),
    ).toEqual([null, 'walk-cycle', null]);

    const visible = (timeMs: number): readonly string[] =>
      evaluate(compiled.ir, timeMs)
        .nodes.filter(
          (node) =>
            hero.some((candidate) => candidate.id === node.nodeId) &&
            node.worldTransform.opacity > 0,
        )
        .map((node) => node.nodeId);

    expect(visible(0)).toEqual([hero[0]?.id]);
    expect(visible(500)).toEqual([hero[1]?.id]);
    expect(visible(1500)).toEqual([hero[2]?.id]);
  });

  it('cross-fades into a clip that asks for a blend', async () => {
    const compiled = await compile({
      shots: [shot({ blocking: [action({ blendMs: 200 })] })],
    });

    const walk = compiled.ir.nodes.find(
      (node) => node.kind === 'asset-instance' && node.clipName === 'walk-cycle',
    );
    expect(walk).toBeDefined();
    if (walk === undefined) return;

    const opacityAt = (timeMs: number): number =>
      evaluate(compiled.ir, timeMs).nodes.find((node) => node.nodeId === walk.id)?.worldTransform
        .opacity ?? -1;

    // A ramp rather than a jump: half way through the blend the incoming clip is half
    // there, which is what stops the pose change from popping.
    expect(opacityAt(400)).toBe(0);
    expect(opacityAt(500)).toBeGreaterThan(0.3);
    expect(opacityAt(500)).toBeLessThan(0.7);
    expect(opacityAt(600)).toBe(1);
  });

  it('refuses two clips on one instance at the same instant', async () => {
    const outcome = await useCase().execute(
      input({
        shots: [
          shot({
            blocking: [action(), action({ clip: 'wave', startMs: 600, durationMs: 400 })],
          }),
        ],
      }),
    );

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
    expect(JSON.stringify(outcome.error.context)).toContain('wave');
  });

  it('refuses a nearer band that travels less than the one behind it', async () => {
    // The one thing a single `depth` cannot express: paint over *and* travel less.
    const outcome = await useCase().execute(
      input({
        shots: [
          shot({
            layout: [
              { z: 0, instances: [placed('sky', { depth: 1 })] },
              { z: 1, instances: [placed('hero', { depth: 4 })] },
            ],
          }),
        ],
      }),
    );

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
    expect(JSON.stringify(outcome.error.context)).toContain('hero');
  });

  it('accepts two bands at one parallax depth, because that is not a contradiction', async () => {
    const compiled = await compile({
      shots: [
        shot({
          layout: [
            { z: 0, instances: [placed('sky')] },
            { z: 1, instances: [placed('hero')] },
          ],
        }),
      ],
    });

    const order = compiled.ir.nodes
      .filter((node) => node.kind === 'asset-instance')
      .map((node) => node.name);
    // Same depth, so the document's order is what decides: back band first.
    expect(order).toEqual(['0-sky', '0-hero']);
  });

  it('refuses shots composed on different canvases', async () => {
    const outcome = await useCase().execute(
      input({
        shots: [
          shot(),
          shot({
            id: shotId('0B'),
            index: 1,
            sceneSpace: {
              size: { width: 1920, height: 1080 },
              masterAspect: '16:9',
              reframeTargets: ['16:9'],
            },
          }),
        ],
      }),
    );

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
  });

  it('refuses a placement whose variant nobody translated', async () => {
    const outcome = await useCase().execute(
      input({
        shots: [
          shot({
            layout: [
              { z: 0, instances: [placed('sky', { depth: 4 })] },
              {
                z: 1,
                instances: [placed('hero', { variantId: 'vnt_01J0000000000000000000000A' })],
              },
            ],
          }),
        ],
      }),
    );

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('validation');
    expect(JSON.stringify(outcome.error.context)).toContain('vnt_');
  });

  it('frames a close-up on its subject and pans where the move says', async () => {
    const compiled = await compile({
      shots: [shot({ camera: { framing: 'close', move: 'pan-right', focusTarget: focus() } })],
      motion: MOTION,
    });

    const keys = compiled.ir.camera?.keyframes ?? [];
    expect(keys).toHaveLength(2);
    const [first, last] = keys;
    expect(first?.zoom).toBeCloseTo(1.6, 5);
    // A pan-right ends further right than it began, and is centred on the subject: the
    // middle of the move is the frame the composer actually saw.
    expect(last?.position.x).toBeGreaterThan(first?.position.x ?? 0);
    expect(((first?.position.x ?? 0) + (last?.position.x ?? 0)) / 2).toBeCloseTo(
      (0.5 - 0.5) * SCENE.width,
      5,
    );
  });

  it('honours a style that forbids zoom', async () => {
    const compiled = await compile({
      shots: [
        shot({ camera: { framing: 'extreme-close', move: 'zoom-in', focusTarget: focus() } }),
      ],
      motion: { ...MOTION, camera: { ...MOTION.camera, allowZoom: false } },
    });

    for (const key of compiled.ir.camera?.keyframes ?? []) expect(key.zoom).toBe(1);
  });

  it('attaches the ambient life the bible parameterises, and only to what was named', async () => {
    const compiled = await compile({
      shots: [shot()],
      motion: MOTION,
      ambient: [{ instance: 'hero', kinds: ['breathe', 'blink'] }],
    });

    const hero = compiled.ir.nodes.find((node) => node.name === '0-hero');
    const sky = compiled.ir.nodes.find((node) => node.name === '0-sky');
    const kindsOn = (id: string | undefined): string[] =>
      compiled.ir.behaviours
        .filter((b) => b.nodeId === id)
        .map((b) => b.kind)
        .sort();

    // Breathe and blink where the story said there is something alive; parallax and
    // boil everywhere, because those are properties of the staging and the drawing.
    expect(kindsOn(hero?.id)).toEqual(['blink', 'boil', 'breathe', 'parallax']);
    expect(kindsOn(sky?.id)).toEqual(['boil', 'parallax']);

    const breathe = compiled.ir.behaviours.find((b) => b.kind === 'breathe');
    expect(breathe?.kind === 'breathe' ? breathe.hz : null).toBe(MOTION.ambient.breathHz);
    // Seeded from the request, never at random: two behaviours on two nodes differ.
    const seeds = compiled.ir.behaviours.map((b) => b.seed);
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it('marks every cut, every beat and every line', async () => {
    const compiled = await compile({
      shots: [
        shot({
          dialogue: [
            {
              speakerRef: 'ent_01J0000000000000000000000A',
              text: 'The street moved again.',
              subtext: 'She is testing whether he noticed.',
              delivery: { emotion: 'wry', intensity: 0.4, pace: 'measured', volume: 'normal' },
              startMs: 500,
            },
          ],
          audio: { sfx: [{ key: 'sfx/door-creak/slow', startMs: 100 }], music: null },
        }),
      ],
    });

    const kinds = compiled.ir.markers.map((marker) => marker.kind).sort();
    expect(kinds).toEqual(['beat', 'cut', 'dialogue', 'sfx']);
    expect(compiled.ir.markers.find((marker) => marker.kind === 'dialogue')?.timeMs).toBe(500);
  });

  it('drives a mouth only where the line has phonemes and the speaker is placed', async () => {
    const line = {
      speakerRef: 'ent_01J0000000000000000000000A',
      text: 'The street moved again.',
      subtext: 'She is testing whether he noticed.',
      delivery: { emotion: 'wry', intensity: 0.4, pace: 'measured', volume: 'normal' },
      startMs: 500,
      phonemes: [
        { phoneme: 'AH', startMs: 0, durationMs: 120 },
        { phoneme: 'M', startMs: 120, durationMs: 90 },
      ],
    };

    const unbound = await compile({ shots: [shot({ dialogue: [line] })] });
    expect(unbound.ir.behaviours.some((b) => b.kind === 'lip-sync')).toBe(false);

    const bound = await compile({
      shots: [shot({ dialogue: [line] })],
      speakers: [{ entity: 'ent_01J0000000000000000000000A', instance: 'hero' }],
    });
    const lipSync = bound.ir.behaviours.find((b) => b.kind === 'lip-sync');
    expect(lipSync).toBeDefined();
    if (lipSync?.kind !== 'lip-sync') return;
    // On the composition's clock, not the line's: the evaluator is handed absolute time.
    expect(lipSync.phonemes[0]?.timeMs).toBe(500);
    expect(lipSync.startMs).toBe(500);
  });

  it('plays a library clip on a rig it was not authored on, rescaled', async () => {
    const compiled = await compile({
      shots: [shot({ blocking: [action({ clip: 'walk-cycle' })] })],
      // Twice the height of the rig the clip was authored on.
      rigs: [{ instance: 'hero', rig: biped(2), clips: [] }],
      library: [{ entry: walkEntry(), fragment: walkFragment(1) }],
    });

    const binding = compiled.bindings.find((entry) => entry.clip === 'walk-cycle');
    expect(binding?.origin).toBe('library');
    expect(binding?.fragmentId).toMatch(/^[0-9a-f]{64}$/);

    const fragment = compiled.fragments[0];
    expect(fragment).toBeDefined();
    if (fragment === undefined) return;

    // The whole economics of a clip library: the stride doubles because the character
    // is twice the size, and nothing else about the clip changes. A carry that did not
    // rescale is a character whose feet skate.
    const carry = fragment.ir.tracks.find((track) => track.channel === 'position.x');
    expect(carry?.keyframes[1]?.value).toBe(88);
    const cycle = fragment.ir.behaviours.find((b) => b.kind === 'walk-cycle');
    expect(cycle?.kind === 'walk-cycle' ? cycle.strideLength : null).toBe(52);
  });

  it('prefers the asset’s own clip over the library, so promotion changes nothing', async () => {
    const compiled = await compile({
      shots: [shot({ blocking: [action({ clip: 'walk-cycle' })] })],
      rigs: [
        {
          instance: 'hero',
          rig: biped(2),
          clips: [
            {
              id: 'clp_01J0000000000000000000000A',
              name: 'walk-cycle',
              source: 'template',
              durationMs: 1000,
              fps: 24,
              loop: 'loop',
              irHash: 'a'.repeat(64),
              tags: [],
              provenance: {
                source: 'derived',
                parents: [],
                createdAt: '2026-08-24T00:00:00.000Z',
                costNanoUsd: 0,
              },
            },
          ],
        },
      ],
      library: [{ entry: walkEntry(), fragment: walkFragment(1) }],
    });

    expect(compiled.bindings[0]?.origin).toBe('asset');
    expect(compiled.fragments).toHaveLength(0);
  });

  it('fails a clip name that resolves to nothing on a rig it can check', async () => {
    const outcome = await useCase().execute(
      input({
        shots: [shot({ blocking: [action({ clip: 'somersault' })] })],
        rigs: [{ instance: 'hero', rig: biped(1), clips: [] }],
        library: [{ entry: walkEntry(), fragment: walkFragment(1) }],
      }),
    );

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.kind).toBe('not-found');
  });

  it('compiles the same shots to the same document, byte for byte', async () => {
    const first = await compile({
      motion: MOTION,
      ambient: [{ instance: 'hero', kinds: ['wind'] }],
    });
    const second = await compile({
      motion: MOTION,
      ambient: [{ instance: 'hero', kinds: ['wind'] }],
    });

    // Ids, seeds and the handheld jitter all derive from the request, so two compiles
    // are the same document and therefore the same content address - which is what
    // lets a re-run of a cut reuse the render instead of drawing it again.
    expect(JSON.stringify(second.ir)).toBe(JSON.stringify(first.ir));
  });

  it('shakes a handheld shot deterministically, and differently from a locked one', async () => {
    const held = await compile({
      shots: [shot({ camera: { framing: 'medium', move: 'handheld', focusTarget: focus() } })],
      motion: MOTION,
    });
    const locked = await compile({
      shots: [shot({ camera: { framing: 'medium', move: 'static', focusTarget: focus() } })],
      motion: MOTION,
    });

    const heldKeys = held.ir.camera?.keyframes ?? [];
    expect(heldKeys.length).toBeGreaterThan(5);
    expect(new Set(heldKeys.map((key) => key.position.x)).size).toBeGreaterThan(5);
    expect(locked.ir.camera?.keyframes).toHaveLength(2);

    const again = await compile({
      shots: [shot({ camera: { framing: 'medium', move: 'handheld', focusTarget: focus() } })],
      motion: MOTION,
    });
    expect(again.ir.camera?.keyframes).toEqual(heldKeys);
  });

  it('records what each shot is about, because the IR cannot', async () => {
    const compiled = await compile({
      shots: [shot(), shot({ id: shotId('0B'), index: 1, durationMs: 1000 })],
    });

    expect(compiled.shots.map((entry) => entry.startMs)).toEqual([0, 2000]);
    const hero = compiled.ir.nodes.find((node) => node.name === '0-hero');
    expect(compiled.shots[0]?.focusNodeId).toBe(hero?.id);
    expect(compiled.shots[0]?.safeArea).toEqual({ x: 0.05, y: 0.05, width: 0.9, height: 0.9 });
  });
});

function focus(): Record<string, unknown> {
  return {
    instance: 'hero',
    region: { x: 0.4, y: 0.35, width: 0.2, height: 0.3 },
    priority: 'must-keep',
  };
}
