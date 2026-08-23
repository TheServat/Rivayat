/**
 * The reframer, against all seven verified presets.
 *
 * The claims being tested are the ones the architecture rests on:
 *
 *  - for **every** delivery format, the focus target lands inside that platform's safe
 *    area - asserted numerically, per shot, not by eye;
 *  - a shot whose focus cannot be satisfied sets `needsReview`, because a silent bad
 *    crop is worse than a flagged one;
 *  - the crop is **continuous** across a shot - the frame-to-frame delta is bounded, so
 *    a pan cannot jitter;
 *  - the same input produces the same plan, twice.
 *
 * The safe-area numbers come from `FORMAT_PRESETS`, which is where research §7's
 * live-verified figures live. Nothing here restates them.
 */

import { FORMAT_PRESETS, ReframePlan, type FormatProfileId, type NormRect } from '@rv/contracts';
import { unwrap } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { contains, mapIntoCrop, mapIntoFit, containFit } from './geometry';
import { buildReframePlan, buildReframePlans } from './reframe-plan';
import {
  cropAtProgress,
  feasibleInterval,
  solveShotCrop,
  type FocusSample,
  type ShotFraming,
} from './solve-crop';

const COMPOSITION = { width: 2400, height: 1800 };
const ALL_FORMATS = Object.keys(FORMAT_PRESETS) as FormatProfileId[];

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

/** A subject crossing the canvas from left to right over the shot. */
function crossing(samples = 5, from = 0.05, to = 0.85, durationMs = 4000): readonly FocusSample[] {
  return Array.from({ length: samples }, (_unused, index) => {
    const progress = index / (samples - 1);
    return {
      timeMs: durationMs * progress,
      region: { x: from + (to - from) * progress, y: 0.44, width: 0.1, height: 0.12 },
    };
  });
}

/** Where the focus rectangle lands in the target frame, for a given crop. */
function landed(shot: ShotFraming, crop: NormRect, sample = 0): NormRect {
  const focus = shot.focus[sample];
  if (focus === undefined) throw new Error('no such sample');
  return mapIntoCrop(focus.region, crop);
}

describe('every verified preset holds a centred subject', () => {
  it.each(ALL_FORMATS)('%s keeps the focus inside its safe area', (format) => {
    const profile = FORMAT_PRESETS[format];
    const shot = framing();
    const solved = solveShotCrop(shot, COMPOSITION, profile.size, profile.safeArea);

    expect(solved.safeAreaViolation).toBe(false);
    expect(contains(profile.safeArea, landed(shot, solved.sourceCrop))).toBe(true);
  });

  it.each(ALL_FORMATS)('%s reports a focus point inside its safe area', (format) => {
    const profile = FORMAT_PRESETS[format];
    const plan = unwrap(
      buildReframePlan({ composition: COMPOSITION, shots: [framing()] }, profile),
    );
    const shot = plan.shots[0];
    if (shot === undefined) throw new Error('no shot in the plan');
    expect(shot.focusPoint.x).toBeGreaterThanOrEqual(profile.safeArea.x);
    expect(shot.focusPoint.x).toBeLessThanOrEqual(profile.safeArea.x + profile.safeArea.width);
    expect(shot.focusPoint.y).toBeGreaterThanOrEqual(profile.safeArea.y);
    expect(shot.focusPoint.y).toBeLessThanOrEqual(profile.safeArea.y + profile.safeArea.height);
  });

  it("respects TikTok's extra exclusions, which no other 9:16 preset has", () => {
    // The universal 9:16 zone alone would let the subject sit under the action rail.
    const tiktok = FORMAT_PRESETS['tiktok-9x16'];
    const shorts = FORMAT_PRESETS['shorts-9x16'];
    expect(tiktok.safeArea.width).toBeLessThan(shorts.safeArea.width);

    const shot = framing({
      focus: [{ timeMs: 0, region: { x: 0.7, y: 0.44, width: 0.08, height: 0.12 } }],
    });
    const solved = solveShotCrop(shot, COMPOSITION, tiktok.size, tiktok.safeArea);
    const mapped = landed(shot, solved.sourceCrop);
    // Right action rail: the subject must finish left of 85 % of the frame.
    expect(mapped.x + mapped.width).toBeLessThanOrEqual(1 - 0.15 + 1e-6);
    // Bottom caption rail.
    expect(mapped.y + mapped.height).toBeLessThanOrEqual(1 - 0.2 + 1e-6);
  });
});

describe('strategy selection', () => {
  const shorts = FORMAT_PRESETS['shorts-9x16'];

  it('prefers a static crop when one satisfies the whole shot', () => {
    const solved = solveShotCrop(framing(), COMPOSITION, shorts.size, shorts.safeArea);
    expect(solved.strategy).toBe('crop');
    expect(solved.panTo).toBeNull();
  });

  it('pans only when no static crop works', () => {
    const shot = framing({ focus: crossing() });
    const solved = solveShotCrop(shot, COMPOSITION, shorts.size, shorts.safeArea);
    expect(solved.strategy).toBe('pan-scan');
    expect(solved.panTo).not.toBeNull();
  });

  it('keeps the crop size fixed across a pan - a pan translates, it does not zoom', () => {
    // The FFmpeg filter graph depends on this: `crop` evaluates w and h once.
    const solved = solveShotCrop(
      framing({ focus: crossing() }),
      COMPOSITION,
      shorts.size,
      shorts.safeArea,
    );
    expect(solved.panTo?.width).toBe(solved.sourceCrop.width);
    expect(solved.panTo?.height).toBe(solved.sourceCrop.height);
  });

  it('letterboxes when the focus region is wider than any crop can hold', () => {
    const shot = framing({
      focus: [{ timeMs: 0, region: { x: 0.1, y: 0.4, width: 0.8, height: 0.2 } }],
    });
    const solved = solveShotCrop(shot, COMPOSITION, shorts.size, shorts.safeArea);
    expect(solved.strategy).toBe('letterbox');
    expect(solved.safeAreaViolation).toBe(false);
    const fit = containFit(COMPOSITION, shorts.size);
    expect(contains(shorts.safeArea, mapIntoFit(shot.focus[0]!.region, fit))).toBe(true);
  });

  it('pillarboxes a tall composition into a wide frame', () => {
    const tall = { width: 1000, height: 2400 };
    const wide = FORMAT_PRESETS['yt-1080p'];
    // Too tall for the 16:9 crop of a 1000x2400 canvas (which is only 23 % of its
    // height), so the whole composition is kept with bars down the sides instead.
    const shot = framing({
      focus: [{ timeMs: 0, region: { x: 0.02, y: 0.25, width: 0.96, height: 0.5 } }],
    });
    const solved = solveShotCrop(shot, tall, wide.size, wide.safeArea);
    expect(solved.strategy).toBe('pillarbox');
    expect(solved.safeAreaViolation).toBe(false);
  });
});

describe('a shot that cannot be satisfied says so', () => {
  const shorts = FORMAT_PRESETS['shorts-9x16'];
  const impossible = framing({
    focus: [{ timeMs: 0, region: { x: 0.01, y: 0.4, width: 0.98, height: 0.2 } }],
  });

  it('flags the violation rather than shipping a silent bad crop', () => {
    const solved = solveShotCrop(impossible, COMPOSITION, shorts.size, shorts.safeArea);
    expect(solved.safeAreaViolation).toBe(true);
    expect(solved.notes.join(' ')).toContain('no crop or fit holds the focus target');
  });

  it('sets needsReview on the plan', () => {
    const plan = unwrap(
      buildReframePlan({ composition: COMPOSITION, shots: [impossible] }, shorts),
    );
    expect(plan.needsReview).toBe(true);
  });

  it('leaves needsReview clear when every shot is satisfied', () => {
    const plan = unwrap(buildReframePlan({ composition: COMPOSITION, shots: [framing()] }, shorts));
    expect(plan.needsReview).toBe(false);
  });

  it('still clamps the reported focus point into the frame', () => {
    // `ShotReframe.focusPoint` is `Unit01`; an unclamped miss would fail the schema and
    // the plan would be unstorable rather than merely flagged.
    const solved = solveShotCrop(impossible, COMPOSITION, shorts.size, shorts.safeArea);
    expect(solved.focusPoint.x).toBeGreaterThanOrEqual(0);
    expect(solved.focusPoint.x).toBeLessThanOrEqual(1);
  });

  it('accepts the miss when the focus is optional', () => {
    const solved = solveShotCrop(
      { ...impossible, priority: 'optional' },
      COMPOSITION,
      shorts.size,
      shorts.safeArea,
    );
    expect(solved.safeAreaViolation).toBe(false);
    expect(solved.notes.join(' ')).toContain('optional');
  });

  it('still flags a "prefer" focus, and says it was only preferred', () => {
    const solved = solveShotCrop(
      { ...impossible, priority: 'prefer' },
      COMPOSITION,
      shorts.size,
      shorts.safeArea,
    );
    expect(solved.safeAreaViolation).toBe(true);
    expect(solved.notes.join(' ')).toContain('prefer');
  });
});

describe('the crop is continuous across a shot', () => {
  const shorts = FORMAT_PRESETS['shorts-9x16'];

  it('never jumps more than the smoothstep bound between adjacent frames', () => {
    // A per-frame independently-solved crop is mathematically valid and vibrates.
    // Representing the crop as two endpoints and an eased interpolation makes
    // continuity a property of the representation rather than of a smoothing pass.
    const solved = solveShotCrop(
      framing({ focus: crossing() }),
      COMPOSITION,
      shorts.size,
      shorts.safeArea,
    );
    expect(solved.panTo).not.toBeNull();

    const frames = 100;
    const travel = Math.abs((solved.panTo?.x ?? 0) - solved.sourceCrop.x);
    const bound = (1.5 * travel) / frames + 1e-9;

    let previous = cropAtProgress(solved, 0);
    let biggest = 0;
    for (let frame = 1; frame <= frames; frame += 1) {
      const current = cropAtProgress(solved, frame / frames);
      biggest = Math.max(biggest, Math.abs(current.x - previous.x));
      previous = current;
    }
    expect(biggest).toBeLessThanOrEqual(bound);
    expect(biggest).toBeGreaterThan(0);
  });

  it('holds the focus inside the safe area at every sampled instant of the pan', () => {
    const shot = framing({ focus: crossing(9) });
    const solved = solveShotCrop(shot, COMPOSITION, shorts.size, shorts.safeArea);
    for (const sample of shot.focus) {
      const crop = cropAtProgress(solved, sample.timeMs / shot.durationMs);
      expect(contains(shorts.safeArea, mapIntoCrop(sample.region, crop))).toBe(true);
    }
  });

  it('returns the static crop unchanged at every progress when there is no pan', () => {
    const solved = solveShotCrop(framing(), COMPOSITION, shorts.size, shorts.safeArea);
    expect(cropAtProgress(solved, 0.37)).toEqual(solved.sourceCrop);
  });

  it('clamps a pan that would exceed the declared velocity, and flags it', () => {
    const solved = solveShotCrop(
      framing({ focus: crossing(5, 0.05, 0.85, 400), durationMs: 400 }),
      COMPOSITION,
      shorts.size,
      shorts.safeArea,
      { maxPanPerSecond: 0.05 },
    );
    expect(solved.notes.join(' ')).toContain('was clamped');
    expect(solved.safeAreaViolation).toBe(true);
  });
});

describe('manual overrides', () => {
  const shorts = FORMAT_PRESETS['shorts-9x16'];

  it('uses the authored crop verbatim', () => {
    const override = { x: 0.2, y: 0, width: 0.421875, height: 1 };
    const solved = solveShotCrop(framing({ override }), COMPOSITION, shorts.size, shorts.safeArea);
    expect(solved.sourceCrop).toEqual(override);
    expect(solved.strategy).toBe('crop');
  });

  it('still measures it, so a bad override is flagged rather than trusted', () => {
    const solved = solveShotCrop(
      framing({ override: { x: 0.9, y: 0, width: 0.1, height: 1 } }),
      COMPOSITION,
      shorts.size,
      shorts.safeArea,
    );
    expect(solved.safeAreaViolation).toBe(true);
    expect(solved.notes.join(' ')).toContain('manual crop');
  });
});

describe('notes', () => {
  it("mentions when the crop eats into the shot's declared safe area", () => {
    const shorts = FORMAT_PRESETS['shorts-9x16'];
    // A 9:16 crop of a 4:3 canvas cannot possibly contain an 80 %-wide safe area.
    const solved = solveShotCrop(framing(), COMPOSITION, shorts.size, shorts.safeArea);
    expect(solved.notes.join(' ')).toContain("cuts into the shot's declared safe area");
  });
});

describe('buildReframePlan', () => {
  const shorts = FORMAT_PRESETS['shorts-9x16'];

  it('produces a plan the contract accepts', () => {
    const plan = unwrap(
      buildReframePlan(
        {
          composition: COMPOSITION,
          shots: [
            framing(),
            framing({ shotId: 'sht_0000000000000000000000000B', focus: crossing() }),
          ],
        },
        shorts,
      ),
    );
    expect(() => ReframePlan.parse(plan)).not.toThrow();
  });

  it('copies the profile safe area rather than referencing the preset', () => {
    const plan = unwrap(buildReframePlan({ composition: COMPOSITION, shots: [framing()] }, shorts));
    expect(plan.safeArea).toEqual(shorts.safeArea);
    expect(plan.targetSize).toEqual(shorts.size);
  });

  it('is deterministic: the same input twice gives the same crops', () => {
    const input = { composition: COMPOSITION, shots: [framing({ focus: crossing() })] };
    expect(unwrap(buildReframePlan(input, shorts))).toEqual(
      unwrap(buildReframePlan(input, shorts)),
    );
  });

  it('refuses a composition with no shots', () => {
    const result = buildReframePlan({ composition: COMPOSITION, shots: [] }, shorts);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('validation');
  });

  it('caps the notes it carries', () => {
    const shots = Array.from({ length: 40 }, (_unused, index) =>
      framing({ shotId: `sht_${String(index).padStart(26, '0')}` }),
    );
    const plan = unwrap(
      buildReframePlan({ composition: COMPOSITION, shots }, shorts, { maxNotes: 3 }),
    );
    expect(plan.notes.length).toBeLessThanOrEqual(3);
  });
});

describe('buildReframePlans', () => {
  it('solves every requested format', () => {
    const plans = unwrap(
      buildReframePlans({ composition: COMPOSITION, shots: [framing()] }, ALL_FORMATS),
    );
    expect([...plans.keys()].sort()).toEqual([...ALL_FORMATS].sort());
  });

  it('fails the whole set rather than silently skipping one', () => {
    // Six files and a missing seventh is a failure nobody notices until the schedule.
    const result = buildReframePlans({ composition: COMPOSITION, shots: [] }, ALL_FORMATS);
    expect(result.ok).toBe(false);
  });
});

describe('feasibleInterval', () => {
  it('is the closed interval of crop offsets that hold the focus', () => {
    const interval = feasibleInterval(0.4, 0.1, 0.1, 0.8, 0.5);
    expect(interval).not.toBeNull();
    expect(interval?.low).toBeCloseTo(Math.max(0, 0.4 + 0.1 - 0.9 * 0.5), 10);
    expect(interval?.high).toBeCloseTo(0.4 - 0.1 * 0.5, 10);
  });

  it('is null when the focus is simply too big for the safe area', () => {
    expect(feasibleInterval(0.1, 0.9, 0.1, 0.8, 0.5)).toBeNull();
  });

  it('is null when the composition edge rules the interval out', () => {
    // A subject at the very edge of the canvas cannot be centred: there is nothing
    // beside it to crop.
    expect(feasibleInterval(0.99, 0.01, 0.4, 0.2, 0.9)).toBeNull();
  });
});
