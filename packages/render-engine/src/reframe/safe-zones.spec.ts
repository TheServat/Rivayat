import { FORMAT_PRESETS, type FormatProfileId } from '@rv/contracts';
import { describe, expect, it } from 'vitest';

import type { ReframeInput } from './reframe-plan';
import {
  allSafeZoneTemplates,
  isDeliverable,
  safeZoneTemplate,
  validateAllDeliveries,
  validateDelivery,
} from './safe-zones';
import type { ShotFraming } from './solve-crop';

const COMPOSITION = { width: 2400, height: 1800 };

function input(shots: readonly ShotFraming[]): ReframeInput {
  return { composition: COMPOSITION, shots };
}

function framing(overrides: Partial<ShotFraming> = {}): ShotFraming {
  return {
    shotId: 'sht_0000000000000000000000000A',
    startMs: 0,
    durationMs: 4000,
    safeArea: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    focus: [{ timeMs: 0, region: { x: 0.46, y: 0.44, width: 0.08, height: 0.12 } }],
    priority: 'must-keep',
    ...overrides,
  };
}

describe('safeZoneTemplate', () => {
  it('reports the universal vertical safe zone as 900x1400 in 1080x1920', () => {
    // Research §7's figure, arrived at by arithmetic on the preset rather than restated.
    const template = safeZoneTemplate('shorts-9x16');
    expect(template.safeAreaPx).toEqual({ x: 90, y: 260, width: 900, height: 1400 });
  });

  it('gives TikTok its three exclusion rects for the UI to draw', () => {
    const template = safeZoneTemplate('tiktok-9x16');
    expect(template.exclusions.map((zone) => zone.name).sort()).toEqual([
      'bottom caption rail',
      'right action rail',
      'top chrome',
    ]);
  });

  it('reports the full frame where the platform states no exclusion', () => {
    expect(safeZoneTemplate('yt-1080p').safeArea).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(safeZoneTemplate('yt-1080p').exclusions).toEqual([]);
  });

  it('covers every preset', () => {
    expect(allSafeZoneTemplates()).toHaveLength(Object.keys(FORMAT_PRESETS).length);
  });
});

describe('validateDelivery', () => {
  it('passes a clean composition with zero issues', () => {
    expect(validateDelivery(input([framing()]), 'shorts-9x16', 4000)).toEqual([]);
  });

  it('names the shot, the profile and the strategy when a crop cannot be solved', () => {
    // "before any frame is rendered" is the whole point: solving costs microseconds,
    // rendering costs minutes.
    const issues = validateDelivery(
      input([
        framing({ focus: [{ timeMs: 0, region: { x: 0.01, y: 0.4, width: 0.98, height: 0.2 } }] }),
      ]),
      'shorts-9x16',
      4000,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'safe-area-violation',
      severity: 'error',
      format: 'shorts-9x16',
      shotId: 'sht_0000000000000000000000000A',
    });
  });

  it('rejects a 95-second composition for Reels and accepts it elsewhere', () => {
    // Research §7: Reels 90 s, Shorts 3 min, TikTok 10 min.
    const composition = input([framing()]);
    const reels = validateDelivery(composition, 'reels-9x16', 95_000);
    expect(reels[0]).toMatchObject({
      code: 'duration-exceeded',
      detail: { limitMs: 90_000, actualMs: 95_000, overageMs: 5_000 },
    });
    expect(validateDelivery(composition, 'shorts-9x16', 95_000)).toEqual([]);
    expect(validateDelivery(composition, 'tiktok-9x16', 95_000)).toEqual([]);
  });

  it('never complains about duration for YouTube, which states no limit', () => {
    expect(validateDelivery(input([framing()]), 'yt-1080p', 60 * 60 * 1000)).toEqual([]);
  });

  it('reports an empty composition once rather than per shot', () => {
    const issues = validateDelivery(input([]), 'ig-1x1', 1000);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('no-shots');
  });
});

describe('validateAllDeliveries', () => {
  const formats = Object.keys(FORMAT_PRESETS) as FormatProfileId[];

  it('is clean across every preset for a well-composed shot', () => {
    expect(validateAllDeliveries(input([framing()]), formats, 30_000)).toEqual([]);
    expect(isDeliverable([])).toBe(true);
  });

  it('reports each failing profile separately', () => {
    const issues = validateAllDeliveries(input([framing()]), formats, 120_000);
    // 120 s exceeds Reels (90 s), Feed (60 s) and Square (60 s), and nothing else.
    expect(issues.map((issue) => issue.format).sort()).toEqual(['ig-1x1', 'ig-4x5', 'reels-9x16']);
    expect(isDeliverable(issues)).toBe(false);
  });
});
