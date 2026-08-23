/**
 * Subprocesses, as the render engine is allowed to see them.
 *
 * FFmpeg is **spawned with an argv array**, never handed a command string. A string
 * command means a shell, and a shell means every path the pipeline touches - a project
 * name with a space, a Persian episode title, an apostrophe - becomes a quoting bug or
 * an injection. The port therefore cannot express "run this line"; it can only express
 * "run this binary with these arguments".
 *
 * Two entry points because the encoder needs both: `run` for the short probes
 * (`ffprobe`, `ffmpeg -version`) whose output fits in memory, and `spawnPiped` for the
 * encode itself, where frames are written to stdin as they are produced and the whole
 * point is that they are never all in memory at once.
 */

import type { AppError, Result, Unit } from '@rv/shared-kernel';

export interface ProcessSpec {
  /** Absolute path or a name on PATH. Never a shell line. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Kills the process and fails the call once elapsed. */
  readonly timeoutMs?: number;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  /** Kept in full: FFmpeg says everything useful here, including on success. */
  readonly stderr: string;
}

/**
 * A running process whose stdin we own.
 *
 * `write` resolves when the chunk has been accepted, so a slow encoder applies
 * back-pressure to the frame loop instead of letting an unbounded queue of 1080p RGBA
 * frames (8.3 MB each) accumulate in the heap.
 */
export interface PipedProcess {
  write(chunk: Uint8Array): Promise<Result<Unit, AppError>>;
  /** Closes stdin and waits for exit. The only place an exit code is observed. */
  end(): Promise<Result<ProcessResult, AppError>>;
  /** Terminates without waiting for the remaining input. Used for cancellation. */
  abort(): Promise<void>;
}

export interface ProcessPort {
  run(spec: ProcessSpec): Promise<Result<ProcessResult, AppError>>;
  spawnPiped(spec: ProcessSpec): Result<PipedProcess, AppError>;
}
