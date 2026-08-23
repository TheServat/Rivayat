import { type ArtMedium, type MotionStyle, StyleBible } from '@rv/contracts';
import { at, isErr, isOk } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { testClock, testIds } from '../__fixtures__/fakes';
import { compilePromptFragments } from '../prompts/compile';
import { materialiseStyleBible } from '../style-bible-factory';
import { STYLE_PRESETS, findPreset, presetIds, presetsForMedium } from './index';
import {
  MOTION_DISTINCTNESS_FLOOR,
  coreMotionDistance,
  motionDifferences,
  motionDistance,
} from './motion-signature';
import { PRESET_DEFINITIONS } from './library';
import { toStylePreset } from './preset';

/**
 * The media RV-041 requires a preset for.
 *
 * Spelled with the contract's own enum values, so a rename in `ArtMedium` breaks this
 * list rather than quietly leaving a medium uncovered.
 */
const REQUIRED_MEDIA: readonly ArtMedium[] = [
  'flat-vector',
  'painterly',
  'paper-cutout',
  'pixel-art',
  'ink-comic',
  'watercolour',
  'claymation',
  'gouache',
  'woodblock',
];

describe('the preset library', () => {
  it('ships at least one preset per medium the backlog names', () => {
    for (const medium of REQUIRED_MEDIA) {
      expect(presetsForMedium(medium).length, `no preset for medium "${medium}"`).toBeGreaterThan(
        0,
      );
    }
  });

  it('has unique ids and unique seeds', () => {
    expect(new Set(presetIds()).size).toBe(STYLE_PRESETS.length);
    // Two styles sharing a base seed produce the same composition from the same prompt,
    // which makes them look more alike than they are.
    expect(new Set(STYLE_PRESETS.map((preset) => preset.draft.seed)).size).toBe(
      STYLE_PRESETS.length,
    );
  });

  it('names every preset in both locales', () => {
    for (const preset of STYLE_PRESETS) {
      expect(preset.name.fa.length, preset.id).toBeGreaterThan(0);
      expect(preset.name.en, preset.id).toBeDefined();
      expect(preset.description.fa.length, preset.id).toBeGreaterThan(0);
      expect(preset.description.en, preset.id).toBeDefined();
    }
  });

  it.each(STYLE_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s materialises into a StyleBible that parses',
    (_id, preset) => {
      const bible = materialiseStyleBible({
        draft: preset.draft,
        id: testIds().styleBible(),
        clock: testClock(),
      });
      expect(() => StyleBible.parse(bible)).not.toThrow();
      expect(bible.origin).toBe('preset');
      expect(bible.lockedAt).toBeNull();
    },
  );

  it.each(STYLE_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s derives its prompts rather than storing hand-written ones',
    (_id, preset) => {
      // The point of the whole compiler: recompiling from the structured fields must
      // reproduce the stored fragments exactly. If a preset ever hand-wrote its prompt,
      // editing `shading.steps` in the UI would change nothing about the pixels.
      expect(compilePromptFragments({ visual: preset.draft.visual })).toEqual(preset.draft.prompts);
    },
  );

  it('compiles identically on every load', () => {
    const first = PRESET_DEFINITIONS.map((definition) => toStylePreset(definition));
    const second = PRESET_DEFINITIONS.map((definition) => toStylePreset(definition));
    expect(first).toEqual(second);
    expect(first).toEqual([...STYLE_PRESETS]);
  });

  it('takes its bible name from the requested locale', () => {
    const definition = PRESET_DEFINITIONS[0];
    if (definition === undefined) throw new Error('no presets');
    expect(toStylePreset(definition, { locale: 'en' }).draft.name).toBe(definition.name.en);
    expect(toStylePreset(definition, { locale: 'fa' }).draft.name).toBe(definition.name.fa);
  });

  it('falls back to Persian for a preset with no English name, and omits absent notes', () => {
    // `LocalisedText` makes English optional on purpose - a Persian-only project must
    // not be forced to invent translations - so asking for `en` on one has to resolve
    // to something rather than to `undefined` in a required `Label`.
    const definition = PRESET_DEFINITIONS[0];
    if (definition === undefined) throw new Error('no presets');
    const { notes: _dropped, ...withoutNotes } = definition;
    const persianOnly = toStylePreset(
      { ...withoutNotes, name: { fa: 'فقط فارسی' }, description: { fa: 'بدون ترجمه' } },
      { locale: 'en' },
    );
    expect(persianOnly.draft.name).toBe('فقط فارسی');
    expect(persianOnly.draft.notes).toBeUndefined();
  });

  it('reports an unknown id rather than returning undefined', () => {
    const missing = findPreset('not-a-style');
    expect(isErr(missing)).toBe(true);
    if (isErr(missing)) expect(missing.error.kind).toBe('not-found');
    expect(isOk(findPreset('paper-cutout'))).toBe(true);
  });
});

describe('preset motion profiles', () => {
  const pairs = STYLE_PRESETS.flatMap((left, index) =>
    STYLE_PRESETS.slice(index + 1).map((right) => [left, right] as const),
  );

  /**
   * The property that matters, asserted over the whole set.
   *
   * A library where seven styles share one motion profile is eight palettes over one
   * template. Checking every pair - rather than eyeballing the file - is the only way
   * that failure is caught, because it is invisible one preset at a time.
   */
  it.each(pairs.map(([left, right]) => [`${left.id} vs ${right.id}`, left, right] as const))(
    '%s move materially differently',
    (label, left, right) => {
      const distance = motionDistance(left.draft.motion, right.draft.motion);
      expect(
        distance,
        `${label} differ on only ${String(motionDifferences(left.draft.motion, right.draft.motion).length)} dimensions (distance ${distance.toFixed(3)})`,
      ).toBeGreaterThanOrEqual(MOTION_DISTINCTNESS_FLOOR);
    },
  );

  /**
   * The same floor, over the dimensions that decide movement rather than editing.
   *
   * `motionDistance` is a mean over every dimension of `MotionStyle`, and four of those -
   * shot length, cut rhythm, and whether the camera may zoom or roll - are worth `4/34`
   * between them. Two profiles identical in frame rate, tempo, step mode, all eight
   * principles, boil, easing and every ambient value score 0.125 on the full measure and
   * clear the 0.12 floor while being, to a viewer, the same motion.
   *
   * So the library is held to the floor on the core measure too. It passes with room -
   * the closest pair is `ink-comic` vs `felt-craft` - and no preset or threshold moved to
   * make that true.
   */
  it.each(pairs.map(([left, right]) => [`${left.id} vs ${right.id}`, left, right] as const))(
    '%s differ in how they move, not only in how they are cut',
    (label, left, right) => {
      const distance = coreMotionDistance(left.draft.motion, right.draft.motion);
      expect(
        distance,
        `${label} are distinguishable only by editorial settings (core distance ${distance.toFixed(3)})`,
      ).toBeGreaterThanOrEqual(MOTION_DISTINCTNESS_FLOOR);
    },
  );

  it('rejects a twin that clears the full floor on editorial dimensions alone', () => {
    // The counterexample, built rather than described. Everything a viewer could see is
    // byte-identical; only the cut and two camera permissions differ.
    const base = at(STYLE_PRESETS, 0).draft.motion;
    const twin: MotionStyle = {
      ...base,
      ambient: { ...base.ambient, blinkIntervalMs: 12_000 },
      camera: {
        ...base.camera,
        defaultShotMs: 12_000,
        allowZoom: !base.camera.allowZoom,
        allowRoll: !base.camera.allowRoll,
        cutRhythm: base.camera.cutRhythm === 'languid' ? 'frenetic' : 'languid',
      },
    };

    // Nothing that governs movement has changed.
    expect(twin.fps).toBe(base.fps);
    expect(twin.stepMode).toBe(base.stepMode);
    expect(twin.tempo).toBe(base.tempo);
    expect(twin.easings).toEqual(base.easings);
    expect(twin.principles).toEqual(base.principles);
    expect(twin.boil).toEqual(base.boil);
    expect(twin.camera.parallaxStrength).toBe(base.camera.parallaxStrength);
    expect(twin.camera.shakeAmplitude).toBe(base.camera.shakeAmplitude);

    // The full measure is fooled; the core measure is not.
    expect(motionDistance(base, twin)).toBeGreaterThanOrEqual(MOTION_DISTINCTNESS_FLOOR);
    expect(coreMotionDistance(base, twin)).toBeLessThan(MOTION_DISTINCTNESS_FLOOR);
  });

  it('still counts a change to how something moves, wherever it is', () => {
    // The core measure must not have been narrowed into uselessness: a real motion change
    // has to register, and register at least as strongly as it does on the full measure.
    const base = at(STYLE_PRESETS, 0).draft.motion;
    const heavier: MotionStyle = {
      ...base,
      principles: { ...base.principles, weight: 1, overshoot: 0, followThrough: 0 },
      ambient: { ...base.ambient, windAmplitude: 1, idleAmplitude: 1 },
    };

    expect(coreMotionDistance(base, heavier)).toBeGreaterThan(0);
    expect(coreMotionDistance(base, heavier)).toBeGreaterThanOrEqual(motionDistance(base, heavier));
  });

  it.each(pairs.map(([left, right]) => [`${left.id} vs ${right.id}`, left, right] as const))(
    '%s differ on step mode or easing curves (RV-041)',
    (_label, left, right) => {
      const stepModeDiffers = left.draft.motion.stepMode !== right.draft.motion.stepMode;
      const easingsDiffer =
        JSON.stringify(left.draft.motion.easings) !== JSON.stringify(right.draft.motion.easings);
      expect(stepModeDiffers || easingsDiffer).toBe(true);
    },
  );

  it('spreads across step modes and frame rates rather than clustering on one', () => {
    const stepModes = new Set(STYLE_PRESETS.map((preset) => preset.draft.motion.stepMode));
    const rates = new Set(STYLE_PRESETS.map((preset) => preset.draft.motion.fps));
    expect(stepModes.size).toBeGreaterThanOrEqual(3);
    expect(rates.size).toBeGreaterThanOrEqual(3);

    // No single cadence may account for more than half the library, which is the shape
    // "we added ten styles and gave them all `on-2s`" would take.
    for (const mode of stepModes) {
      const share = STYLE_PRESETS.filter((preset) => preset.draft.motion.stepMode === mode).length;
      expect(share, `too many presets use ${mode}`).toBeLessThanOrEqual(
        Math.ceil(STYLE_PRESETS.length / 2),
      );
    }
  });

  it('gives every preset a distinct default easing curve', () => {
    const curves = STYLE_PRESETS.map((preset) => {
      const motion = preset.draft.motion;
      const curve = motion.easings.find((candidate) => candidate.name === motion.defaultEasing);
      return JSON.stringify(curve);
    });
    expect(new Set(curves).size).toBe(STYLE_PRESETS.length);
  });

  it('stays total when the easing reference does not resolve', () => {
    // `MotionStyle`'s refinement forbids a dangling `defaultEasing`, so this cannot
    // arrive from a parsed bible - but `motionSignature` is public API, and a signature
    // that threw on a half-built object would take a UI's live preview down with it.
    const base = STYLE_PRESETS[0];
    if (base === undefined) throw new Error('no presets');

    const dangling = { ...base.draft.motion, defaultEasing: 'nonexistent' };
    expect(motionDistance(dangling, base.draft.motion)).toBe(0);

    const noCurves = { ...base.draft.motion, easings: [] };
    expect(Number.isFinite(motionDistance(noCurves, base.draft.motion))).toBe(true);
  });

  it('reports which dimensions two profiles differ on', () => {
    const [first, second] = STYLE_PRESETS;
    if (first === undefined || second === undefined) throw new Error('need two presets');
    expect(motionDifferences(first.draft.motion, second.draft.motion).length).toBeGreaterThan(5);
    expect(motionDifferences(first.draft.motion, first.draft.motion)).toEqual([]);
    expect(motionDistance(first.draft.motion, first.draft.motion)).toBe(0);
  });
});
