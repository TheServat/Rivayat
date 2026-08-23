/**
 * Render jobs: what to render, how far it got, and what came out.
 *
 * The shapes here exist because of one decision in architecture 7 - the frame loop
 * seeks the timeline (`for f in 0..N: evaluate(ir, f/fps) -> draw -> capture`) instead
 * of playing it. Nothing in a render depends on wall-clock time, so a render is pure,
 * and a pure render is **resumable** and **shardable**. `RenderCheckpoint` is what
 * turns that property into a feature: a job that died at frame 3,400 of 5,000 resumes
 * at 3,400, and eight workers rendering disjoint ranges produce the same frames a
 * single worker would.
 *
 * That is also why progress is frames-done over frames-total rather than a percentage
 * the renderer feels like reporting: the denominator is known before the first frame
 * because the timeline has a length, and an honest ETA needs a real denominator.
 */

import { z } from 'zod';

import {
  Fps,
  IsoInstant,
  Label,
  Millis,
  NonEmptyString,
  NonNegativeInt,
  PositiveInt,
  Sha256Hex,
  Size,
  Unit01,
} from '../primitives/common';
import { AnimationId, EpisodeId, JobId, ProjectId, RunId } from '../primitives/ids';
import { PIPELINE_STATUSES } from '../pipeline/stage';
import { QualityTier } from '../provider/capability';
import { EBU_R128, FormatProfileId, LoudnessTarget, MediaContainer, VideoCodec } from './format';

// ── backends ────────────────────────────────────────────────────────────────

/**
 * Which renderer draws the frames.
 *
 * Research 6 measured headless Chrome at roughly 8-15 s per 150 frames at 1080p, which
 * is fine for a shot with a shader on it and absurd for a title card. The two backends
 * are not a fallback pair - they are a real choice, and `auto` makes it from the
 * composition's own feature use rather than from a guess at the call site.
 */
export const RenderBackend = z.enum([
  /** PixiJS inside Playwright. Effects, shaders, anything that needs a GPU context. */
  'pixi-playwright',
  /** `@napi-rs/canvas` offscreen. Pure 2D, no browser, no Chromium start-up cost. */
  'napi-canvas',
  /** Pick per composition: `napi-canvas` unless something in the IR needs the browser. */
  'auto',
]);
export type RenderBackend = z.infer<typeof RenderBackend>;

/**
 * A half-open frame range, `[from, to)`.
 *
 * Half-open so ranges concatenate without off-by-one arithmetic - which matters
 * because sharding and resuming both work by splitting and rejoining these.
 */
export const FrameRange = z
  .strictObject({
    from: NonNegativeInt,
    to: NonNegativeInt,
  })
  .refine((range) => range.to > range.from, {
    message: 'frame range must contain at least one frame',
    path: ['to'],
  });
export type FrameRange = z.infer<typeof FrameRange>;

// ── encoding ────────────────────────────────────────────────────────────────

/**
 * Constant quality or constant bitrate, never both.
 *
 * A discriminated union rather than two nullable fields because "CRF 18 and also
 * 12 Mbps" is not a thing an encoder can honour, and a schema that can express it will
 * eventually be handed it.
 */
export const RateControl = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('crf'),
    /** Lower is better quality. 0-51 for H.264, 0-63 for AV1/VP9. */
    crf: z.number().int().min(0).max(63),
  }),
  z.strictObject({
    mode: z.literal('bitrate'),
    targetMbps: z.number().positive().max(1000),
    maxMbps: z.number().positive().max(1000),
    /** VBV buffer size, megabits. Governs how far the encoder may overshoot. */
    bufferMb: z.number().positive().max(2000),
  }),
]);
export type RateControl = z.infer<typeof RateControl>;

export const PixelFormat = z.enum(['yuv420p', 'yuv420p10le', 'yuv422p10le', 'yuva420p']);
export type PixelFormat = z.infer<typeof PixelFormat>;

/**
 * Limited (16-235) or full (0-255) luma range.
 *
 * Worth carrying explicitly because getting it wrong is the classic "why is my black
 * grey" bug, and it is invisible until someone compares two exports side by side.
 */
export const ColorRange = z.enum(['limited', 'full']);
export type ColorRange = z.infer<typeof ColorRange>;

export const AudioCodec = z.enum(['aac', 'opus', 'pcm_s16le', 'none']);
export type AudioCodec = z.infer<typeof AudioCodec>;

/**
 * Everything FFmpeg needs, for one output.
 *
 * Stored on the artefact as well as the request: an export has to be reproducible from
 * its own record, and "which CRF did we ship that one at" is otherwise unanswerable
 * once the request has been edited.
 */
export const EncodeSettings = z.strictObject({
  codec: VideoCodec,
  container: MediaContainer,
  rateControl: RateControl,
  pixelFormat: PixelFormat.default('yuv420p'),
  colorRange: ColorRange.default('limited'),
  fps: Fps,
  /** Keyframe interval, seconds. Short intervals seek better and compress worse. */
  gopSeconds: z.number().positive().max(20).default(2),
  audioCodec: AudioCodec.default('aac'),
  audioBitrateKbps: PositiveInt.max(1024).default(192),
  /** Normalisation target for the mix. Defaults to the EBU R128 standard itself. */
  loudness: LoudnessTarget.default(EBU_R128),
});
export type EncodeSettings = z.infer<typeof EncodeSettings>;

// ── requests ────────────────────────────────────────────────────────────────

/**
 * One render, as asked for.
 *
 * `formats` is a list rather than a single target because the master is rendered once
 * and re-framed per format (architecture 7); asking for all six in one request is what
 * lets the frame work be shared instead of repeated six times.
 */
export const RenderRequest = z.strictObject({
  projectId: ProjectId,
  animationId: AnimationId,
  /** `null` for a one-off render that is not part of an episode, e.g. a style probe. */
  episodeId: EpisodeId.nullable().default(null),
  formats: z.array(FormatProfileId).min(1),
  quality: QualityTier,
  /**
   * `null` renders the whole timeline. A range renders one slice, which is how a shard
   * is expressed and how "re-render just the shot I edited" is expressed.
   */
  frames: FrameRange.nullable().default(null),
  backend: RenderBackend.default('auto'),
  /** Parallel frame workers. Bounded because each one is a browser or a canvas context. */
  concurrency: PositiveInt.max(64).default(4),
  /**
   * Keep the PNG/raw frame sequence on disk after encoding.
   *
   * Off by default: a 1080p minute is thousands of files. On, it makes a failed encode
   * cheap to retry and makes a frame-level diff possible.
   */
  writeIntermediateFrames: z.boolean().default(false),
  /** Per-format encoder overrides. Anything absent falls back to the format's defaults. */
  encodeOverrides: z.partialRecord(FormatProfileId, EncodeSettings).default({}),
});
export type RenderRequest = z.infer<typeof RenderRequest>;

// ── job state ───────────────────────────────────────────────────────────────

/**
 * The render job's lifecycle, which is the pipeline's lifecycle.
 *
 * *Not* a copy of `PIPELINE_STATUSES` - the same list. A render is stage S10, and a
 * `RenderJob` is what lives inside a `PipelineJob` at that stage; two independently
 * written state vocabularies would need a mapping table between the job the scheduler
 * sees and the job the render worker sees, and a mapping table is where a `cancelled`
 * render quietly reports as `failed`.
 */
export const RenderJobState = z
  .enum(PIPELINE_STATUSES)
  .describe('Where this render is in its lifecycle. The same six states every job has.');
export type RenderJobState = z.infer<typeof RenderJobState>;

/**
 * Which slice of the work this worker owns.
 *
 * Sharding and resuming are the same mechanism seen from two directions: a shard is
 * handed a range up front, a resumed job computes the complement of what it already
 * finished.
 */
export const RenderShard = z.strictObject({
  index: NonNegativeInt,
  count: PositiveInt,
});
export type RenderShard = z.infer<typeof RenderShard>;

/**
 * Frame-level resume point.
 *
 * Ranges rather than a single high-water mark, because a sharded job completes its
 * frames out of order and a single number would either lose work or redo it.
 *
 * `lastFrameHash` is the honesty check: a resumed worker re-evaluates the last
 * completed frame and compares. A mismatch means the IR changed underneath the job,
 * and continuing would splice two different films together.
 */
export const RenderCheckpoint = z.strictObject({
  completedRanges: z.array(FrameRange).max(4096).default([]),
  /** Highest contiguous frame finished, or `null` before the first one lands. */
  lastCompletedFrame: NonNegativeInt.nullable().default(null),
  lastFrameHash: Sha256Hex.nullable().default(null),
  updatedAt: IsoInstant,
});
export type RenderCheckpoint = z.infer<typeof RenderCheckpoint>;

/** Which part of the pipeline the job is in. Encoding is not rendering, and users ask. */
export const RenderPhase = z.enum([
  'preparing',
  'rendering',
  'reframing',
  'encoding',
  'muxing',
  'finalising',
]);
export type RenderPhase = z.infer<typeof RenderPhase>;

/**
 * A progress tick, as streamed over SSE.
 *
 * `fraction` is carried alongside the counts rather than derived by each consumer,
 * because a multi-format job's overall progress is not `framesDone / framesTotal` -
 * encoding and reframing take real time after the last frame is drawn.
 */
export const RenderProgress = z
  .strictObject({
    jobId: JobId,
    phase: RenderPhase,
    framesDone: NonNegativeInt,
    framesTotal: PositiveInt,
    /** Overall completion across every phase, not just the frame loop. */
    fraction: Unit01,
    /** `null` until enough frames have landed for an estimate that is not noise. */
    etaMs: Millis.nullable().default(null),
    /** Observed throughput, frames per second. Diagnostic, not a target. */
    framesPerSecond: z.number().nonnegative().max(10_000).default(0),
    /** The format currently being encoded, or `null` during the shared frame loop. */
    currentFormat: FormatProfileId.nullable().default(null),
    message: Label.optional(),
  })
  .refine((progress) => progress.framesDone <= progress.framesTotal, {
    message: 'framesDone must not exceed framesTotal',
    path: ['framesDone'],
  });
export type RenderProgress = z.infer<typeof RenderProgress>;

// ── outputs ─────────────────────────────────────────────────────────────────

export const RenderArtifactKind = z.enum([
  /** The format-agnostic high-quality intermediate every delivery is cut from. */
  'master',
  /** One finished, platform-ready file. */
  'delivery',
  /** The retained frame sequence, when `writeIntermediateFrames` was set. */
  'frame-sequence',
  'poster',
  'audio',
]);
export type RenderArtifactKind = z.infer<typeof RenderArtifactKind>;

/**
 * A file the render produced.
 *
 * `sha256` is not decoration: renders are bit-reproducible (CLAUDE.md #1), so the hash
 * of a re-render is the assertion that determinism still holds. It is also the key the
 * content-addressed store files it under.
 */
export const RenderArtifact = z
  .strictObject({
    kind: RenderArtifactKind,
    /** `null` for a master or an audio stem, which belong to no single format. */
    format: FormatProfileId.nullable(),
    /** Path relative to the workspace root. Never absolute - workspaces move. */
    path: NonEmptyString.max(1024),
    sha256: Sha256Hex,
    bytes: NonNegativeInt,
    durationMs: Millis,
    size: Size,
    frameCount: NonNegativeInt,
    encode: EncodeSettings,
    createdAt: IsoInstant,
  })
  .superRefine((artifact, ctx) => {
    // "`null` for a master or an audio stem, which belong to no single format" was prose
    // only. A master tagged with a format is indistinguishable from a delivery in the
    // artifact list, so the delivery check picks it up and validates the wrong file
    // against a platform spec; a delivery with no format cannot be validated at all.
    const belongsToNoFormat = artifact.kind === 'master' || artifact.kind === 'audio';
    if (belongsToNoFormat && artifact.format !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['format'],
        message: `a ${artifact.kind} artefact belongs to no single format`,
      });
    }
    if (artifact.kind === 'delivery' && artifact.format === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['format'],
        message: 'a delivery artefact must name the format it was cut for',
      });
    }
  });
export type RenderArtifact = z.infer<typeof RenderArtifact>;

/**
 * The durable state of one render.
 *
 * Everything needed to resume lives in the record itself - request, shard, checkpoint -
 * so a worker that picks the job up has no dependency on the worker that dropped it,
 * and the queue library stays a transport rather than a source of truth.
 */
export const RenderJob = z
  .strictObject({
    id: JobId,
    runId: RunId,
    request: RenderRequest,
    state: RenderJobState,
    /** `null` for an unsharded job. */
    shard: RenderShard.nullable().default(null),
    checkpoint: RenderCheckpoint,
    /** `null` before the first tick. */
    progress: RenderProgress.nullable().default(null),
    artifacts: z.array(RenderArtifact).default([]),
    /** `AppError.code` when `state` is `failed`. */
    errorCode: NonEmptyString.max(80).nullable().default(null),
    createdAt: IsoInstant,
    updatedAt: IsoInstant,
  })
  .superRefine((job, ctx) => {
    // A failed job with no code is a job nobody can route, retry or report on - the same
    // invariant `StructuredCallOutcome` already enforces for a failed provider call, and
    // it should not depend on which file the failure landed in.
    if (job.state === 'failed' && job.errorCode === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'a failed render job must carry an error code',
      });
    }
  });
export type RenderJob = z.infer<typeof RenderJob>;
