/**
 * The render job: seek, draw, store, checkpoint, encode.
 *
 * Everything the package promises converges here, and all of it follows from one line
 * in the loop - the frame index is the only state. `renderFrame(f)` does not know what
 * frame came before it, so:
 *
 *  - **Resume** is `target \ completed`, and the frames already in the store are reused
 *    rather than redrawn. The encode then consumes the *same bytes* an uninterrupted
 *    run would have, which is why the resume test can assert byte equality instead of
 *    merely asserting that the evaluator is pure.
 *  - **Sharding** is a partition of `target`. Four workers with no coordination beyond
 *    their ranges produce the frames one worker would.
 *  - **Cancellation** is a check between frames. There is nothing to unwind, because
 *    there is nothing in flight but one frame.
 *
 * Nothing here reads a wall clock for logic. The injected `Clock` is used only to
 * measure throughput for the ETA and to stamp the checkpoint, both of which are
 * reporting rather than behaviour - the frames are identical whatever it says.
 */

import {
  CancelledError,
  NotFoundError,
  contentHash,
  err,
  ok,
  toIso,
  type AppError,
  type Clock,
  type Result,
  type Sha256,
  type Unit,
} from '@rv/shared-kernel';
import type {
  AnimationIR,
  EncodeSettings,
  FrameRange,
  JobId,
  RenderBackend,
  RenderCheckpoint,
  RenderShard,
  Size,
} from '@rv/contracts';

import { selectBackend, type BackendDecision } from '../backends/selector';
import type { FfmpegEncoder } from '../encode/ffmpeg-encoder';
import { clampToTimeline, framesIn, fullRange } from '../frames/frame-clock';
import { hashFrame, hashFrameSequence } from '../frames/frame-hash';
import type { TextStyleTable } from '../frames/draw-list';
import type { FrameBackendId, FrameRenderer } from '../ports/frame-renderer';
import { NULL_PROGRESS, type ProgressPort } from '../ports/progress';
import type { CheckpointStorePort, FrameStorePort } from '../ports/storage';
import {
  countFrames,
  isResumable,
  normaliseRanges,
  rangesContain,
  subtractRanges,
  toRenderCheckpoint,
  withFrame,
} from './checkpoint';
import { ProgressTracker } from './progress-tracker';
import { shardRange } from './shard';

export interface RunRenderJobDeps {
  /** Backends by id. `auto` picks between whatever is registered. */
  readonly renderers: ReadonlyMap<FrameBackendId, FrameRenderer>;
  readonly frames: FrameStorePort;
  readonly checkpoints: CheckpointStorePort;
  readonly encoder: FfmpegEncoder;
  readonly clock: Clock;
  readonly progress?: ProgressPort;
}

export interface MasterEncodeSpec {
  /** Absolute path. FFmpeg is a subprocess with its own working directory. */
  readonly outputPath: string;
  readonly settings: EncodeSettings;
}

export interface RunRenderJobInput {
  readonly jobId: JobId;
  readonly ir: AnimationIR;
  readonly size: Size;
  readonly backend: RenderBackend;
  /** `null` renders the whole timeline. */
  readonly frames: FrameRange | null;
  readonly shard?: RenderShard | null;
  /** `null` renders frames without encoding - the shard worker's job. */
  readonly master: MasterEncodeSpec | null;
  /** Kept after a successful encode when true. Off by default: a 1080p minute is 1,800 files. */
  readonly keepFrames?: boolean;
  readonly background?: string | null;
  readonly textStyles?: TextStyleTable;
  readonly signal?: AbortSignal;
  /** Frames between checkpoint writes. 1 is exact and cheap; higher trades precision for IO. */
  readonly checkpointEvery?: number;
}

export interface RunRenderJobOutput {
  readonly backend: FrameBackendId;
  readonly decision: BackendDecision;
  readonly range: FrameRange;
  /** Frames drawn by *this* run. Zero on a resume that had nothing left to do. */
  readonly framesRendered: number;
  /** Frames in the range, however they got there. */
  readonly framesTotal: number;
  /** Digest of the ordered frame hashes over the whole range. The determinism fixture. */
  readonly frameStreamHash: Sha256;
  readonly checkpoint: RenderCheckpoint;
  readonly masterPath: string | null;
}

/**
 * One render, resumable and shardable.
 *
 * A single `execute` per CLAUDE.md §2. The constructor takes the ports and nothing
 * else, so the same instance serves every job on a worker.
 */
export class RunRenderJobUseCase {
  readonly #deps: RunRenderJobDeps;

  constructor(deps: RunRenderJobDeps) {
    this.#deps = deps;
  }

  async execute(input: RunRenderJobInput): Promise<Result<RunRenderJobOutput, AppError>> {
    const { ir } = input;
    const timeline = fullRange(ir.durationMs, ir.fps);

    const requested = clampToTimeline(input.frames, timeline);
    if (!requested.ok) return requested;

    const range =
      input.shard == null ? ok(requested.value) : shardRange(requested.value, input.shard);
    if (!range.ok) return range;
    const target = range.value;

    const decision = selectBackend(ir, input.backend);
    const renderer = this.#deps.renderers.get(decision.backend);
    if (renderer === undefined) {
      return err(
        new NotFoundError('render backend', decision.backend, {
          context: { requested: input.backend, reason: decision.reason },
        }),
      );
    }

    const progress = this.#deps.progress ?? NULL_PROGRESS;
    const tracker = new ProgressTracker({
      jobId: input.jobId,
      framesTotal: countFrames([target]),
      clock: this.#deps.clock,
      sink: progress,
    });
    tracker.emit('preparing');

    // ── what is already done ──────────────────────────────────────────────
    const irHash = contentHash(ir);
    const stored = await this.#deps.checkpoints.load(input.jobId);
    if (!stored.ok) return stored;

    let completed = isResumable(stored.value, irHash)
      ? await this.#reconcile(stored.value?.completedRanges ?? [])
      : [];

    // Frames outside `pending` are already in the store and are deliberately **not**
    // recomputed - RV-160 asserts exactly that ("frames 0-59 not recomputed").
    const pending = subtractRanges(target, completed);

    // ── draw ──────────────────────────────────────────────────────────────
    let framesRendered = 0;
    let lastHash: Sha256 | null = null;
    const checkpointEvery = Math.max(1, input.checkpointEvery ?? 1);

    if (pending.length > 0) {
      const session = await renderer.open({
        ir,
        size: input.size,
        ...(input.background === undefined ? {} : { background: input.background }),
        ...(input.textStyles === undefined ? {} : { textStyles: input.textStyles }),
      });
      if (!session.ok) return session;
      const source = session.value;

      try {
        for (const block of pending) {
          for (const frame of framesIn(block)) {
            if (input.signal?.aborted === true) {
              await this.#save(input.jobId, completed, irHash, lastHash);
              return err(new CancelledError(`render ${input.jobId} at frame ${String(frame)}`));
            }

            const rendered = await source.renderFrame(frame);
            if (!rendered.ok) {
              await this.#save(input.jobId, completed, irHash, lastHash);
              return rendered;
            }

            const written = await this.#deps.frames.put(frame, rendered.value);
            if (!written.ok) return written;

            lastHash = hashFrame(rendered.value);
            completed = withFrame(completed, frame);
            framesRendered += 1;
            tracker.frameDone('rendering');

            if (framesRendered % checkpointEvery === 0) {
              const saved = await this.#save(input.jobId, completed, irHash, lastHash);
              if (!saved.ok) return saved;
            }
          }
        }
      } finally {
        await source.close();
      }
    }

    const finalSave = await this.#save(input.jobId, completed, irHash, lastHash);
    if (!finalSave.ok) return finalSave;

    // ── encode ────────────────────────────────────────────────────────────
    tracker.emit('encoding');
    const encoded = await this.#encode(input, target);
    if (!encoded.ok) return encoded;

    if (input.keepFrames !== true && input.master !== null) {
      const cleared = await this.#deps.frames.clear();
      if (!cleared.ok) return cleared;
    }

    tracker.emit('finalising');

    return ok({
      backend: decision.backend,
      decision,
      range: target,
      framesRendered,
      framesTotal: countFrames([target]),
      frameStreamHash: encoded.value.frameStreamHash,
      checkpoint: toRenderCheckpoint({
        jobId: input.jobId,
        completedRanges: [...completed],
        irHash,
        lastFrameHash: lastHash,
        updatedAtIso: toIso(this.#deps.clock.now()),
      }),
      masterPath: input.master?.outputPath ?? null,
    });
  }

  /**
   * Streams the range out of the store and into FFmpeg, in frame order.
   *
   * Reading from the store rather than from memory is what makes a resumed encode
   * byte-identical: the frames written before the interruption are the frames encoded
   * after it, not re-derivations of them.
   */
  async #encode(
    input: RunRenderJobInput,
    target: FrameRange,
  ): Promise<Result<{ frameStreamHash: Sha256 }, AppError>> {
    const hashes: Sha256[] = [];

    if (input.master === null) {
      // Frames-only: a shard worker whose output is the frames themselves. Still hashed,
      // so the shard's contribution can be compared with the same fixture.
      for (const frame of framesIn(target)) {
        const buffer = await this.#deps.frames.get(frame);
        if (!buffer.ok) return buffer;
        hashes.push(hashFrame(buffer.value));
      }
      return ok({ frameStreamHash: hashFrameSequence(hashes) });
    }

    const sink = this.#deps.encoder.open({
      size: input.size,
      settings: input.master.settings,
      outputPath: input.master.outputPath,
    });
    if (!sink.ok) return sink;

    for (const frame of framesIn(target)) {
      const buffer = await this.#deps.frames.get(frame);
      if (!buffer.ok) {
        await sink.value.cancel();
        return buffer;
      }
      const written = await sink.value.writeFrame(buffer.value);
      if (!written.ok) {
        await sink.value.cancel();
        return written;
      }
      hashes.push(written.value);
    }

    const summary = await sink.value.finish();
    if (!summary.ok) return summary;
    return ok({ frameStreamHash: summary.value.frameStreamHash });
  }

  /**
   * A checkpoint is only as true as the frames behind it.
   *
   * A process killed between writing a frame and writing the checkpoint - or the other
   * way round - leaves the two disagreeing. Intersecting them means the resume trusts
   * whichever is more pessimistic, and re-renders at most a frame or two.
   */
  async #reconcile(claimed: readonly FrameRange[]): Promise<readonly FrameRange[]> {
    const present = await this.#deps.frames.list();
    return normaliseRanges(
      present
        .filter((frame) => rangesContain(claimed, frame))
        .map((frame) => ({ from: frame, to: frame + 1 })),
    );
  }

  #save(
    jobId: JobId,
    completed: readonly FrameRange[],
    irHash: string,
    lastFrameHash: string | null,
  ): Promise<Result<Unit, AppError>> {
    return this.#deps.checkpoints.save(jobId, {
      jobId,
      completedRanges: [...completed],
      irHash,
      lastFrameHash,
      updatedAtIso: toIso(this.#deps.clock.now()),
    });
  }
}
