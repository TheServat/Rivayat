/**
 * Frames in, a file out, and FFmpeg's own words when it fails.
 *
 * Three decisions, all of which the brief calls out and all of which have a cost if
 * they go the other way:
 *
 *  - **Spawned, not shelled.** {@link ProcessPort} cannot express a command string.
 *  - **Piped, not written.** A 90-second 1080p render is 2,700 frames; a PNG each is
 *    2,700 files and about 5 GB of encode/decode nobody asked for. Raw RGBA on stdin
 *    is one file handle and no round trip.
 *  - **Stderr becomes an `AppError`.** `exit code 1` is not a diagnosis. FFmpeg puts
 *    the actual reason - an unknown encoder, an odd frame width, a full disk - on
 *    stderr, so a non-zero exit carries the last lines of it into the error's context.
 */

import { ProviderError, err, ok, type AppError, type Result, type Sha256 } from '@rv/shared-kernel';
import type { EncodeSettings, Size } from '@rv/contracts';

import { hashFrame, hashFrameSequence } from '../frames/frame-hash';
import type { FrameBuffer } from '../ports/frame-renderer';
import type { PipedProcess, ProcessPort, ProcessResult } from '../ports/process';
import { buildConcatArgs, buildEncodeArgs } from './ffmpeg-args';

export interface FfmpegPaths {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

export const DEFAULT_FFMPEG_PATHS: FfmpegPaths = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };

export interface EncodeStreamOptions {
  readonly size: Size;
  readonly settings: EncodeSettings;
  /** Absolute path. FFmpeg has its own working directory. */
  readonly outputPath: string;
  readonly videoFilter?: string;
}

/**
 * An encode that is accepting frames.
 *
 * Separate from the encoder so the frame loop can interleave: render frame `f`, write
 * frame `f`, checkpoint, repeat. Collecting all the frames first and encoding
 * afterwards would need the whole sequence resident or on disk, which is the thing this
 * design exists to avoid.
 */
export interface FrameSink {
  writeFrame(buffer: FrameBuffer): Promise<Result<Sha256, AppError>>;
  finish(): Promise<Result<EncodeSummary, AppError>>;
  cancel(): Promise<void>;
}

export interface EncodeSummary {
  readonly framesWritten: number;
  /** Digest of the ordered frame hashes. The golden fixture for the whole loop. */
  readonly frameStreamHash: Sha256;
  readonly stderr: string;
}

export class FfmpegEncoder {
  readonly #process: ProcessPort;
  readonly #paths: FfmpegPaths;

  constructor(process: ProcessPort, paths: FfmpegPaths = DEFAULT_FFMPEG_PATHS) {
    this.#process = process;
    this.#paths = paths;
  }

  /**
   * Fails fast when the binary is not there.
   *
   * Called before the first frame is drawn. Discovering a missing encoder after a
   * twenty-minute render is the failure RV-163 names, and it is entirely avoidable.
   */
  async probeAvailable(): Promise<Result<string, AppError>> {
    const result = await this.#process.run({
      command: this.#paths.ffmpeg,
      args: ['-hide_banner', '-version'],
      timeoutMs: 10_000,
    });
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return err(this.#failure('ffmpeg -version failed', result.value));
    }
    const firstLine = result.value.stdout.split('\n')[0] ?? '';
    return ok(firstLine.trim());
  }

  /** Opens an encode and returns the sink the frame loop writes into. */
  open(options: EncodeStreamOptions): Result<FrameSink, AppError> {
    const args = buildEncodeArgs({
      input: { kind: 'raw-rgba', size: options.size, fps: options.settings.fps },
      settings: options.settings,
      outputPath: options.outputPath,
      ...(options.videoFilter === undefined ? {} : { videoFilter: options.videoFilter }),
    });

    const spawned = this.#process.spawnPiped({ command: this.#paths.ffmpeg, args });
    if (!spawned.ok) return spawned;
    return ok(
      new PipedFrameSink(spawned.value, options, (message, result) =>
        this.#failure(message, result),
      ),
    );
  }

  /**
   * A one-shot transcode: file in, file out, no frames through this process.
   *
   * This is the delivery path. The master is already on disk, and re-piping it through
   * Node would move gigabytes for nothing when FFmpeg can read it directly.
   */
  async transcode(options: {
    readonly inputPath: string;
    readonly settings: EncodeSettings;
    readonly outputPath: string;
    readonly videoFilter?: string;
    readonly complexFilter?: { readonly graph: string; readonly map: string };
  }): Promise<Result<string, AppError>> {
    const args = buildEncodeArgs({
      input: { kind: 'file', path: options.inputPath },
      settings: options.settings,
      outputPath: options.outputPath,
      ...(options.videoFilter === undefined ? {} : { videoFilter: options.videoFilter }),
      ...(options.complexFilter === undefined ? {} : { complexFilter: options.complexFilter }),
    });
    const result = await this.#process.run({ command: this.#paths.ffmpeg, args });
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return err(this.#failure(`transcode to ${options.outputPath} failed`, result.value));
    }
    return ok(result.value.stderr);
  }

  /** Stitches encoded shards with `-c copy`. See {@link buildConcatArgs}. */
  async concat(listPath: string, outputPath: string): Promise<Result<string, AppError>> {
    const result = await this.#process.run({
      command: this.#paths.ffmpeg,
      args: buildConcatArgs(listPath, outputPath),
    });
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return err(this.#failure(`concatenating shards into ${outputPath} failed`, result.value));
    }
    return ok(result.value.stderr);
  }

  /**
   * FFmpeg's exit code plus what it actually said.
   *
   * The last lines rather than all of them: FFmpeg repeats a per-frame complaint once
   * per frame, and the useful sentence is always the last one.
   */
  #failure(message: string, result: ProcessResult): AppError {
    const tail = result.stderr.trim().split('\n').slice(-8).join('\n');
    return new ProviderError({
      message: tail === '' ? message : `${message}: ${tail}`,
      provider: 'ffmpeg',
      retryable: false,
      context: { exitCode: result.exitCode, stderr: tail },
    });
  }
}

class PipedFrameSink implements FrameSink {
  readonly #process: PipedProcess;
  readonly #options: EncodeStreamOptions;
  readonly #failure: (message: string, result: ProcessResult) => AppError;
  readonly #hashes: Sha256[] = [];
  #closed = false;

  constructor(
    process: PipedProcess,
    options: EncodeStreamOptions,
    failure: (message: string, result: ProcessResult) => AppError,
  ) {
    this.#process = process;
    this.#options = options;
    this.#failure = failure;
  }

  async writeFrame(buffer: FrameBuffer): Promise<Result<Sha256, AppError>> {
    const expected = this.#options.size;
    if (buffer.width !== expected.width || buffer.height !== expected.height) {
      // rawvideo has no per-frame header, so a wrong-sized frame does not fail - it
      // shifts every subsequent frame by the difference and the video tears diagonally
      // from that point on. Refusing it here is the only place it can be caught.
      return err(
        new ProviderError({
          message: `frame is ${String(buffer.width)}x${String(buffer.height)}, encoder expects ${String(expected.width)}x${String(expected.height)}`,
          provider: 'ffmpeg',
          retryable: false,
        }),
      );
    }

    const written = await this.#process.write(buffer.data);
    if (!written.ok) return written;
    const hash = hashFrame(buffer);
    this.#hashes.push(hash);
    return ok(hash);
  }

  async finish(): Promise<Result<EncodeSummary, AppError>> {
    this.#closed = true;
    const result = await this.#process.end();
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      return err(this.#failure(`encoding ${this.#options.outputPath} failed`, result.value));
    }
    return ok({
      framesWritten: this.#hashes.length,
      frameStreamHash: hashFrameSequence(this.#hashes),
      stderr: result.value.stderr,
    });
  }

  async cancel(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#process.abort();
  }
}
