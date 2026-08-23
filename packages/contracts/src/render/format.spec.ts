import { at } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { NormRect } from '../primitives/common';
import { DELIVERY_ASPECTS, DeliveryAspect } from '../story/story-bible';
import {
  BitrateRange,
  DeliveryPlatform,
  EBU_R128,
  FORMAT_PRESETS,
  FULL_FRAME,
  FormatAspectRatio,
  FormatProfile,
  FormatProfileId,
  LayoutOverride,
  LoudnessTarget,
  ReframePlan,
  ReframeStrategy,
  ShotReframe,
  TIKTOK_SAFE_AREA,
  VERTICAL_SAFE_AREA,
} from './format';

const body = (tail: string): string => tail.padStart(26, '0');
const SHOT_ID = `sht_${body('A1')}`;
const NODE_ID = `nod_${body('A2')}`;

/** Ratio implied by the pixel dimensions, so the declared string can be checked against it. */
function declaredRatio(aspect: string): number {
  const parts = aspect.split(':');
  return Number(at(parts, 0)) / Number(at(parts, 1));
}

function overlaps(a: NormRect, b: NormRect): boolean {
  const epsilon = 1e-9;
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlapX > epsilon && overlapY > epsilon;
}

const presets = Object.values(FORMAT_PRESETS);

describe('FORMAT_PRESETS - verified 2026 platform specs (research 7)', () => {
  it('has exactly one preset per declared id, keyed by that id', () => {
    expect(Object.keys(FORMAT_PRESETS).sort()).toEqual([...FormatProfileId.options].sort());
    for (const [key, profile] of Object.entries(FORMAT_PRESETS)) {
      expect(profile.id).toBe(key);
    }
  });

  it('every preset satisfies FormatProfile', () => {
    for (const profile of presets) {
      const result = FormatProfile.safeParse(profile);
      expect(result.success, `${profile.id}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it('YouTube landscape is 1920x1080 and 3840x2160, 16:9, H.264, 8-12 and 35-45 Mbps, no length cap', () => {
    const hd = FORMAT_PRESETS['yt-1080p'];
    expect(hd.platform).toBe('youtube');
    expect(hd.size).toEqual({ width: 1920, height: 1080 });
    expect(hd.aspectRatio).toBe('16:9');
    expect(hd.codec).toBe('h264');
    expect(hd.allowedCodecs).toEqual(['h264']);
    expect(hd.bitrateMbps).toEqual({ minMbps: 8, maxMbps: 12 });
    expect(hd.maxDurationMs).toBeNull();

    const uhd = FORMAT_PRESETS['yt-2160p'];
    expect(uhd.platform).toBe('youtube');
    expect(uhd.size).toEqual({ width: 3840, height: 2160 });
    expect(uhd.aspectRatio).toBe('16:9');
    expect(uhd.codec).toBe('h264');
    expect(uhd.bitrateMbps).toEqual({ minMbps: 35, maxMbps: 45 });
    expect(uhd.maxDurationMs).toBeNull();
  });

  it('YouTube Shorts is 1080x1920, 9:16, H.264, 8-12 Mbps, max 3 minutes', () => {
    const shorts = FORMAT_PRESETS['shorts-9x16'];
    expect(shorts.platform).toBe('youtube-shorts');
    expect(shorts.size).toEqual({ width: 1080, height: 1920 });
    expect(shorts.aspectRatio).toBe('9:16');
    expect(shorts.allowedCodecs).toEqual(['h264']);
    expect(shorts.bitrateMbps).toEqual({ minMbps: 8, maxMbps: 12 });
    expect(shorts.maxDurationMs).toBe(3 * 60 * 1000);
    expect(shorts.maxDurationMs).toBe(180_000);
  });

  it('Instagram Reels is 1080x1920, 9:16, H.264 only, 8-12 Mbps, max 90 seconds', () => {
    const reels = FORMAT_PRESETS['reels-9x16'];
    expect(reels.platform).toBe('instagram-reels');
    expect(reels.size).toEqual({ width: 1080, height: 1920 });
    expect(reels.aspectRatio).toBe('9:16');
    expect(reels.codec).toBe('h264');
    // "H.264 only" is the whole allowed list, not an abbreviation of it.
    expect(reels.allowedCodecs).toEqual(['h264']);
    expect(reels.bitrateMbps).toEqual({ minMbps: 8, maxMbps: 12 });
    expect(reels.maxDurationMs).toBe(90_000);
  });

  it('Instagram Feed is 1080x1350 4:5 and Square is 1080x1080 1:1, both capped at 60 seconds', () => {
    const feed = FORMAT_PRESETS['ig-4x5'];
    expect(feed.platform).toBe('instagram-feed');
    expect(feed.size).toEqual({ width: 1080, height: 1350 });
    expect(feed.aspectRatio).toBe('4:5');
    expect(feed.allowedCodecs).toEqual(['h264']);
    expect(feed.bitrateMbps).toEqual({ minMbps: 8, maxMbps: 12 });
    expect(feed.maxDurationMs).toBe(60_000);

    const square = FORMAT_PRESETS['ig-1x1'];
    expect(square.platform).toBe('instagram-square');
    expect(square.size).toEqual({ width: 1080, height: 1080 });
    expect(square.aspectRatio).toBe('1:1');
    expect(square.allowedCodecs).toEqual(['h264']);
    expect(square.bitrateMbps).toEqual({ minMbps: 8, maxMbps: 12 });
    expect(square.maxDurationMs).toBe(60_000);
  });

  it('TikTok is 1080x1920, 9:16, H.264/H.265, 8-12 Mbps, max 10 minutes', () => {
    const tiktok = FORMAT_PRESETS['tiktok-9x16'];
    expect(tiktok.platform).toBe('tiktok');
    expect(tiktok.size).toEqual({ width: 1080, height: 1920 });
    expect(tiktok.aspectRatio).toBe('9:16');
    expect(tiktok.allowedCodecs).toEqual(['h264', 'h265']);
    expect(tiktok.bitrateMbps).toEqual({ minMbps: 8, maxMbps: 12 });
    expect(tiktok.maxDurationMs).toBe(10 * 60 * 1000);
    expect(tiktok.maxDurationMs).toBe(600_000);
  });

  it('every preset encodes with a codec the platform accepts, into mp4, at 30 fps', () => {
    for (const profile of presets) {
      expect(profile.allowedCodecs, profile.id).toContain(profile.codec);
      expect(profile.container, profile.id).toBe('mp4');
      expect(profile.fps, profile.id).toBe(30);
    }
  });

  it('every preset carries the EBU R128 loudness target', () => {
    for (const profile of presets) {
      expect(profile.loudness, profile.id).toEqual({
        integratedLufs: -23,
        truePeakDbtp: -1,
        loudnessRangeLu: 7,
      });
    }
    expect(LoudnessTarget.parse(EBU_R128)).toEqual(EBU_R128);
  });

  it('states an aspect ratio that agrees with its own pixel dimensions', () => {
    for (const profile of presets) {
      const fromPixels = profile.size.width / profile.size.height;
      expect(declaredRatio(profile.aspectRatio), profile.id).toBeCloseTo(fromPixels, 12);
    }
  });

  it('covers every platform except `custom`, which by definition has no preset', () => {
    const covered = new Set(presets.map((profile) => profile.platform));
    for (const platform of DeliveryPlatform.options) {
      if (platform === 'custom') {
        expect(covered.has(platform)).toBe(false);
        continue;
      }
      expect(covered.has(platform), platform).toBe(true);
    }
  });
});

describe('safe areas', () => {
  it('keeps every safe-area rect inside the normalised frame', () => {
    for (const profile of presets) {
      const { x, y, width, height } = profile.safeArea;
      for (const value of [x, y, width, height]) {
        expect(value, profile.id).toBeGreaterThanOrEqual(0);
        expect(value, profile.id).toBeLessThanOrEqual(1);
      }
      expect(x + width, profile.id).toBeLessThanOrEqual(1 + 1e-9);
      expect(y + height, profile.id).toBeLessThanOrEqual(1 + 1e-9);
      expect(width, profile.id).toBeGreaterThan(0);
      expect(height, profile.id).toBeGreaterThan(0);
    }
  });

  it('keeps every exclusion rect inside the normalised frame', () => {
    for (const profile of presets) {
      for (const zone of profile.exclusions) {
        const { x, y, width, height } = zone.rect;
        for (const value of [x, y, width, height]) {
          expect(value, `${profile.id}/${zone.name}`).toBeGreaterThanOrEqual(0);
          expect(value, `${profile.id}/${zone.name}`).toBeLessThanOrEqual(1);
        }
        expect(x + width).toBeLessThanOrEqual(1 + 1e-9);
        expect(y + height).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('is exactly 900x1400 centred inside 1080x1920 when denormalised', () => {
    expect(VERTICAL_SAFE_AREA.width * 1080).toBeCloseTo(900, 9);
    expect(VERTICAL_SAFE_AREA.height * 1920).toBeCloseTo(1400, 9);
    expect(Math.round(VERTICAL_SAFE_AREA.width * 1080)).toBe(900);
    expect(Math.round(VERTICAL_SAFE_AREA.height * 1920)).toBe(1400);

    // Centred: equal margin on both axes.
    const leftMargin = VERTICAL_SAFE_AREA.x * 1080;
    const rightMargin = (1 - VERTICAL_SAFE_AREA.x - VERTICAL_SAFE_AREA.width) * 1080;
    const topMargin = VERTICAL_SAFE_AREA.y * 1920;
    const bottomMargin = (1 - VERTICAL_SAFE_AREA.y - VERTICAL_SAFE_AREA.height) * 1920;
    expect(leftMargin).toBeCloseTo(90, 9);
    expect(rightMargin).toBeCloseTo(90, 9);
    expect(topMargin).toBeCloseTo(260, 9);
    expect(bottomMargin).toBeCloseTo(260, 9);
  });

  it('applies the universal vertical safe zone to both 9:16 non-TikTok targets', () => {
    expect(FORMAT_PRESETS['shorts-9x16'].safeArea).toEqual(VERTICAL_SAFE_AREA);
    expect(FORMAT_PRESETS['reels-9x16'].safeArea).toEqual(VERTICAL_SAFE_AREA);
  });

  it('leaves the whole frame safe where research 7 records no exclusion', () => {
    for (const id of ['yt-1080p', 'yt-2160p', 'ig-4x5', 'ig-1x1'] as const) {
      expect(FORMAT_PRESETS[id].safeArea, id).toEqual(FULL_FRAME);
      expect(FORMAT_PRESETS[id].exclusions, id).toEqual([]);
    }
  });

  it("names TikTok's extra exclusions: top 15%, bottom 20%, right 15%", () => {
    const tiktok = FORMAT_PRESETS['tiktok-9x16'];
    expect(tiktok.exclusions).toHaveLength(3);

    const byName = new Map(tiktok.exclusions.map((zone) => [zone.name, zone.rect]));
    expect(byName.get('top chrome')).toEqual({ x: 0, y: 0, width: 1, height: 0.15 });
    expect(byName.get('bottom caption rail')).toEqual({ x: 0, y: 0.8, width: 1, height: 0.2 });
    expect(byName.get('right action rail')).toEqual({ x: 0.85, y: 0, width: 0.15, height: 1 });
  });

  it("keeps TikTok's safe area clear of every one of its exclusions", () => {
    const tiktok = FORMAT_PRESETS['tiktok-9x16'];
    expect(tiktok.safeArea).toEqual(TIKTOK_SAFE_AREA);
    for (const zone of tiktok.exclusions) {
      expect(overlaps(tiktok.safeArea, zone.rect), zone.name).toBe(false);
    }
  });

  it("narrows the universal zone rather than widening it, because TikTok's chrome reaches further in", () => {
    expect(TIKTOK_SAFE_AREA.x).toBe(VERTICAL_SAFE_AREA.x);
    expect(TIKTOK_SAFE_AREA.y).toBeGreaterThan(VERTICAL_SAFE_AREA.y);
    expect(TIKTOK_SAFE_AREA.width).toBeLessThan(VERTICAL_SAFE_AREA.width);
    expect(TIKTOK_SAFE_AREA.height).toBeLessThan(VERTICAL_SAFE_AREA.height);
  });
});

describe('field schemas', () => {
  it('accepts a `width:height` ratio and rejects anything else', () => {
    expect(FormatAspectRatio.parse('16:9')).toBe('16:9');
    expect(FormatAspectRatio.safeParse('1.78:1').success).toBe(false);
    expect(FormatAspectRatio.safeParse('0:9').success).toBe(false);
    expect(FormatAspectRatio.safeParse('16-9').success).toBe(false);
  });

  it('refuses an inverted bitrate range', () => {
    expect(BitrateRange.safeParse({ minMbps: 8, maxMbps: 12 }).success).toBe(true);
    expect(BitrateRange.safeParse({ minMbps: 8, maxMbps: 8 }).success).toBe(true);
    const result = BitrateRange.safeParse({ minMbps: 12, maxMbps: 8 });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('maxMbps');
  });

  it('refuses a positive integrated loudness, which is not a thing', () => {
    expect(LoudnessTarget.safeParse({ ...EBU_R128, integratedLufs: 3 }).success).toBe(false);
    expect(LoudnessTarget.safeParse({ ...EBU_R128, truePeakDbtp: 1 }).success).toBe(false);
  });
});

describe('ReframePlan', () => {
  const shot = {
    shotId: SHOT_ID,
    strategy: 'crop',
    sourceCrop: { x: 0.15, y: 0, width: 0.5, height: 1 },
    panTo: null,
    focusPoint: { x: 0.5, y: 0.42 },
    scale: 1.6,
    safeAreaViolation: false,
  };

  it('names every strategy the solver can pick', () => {
    expect(ReframeStrategy.options).toEqual([
      'crop',
      'pan-scan',
      'letterbox',
      'pillarbox',
      'reflow',
    ]);
  });

  it('describes a static crop with no layout overrides', () => {
    const parsed = ShotReframe.parse(shot);
    expect(parsed.panTo).toBeNull();
    expect(parsed.layoutOverrides).toEqual([]);
  });

  it('describes a pan when a fixed crop could not hold the focus target', () => {
    const parsed = ShotReframe.parse({
      ...shot,
      strategy: 'pan-scan',
      panTo: { x: 0.35, y: 0, width: 0.5, height: 1 },
    });
    expect(parsed.panTo).toEqual({ x: 0.35, y: 0, width: 0.5, height: 1 });
  });

  it('rejects a non-positive scale', () => {
    expect(ShotReframe.safeParse({ ...shot, scale: 0 }).success).toBe(false);
  });

  it('rejects a focus point outside the frame', () => {
    expect(ShotReframe.safeParse({ ...shot, focusPoint: { x: 1.2, y: 0.5 } }).success).toBe(false);
  });

  it('carries per-format layout overrides for the nodes a crop cannot rescue', () => {
    const override = LayoutOverride.parse({
      nodeId: NODE_ID,
      rect: { x: 0.1, y: 0.62, width: 0.7, height: 0.1 },
      visible: true,
      reason: 'title block collides with the TikTok action rail',
    });
    expect(override.nodeId).toBe(NODE_ID);
    expect(override.transform).toBeUndefined();
  });

  it('maps one composition onto one format and flags the plans that need eyes', () => {
    const plan = ReframePlan.parse({
      format: 'tiktok-9x16',
      targetSize: { width: 1080, height: 1920 },
      safeArea: TIKTOK_SAFE_AREA,
      shots: [shot, { ...shot, strategy: 'letterbox', scale: 1, safeAreaViolation: true }],
      needsReview: true,
    });
    expect(plan.shots).toHaveLength(2);
    expect(plan.needsReview).toBe(true);
    expect(plan.layoutOverrides).toEqual([]);
    expect(plan.notes).toEqual([]);
    expect(plan.shots.some((entry) => entry.safeAreaViolation)).toBe(true);
  });

  it('refuses a plan with no shots', () => {
    expect(
      ReframePlan.safeParse({
        format: 'ig-1x1',
        targetSize: { width: 1080, height: 1080 },
        safeArea: FULL_FRAME,
        shots: [],
        needsReview: false,
      }).success,
    ).toBe(false);
  });

  it('refuses a plan for a format that is not a known preset', () => {
    expect(
      ReframePlan.safeParse({
        format: 'snapchat-9x16',
        targetSize: { width: 1080, height: 1920 },
        safeArea: FULL_FRAME,
        shots: [shot],
        needsReview: false,
      }).success,
    ).toBe(false);
  });
});

describe('JSON Schema emission', () => {
  it('emits for the format and reframing schemas', () => {
    for (const schema of [FormatProfile, ShotReframe, LayoutOverride, ReframePlan]) {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
    }
  });
});

// ── the two aspect vocabularies agree ───────────────────────────────────────
//
// `DeliveryAspect` (story-bible) is the closed set of four aspects a shot is composed
// to survive; `FormatAspectRatio` (here) is the open `width:height` string a platform
// states, open because `DeliveryPlatform: 'custom'` exists. They are different types on
// purpose and nothing structural relates them, so the relationship is asserted.

describe('authoring aspects and delivery presets agree', () => {
  it('realises every authoring aspect in at least one delivery preset', () => {
    const shipped = new Set(presets.map((profile) => profile.aspectRatio));
    for (const aspect of DELIVERY_ASPECTS) {
      expect(
        shipped.has(aspect),
        `${aspect} is an authoring obligation no preset can discharge`,
      ).toBe(true);
    }
  });

  it('states every preset aspect in the grammar the open ratio type accepts', () => {
    for (const profile of presets) {
      expect(FormatAspectRatio.safeParse(profile.aspectRatio).success, profile.id).toBe(true);
    }
  });

  it('accepts every closed authoring aspect as a well-formed open ratio', () => {
    for (const aspect of DELIVERY_ASPECTS) {
      expect(FormatAspectRatio.safeParse(aspect).success, aspect).toBe(true);
    }
  });

  it('stays open to a ratio the closed authoring set does not contain', () => {
    // The reason the two types exist separately: a custom platform may state 21:9, and
    // the format table has to be able to say so without the shot composer promising it.
    expect(FormatAspectRatio.safeParse('21:9').success).toBe(true);
    expect(DeliveryAspect.safeParse('21:9').success).toBe(false);
  });

  it('recomputes every preset ratio from its own pixels rather than trusting the string', () => {
    for (const profile of presets) {
      const parts = profile.aspectRatio.split(':');
      expect(Number(parts[0]) / Number(parts[1]), profile.id).toBeCloseTo(
        profile.size.width / profile.size.height,
        12,
      );
    }
  });
});

describe('a reframe plan that needs eyes says so', () => {
  const violating = {
    shotId: SHOT_ID,
    strategy: 'crop',
    sourceCrop: { x: 0.15, y: 0, width: 0.5, height: 1 },
    panTo: null,
    focusPoint: { x: 0.5, y: 0.42 },
    scale: 1.6,
    safeAreaViolation: true,
  };
  const clean = { ...violating, safeAreaViolation: false };
  const plan = (shots: unknown[], needsReview: boolean): unknown => ({
    format: 'tiktok-9x16',
    targetSize: { width: 1080, height: 1920 },
    safeArea: TIKTOK_SAFE_AREA,
    shots,
    needsReview,
  });

  it('rejects a plan that hides a safe-area violation behind a clean flag', () => {
    const result = ReframePlan.safeParse(plan([clean, violating], false));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['needsReview']);
  });

  it('accepts the same plan once it admits it needs review', () => {
    expect(ReframePlan.safeParse(plan([clean, violating], true)).success).toBe(true);
  });

  it('lets a clean plan flag itself anyway - review is allowed to be conservative', () => {
    expect(ReframePlan.safeParse(plan([clean], true)).success).toBe(true);
    expect(ReframePlan.safeParse(plan([clean], false)).success).toBe(true);
  });
});
