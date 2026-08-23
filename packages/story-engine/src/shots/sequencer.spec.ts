/**
 * S7, tested on the two properties that make a shot list re-framable.
 *
 * Every shot must carry a `focusTarget` and a `safeArea` - without both, one composition
 * cannot become four deliverables and the whole authoring-once premise collapses. The rest
 * of the tests are about the references resolving: a handle, a clip or a beat that does
 * not exist is a failure three stages later, and here it is a failure now.
 */

import { describe, expect, it } from 'vitest';
import type { DialogueLine } from '@rv/contracts';
import { CameraGrammar, Shot } from '@rv/contracts';
import { isErr } from '@rv/shared-kernel';

import { FakeStructuredBackend, respondError, respondJson } from '../__fixtures__/fakes';
import { IDS, fixtureId, scene, testDeps } from '../__fixtures__/builders';
import {
  BuildShotListUseCase,
  type BuildShotListInput,
  type PlaceableAsset,
  bandDepthOrder,
  checkPlanReferences,
} from './build-shot-list';
import { ShotListPlan } from './build-shot-list';

const CANVAS = { width: 2_560, height: 2_560 };

const PLACEABLES: readonly PlaceableAsset[] = [
  {
    instance: 'mahtab',
    label: 'Mahtab, working oilskin',
    assetId: fixtureId('ast', 1),
    assetVersionId: fixtureId('asv', 1),
    entityRef: IDS.mahtab,
    band: 'midground',
    clipVocabulary: ['idle', 'walk-cycle', 'reach-left'],
  },
  {
    instance: 'lamp-room',
    label: 'The lamp room interior',
    assetId: fixtureId('ast', 2),
    assetVersionId: fixtureId('asv', 2),
    band: 'background',
    clipVocabulary: [],
  },
];

const DIALOGUE: readonly DialogueLine[] = [
  {
    speakerRef: IDS.mahtab,
    text: 'Aye then.',
    subtext: 'Buying a second.',
    delivery: { emotion: 'flat', intensity: 0.3, pace: 'measured', volume: 'low' },
    startMs: 4_000,
    phonemes: [],
  },
];

function shotPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ordinal: 1,
    beatOrdinal: 1,
    framing: 'wide',
    move: 'static',
    weight: 1,
    intent: 'Establish the room and how far she still has to climb.',
    instances: [
      { instance: 'lamp-room', band: 'background', x: 0.5, y: 0.5, scale: 1, depth: 4 },
      { instance: 'mahtab', band: 'midground', x: 0.35, y: 0.6, scale: 1, depth: 1 },
    ],
    focusInstance: 'mahtab',
    focusRegion: { x: 0.28, y: 0.4, width: 0.2, height: 0.35 },
    focusPriority: 'must-keep',
    blocking: [
      {
        instance: 'mahtab',
        clip: 'walk-cycle',
        startFraction: 0,
        durationFraction: 0.8,
        loop: 'loop',
      },
    ],
    dialogueLineIndexes: [],
    ...overrides,
  };
}

function plan(...shots: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    pacingNote: 'Two wides and a close, so the name lands on the only tight frame.',
    shots: shots.length === 0 ? [shotPlan()] : shots,
  };
}

function input(overrides: Partial<BuildShotListInput> = {}): BuildShotListInput {
  return {
    scene: scene(),
    sceneDurationMs: 12_000,
    camera: CameraGrammar.parse({ cutRhythm: 'measured', defaultShotMs: 3_000 }),
    fps: 24,
    masterAspect: '16:9',
    deliverables: ['16:9', '9:16'],
    canvas: CANVAS,
    placeables: PLACEABLES,
    ...overrides,
  };
}

function run(
  body: Record<string, unknown>,
  overrides: Partial<BuildShotListInput> = {},
): { backend: FakeStructuredBackend; result: ReturnType<BuildShotListUseCase['execute']> } {
  const backend = new FakeStructuredBackend({ script: [respondJson(body)] });
  return {
    backend,
    result: new BuildShotListUseCase(testDeps(backend)).execute(input(overrides)),
  };
}

describe('BuildShotListUseCase', () => {
  it('produces shots that parse against the Shot contract', async () => {
    const outcome = await run(
      plan(shotPlan(), shotPlan({ ordinal: 2, beatOrdinal: 2, framing: 'close' })),
    ).result;

    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.shots).toHaveLength(2);
    for (const shot of outcome.value.shots) {
      expect(Shot.safeParse(shot).success).toBe(true);
      expect(shot.durationMs).toBeGreaterThan(0);
    }
    expect(outcome.value.shots.map((shot) => shot.index)).toEqual([0, 1]);
  });

  it('gives every shot a focus target and a safe area, so one composition reframes', async () => {
    const outcome = await run(plan()).result;
    if (isErr(outcome)) throw new Error(outcome.error.message);

    const [shot] = outcome.value.shots;
    expect(shot?.focusTarget.instance).toBe('mahtab');
    expect(shot?.focusTarget.priority).toBe('must-keep');
    expect(shot?.safeArea.width).toBeGreaterThan(0);
    expect(shot?.safeArea.width).toBeLessThan(1);
    expect(shot?.sceneSpace.reframeTargets).toEqual(['16:9', '9:16']);
    expect(shot?.sceneSpace.masterAspect).toBe('16:9');
  });

  it('sums the shot durations to exactly the scene duration', async () => {
    const outcome = await run(
      plan(
        shotPlan({ weight: 1 }),
        shotPlan({ ordinal: 2, beatOrdinal: 2, weight: 3 }),
        shotPlan({ ordinal: 3, beatOrdinal: 1, weight: 2 }),
      ),
    ).result;

    if (isErr(outcome)) throw new Error(outcome.error.message);
    const total = outcome.value.shots.reduce((sum, shot) => sum + shot.durationMs, 0);
    expect(total).toBe(12_000);
  });

  it('paces from the style bible, not from the model', async () => {
    const { backend } = run(plan(), {
      camera: CameraGrammar.parse({ cutRhythm: 'frenetic', defaultShotMs: 2_000 }),
    });
    await new BuildShotListUseCase(testDeps(backend)).execute(
      input({ camera: CameraGrammar.parse({ cutRhythm: 'frenetic', defaultShotMs: 2_000 }) }),
    );
    expect(backend.userPromptAt(0)).toContain('The style cuts frenetic');
  });

  it('bands the layout by depth with contiguous paint order', async () => {
    const outcome = await run(plan()).result;
    if (isErr(outcome)) throw new Error(outcome.error.message);

    const [shot] = outcome.value.shots;
    expect(shot?.layout.map((layer) => layer.z)).toEqual([0, 1]);
    expect(shot?.layout.map((layer) => layer.name)).toEqual(['background', 'midground']);
    expect(shot?.layout[0]?.instances[0]?.assetVersionId).toBe(fixtureId('asv', 2));
  });

  it('places instances in scene units, not in fractions', async () => {
    const outcome = await run(plan()).result;
    if (isErr(outcome)) throw new Error(outcome.error.message);
    const instance = outcome.value.shots[0]?.layout[1]?.instances[0];
    expect(instance?.transform.position.x).toBeCloseTo(0.35 * CANVAS.width);
    expect(instance?.transform.position.y).toBeCloseTo(0.6 * CANVAS.height);
    expect(instance?.depth).toBe(1);
  });

  it('turns blocking fractions into milliseconds inside the shot', async () => {
    const outcome = await run(plan()).result;
    if (isErr(outcome)) throw new Error(outcome.error.message);
    const action = outcome.value.shots[0]?.blocking[0];
    expect(action?.startMs).toBe(0);
    expect(action?.durationMs).toBeCloseTo(0.8 * (outcome.value.shots[0]?.durationMs ?? 0), -1);
    expect(action?.loop).toBe('loop');
  });

  it('re-bases a scene-timed line onto the shot that carries it', async () => {
    const outcome = await run(
      plan(shotPlan(), shotPlan({ ordinal: 2, beatOrdinal: 2, dialogueLineIndexes: [0] })),
      { dialogue: DIALOGUE },
    ).result;

    if (isErr(outcome)) throw new Error(outcome.error.message);
    const [first, second] = outcome.value.shots;
    expect(first?.dialogue).toEqual([]);
    // The line was at 4 000 ms of the scene; shot two starts at 6 000 ms, so it clamps to 0.
    expect(second?.dialogue[0]?.startMs).toBe(0);
    expect(second?.dialogue[0]?.text).toBe('Aye then.');
  });

  it('ignores a dialogue index that points at no line', async () => {
    const outcome = await run(plan(shotPlan({ dialogueLineIndexes: [0, 9] })), {
      dialogue: DIALOGUE,
    }).result;
    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.shots[0]?.dialogue).toHaveLength(1);
  });

  it('refuses a plan with nothing to stage', async () => {
    const backend = new FakeStructuredBackend();
    const outcome = await new BuildShotListUseCase(testDeps(backend)).execute(
      input({ placeables: [] }),
    );
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'no-placeables' });
    expect(backend.callCount).toBe(0);
  });

  it('refuses an unknown asset handle', async () => {
    const outcome = await run(
      plan(
        shotPlan({
          instances: [
            { instance: 'the-tide', band: 'midground', x: 0.5, y: 0.5, scale: 1, depth: 1 },
          ],
          focusInstance: null,
        }),
      ),
    ).result;
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({
      reason: 'dangling-shot-reference',
      unknownHandles: ['the-tide'],
    });
  });

  it("refuses a clip the asset's rig does not register", async () => {
    const outcome = await run(
      plan(
        shotPlan({
          blocking: [
            {
              instance: 'mahtab',
              clip: 'backflip',
              startFraction: 0,
              durationFraction: 1,
              loop: 'once',
            },
          ],
        }),
      ),
    ).result;
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ unknownClips: ['mahtab:backflip'] });
  });

  it('refuses a beat that is not in this scene', async () => {
    const outcome = await run(plan(shotPlan({ beatOrdinal: 9 }))).result;
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ unknownBeats: [9] });
  });

  it('refuses a focus target that is not staged in its own shot', async () => {
    const outcome = await run(
      plan(
        shotPlan({
          instances: [
            { instance: 'lamp-room', band: 'background', x: 0.5, y: 0.5, scale: 1, depth: 4 },
          ],
          focusInstance: 'mahtab',
          blocking: [],
        }),
      ),
    ).result;
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ unplacedFocus: ['mahtab'] });
  });

  it('refuses a scene too short for the shots the plan wants', async () => {
    const outcome = await run(
      plan(
        shotPlan(),
        shotPlan({ ordinal: 2, beatOrdinal: 2 }),
        shotPlan({ ordinal: 3, beatOrdinal: 1 }),
      ),
      { sceneDurationMs: 50 },
    ).result;
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'scene-too-short-for-shots' });
  });

  it('reports every class of dangling reference at once, not one per round trip', async () => {
    const outcome = await run(
      plan(
        shotPlan({
          beatOrdinal: 9,
          instances: [
            { instance: 'nobody', band: 'midground', x: 0.5, y: 0.5, scale: 1, depth: 1 },
          ],
          focusInstance: 'mahtab',
          blocking: [
            {
              instance: 'mahtab',
              clip: 'backflip',
              startFraction: 0,
              durationFraction: 1,
              loop: 'once',
            },
          ],
        }),
      ),
    ).result;

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({
      unknownHandles: ['nobody'],
      unknownBeats: [9],
      unknownClips: ['mahtab:backflip'],
      unplacedFocus: ['mahtab'],
    });
  });

  it('refuses a blocking action on a handle that is not a placeable at all', async () => {
    const outcome = await run(
      plan(
        shotPlan({
          blocking: [
            {
              instance: 'the-tide',
              clip: 'idle',
              startFraction: 0,
              durationFraction: 1,
              loop: 'once',
            },
          ],
        }),
      ),
    ).result;
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ unknownHandles: ['the-tide'] });
  });

  it('lets the Shot contract have the last word on a composition it rejects', async () => {
    // Every handle resolves, so the pre-check passes - but the same instance is staged in
    // two bands, which `Shot`'s own refinement refuses. Re-implementing that check here
    // would give us two versions of it, so the failure is surfaced from the parse.
    const outcome = await run(
      plan(
        shotPlan({
          instances: [
            { instance: 'mahtab', band: 'background', x: 0.4, y: 0.5, scale: 1, depth: 2 },
            { instance: 'mahtab', band: 'midground', x: 0.6, y: 0.5, scale: 1, depth: 1 },
          ],
          blocking: [],
        }),
      ),
    ).result;

    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.context).toMatchObject({ reason: 'invalid-shot', ordinal: 1 });
  });

  it('honours a caller-supplied safe area over the solved one', async () => {
    const custom = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    const outcome = await run(plan(), { safeArea: custom }).result;
    if (isErr(outcome)) throw new Error(outcome.error.message);
    expect(outcome.value.safeArea).toEqual(custom);
    expect(outcome.value.shots[0]?.safeArea).toEqual(custom);
  });

  it('shows the director only the handles it may use', async () => {
    const { backend, result } = run(plan());
    await result;
    const prompt = backend.userPromptAt(0);
    expect(prompt).toContain(
      'mahtab - Mahtab, working oilskin [midground]; clips: idle, walk-cycle',
    );
    expect(prompt).toContain('You cannot introduce an asset that is not here');
    expect(prompt).toContain('1. [setup] The climb');
  });

  it('surfaces a failed call as a Result', async () => {
    const backend = new FakeStructuredBackend({ script: [respondError(), respondError()] });
    const outcome = await new BuildShotListUseCase(testDeps(backend)).execute(input());
    expect(isErr(outcome)).toBe(true);
  });
});

describe('ShotListPlan', () => {
  it('refuses a shot list whose ordinals have a gap', () => {
    const parsed = ShotListPlan.safeParse(plan(shotPlan({ ordinal: 1 }), shotPlan({ ordinal: 3 })));
    expect(parsed.success).toBe(false);
  });
});

describe('checkPlanReferences', () => {
  it('passes a plan whose references all resolve', () => {
    const parsed = ShotListPlan.parse(plan());
    const outcome = checkPlanReferences(
      parsed,
      new Map(PLACEABLES.map((placeable) => [placeable.instance, placeable])),
      new Map([[1, { id: 'bet_x' }]]),
    );
    expect(isErr(outcome)).toBe(false);
  });
});

describe('bandDepthOrder', () => {
  it('keeps the canonical ordering even when a band is unused', () => {
    expect(bandDepthOrder('background')).toBeLessThan(bandDepthOrder('midground'));
    expect(bandDepthOrder('midground')).toBeLessThan(bandDepthOrder('foreground'));
  });
});
