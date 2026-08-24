/**
 * The two stores a resumable render needs, both addressed by content rather than by job.
 *
 * {@link PinnedCheckpointStore} exists because `CheckpointStorePort` is keyed by job id
 * and a resumed render is a *different job*. Handing the engine the run's job id would
 * make it look for a checkpoint filed under an id no previous process ever used, find
 * nothing, and redraw every frame - which still produces the right master, and produces
 * it by doing the whole render again. Pinning the key to the render's content address
 * is what makes "frames 0-59 were not recomputed" true rather than merely likely.
 *
 * {@link VerifiedFileFrameStore} is the other half: a frame store that will not claim a
 * half-written frame is done.
 *
 * `FileFrameStore` writes a frame with a single `writeFile`, and `list()` reports every
 * file whose *name* matches. A process killed inside that write leaves a short file on
 * disk with a perfectly good name, and the resume path believes it: `RunRenderJobUseCase`
 * intersects the checkpoint with `list()`, decides the frame is complete, and then the
 * encode fails on `decodeFrameFile`'s length check - after every other frame has been
 * drawn. The resume that was supposed to cost one frame costs the whole render and ends
 * in an error instead.
 *
 * The kill is not hypothetical: it is the exact scenario `resume.e2e-spec.ts` produces
 * on purpose, and a frame file is `12 + width * height * 4` bytes, which at 1080p is
 * eight megabytes and several milliseconds of write. So this decorator filters `list()`
 * by *size*, which is a `stat` per file rather than a read, and a frame of the wrong
 * length is simply not listed - the resume redraws that one frame and nothing else.
 *
 * A decorator rather than a fix in `@rv/render-engine` because the engine is frozen for
 * this workstream. The upstream fix is one line - write to a temporary name and rename,
 * which the comment in `FileFrameStore.put` already claims it does - and this file
 * disappears the day it lands.
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Size } from '@rv/contracts';
import {
  FileFrameStore,
  frameFileName,
  parseRecord,
  type CheckpointRecord,
  type CheckpointStorePort,
  type FrameBuffer,
  type FrameStorePort,
} from '@rv/render-engine';
import {
  UNIT,
  ValidationError,
  err,
  ok,
  type AppError,
  type Logger,
  type Result,
  type Unit,
} from '@rv/shared-kernel';

/**
 * A checkpoint store whose key is the render, not the job that happens to be running it,
 * and whose write is atomic.
 *
 * Two departures from `FileCheckpointStore`, both found by the kill test rather than
 * reasoned about in advance.
 *
 * **The key.** The job id is still written *into* the record by the engine, so an audit
 * can see which job last touched it; only the address is pinned.
 *
 * **Temp file, then rename.** `FileCheckpointStore.save` is a single `writeFile` over
 * the live file, and it is called once per frame. A `SIGKILL` inside one of those writes
 * leaves truncated JSON, `parseRecord` refuses it - correctly - and the resumed render
 * fails outright instead of redrawing one frame. That is the worst possible outcome for
 * the one file whose entire job is to survive a crash. A rename within a directory is
 * atomic on both filesystems this runs on, so the checkpoint on disk is always either
 * the previous whole record or the next one.
 *
 * An unreadable checkpoint is therefore no longer expected - but it is still *possible*,
 * from a build before this one, so it is degraded to "no checkpoint" rather than to an
 * error. The render redraws every frame, which is slow and correct; failing would be
 * fast and useless.
 */
export class PinnedCheckpointStore implements CheckpointStorePort {
  readonly #directory: string;
  readonly #path: string;
  readonly #logger: Logger | undefined;

  constructor(directory: string, key: string, logger?: Logger) {
    this.#directory = directory;
    // The same filename `FileCheckpointStore` derives, so a checkpoint written by either
    // is readable by the other. The key is a hex content hash and already safe; the
    // replacement guards a caller that passes something else.
    this.#path = join(directory, `${key.replaceAll(/[^\w.-]/g, '_')}.checkpoint.json`);
    this.#logger = logger;
  }

  async load(_jobId: string): Promise<Result<CheckpointRecord | null, AppError>> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch {
      // Absent means "this render has not started", not a failure.
      return ok(null);
    }

    try {
      return ok(parseRecord(JSON.parse(raw), this.#path));
    } catch (caught: unknown) {
      this.#logger?.warn('checkpoint unreadable; the render will start from frame 0', {
        path: this.#path,
        cause: String(caught),
      });
      return ok(null);
    }
  }

  async save(_jobId: string, record: CheckpointRecord): Promise<Result<Unit, AppError>> {
    const staging = `${this.#path}.tmp`;
    try {
      await mkdir(this.#directory, { recursive: true });
      await writeFile(staging, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await rename(staging, this.#path);
      return ok(UNIT);
    } catch (caught: unknown) {
      return err(
        new ValidationError({
          message: `Could not write the render checkpoint at ${this.#path}`,
          cause: caught,
          context: { path: this.#path },
        }),
      );
    }
  }
}

/** `RVF1` plus width and height, little-endian: the header `encodeFrameFile` writes. */
const FRAME_HEADER_BYTES = 12;

export function expectedFrameBytes(size: Size): number {
  return FRAME_HEADER_BYTES + size.width * size.height * 4;
}

export class VerifiedFileFrameStore implements FrameStorePort {
  readonly #inner: FileFrameStore;
  readonly #directory: string;
  readonly #expectedBytes: number;

  constructor(directory: string, size: Size) {
    this.#inner = new FileFrameStore(directory);
    this.#directory = directory;
    this.#expectedBytes = expectedFrameBytes(size);
  }

  put(frame: number, buffer: FrameBuffer): Promise<Result<Unit, AppError>> {
    return this.#inner.put(frame, buffer);
  }

  get(frame: number): Promise<Result<FrameBuffer, AppError>> {
    return this.#inner.get(frame);
  }

  has(frame: number): Promise<boolean> {
    return this.#inner.has(frame);
  }

  /** Only frames whose file is exactly as long as a whole frame. */
  async list(): Promise<readonly number[]> {
    const named = await this.#inner.list();
    const whole: number[] = [];
    for (const frame of named) {
      if (await this.#isWhole(frame)) whole.push(frame);
    }
    return whole;
  }

  clear(): Promise<Result<Unit, AppError>> {
    return this.#inner.clear();
  }

  async #isWhole(frame: number): Promise<boolean> {
    try {
      const stats = await stat(join(this.#directory, frameFileName(frame)));
      return stats.size === this.#expectedBytes;
    } catch {
      // Vanished between `list` and `stat`. Not present is not complete.
      return false;
    }
  }
}
