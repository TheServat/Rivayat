import type { MotionStyle } from '@rv/contracts';
import { describe, expect, it } from 'vitest';

import { STYLE_PRESET_FIXTURES } from '../../api/fixtures/style.fixture';
import { StylePresetCard } from '../../api/schemas/style';

import { frameSeek, motionPresentation, paletteColour, PREVIEW_FRAMES } from './motion-preview';

const PRESETS = STYLE_PRESET_FIXTURES.map((input) => StylePresetCard.parse(input));

function motionOf(id: string): MotionStyle {
  const preset = PRESETS.find((candidate) => candidate.id === id);
  if (preset === undefined) throw new Error(`no preset ${id}`);
  return preset.draft.motion;
}

describe('a preset card carries its motion, not a summary of it', () => {
  /**
   * The trap the whole screen exists to avoid, asserted as a property of the *set*.
   *
   * `@rv/style-engine` holds a pairwise motion-distinctness floor across the library
   * because eleven styles sharing one motion profile is the failure the design prevents.
   * The gallery inherits that obligation: if two cards present identically, the reader
   * chooses on colour and is surprised later, no matter how distinct the underlying
   * profiles are.
   */
  it('presents every preset differently from every other preset', () => {
    const fingerprints = new Map<string, string[]>();
    for (const preset of PRESETS) {
      const presented = motionPresentation(preset.draft.motion);
      const key = JSON.stringify([
        presented.cycleSeconds,
        presented.imagesPerSecond,
        presented.stepped,
        presented.timingFunction,
        presented.vars,
      ]);
      fingerprints.set(key, [...(fingerprints.get(key) ?? []), preset.id]);
    }

    const collisions = [...fingerprints.values()].filter((ids) => ids.length > 1);
    expect(collisions).toEqual([]);
    expect(fingerprints.size).toBe(PRESETS.length);
  });

  it('separates held media from smooth ones by how the browser is told to move them', () => {
    // Paper cutout hinges and holds on 2s; watercolour drifts smoothly. If the card
    // renders both with the same timing function, half the difference is invisible.
    const paper = motionPresentation(motionOf('paper-cutout'));
    const water = motionPresentation(motionOf('watercolour'));

    expect(paper.stepped).toBe(true);
    expect(paper.timingFunction).toMatch(/^steps\(/);
    expect(water.stepped).toBe(false);
    expect(water.timingFunction).toMatch(/^cubic-bezier\(/);
  });

  it('reports the drawings a second the style actually shows, not its frame rate', () => {
    // 24 fps held on 2s is twelve drawings a second - the single field that most decides
    // whether something reads as animated or as interpolated, and one a still cannot hint
    // at. Woodblock on 4s is six.
    expect(motionPresentation(motionOf('paper-cutout')).imagesPerSecond).toBe(12);
    expect(motionPresentation(motionOf('woodblock-print')).imagesPerSecond).toBe(6);
    expect(motionPresentation(motionOf('painterly')).imagesPerSecond).toBe(30);
  });

  it('holds a pose for the styles whose whole character is holding it', () => {
    // A first cut of the preview ignored `holdBias` and the contact sheet showed the
    // cost at once: woodblock, which changes all at once and then does not move, crept
    // across its frames like gouache. These three are the ends and the middle of the
    // library.
    expect(motionPresentation(motionOf('woodblock-print')).hold).toBe('long');
    expect(motionPresentation(motionOf('paper-cutout')).hold).toBe('long');
    expect(motionPresentation(motionOf('painterly')).hold).toBe('none');
    expect(motionPresentation(motionOf('watercolour')).hold).toBe('some');
  });

  it('gives a held style fewer, chunkier drawings during its shorter move', () => {
    // Both hold on 2s. Paper cutout makes its move in a sixth of the loop and pixel art
    // in a quarter, so the same cadence yields a different number of distinct poses -
    // which is the difference between "hinges and holds" and "pops".
    const paper = motionPresentation(motionOf('paper-cutout'));
    const pixel = motionPresentation(motionOf('pixel-art'));

    expect(paper.timingFunction).toMatch(/^steps\(/);
    expect(pixel.timingFunction).toMatch(/^steps\(/);
    expect(paper.timingFunction).not.toBe(pixel.timingFunction);
  });

  it('lets tempo decide how long a loop takes', () => {
    // Woodblock at 0.7 is slower than ink-comic at 1.25, and the card has to say so.
    const slow = motionPresentation(motionOf('woodblock-print')).cycleSeconds;
    const quick = motionPresentation(motionOf('ink-comic')).cycleSeconds;
    expect(slow).toBeGreaterThan(quick);
  });

  it('turns boil on only for the styles that boil, at their own rate', () => {
    const clay = motionPresentation(motionOf('claymation')).vars;
    const flat = motionPresentation(motionOf('flat-vector')).vars;

    // Claymation redraws twelve times a second; flat vector never wobbles.
    expect(clay['--sl-boil']).not.toBe('0px');
    expect(clay['--sl-boil-cycle']).toBe('0.25s');
    expect(flat['--sl-boil']).toBe('0px');
  });

  it('never emits a zero-length animation for a windless style', () => {
    // A zero-duration animation is undefined territory across engines; an animation that
    // runs and moves nothing is not.
    for (const preset of PRESETS) {
      const vars = motionPresentation(preset.draft.motion).vars;
      expect(vars['--sl-sway-cycle'], preset.id).not.toBe('0s');
      expect(vars['--sl-blink-cycle'], preset.id).not.toBe('0s');
      expect(vars['--sl-cycle'], preset.id).not.toBe('0s');
    }
  });
});

describe('stepping is the same animation, seeked', () => {
  it('parks frame zero at the start and later frames further in', () => {
    expect(frameSeek(2, 0)).toBe('0s');
    // Negative, because a negative delay starts an animation part-way through: the
    // browser evaluates the real keyframes through the real timing function, so stepping
    // to a frame and playing to it cannot diverge.
    expect(frameSeek(2.4, 6)).toBe('-1.2s');
  });

  it('clamps rather than wrapping past the end of the strip', () => {
    const last = frameSeek(2, PREVIEW_FRAMES - 1);
    expect(frameSeek(2, PREVIEW_FRAMES + 5)).toBe(last);
    expect(frameSeek(2, -3)).toBe('0s');
  });
});

describe('a card draws itself in the style it is offering', () => {
  it('finds a colour by the role it plays and degrades along the palette', () => {
    const palette = PRESETS[0]?.draft.visual.palette;
    expect(palette).toBeDefined();
    if (palette === undefined) return;

    const byRole = palette.colors.find((colour) => colour.role === 'primary');
    expect(paletteColour(palette, 'primary', 0)).toBe(byRole?.hex);
    // A three-colour palette must still fill a five-slot drawing rather than leaving
    // holes, so an index past the end wraps instead of returning nothing.
    expect(paletteColour(palette, 'highlight', 9)).toMatch(/^#/);
  });
});
