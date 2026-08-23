/**
 * Delivery formats, their verified platform specs, and how one composition is
 * re-framed into each of them.
 *
 * The architecture's whole reason for a format-agnostic scene space (architecture 7)
 * is that maintaining three parallel projects is how a series stops shipping. So a
 * shot declares a `focusTarget` and a `safeArea` once, and every delivery format is a
 * *computed* crop rather than a re-authored composition.
 *
 * `FORMAT_PRESETS` holds the numbers verified in research 7 on 2026-08-23. They are
 * asserted individually in the spec beside this file, because a platform spec that
 * drifts silently - a Shorts limit that was two minutes last year and three now - is
 * exactly the bug this table exists to prevent. Do not round them, and do not
 * "improve" them from memory.
 */

import { z } from 'zod';

import {
  Fps,
  Label,
  Millis,
  NonEmptyString,
  NormRect,
  Size,
  Transform2D,
  Unit01,
} from '../primitives/common';
import { NodeId, ShotId } from '../primitives/ids';

// ── codecs and containers ───────────────────────────────────────────────────

export const VideoCodec = z.enum(['h264', 'h265', 'vp9', 'av1', 'prores']);
export type VideoCodec = z.infer<typeof VideoCodec>;

export const MediaContainer = z.enum(['mp4', 'mov', 'webm', 'mkv']);
export type MediaContainer = z.infer<typeof MediaContainer>;

/**
 * `width:height` as the platform states it, e.g. `16:9`.
 *
 * Kept as the declared ratio rather than a computed float so the table reads like its
 * source. The spec recomputes it from `size` for every preset rather than trusting
 * this field, which is the only way the two can be caught disagreeing.
 *
 * Open on purpose, and deliberately **not** `story-bible.ts`'s `DeliveryAspect`. This
 * one describes whatever ratio a platform happens to state, which has to stay open
 * because `DeliveryPlatform: 'custom'` exists; `DeliveryAspect` is the closed set of
 * four aspects the shot composer commits to keeping legible, and closed is what makes
 * it usable as an enum in the JSON Schema a model fills.
 *
 * The two are different things, so nothing makes them agree - the agreement is
 * asserted instead. `format.spec.ts` requires every `DELIVERY_ASPECTS` member to be
 * the aspect of at least one `FORMAT_PRESETS` entry (an authoring target nothing
 * encodes is an obligation nobody can discharge) and every preset's declared ratio to
 * equal its own width/height.
 */
export const FormatAspectRatio = z
  .string()
  .regex(/^[1-9]\d*:[1-9]\d*$/, 'expected a `width:height` ratio such as "16:9"');
export type FormatAspectRatio = z.infer<typeof FormatAspectRatio>;

/** Megabits per second. A range, because platforms state one and encoders need both ends. */
export const BitrateRange = z
  .strictObject({
    minMbps: z.number().positive().max(1000),
    maxMbps: z.number().positive().max(1000),
  })
  .refine((range) => range.maxMbps >= range.minMbps, {
    message: 'maxMbps must not be below minMbps',
    path: ['maxMbps'],
  });
export type BitrateRange = z.infer<typeof BitrateRange>;

// ── loudness ────────────────────────────────────────────────────────────────

/**
 * An EBU R128 loudness target.
 *
 * Architecture 7 mixes with loudness normalisation per platform; this is the shape
 * that target takes. Recorded per format rather than globally because platforms
 * normalise to different figures - but see `EBU_R128` for what we actually ship.
 */
export const LoudnessTarget = z.strictObject({
  /** Integrated programme loudness, LUFS. Negative. */
  integratedLufs: z.number().min(-70).max(0),
  /** Maximum true peak, dBTP. Negative, to leave headroom for lossy re-encoding. */
  truePeakDbtp: z.number().min(-20).max(0),
  /** Loudness range, LU. How much the level is allowed to move across the programme. */
  loudnessRangeLu: z.number().min(0).max(30),
});
export type LoudnessTarget = z.infer<typeof LoudnessTarget>;

/**
 * The EBU R128 standard itself: -23 LUFS integrated, -1 dBTP, 7 LU range.
 *
 * Every preset ships this value. Research 7 verified the *video* specs only and says
 * nothing about audio, and the per-platform normalisation figures that circulate are
 * not sourced there - so rather than invent five plausible numbers, every format
 * carries the standard and the field is ready for real per-platform targets the moment
 * someone verifies them.
 */
export const EBU_R128: LoudnessTarget = {
  integratedLufs: -23,
  truePeakDbtp: -1,
  loudnessRangeLu: 7,
};

// ── safe areas ──────────────────────────────────────────────────────────────

/**
 * The universal vertical safe zone: 900x1400 centred inside 1080x1920 (research 7).
 *
 * Written as the divisions rather than as decimals so the pixel figures stay visible;
 * `90/1080` is checkable against the source, `0.08333333333333333` is not.
 */
export const VERTICAL_SAFE_AREA: NormRect = {
  x: 90 / 1080, // (1080 - 900) / 2
  y: 260 / 1920, // (1920 - 1400) / 2
  width: 900 / 1080,
  height: 1400 / 1920,
};

/** TikTok's extra chrome exclusions, as fractions of the frame (research 7). */
const TIKTOK_TOP_EXCLUSION = 0.15;
const TIKTOK_BOTTOM_EXCLUSION = 0.2;
const TIKTOK_RIGHT_EXCLUSION = 0.15;

/**
 * TikTok's effective safe area: the universal vertical zone with the chrome cut out.
 *
 * Pre-intersected rather than left for each caller to compute, because a reframer that
 * forgets to subtract the caption rail puts the subject's face behind the follow
 * button and nobody notices until it is published.
 */
export const TIKTOK_SAFE_AREA: NormRect = {
  x: VERTICAL_SAFE_AREA.x,
  // TikTok's 15% top chrome reaches further in than the universal zone's 13.5%.
  y: TIKTOK_TOP_EXCLUSION,
  width: 1 - TIKTOK_RIGHT_EXCLUSION - VERTICAL_SAFE_AREA.x,
  height: 1 - TIKTOK_BOTTOM_EXCLUSION - TIKTOK_TOP_EXCLUSION,
};

/** The whole frame. Used where research 7 records no exclusion, rather than guessing one. */
export const FULL_FRAME: NormRect = { x: 0, y: 0, width: 1, height: 1 };

/** A named region of the frame that platform UI covers. */
export const ExclusionZone = z.strictObject({
  name: Label,
  rect: NormRect,
});
export type ExclusionZone = z.infer<typeof ExclusionZone>;

const TIKTOK_EXCLUSIONS: readonly ExclusionZone[] = [
  { name: 'top chrome', rect: { x: 0, y: 0, width: 1, height: TIKTOK_TOP_EXCLUSION } },
  {
    name: 'bottom caption rail',
    rect: { x: 0, y: 1 - TIKTOK_BOTTOM_EXCLUSION, width: 1, height: TIKTOK_BOTTOM_EXCLUSION },
  },
  {
    name: 'right action rail',
    rect: { x: 1 - TIKTOK_RIGHT_EXCLUSION, y: 0, width: TIKTOK_RIGHT_EXCLUSION, height: 1 },
  },
];

// ── format profiles ─────────────────────────────────────────────────────────

export const DeliveryPlatform = z.enum([
  'youtube',
  'youtube-shorts',
  'instagram-reels',
  'instagram-feed',
  'instagram-square',
  'tiktok',
  'custom',
]);
export type DeliveryPlatform = z.infer<typeof DeliveryPlatform>;

/**
 * Preset identifiers. One per row of the research 7 table, plus YouTube's two
 * resolutions, which are the same platform at genuinely different bitrates.
 */
export const FormatProfileId = z.enum([
  'yt-1080p',
  'yt-2160p',
  'shorts-9x16',
  'reels-9x16',
  'ig-4x5',
  'ig-1x1',
  'tiktok-9x16',
]);
export type FormatProfileId = z.infer<typeof FormatProfileId>;

/**
 * Everything the encoder and the reframer need to hit one delivery target.
 *
 * `codec` is what we emit; `allowedCodecs` is what the platform accepts. They are
 * separate so that "Reels is H.264 only" survives as data - a future decision to ship
 * HEVC everywhere then fails validation here instead of failing upload.
 */
export const FormatProfile = z.strictObject({
  id: FormatProfileId,
  platform: DeliveryPlatform,
  label: Label,
  size: Size,
  aspectRatio: FormatAspectRatio,
  /** The codec we encode this target with. */
  codec: VideoCodec,
  /** Every codec the platform accepts, per research 7. */
  allowedCodecs: z.array(VideoCodec).min(1),
  bitrateMbps: BitrateRange,
  /**
   * Delivery frame rate.
   *
   * Ours, not the platform's: research 7 does not state per-platform frame rates, and
   * all six targets accept 30. Change it deliberately, not by drift.
   */
  fps: Fps,
  /** `null` where the platform states no limit. */
  maxDurationMs: Millis.nullable(),
  container: MediaContainer,
  /** Region guaranteed clear of platform UI. Already excludes anything in `exclusions`. */
  safeArea: NormRect,
  /** The chrome that carved `safeArea` out of the frame, kept so the UI can draw it. */
  exclusions: z.array(ExclusionZone),
  loudness: LoudnessTarget,
});
export type FormatProfile = z.infer<typeof FormatProfile>;

/**
 * The verified 2026 platform specs from research 7.
 *
 * Every number here was live-checked on 2026-08-23 and is asserted field by field in
 * `format.spec.ts`. Treat a failing assertion as "the platform changed, go re-verify",
 * never as "the test is out of date".
 */
export const FORMAT_PRESETS: Record<FormatProfileId, FormatProfile> = {
  'yt-1080p': {
    id: 'yt-1080p',
    platform: 'youtube',
    label: 'YouTube 1080p',
    size: { width: 1920, height: 1080 },
    aspectRatio: '16:9',
    codec: 'h264',
    allowedCodecs: ['h264'],
    bitrateMbps: { minMbps: 8, maxMbps: 12 },
    fps: 30,
    maxDurationMs: null,
    container: 'mp4',
    safeArea: FULL_FRAME,
    exclusions: [],
    loudness: EBU_R128,
  },
  'yt-2160p': {
    id: 'yt-2160p',
    platform: 'youtube',
    label: 'YouTube 2160p (4K)',
    size: { width: 3840, height: 2160 },
    aspectRatio: '16:9',
    codec: 'h264',
    allowedCodecs: ['h264'],
    bitrateMbps: { minMbps: 35, maxMbps: 45 },
    fps: 30,
    maxDurationMs: null,
    container: 'mp4',
    safeArea: FULL_FRAME,
    exclusions: [],
    loudness: EBU_R128,
  },
  'shorts-9x16': {
    id: 'shorts-9x16',
    platform: 'youtube-shorts',
    label: 'YouTube Shorts',
    size: { width: 1080, height: 1920 },
    aspectRatio: '9:16',
    codec: 'h264',
    allowedCodecs: ['h264'],
    bitrateMbps: { minMbps: 8, maxMbps: 12 },
    fps: 30,
    // 3 minutes as of 2026. It was 60 seconds two specs ago; assume nothing.
    maxDurationMs: 180_000,
    container: 'mp4',
    safeArea: VERTICAL_SAFE_AREA,
    exclusions: [],
    loudness: EBU_R128,
  },
  'reels-9x16': {
    id: 'reels-9x16',
    platform: 'instagram-reels',
    label: 'Instagram Reels',
    size: { width: 1080, height: 1920 },
    aspectRatio: '9:16',
    codec: 'h264',
    // Research 7 is emphatic: H.264 only. Not a shortened list, the whole list.
    allowedCodecs: ['h264'],
    bitrateMbps: { minMbps: 8, maxMbps: 12 },
    fps: 30,
    maxDurationMs: 90_000,
    container: 'mp4',
    safeArea: VERTICAL_SAFE_AREA,
    exclusions: [],
    loudness: EBU_R128,
  },
  'ig-4x5': {
    id: 'ig-4x5',
    platform: 'instagram-feed',
    label: 'Instagram Feed 4:5',
    size: { width: 1080, height: 1350 },
    aspectRatio: '4:5',
    codec: 'h264',
    allowedCodecs: ['h264'],
    bitrateMbps: { minMbps: 8, maxMbps: 12 },
    fps: 30,
    maxDurationMs: 60_000,
    container: 'mp4',
    safeArea: FULL_FRAME,
    exclusions: [],
    loudness: EBU_R128,
  },
  'ig-1x1': {
    id: 'ig-1x1',
    platform: 'instagram-square',
    label: 'Instagram Square',
    size: { width: 1080, height: 1080 },
    aspectRatio: '1:1',
    codec: 'h264',
    allowedCodecs: ['h264'],
    bitrateMbps: { minMbps: 8, maxMbps: 12 },
    fps: 30,
    maxDurationMs: 60_000,
    container: 'mp4',
    safeArea: FULL_FRAME,
    exclusions: [],
    loudness: EBU_R128,
  },
  'tiktok-9x16': {
    id: 'tiktok-9x16',
    platform: 'tiktok',
    label: 'TikTok',
    size: { width: 1080, height: 1920 },
    aspectRatio: '9:16',
    codec: 'h264',
    allowedCodecs: ['h264', 'h265'],
    bitrateMbps: { minMbps: 8, maxMbps: 12 },
    fps: 30,
    maxDurationMs: 600_000,
    container: 'mp4',
    safeArea: TIKTOK_SAFE_AREA,
    exclusions: [...TIKTOK_EXCLUSIONS],
    loudness: EBU_R128,
  },
};

// ── reframing ───────────────────────────────────────────────────────────────

/**
 * How the solver got from the composition to this frame.
 *
 * Recorded per shot rather than per format because a single delivery usually mixes
 * them: a wide establishing shot letterboxes cleanly, the close-up two shots later
 * needs a crop, and the dialogue shot after that needs the camera to move.
 */
export const ReframeStrategy = z.enum([
  /** Static sub-rectangle of the composition. Always preferred: nothing moves that the author did not move. */
  'crop',
  /** The crop travels during the shot to keep the focus target inside the safe area. */
  'pan-scan',
  /** Whole frame kept, bars top and bottom. */
  'letterbox',
  /** Whole frame kept, bars left and right. */
  'pillarbox',
  /** Layout nodes are repositioned rather than the camera moved. Needs `layoutOverrides`. */
  'reflow',
]);
export type ReframeStrategy = z.infer<typeof ReframeStrategy>;

/**
 * A per-format adjustment to one layout node.
 *
 * The escape hatch for the cases a crop solver cannot reach: a title block that fits
 * in 16:9 and collides with the TikTok action rail in 9:16 has to move, not be cropped
 * around. Overrides are the exception, and a plan full of them means the composition
 * is not actually format-agnostic.
 */
export const LayoutOverride = z.strictObject({
  nodeId: NodeId,
  /** Replacement placement within the target frame. */
  rect: NormRect.optional(),
  transform: Transform2D.optional(),
  /** `false` drops the node from this format entirely. */
  visible: z.boolean().optional(),
  reason: Label.optional(),
});
export type LayoutOverride = z.infer<typeof LayoutOverride>;

/** The crop/pan solution for one shot in one target format. */
export const ShotReframe = z.strictObject({
  shotId: ShotId,
  strategy: ReframeStrategy,
  /** Region of the format-agnostic composition the target frame shows at the shot's start. */
  sourceCrop: NormRect,
  /**
   * Where the crop finishes. `null` for a static solution.
   *
   * Non-null only when the solver could not keep `focusTarget` inside the safe area
   * from a fixed crop, because a pan the author did not ask for is a visible artefact
   * and the cheapest correct answer is the one that does not move.
   */
  panTo: NormRect.nullable(),
  /** Where the shot's `focusTarget` lands inside the target frame. */
  focusPoint: z.object({ x: Unit01, y: Unit01 }),
  /** Uniform scale applied to the composition. Above 1 means we zoomed in to fill. */
  scale: z.number().positive().max(8),
  /** True when the focus target could not be fitted inside `safeArea`. Surfaces to the user. */
  safeAreaViolation: z.boolean(),
  layoutOverrides: z.array(LayoutOverride).default([]),
});
export type ShotReframe = z.infer<typeof ShotReframe>;

/**
 * The complete mapping of one composition onto one delivery format.
 *
 * A plan is a value, not a side effect: it is computed, shown, editable, and only then
 * rendered. That is what makes "re-framing to another aspect ratio costs $0"
 * (research 2) true - nothing is regenerated, a different plan is solved.
 */
export const ReframePlan = z
  .strictObject({
    format: FormatProfileId,
    targetSize: Size,
    /** Copied from the profile so a stored plan stays interpretable if the preset changes. */
    safeArea: NormRect,
    shots: z.array(ShotReframe).min(1),
    /** Overrides that apply to the whole plan rather than to one shot. */
    layoutOverrides: z.array(LayoutOverride).default([]),
    /** Set when any shot violates its safe area. A plan that needs eyes says so. */
    needsReview: z.boolean(),
    notes: z.array(NonEmptyString).max(32).default([]),
  })
  .superRefine((plan, ctx) => {
    // "A plan that needs eyes says so" was prose, and the whole value of the flag is
    // that a caller can trust it without walking every shot. A plan carrying a safe-area
    // violation and `needsReview: false` publishes a face behind the follow button and
    // reports itself clean while doing it.
    if (plan.shots.some((shot) => shot.safeAreaViolation) && !plan.needsReview) {
      ctx.addIssue({
        code: 'custom',
        path: ['needsReview'],
        message: 'a plan containing a safe-area violation must flag itself for review',
      });
    }
  });
export type ReframePlan = z.infer<typeof ReframePlan>;
