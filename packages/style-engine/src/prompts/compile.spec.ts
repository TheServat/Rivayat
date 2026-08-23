import { PromptFragments, SubjectClass, VisualStyle } from '@rv/contracts';
import { stableStringify } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { compileNegativeClause, compilePositiveClause, compilePromptFragments } from './compile';
import { composeStylePrompt } from './compose';
import { UNIVERSAL_NEGATIVES } from './medium';
import { compileModelOverrides, compileTagPrompt } from './model-phrasing';
import { BAND_EDGES, band, bandIndex, dedupeStable, lightDirectionPhrase } from './words';

/**
 * A style with every optional feature switched **on**.
 *
 * Field sensitivity can only be asserted in the regime where a field is live: the
 * compiler is supposed to drop `line.taper` when there is no line, and a base fixture
 * with `line.present: false` would make that correct behaviour look like a missing
 * control. So the base has an outline, a rim light, an ambient tint, five non-zero
 * texture channels and an organic ramp, and the suppression rules get their own tests.
 */
const MAXIMAL: VisualStyle = VisualStyle.parse({
  medium: 'gouache',
  mediumNote: 'thinned with a little chalk',
  palette: {
    colors: [
      { name: 'moss', hex: '#4a6b3f', role: 'primary' },
      { name: 'bark', hex: '#5a4632', role: 'secondary' },
      { name: 'sky', hex: '#cfe3ef', role: 'background' },
    ],
    harmony: 'earthy',
    contrastFloor: 0.45,
    organicRamp: ['#e2b48c', '#b9825c'],
  },
  line: {
    present: true,
    weight: 0.4,
    variability: 0.4,
    colorMode: 'tinted',
    taper: 0.4,
    roughness: 0.4,
  },
  shading: {
    model: 'cel',
    steps: 3,
    lightDirection: 45,
    ambientTint: '#112233',
    rimLight: 0.4,
    occlusionStrength: 0.4,
  },
  texture: { grain: 0.4, paperFiber: 0.4, halftone: 0.4, edgeRoughness: 0.4, brushVisibility: 0.4 },
  shape: {
    roundness: 0.5,
    exaggeration: 0.5,
    headToBodyRatio: 5,
    silhouetteRule: 'Readable as a solid black shape at 64px.',
    detailDensity: 0.5,
  },
  backgroundTreatment: 'layered-parallax',
  negative: ['photorealism'],
});

interface Mutation {
  readonly path: string;
  readonly apply: (visual: VisualStyle) => VisualStyle;
}

/** Replaces one sub-block, keeping the rest. */
function withBlock<K extends keyof VisualStyle>(
  visual: VisualStyle,
  key: K,
  value: VisualStyle[K],
): VisualStyle {
  return { ...visual, [key]: value };
}

/**
 * One mutation per leaf of `VisualStyle`.
 *
 * Every mutation moves the value to a genuinely different setting - the far end of the
 * range, or a different enum member - because the compiler bands unit sliders into
 * words on purpose (see `words.ts`) and a 0.40-to-0.41 nudge is below the resolution of
 * the control by design.
 */
const MUTATIONS: readonly Mutation[] = [
  { path: 'medium', apply: (v) => ({ ...v, medium: 'ink-comic' }) },
  { path: 'mediumNote', apply: (v) => ({ ...v, mediumNote: 'laid on thick and dry' }) },

  {
    path: 'palette.colors',
    apply: (v) =>
      withBlock(v, 'palette', {
        ...v.palette,
        colors: [{ name: 'rust', hex: '#a4462b', role: 'primary' }, ...v.palette.colors.slice(1)],
      }),
  },
  {
    path: 'palette.harmony',
    apply: (v) => withBlock(v, 'palette', { ...v.palette, harmony: 'neon' }),
  },
  {
    path: 'palette.contrastFloor',
    apply: (v) => withBlock(v, 'palette', { ...v.palette, contrastFloor: 0.95 }),
  },
  {
    path: 'palette.organicRamp',
    apply: (v) => withBlock(v, 'palette', { ...v.palette, organicRamp: [] }),
  },

  { path: 'line.present', apply: (v) => withBlock(v, 'line', { ...v.line, present: false }) },
  { path: 'line.weight', apply: (v) => withBlock(v, 'line', { ...v.line, weight: 0.95 }) },
  {
    path: 'line.variability',
    apply: (v) => withBlock(v, 'line', { ...v.line, variability: 0.95 }),
  },
  { path: 'line.colorMode', apply: (v) => withBlock(v, 'line', { ...v.line, colorMode: 'black' }) },
  { path: 'line.taper', apply: (v) => withBlock(v, 'line', { ...v.line, taper: 0.95 }) },
  { path: 'line.roughness', apply: (v) => withBlock(v, 'line', { ...v.line, roughness: 0.95 }) },

  {
    path: 'shading.model',
    apply: (v) => withBlock(v, 'shading', { ...v.shading, model: 'crosshatch' }),
  },
  { path: 'shading.steps', apply: (v) => withBlock(v, 'shading', { ...v.shading, steps: 6 }) },
  {
    path: 'shading.lightDirection',
    apply: (v) => withBlock(v, 'shading', { ...v.shading, lightDirection: 225 }),
  },
  {
    path: 'shading.ambientTint',
    apply: (v) => {
      // Removed rather than changed: `exactOptionalPropertyTypes` makes absent and
      // undefined different, and "the art director cleared the field" is the edit that
      // actually happens in the UI.
      const { ambientTint: _dropped, ...rest } = v.shading;
      return withBlock(v, 'shading', rest);
    },
  },
  {
    path: 'shading.rimLight',
    apply: (v) => withBlock(v, 'shading', { ...v.shading, rimLight: 0 }),
  },
  {
    path: 'shading.occlusionStrength',
    apply: (v) => withBlock(v, 'shading', { ...v.shading, occlusionStrength: 0.95 }),
  },

  { path: 'texture.grain', apply: (v) => withBlock(v, 'texture', { ...v.texture, grain: 0 }) },
  {
    path: 'texture.paperFiber',
    apply: (v) => withBlock(v, 'texture', { ...v.texture, paperFiber: 0 }),
  },
  {
    path: 'texture.halftone',
    apply: (v) => withBlock(v, 'texture', { ...v.texture, halftone: 0 }),
  },
  {
    path: 'texture.edgeRoughness',
    apply: (v) => withBlock(v, 'texture', { ...v.texture, edgeRoughness: 0.95 }),
  },
  {
    path: 'texture.brushVisibility',
    apply: (v) => withBlock(v, 'texture', { ...v.texture, brushVisibility: 0 }),
  },

  { path: 'shape.roundness', apply: (v) => withBlock(v, 'shape', { ...v.shape, roundness: 0.95 }) },
  {
    path: 'shape.exaggeration',
    apply: (v) => withBlock(v, 'shape', { ...v.shape, exaggeration: 0.02 }),
  },
  {
    path: 'shape.headToBodyRatio',
    apply: (v) => withBlock(v, 'shape', { ...v.shape, headToBodyRatio: 8 }),
  },
  {
    path: 'shape.silhouetteRule',
    apply: (v) =>
      withBlock(v, 'shape', { ...v.shape, silhouetteRule: 'Recognisable from the hat alone.' }),
  },
  {
    path: 'shape.detailDensity',
    apply: (v) => withBlock(v, 'shape', { ...v.shape, detailDensity: 0.95 }),
  },

  { path: 'backgroundTreatment', apply: (v) => ({ ...v, backgroundTreatment: 'flat-color' }) },
  { path: 'negative', apply: (v) => ({ ...v, negative: [...v.negative, 'lens flare'] }) },
];

function compiled(visual: VisualStyle): string {
  return stableStringify(compilePromptFragments({ visual }));
}

describe('compilePromptFragments', () => {
  it('produces fragments that satisfy the contract schema', () => {
    const fragments = compilePromptFragments({ visual: MAXIMAL });
    expect(() => PromptFragments.parse(fragments)).not.toThrow();
    expect(fragments.positive.length).toBeGreaterThan(80);
    expect(fragments.negative.length).toBeGreaterThan(20);
  });

  it('is byte-for-byte deterministic', () => {
    // The compiled string is hashed into the response-cache key and into asset
    // provenance, so "same bible, same string" is not a nicety.
    const first = compilePromptFragments({ visual: MAXIMAL });
    const second = compilePromptFragments({ visual: MAXIMAL });
    expect(stableStringify(first)).toBe(stableStringify(second));
  });

  it('does not depend on the order the visual block was written in', () => {
    const forwards = VisualStyle.parse({
      medium: 'flat-vector',
      palette: { colors: MAXIMAL.palette.colors, harmony: 'muted' },
      shape: MAXIMAL.shape,
    });
    const backwards = VisualStyle.parse({
      shape: MAXIMAL.shape,
      palette: { harmony: 'muted', colors: MAXIMAL.palette.colors },
      medium: 'flat-vector',
    });
    expect(compiled(forwards)).toBe(compiled(backwards));
  });

  /**
   * The property that keeps the UI honest.
   *
   * A control the compiler ignores is a slider that changes the checksum, forks the
   * asset library, and produces identical pixels. Enumerated over `VisualStyle.shape`
   * so a field added to the schema without a compiler clause fails the coverage
   * assertion below rather than slipping through.
   */
  it.each(MUTATIONS.map((mutation) => [mutation.path, mutation] as const))(
    'changes the compiled prompt when %s changes',
    (path, mutation) => {
      const before = compiled(MAXIMAL);
      const after = compiled(mutation.apply(MAXIMAL));
      expect(after, `mutating ${path} did not change the compiled prompt`).not.toBe(before);
    },
  );

  it('covers every field of VisualStyle', () => {
    const covered = new Set(MUTATIONS.map((mutation) => mutation.path.split('.')[0]));
    expect([...covered].sort()).toEqual(Object.keys(VisualStyle.shape).sort());
  });

  it('emits a clause for every subject class', () => {
    const fragments = compilePromptFragments({ visual: MAXIMAL });
    for (const subject of SubjectClass.options) {
      expect(fragments.bySubject[subject], subject).toBeTruthy();
    }
  });
});

describe('the negative clause', () => {
  it('lists every author-declared negative exactly once, in a stable order', () => {
    // A duplicate of a universal negative must collapse, and the author's own entry
    // must be the one that survives - it is first in the list for a reason.
    const visual = { ...MAXIMAL, negative: ['watermark', 'photorealism', 'watermark'] };
    const negative = compileNegativeClause(visual).split(', ');
    expect(negative.filter((entry) => entry === 'watermark')).toHaveLength(1);
    expect(negative[0]).toBe('watermark');
    expect(negative).toContain('photorealism');
  });

  it('states suppressed features as negatives rather than omitting them', () => {
    // An image model adds linework by default. Leaving it out of the positive prompt is
    // not the same as forbidding it.
    const noLine = compileNegativeClause({
      ...MAXIMAL,
      line: { ...MAXIMAL.line, present: false },
    });
    expect(noLine).toContain('outlines');

    const noGrain = compileNegativeClause({
      ...MAXIMAL,
      texture: { ...MAXIMAL.texture, grain: 0 },
    });
    expect(noGrain).toContain('film grain');
  });

  it('always carries the universal negatives', () => {
    const negative = compileNegativeClause(MAXIMAL);
    for (const entry of UNIVERSAL_NEGATIVES) expect(negative).toContain(entry);
  });
});

describe('the positive clause', () => {
  it('drops line detail entirely when there is no line', () => {
    const positive = compilePositiveClause({
      ...MAXIMAL,
      line: {
        present: false,
        weight: 0,
        variability: 0,
        colorMode: 'none',
        taper: 0,
        roughness: 0,
      },
    });
    expect(positive).toContain('no outlines at all');
    expect(positive).not.toContain('stroke ends');
  });

  it('describes a custom medium from its note', () => {
    const custom = VisualStyle.parse({
      ...MAXIMAL,
      medium: 'custom',
      mediumNote: 'scratchboard, white line cut out of solid black ink',
    });
    expect(compilePositiveClause(custom)).toContain('scratchboard');
  });

  it('names the light direction in words, wrapping past a full turn', () => {
    expect(lightDirectionPhrase(0)).toContain('from the right');
    expect(lightDirectionPhrase(90)).toContain('directly above');
    expect(lightDirectionPhrase(-315)).toBe(lightDirectionPhrase(45));
    expect(lightDirectionPhrase(720)).toBe(lightDirectionPhrase(0));
  });

  it('keeps a hard band count for quantised shading and a soft one otherwise', () => {
    const cel = compilePositiveClause({
      ...MAXIMAL,
      shading: { ...MAXIMAL.shading, model: 'cel' },
    });
    const soft = compilePositiveClause({
      ...MAXIMAL,
      shading: { ...MAXIMAL.shading, model: 'soft' },
    });
    expect(cel).toContain('hard tonal bands');
    // A continuous model still resolves into countable tonal zones - the control must
    // do something rather than being silently ignored for half the shading models.
    expect(soft).toContain('tonal zones');
  });
});

describe('per-model overrides', () => {
  it('gives the CLIP-conditioned local lane a tag prompt and leaves the cloud lane alone', () => {
    const byModel = compileModelOverrides(MAXIMAL);
    const keys = Object.keys(byModel);
    expect(keys).toContain('comfyui:sd1.5-lcm');
    expect(keys).toContain('comfyui:sdxl-turbo');
    // Research §2: cloud image models take a T5/LLM encoder and read the long clause as
    // written, so an override for them would be a second copy of the same prompt.
    expect(keys.every((key) => key.startsWith('comfyui:'))).toBe(true);
  });

  it('compresses the tag prompt well below the 77-token CLIP window', () => {
    const tags = compileTagPrompt(MAXIMAL);
    // Comma-separated concepts, not sentences. A rough word count is the right proxy.
    expect(tags.split(/[\s,]+/).filter(Boolean).length).toBeLessThan(60);
    expect(tags.length).toBeLessThan(compilePositiveClause(MAXIMAL).length);
  });

  it('derives the tag prompt from the same fields', () => {
    const before = compileTagPrompt(MAXIMAL);
    const after = compileTagPrompt({ ...MAXIMAL, shading: { ...MAXIMAL.shading, steps: 7 } });
    expect(after).not.toBe(before);
  });
});

describe('composeStylePrompt', () => {
  const fragments = compilePromptFragments({ visual: MAXIMAL });

  it('carries the style clause, the subject clause and the full negative list', () => {
    const composed = composeStylePrompt({
      fragments,
      subject: 'a mature oak',
      subjectClass: 'foliage',
    });
    expect(composed.positive.startsWith('a mature oak')).toBe(true);
    expect(composed.positive).toContain(fragments.positive);
    expect(composed.positive).toContain(fragments.bySubject.foliage ?? '<<missing>>');
    expect(composed.negative).toBe(fragments.negative);
  });

  it('replaces the style clause with a model override rather than appending it', () => {
    const composed = composeStylePrompt({
      fragments,
      subject: 'a mature oak',
      subjectClass: 'foliage',
      modelRef: 'comfyui:sd1.5-lcm',
    });
    expect(composed.positive).toContain(fragments.byModel['comfyui:sd1.5-lcm'] ?? '<<missing>>');
    expect(composed.positive).not.toContain(fragments.positive);
  });

  it('falls back to the default clause for a model with no override', () => {
    const composed = composeStylePrompt({
      fragments,
      subject: 'a jug',
      subjectClass: 'prop',
      modelRef: 'openrouter:google/gemini-3-pro-image',
      extra: 'seen from above',
    });
    expect(composed.positive).toContain(fragments.positive);
    expect(composed.positive.endsWith('seen from above')).toBe(true);
  });
});

describe('the banding vocabulary', () => {
  it('is total over the unit interval and monotonic', () => {
    const words = ['a', 'b', 'c', 'd', 'e'] as const;
    expect(band(0, words)).toBe('a');
    expect(band(1, words)).toBe('e');
    expect(bandIndex(BAND_EDGES[0])).toBe(1);
    expect(bandIndex(BAND_EDGES[3])).toBe(4);

    let previous = -1;
    for (let value = 0; value <= 1.0001; value += 0.01) {
      const index = bandIndex(Math.min(1, value));
      expect(index).toBeGreaterThanOrEqual(previous);
      previous = index;
    }
  });

  it('de-duplicates case-insensitively while keeping the first spelling', () => {
    expect(dedupeStable(['Ink', 'ink', ' ink ', 'paper', ''])).toEqual(['Ink', 'paper']);
  });
});
