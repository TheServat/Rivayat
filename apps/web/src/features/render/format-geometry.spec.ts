import { FORMAT_PRESETS, type FormatProfile, type FormatProfileId } from '@rv/contracts';
import { describe, expect, it } from 'vitest';

import {
  compositionRectInTarget,
  containedSize,
  containsPoint,
  coveredFraction,
  exclusionsPx,
  focusPointPx,
  reduceRatio,
  rectPoints,
  safeAreaFraction,
  safeAreaPx,
  toPixels,
  verdictOf,
} from './format-geometry';

const profiles = Object.values(FORMAT_PRESETS);
const ids = Object.keys(FORMAT_PRESETS) as FormatProfileId[];

/** Area of the intersection of two normalised rectangles. Zero when they only touch. */
function intersectionArea(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width <= 0 || height <= 0 ? 0 : width * height;
}

describe('the safe area, in the platform’s own pixels', () => {
  it('places the universal vertical safe zone at 900x1400 centred inside 1080x1920', () => {
    // Research 7, stated exactly. This is the assertion the whole preview rests on: if
    // it moves, the overlay is drawing a region the renderer does not agree with.
    for (const id of ['shorts-9x16', 'reels-9x16'] as const) {
      expect(safeAreaPx(FORMAT_PRESETS[id])).toEqual({ x: 90, y: 260, width: 900, height: 1400 });
    }
  });

  it('cuts TikTok’s safe area down to what its chrome leaves', () => {
    // Top 15 %, bottom 20 %, right 15 % of 1080x1920, intersected with the universal
    // zone's 90px side inset. The top exclusion reaches further in than the universal
    // zone's 260px, so it - not the universal figure - sets the top edge.
    expect(safeAreaPx(FORMAT_PRESETS['tiktok-9x16'])).toEqual({
      x: 90,
      y: 288,
      width: 828,
      height: 1248,
    });
  });

  it('leaves a format with no declared exclusions using the whole frame', () => {
    for (const id of ['yt-1080p', 'yt-2160p', 'ig-4x5', 'ig-1x1'] as const) {
      const profile = FORMAT_PRESETS[id];
      expect(safeAreaPx(profile)).toEqual({
        x: 0,
        y: 0,
        width: profile.size.width,
        height: profile.size.height,
      });
      expect(safeAreaFraction(profile)).toBe(1);
    }
  });

  it('keeps every preset’s safe area inside its own frame', () => {
    for (const profile of profiles) {
      const safe = safeAreaPx(profile);
      expect(safe.x, profile.id).toBeGreaterThanOrEqual(0);
      expect(safe.y, profile.id).toBeGreaterThanOrEqual(0);
      expect(safe.x + safe.width, profile.id).toBeLessThanOrEqual(profile.size.width);
      expect(safe.y + safe.height, profile.id).toBeLessThanOrEqual(profile.size.height);
    }
  });

  it('never overlaps a safe area with the chrome that carved it out', () => {
    // The contract says the safe area "already excludes anything in `exclusions`". A
    // preview that drew a gold box over a hatched rail would be promising a region the
    // platform is going to cover, which is the one lie this screen must not tell.
    for (const profile of profiles) {
      for (const zone of profile.exclusions) {
        expect(intersectionArea(profile.safeArea, zone.rect), `${profile.id}/${zone.name}`).toBe(0);
      }
    }
  });

  it('rounds to whole pixels, because an overlay is drawn on a pixel grid', () => {
    // 90/1080 of 1080 is 89.999... in floating point for some paths; a hairline gap
    // between the frame edge and a zone beside it is the visible symptom.
    expect(
      toPixels({ x: 1 / 3, y: 0, width: 1 / 3, height: 1 }, { width: 1000, height: 100 }),
    ).toEqual({ x: 333, y: 0, width: 333, height: 100 });
  });
});

describe('how much of the frame the platform covers', () => {
  it('unions overlapping exclusions rather than summing them', () => {
    // TikTok's three zones overlap at the corners: the right rail runs the full height
    // and so crosses both the top bar and the caption rail. Summing gives 0.50; the
    // truth is 1 - (0.65 x 0.85) = 0.4475, and overstating how much of the frame is
    // unusable is not a safe error - it is the number a creator composes against.
    const tiktok = FORMAT_PRESETS['tiktok-9x16'];
    const summed = tiktok.exclusions.reduce(
      (total, zone) => total + zone.rect.width * zone.rect.height,
      0,
    );
    expect(summed).toBeCloseTo(0.5, 10);
    expect(coveredFraction(tiktok.exclusions.map((zone) => zone.rect))).toBeCloseTo(0.4475, 10);
  });

  it('reports nothing covered for a platform that declares no chrome', () => {
    expect(coveredFraction([])).toBe(0);
    for (const profile of profiles.filter((entry) => entry.exclusions.length === 0)) {
      expect(coveredFraction(profile.exclusions.map((zone) => zone.rect)), profile.id).toBe(0);
    }
  });

  it('counts a rectangle covered twice only once', () => {
    const rect = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 };
    expect(coveredFraction([rect, rect])).toBeCloseTo(0.16, 10);
  });

  it('clamps a rectangle that runs off the frame instead of inflating the total', () => {
    expect(coveredFraction([{ x: 0.5, y: 0, width: 1, height: 1 }])).toBeCloseTo(0.5, 10);
  });

  it('is the complement of the safe area when the two partition the frame', () => {
    // Not true in general - a safe area may be smaller than "everything not excluded",
    // as the universal 90px side inset makes it on TikTok - so this asserts the
    // relation that must always hold: safe + covered can never exceed the whole frame.
    for (const profile of profiles) {
      const covered = coveredFraction(profile.exclusions.map((zone) => zone.rect));
      expect(safeAreaFraction(profile) + covered, profile.id).toBeLessThanOrEqual(1.0000001);
    }
  });
});

describe('fitting seven ratios into one row', () => {
  it('contains each frame in the box without distorting it', () => {
    for (const profile of profiles) {
      const fitted = containedSize(profile.size, { width: 9, height: 9 });
      expect(fitted.width, profile.id).toBeLessThanOrEqual(9.000001);
      expect(fitted.height, profile.id).toBeLessThanOrEqual(9.000001);
      expect(fitted.width / fitted.height, profile.id).toBeCloseTo(
        profile.size.width / profile.size.height,
        10,
      );
      // One dimension always touches the box, or the frames would not be comparable.
      expect(Math.max(fitted.width, fitted.height), profile.id).toBeCloseTo(9, 10);
    }
  });

  it('recomputes each preset’s declared ratio from the pixels it will encode at', () => {
    // The preview is drawn from `size`, and the card's badge shows `aspectRatio`. If
    // those two ever disagree the picture and its label describe different formats.
    for (const profile of profiles) {
      expect(reduceRatio(profile.size), profile.id).toBe(profile.aspectRatio);
    }
  });

  it('covers all seven verified presets and no more', () => {
    expect(ids).toHaveLength(7);
  });
});

describe('where the composition lands inside the target frame', () => {
  const target = { width: 1080, height: 1920 };
  const composition = { width: 1920, height: 1080 };

  it('stretches a crop to fill the frame, so what was cut away hangs off the edges', () => {
    const rect = compositionRectInTarget(
      'crop',
      { x: 0.25, y: 0, width: 0.5, height: 1 },
      composition,
      target,
    );
    // The crop is the middle half of the composition, so the composition renders at
    // twice the frame's width and begins half a frame before the frame's leading edge.
    // Everything at x < 0 and x > 1080 is what the crop threw away, drawn so it can be
    // seen rather than described.
    expect(rect).toEqual({ x: -540, y: 0, width: 2160, height: 1920 });
  });

  it('maps a full-frame crop onto the frame exactly', () => {
    expect(
      compositionRectInTarget('crop', { x: 0, y: 0, width: 1, height: 1 }, composition, target),
    ).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
  });

  it('contains and centres the whole composition when the answer was a letterbox', () => {
    // A letterbox is a real answer, not a failure: a wide two-shot that will not
    // survive a 9:16 crop is better delivered whole than with one of the faces cut off.
    const rect = compositionRectInTarget(
      'letterbox',
      { x: 0, y: 0, width: 1, height: 1 },
      composition,
      target,
    );
    expect(rect.width).toBeCloseTo(1080, 10);
    expect(rect.height).toBeCloseTo(607.5, 10);
    expect(rect.x).toBeCloseTo(0, 10);
    expect(rect.y).toBeCloseTo(656.25, 10);
    // Bars of equal depth top and bottom.
    expect(rect.y).toBeCloseTo(target.height - (rect.y + rect.height), 10);
  });

  it('pillarboxes the same way on the other axis', () => {
    const rect = compositionRectInTarget(
      'pillarbox',
      { x: 0, y: 0, width: 1, height: 1 },
      { width: 1080, height: 1920 },
      { width: 1920, height: 1080 },
    );
    expect(rect.height).toBeCloseTo(1080, 10);
    expect(rect.width).toBeCloseTo(607.5, 10);
    expect(rect.x).toBeCloseTo(656.25, 10);
  });

  it('treats a reflow like a crop, because its frame is the frame', () => {
    expect(
      compositionRectInTarget('reflow', { x: 0, y: 0, width: 1, height: 1 }, composition, target),
    ).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
  });

  it('survives a degenerate crop rather than dividing by zero', () => {
    const rect = compositionRectInTarget(
      'crop',
      { x: 0, y: 0, width: 0, height: 0 },
      composition,
      target,
    );
    expect(Number.isFinite(rect.width)).toBe(true);
    expect(Number.isFinite(rect.height)).toBe(true);
  });
});

describe('the focus target', () => {
  it('lands at the fraction of the frame the solver reported', () => {
    expect(focusPointPx({ x: 0.5, y: 0.25 }, { width: 1080, height: 1920 })).toEqual({
      x: 540,
      y: 480,
    });
  });

  it('is inside the safe area exactly when the safe area contains it', () => {
    const safe = FORMAT_PRESETS['tiktok-9x16'].safeArea;
    expect(containsPoint(safe, { x: 0.5, y: 0.5 })).toBe(true);
    // Behind the action rail: TikTok's safe area stops at x = 0.85.
    expect(containsPoint(safe, { x: 0.92, y: 0.5 })).toBe(false);
    // Behind the caption rail.
    expect(containsPoint(safe, { x: 0.5, y: 0.95 })).toBe(false);
  });

  it('takes the solver’s verdict rather than re-deriving one', () => {
    // Two implementations of one constraint is two answers, and the authoritative one
    // is the engine's. The preview draws where the focus landed; it does not judge.
    const shot = {
      shotId: 'sht_1',
      strategy: 'crop' as const,
      sourceCrop: { x: 0, y: 0, width: 1, height: 1 },
      panTo: null,
      focusPoint: { x: 0.5, y: 0.5 },
      scale: 1,
      safeAreaViolation: true,
      layoutOverrides: [],
    };
    expect(verdictOf(shot)).toBe('missed');
    expect(verdictOf({ ...shot, safeAreaViolation: false })).toBe('held');
  });
});

describe('svg helpers', () => {
  it('writes a rectangle as four points in order', () => {
    expect(rectPoints({ x: 10, y: 20, width: 30, height: 40 })).toBe('10,20 40,20 40,60 10,60');
  });
});

describe('the exclusion zones a preview draws', () => {
  it('keeps the platform’s own names so the card can label them', () => {
    const zones = exclusionsPx(FORMAT_PRESETS['tiktok-9x16']);
    expect(zones.map((zone) => zone.name)).toEqual([
      'top chrome',
      'bottom caption rail',
      'right action rail',
    ]);
  });

  it('converts each one to the frame’s pixels', () => {
    const zones = exclusionsPx(FORMAT_PRESETS['tiktok-9x16']);
    expect(zones[0]?.rect).toEqual({ x: 0, y: 0, width: 1080, height: 288 });
    expect(zones[1]?.rect).toEqual({ x: 0, y: 1536, width: 1080, height: 384 });
    expect(zones[2]?.rect).toEqual({ x: 918, y: 0, width: 162, height: 1920 });
  });

  it('is empty for every preset research 7 records no exclusion for', () => {
    const withChrome = profiles.filter((profile: FormatProfile) => profile.exclusions.length > 0);
    expect(withChrome.map((profile) => profile.id)).toEqual(['tiktok-9x16']);
  });
});
