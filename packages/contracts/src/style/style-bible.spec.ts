import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { styleBible } from '../__fixtures__/builders';
import { everyObjectIsClosed, isFullyInlined, toLlmJsonSchema } from '../json-schema';
import { CubicBezierEasing, Easing, STANDARD_EASINGS } from '../anim/easing';
import {
  ArtMedium,
  BezierControlPoint,
  EasingCurve,
  MotionStyle,
  Palette,
  StyleBible,
  StyleBibleDraft,
  StyleCheckpointInput,
  VisualStyle,
} from './style-bible';

describe('StyleBible', () => {
  it('accepts the fixture', () => {
    const result = StyleBible.safeParse(styleBible());
    expect(result.success, result.success ? '' : z.prettifyError(result.error)).toBe(true);
  });

  it('starts unlocked, so nothing can be generated against an unapproved style', () => {
    expect(StyleBible.parse(styleBible()).lockedAt).toBeNull();
  });

  it('requires a checksum, because it participates in every asset dedup key', () => {
    const { checksum: _checksum, ...withoutChecksum } = styleBible();
    expect(StyleBible.safeParse(withoutChecksum).success).toBe(false);
  });

  it('rejects a checksum that is not a sha256 hex', () => {
    expect(StyleBible.safeParse(styleBible({ checksum: 'not-a-hash' })).success).toBe(false);
  });

  it('requires a non-negative integer seed, so a style is reproducible', () => {
    expect(StyleBible.safeParse(styleBible({ seed: -1 })).success).toBe(false);
    expect(StyleBible.safeParse(styleBible({ seed: 1.5 })).success).toBe(false);
    expect(StyleBible.safeParse(styleBible({ seed: 0 })).success).toBe(true);
  });
});

describe('the checksum covers exactly the fields that change output', () => {
  it('includes visual, motion, render, prompts and seed', () => {
    expect(Object.keys(StyleCheckpointInput.shape).sort()).toEqual([
      'motion',
      'prompts',
      'render',
      'seed',
      'visual',
    ]);
  });

  it('excludes identity and bookkeeping, so renaming a style is not a restyle', () => {
    const keys = Object.keys(StyleCheckpointInput.shape);
    for (const excluded of ['id', 'name', 'version', 'createdAt', 'lockedAt', 'notes']) {
      expect(keys).not.toContain(excluded);
    }
  });
});

describe('StyleBibleDraft - what a model is asked to produce', () => {
  it('omits every field the system assigns rather than the model', () => {
    const keys = Object.keys(StyleBibleDraft.shape);
    for (const assigned of ['id', 'checksum', 'lockedAt', 'createdAt', 'version', 'parentId']) {
      expect(keys).not.toContain(assigned);
    }
  });

  it('still requires the substance: visual, motion and prompts', () => {
    for (const required of ['visual', 'motion', 'prompts', 'seed']) {
      expect(Object.keys(StyleBibleDraft.shape)).toContain(required);
    }
  });

  it('converts to a provider-ready JSON Schema with every object closed', () => {
    const schema = toLlmJsonSchema(StyleBibleDraft, { dialect: 'openai-strict' });
    expect(everyObjectIsClosed(schema)).toBe(true);
    expect(isFullyInlined(schema)).toBe(true);
  });
});

describe('VisualStyle', () => {
  it('fills the nested sub-objects entirely from their own defaults', () => {
    // `line`, `shading` and `texture` are `prefault({})`: a style may omit them and
    // still be fully specified, which is what makes the wizard path viable.
    const parsed = VisualStyle.parse({
      medium: 'flat-vector',
      palette: {
        colors: [
          { name: 'a', hex: '#000' },
          { name: 'b', hex: '#fff' },
          { name: 'c', hex: '#888' },
        ],
        harmony: 'muted',
      },
      shape: { silhouetteRule: 'readable at 64px' },
    });
    expect(parsed.line.colorMode).toBe('tinted');
    expect(parsed.shading.model).toBe('cel');
    expect(parsed.texture.grain).toBe(0);
    expect(parsed.shape.headToBodyRatio).toBe(6);
    expect(parsed.backgroundTreatment).toBe('layered-parallax');
  });

  it('lists every medium the pipeline has prompt fragments for', () => {
    expect(ArtMedium.options).toContain('paper-cutout');
    expect(ArtMedium.options).toContain('pixel-art');
    expect(ArtMedium.options).toContain('custom');
  });
});

describe('Palette', () => {
  const valid = {
    colors: [
      { name: 'a', hex: '#112233' },
      { name: 'b', hex: '#abc' },
      { name: 'c', hex: '#11223344' },
    ],
    harmony: 'triadic' as const,
  };

  it('accepts 3, 6 and 8 digit hex', () => {
    expect(Palette.safeParse(valid).success).toBe(true);
  });

  it('rejects a malformed hex', () => {
    expect(
      Palette.safeParse({ ...valid, colors: [...valid.colors, { name: 'd', hex: 'red' }] }).success,
    ).toBe(false);
  });

  it('requires at least three colours - two is a duotone, not a palette', () => {
    expect(Palette.safeParse({ ...valid, colors: valid.colors.slice(0, 2) }).success).toBe(false);
  });

  it('defaults a contrast floor rather than allowing an unreadable style', () => {
    expect(Palette.parse(valid).contrastFloor).toBe(0.35);
  });
});

describe('MotionStyle - the "how it animates" half of the style', () => {
  const minimal = {
    easings: [{ name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } }],
    defaultEasing: 'ease-in-out',
  };

  it('defaults to 24fps smooth with a neutral tempo', () => {
    const parsed = MotionStyle.parse(minimal);
    expect(parsed).toMatchObject({ fps: 24, stepMode: 'smooth', tempo: 1 });
  });

  it('supports the stepped cadences that make motion read as hand-drawn', () => {
    for (const stepMode of ['smooth', 'on-2s', 'on-3s', 'on-4s']) {
      expect(MotionStyle.safeParse({ ...minimal, stepMode }).success).toBe(true);
    }
  });

  it('requires at least one named easing curve', () => {
    expect(MotionStyle.safeParse({ ...minimal, easings: [] }).success).toBe(false);
  });

  it('fills the principle, boil, ambient and camera blocks from their defaults', () => {
    const parsed = MotionStyle.parse(minimal);
    expect(parsed.principles.secondaryMotion).toBe(0.5);
    expect(parsed.boil.enabled).toBe(false);
    expect(parsed.ambient.blinkIntervalMs).toBe(4200);
    expect(parsed.camera.cutRhythm).toBe('measured');
  });

  it('rejects an fps outside a sane range', () => {
    expect(MotionStyle.safeParse({ ...minimal, fps: 0 }).success).toBe(false);
    expect(MotionStyle.safeParse({ ...minimal, fps: 121 }).success).toBe(false);
    expect(MotionStyle.safeParse({ ...minimal, fps: 12 }).success).toBe(true);
  });

  it('clamps tempo so a style cannot silently make a render 100x longer', () => {
    expect(MotionStyle.safeParse({ ...minimal, tempo: 0.1 }).success).toBe(false);
    expect(MotionStyle.safeParse({ ...minimal, tempo: 5 }).success).toBe(false);
  });
});

describe('STANDARD_EASINGS', () => {
  it('provides the baseline curves every style starts with', () => {
    const names = STANDARD_EASINGS.map((curve) => curve.name);
    expect(names).toContain('linear');
    expect(names).toContain('ease-in-out');
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps control-point x within 0..1, as the bezier definition requires', () => {
    for (const curve of STANDARD_EASINGS) {
      expect(curve.p1.x).toBeGreaterThanOrEqual(0);
      expect(curve.p1.x).toBeLessThanOrEqual(1);
      expect(curve.p2.x).toBeGreaterThanOrEqual(0);
      expect(curve.p2.x).toBeLessThanOrEqual(1);
    }
  });

  it('includes curves that deliberately leave 0..1 on y, for anticipation and overshoot', () => {
    const overshoots = STANDARD_EASINGS.filter(
      (curve) => curve.p1.y > 1 || curve.p2.y > 1 || curve.p1.y < 0 || curve.p2.y < 0,
    );
    expect(overshoots.length).toBeGreaterThanOrEqual(3);
  });
});

// ── one bezier, two spellings ───────────────────────────────────────────────
//
// A style bible names a curve by two control points; a keyframe can inline the same
// curve as `CubicBezierEasing`. They are the same mathematics, and until now the style
// side accepted control points the keyframe side rejects - so a clip that inlined a
// style curve would fail validation on a curve the bible had already blessed.

describe('style curves and inline curves accept the same control points', () => {
  const legal = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 0.34, y: 1.56 },
    { x: 0.66, y: -0.56 },
    { x: 0.5, y: 4 },
    { x: 0.5, y: -4 },
  ];
  const illegal = [
    { x: -0.1, y: 0 },
    { x: 1.1, y: 0 },
    { x: 5, y: 0 },
    { x: 0.5, y: 4.1 },
    { x: 0.5, y: -4.1 },
  ];

  function inlineAccepts(p1: { x: number; y: number }, p2: { x: number; y: number }): boolean {
    return CubicBezierEasing.safeParse({
      kind: 'cubic-bezier',
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
    }).success;
  }

  it('agrees on every control point either one would accept', () => {
    const anchor = { x: 0.5, y: 0.5 };
    for (const point of [...legal, ...illegal]) {
      const named = EasingCurve.safeParse({ name: 'c', p1: point, p2: anchor }).success;
      expect(named, JSON.stringify(point)).toBe(inlineAccepts(point, anchor));
    }
  });

  it('accepts a control point outside 0..1 on y, which is what overshoot is', () => {
    for (const point of legal) {
      expect(BezierControlPoint.safeParse(point).success, JSON.stringify(point)).toBe(true);
    }
  });

  it('rejects a control point off the timeline, which is not a slow curve but no curve', () => {
    for (const point of illegal) {
      expect(BezierControlPoint.safeParse(point).success, JSON.stringify(point)).toBe(false);
    }
  });

  it('validates every standard curve as a style curve, so the library is usable as data', () => {
    for (const curve of STANDARD_EASINGS) {
      const result = EasingCurve.safeParse(curve);
      expect(result.success, `${curve.name}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it('lets a keyframe reach a style curve by name rather than re-inlining it', () => {
    expect(Easing.safeParse({ kind: 'named', name: 'ease-in-out' }).success).toBe(true);
  });
});

// ── named curves resolve inside the document that declares them ─────────────

describe('a style bible resolves its own curve names', () => {
  const minimal = {
    easings: [{ name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } }],
    defaultEasing: 'ease-in-out',
  };

  function paths(value: Record<string, unknown>): string[] {
    const result = MotionStyle.safeParse(value);
    return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
  }

  it('accepts a default that names a declared curve', () => {
    expect(MotionStyle.safeParse(minimal).success).toBe(true);
  });

  it('rejects a default easing this style never declared', () => {
    expect(paths({ ...minimal, defaultEasing: 'ease-out-quart' })).toEqual(['defaultEasing']);
  });

  it('rejects a camera pan easing this style never declared', () => {
    expect(paths({ ...minimal, camera: { panEase: 'whip' } })).toEqual(['camera.panEase']);
  });

  it("accepts the camera's default pan easing when the style declares it", () => {
    expect(MotionStyle.parse(minimal).camera.panEase).toBe('ease-in-out');
  });

  it('rejects two curves sharing a name, which makes every reference ambiguous', () => {
    expect(
      paths({
        ...minimal,
        easings: [
          { name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } },
          { name: 'ease-in-out', p1: { x: 0.1, y: 0 }, p2: { x: 0.9, y: 1 } },
        ],
      }),
    ).toEqual(['easings']);
  });
});

// ── the two conditional fields nothing was checking ─────────────────────────

describe('conditional fields the descriptions promised', () => {
  function visual(overrides: Record<string, unknown>): Record<string, unknown> {
    return { ...(styleBible().visual as Record<string, unknown>), ...overrides };
  }

  it('rejects a custom medium that does not describe itself', () => {
    const result = VisualStyle.safeParse(visual({ medium: 'custom' }));
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toEqual([
      'mediumNote',
    ]);
  });

  it('accepts a custom medium that does', () => {
    expect(
      VisualStyle.safeParse(
        visual({ medium: 'custom', mediumNote: 'Wet-on-wet sumi ink on unsized rice paper.' }),
      ).success,
    ).toBe(true);
  });

  it('leaves a named medium free of the note requirement', () => {
    expect(VisualStyle.safeParse(visual({ medium: 'paper-cutout' })).success).toBe(true);
  });

  it('rejects a forked style that does not name what it forked from', () => {
    const result = StyleBible.safeParse(styleBible({ origin: 'forked' }));
    expect(result.success).toBe(false);
    expect((result.error?.issues ?? []).map((issue) => issue.path.join('.'))).toEqual(['parentId']);
  });

  it('accepts a fork that names its parent', () => {
    const parent = (styleBible() as { id: string }).id;
    expect(StyleBible.safeParse(styleBible({ origin: 'forked', parentId: parent })).success).toBe(
      true,
    );
  });

  it('still projects the checksum input and the draft, which the invariant must not block', () => {
    expect(Object.keys(StyleCheckpointInput.shape).sort()).toEqual([
      'motion',
      'prompts',
      'render',
      'seed',
      'visual',
    ]);
    expect(Object.keys(StyleBibleDraft.shape)).not.toContain('parentId');
  });
});
