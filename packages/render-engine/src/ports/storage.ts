/**
 * Where frames and finished files live between the loop and the encoder.
 *
 * {@link FrameStorePort} is what makes resume *byte-identical* rather than merely
 * "close enough". A render killed at frame 30 has already produced 30 frames; if the
 * resumed run re-drew them it would only be reproducible because the evaluator is
 * pure, and any future non-determinism would surface as a corrupt splice. Keeping the
 * pixels means the resumed encode consumes the *same bytes* the uninterrupted one
 * would have, and the hash equality in the test is a real assertion rather than a
 * restatement of `evaluate`'s purity.
 *
 * It is also the sharding mechanism seen from the other side: four workers writing
 * disjoint frame ranges into one store, and one encoder reading 0..N out of it in
 * order, needs no coordination beyond the ranges themselves.
 */

import type { AppError, Result, Unit } from '@rv/shared-kernel';

import type { FrameBuffer } from './frame-renderer';

export interface FrameStorePort {
  /** Overwrites silently: re-rendering a frame must be idempotent, not a conflict. */
  put(frame: number, buffer: FrameBuffer): Promise<Result<Unit, AppError>>;
  get(frame: number): Promise<Result<FrameBuffer, AppError>>;
  has(frame: number): Promise<boolean>;
  /** Frame indices currently held, ascending. Used to rebuild a lost checkpoint. */
  list(): Promise<readonly number[]>;
  /** Drops everything. Called only when a render is explicitly restarted from zero. */
  clear(): Promise<Result<Unit, AppError>>;
}

/**
 * The bytes of finished artefacts.
 *
 * Narrow on purpose - the render engine writes files and reads their size and digest,
 * and it has no business listing directories or deleting things.
 */
export interface ArtifactStorePort {
  write(path: string, bytes: Uint8Array): Promise<Result<Unit, AppError>>;
  read(path: string): Promise<Result<Uint8Array, AppError>>;
  exists(path: string): Promise<boolean>;
  /**
   * Absolute location for a workspace-relative path.
   *
   * FFmpeg is a subprocess with its own working directory, so it needs a real path
   * even though `RenderArtifact.path` is deliberately workspace-relative.
   */
  resolve(path: string): string;
  /**
   * The same, after making the path writable by something that is not this process.
   *
   * `resolve` alone is not enough for a subprocess output: FFmpeg does not create
   * directories, so handing it a path under a directory that does not exist yet fails
   * with "No such file or directory" *after* the whole filter graph has been built.
   * Distinct from `resolve` because it has a side effect and can fail, and a pure
   * function that sometimes writes to the filesystem is a trap.
   */
  prepareWrite(path: string): Promise<Result<string, AppError>>;
}

/** Durable resume points, keyed by job. */
export interface CheckpointStorePort {
  load(jobId: string): Promise<Result<CheckpointRecord | null, AppError>>;
  save(jobId: string, record: CheckpointRecord): Promise<Result<Unit, AppError>>;
}

/**
 * The stored resume point.
 *
 * Deliberately *not* `RenderCheckpoint` from `@rv/contracts`: that shape carries an
 * `IsoInstant` and a `Sha256Hex`, both of which a store has to be handed rather than
 * invent, and `irHash` has no home on it at all. The mapping lives in one place
 * (`job/checkpoint.ts`) so the contract stays the wire shape and this stays the
 * storage shape.
 */
export interface CheckpointRecord {
  readonly jobId: string;
  /** Completed frame ranges, half-open, normalised and merged. */
  readonly completedRanges: readonly { readonly from: number; readonly to: number }[];
  /** Digest of the IR the frames were drawn from. A change here invalidates resume. */
  readonly irHash: string;
  /** Digest of the last frame written, for the honesty check on resume. */
  readonly lastFrameHash: string | null;
  readonly updatedAtIso: string;
}
