/**
 * The half of the reframing problem this package does not own.
 *
 * `Shot.safeArea` and `Shot.focusTarget` are produced by `@rv/story-engine`'s S7 stage
 * (`shots/build-shot-list.ts`, `shots/safe-area.ts`) and consumed here. Neither package
 * depends on the other, so neither one's suite can see the join, and every test in this
 * package up to now has fed the solver rectangles this package invented.
 *
 * That is the classic place for two correct halves not to fit. So the numbers below are
 * the ones `solveSafeArea` actually emits, recorded as a contract rather than recomputed:
 * `packages/story-engine/src/shots/safe-area-contract.spec.ts` pins the same figures at
 * the producing end, and a change to the geometry there fails there and sends whoever made
 * it here.
 *
 * Two properties are asserted. The first is that a real shot list solves cleanly for every
 * delivery format. The second is the caveat that falls out of the two definitions meeting:
 * story-engine's safe area is the intersection of every **centred** maximal crop, and this
 * solver centres on the *focus*, so an off-centre subject legitimately costs part of the
 * declared safe area - and that must be a note, never a silent loss and never a review flag.
 */

import { describe, expect, it } from 'vitest';
import { FORMAT_PRESETS, type FormatProfileId, type NormRect, type Size } from '@rv/contracts';
import { unwrap } from '@rv/shared-kernel';

import { contains, mapIntoCrop } from './geometry';
import { buildReframePlan, buildReframePlans } from './reframe-plan';
import { solveShotCrop, type ShotFraming } from './solve-crop';

/**
 * What `@rv/story-engine` emits for a square authoring canvas shipping all four aspects.
 *
 * `solveSafeArea({width: 2560, height: 2560}, ['16:9', '9:16', '1:1', '4:5'])`. The square
 * canvas is the interesting one: the 16:9 and 9:16 crops of it are each 56.25 % of one
 * axis, so their intersection is small and the 5 % title-safe inset bites on both.
 */
const STORY_SAFE_AREA: NormRect = {
  x: 0.246875,
  y: 0.246875,
  width: 0.50625,
  height: 0.50625,
};

const CANVAS: Size = { width: 2560, height: 2560 };
const ALL_FORMATS = Object.keys(FORMAT_PRESETS) as FormatProfileId[];

/**
 * Two shots from a director's plan.
 *
 * The regions are the ones `sequencer.spec.ts` scripts its fake director to return, so
 * these are the numbers the story stage really produces rather than numbers chosen to
 * make the solver look good.
 */
const SHOTS: readonly ShotFraming[] = [
  {
    shotId: 'sht_0000000000000000000000000A',
    startMs: 0,
    durationMs: 4000,
    safeArea: STORY_SAFE_AREA,
    focus: [{ timeMs: 0, region: { x: 0.28, y: 0.4, width: 0.2, height: 0.35 } }],
    priority: 'must-keep',
  },
  {
    shotId: 'sht_0000000000000000000000000B',
    startMs: 4000,
    durationMs: 4000,
    safeArea: STORY_SAFE_AREA,
    focus: [{ timeMs: 0, region: { x: 0.4, y: 0.3, width: 0.25, height: 0.4 } }],
    priority: 'must-keep',
  },
];

describe('a real story-engine shot list solves for every delivery format', () => {
  it.each(ALL_FORMATS)('%s crops without needing review', (format) => {
    const plan = unwrap(
      buildReframePlan({ composition: CANVAS, shots: SHOTS }, FORMAT_PRESETS[format]),
    );

    expect(plan.needsReview).toBe(false);
    for (const shot of plan.shots) {
      expect(shot.strategy, `${format}/${shot.shotId}`).toBe('crop');
      expect(shot.safeAreaViolation).toBe(false);
    }
  });

  it.each(ALL_FORMATS)('%s lands the focus inside the platform safe area', (format) => {
    const profile = FORMAT_PRESETS[format];
    for (const shot of SHOTS) {
      const solved = solveShotCrop(shot, CANVAS, profile.size, profile.safeArea);
      const region = shot.focus[0]?.region;
      expect(region).toBeDefined();
      expect(
        contains(profile.safeArea, mapIntoCrop(region!, solved.sourceCrop)),
        `${format}/${shot.shotId}`,
      ).toBe(true);
    }
  });

  it('produces a plan for all seven formats at once, with no format failing alone', () => {
    const plans = unwrap(buildReframePlans({ composition: CANVAS, shots: SHOTS }, ALL_FORMATS));
    expect([...plans.keys()].sort()).toEqual([...ALL_FORMATS].sort());
    for (const plan of plans.values()) expect(plan.needsReview).toBe(false);
  });
});

describe('the two definitions of "safe area" meeting', () => {
  it('records a crop that eats into the shot’s declared safe area as a note, not a violation', () => {
    // The subject sits left of centre, so the 16:9 crop of a square canvas is pushed off
    // the vertical middle and clips the top of the story stage's centred safe rectangle.
    // Real, and the right answer: keeping the subject framed is what the safe area is for.
    const profile = FORMAT_PRESETS['yt-1080p'];
    const shot = SHOTS[0];
    expect(shot).toBeDefined();
    const solved = solveShotCrop(shot!, CANVAS, profile.size, profile.safeArea);

    expect(contains(solved.sourceCrop, STORY_SAFE_AREA)).toBe(false);
    expect(solved.notes.some((note) => note.includes('declared safe area'))).toBe(true);
    expect(solved.safeAreaViolation).toBe(false);
  });

  it('says nothing when the subject is centred and the crop keeps the whole safe area', () => {
    // The other half of the same property: the note has to be about this crop, not a
    // constant that fires on every shot.
    const profile = FORMAT_PRESETS['ig-1x1'];
    const centredShot: ShotFraming = {
      shotId: 'sht_0000000000000000000000000C',
      startMs: 0,
      durationMs: 2000,
      safeArea: STORY_SAFE_AREA,
      focus: [{ timeMs: 0, region: { x: 0.45, y: 0.45, width: 0.1, height: 0.1 } }],
      priority: 'must-keep',
    };

    const solved = solveShotCrop(centredShot, CANVAS, profile.size, profile.safeArea);
    expect(contains(solved.sourceCrop, STORY_SAFE_AREA)).toBe(true);
    expect(solved.notes).toEqual([]);
  });

  it('holds a subject that fills the declared safe area exactly, in every format', () => {
    // The worst case a composer is allowed to hand over: the subject is the safe area. If
    // this does not solve, the story stage's own geometry is unusable downstream.
    const filling: ShotFraming = {
      shotId: 'sht_0000000000000000000000000D',
      startMs: 0,
      durationMs: 2000,
      safeArea: STORY_SAFE_AREA,
      focus: [{ timeMs: 0, region: STORY_SAFE_AREA }],
      priority: 'must-keep',
    };

    for (const format of ALL_FORMATS) {
      const profile = FORMAT_PRESETS[format];
      const solved = solveShotCrop(filling, CANVAS, profile.size, profile.safeArea);
      expect(
        contains(profile.safeArea, mapIntoCrop(STORY_SAFE_AREA, solved.sourceCrop)) ||
          solved.strategy === 'letterbox' ||
          solved.strategy === 'pillarbox',
        `${format} neither held the subject nor fell back to bars`,
      ).toBe(true);
      expect(solved.safeAreaViolation, `${format} flagged a subject it could serve`).toBe(false);
    }
  });
});
