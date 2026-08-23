/**
 * Two frame stores: one in memory, one on disk.
 *
 * Both exist for real reasons rather than "one for tests". The in-memory store is what
 * a single-process render of a short clip should use - writing 300 frames to disk to
 * read them back immediately is pure IO for nothing - and the disk store is what makes
 * a render survive the process dying, which is the entire point of checkpointing.
 *
 * The on-disk format is raw RGBA with a tiny header, not PNG. A PNG per frame costs a
 * compress on write and a decompress on read for data that is about to be handed to an
 * encoder that will throw the compression away, and it makes a resumed render's frames
 * depend on the PNG encoder's version.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ValidationError,
  err,
  fromPromise,
  ok,
  toAppError,
  type AppError,
  type Result,
  type Unit,
} from '@rv/shared-kernel';

import type { FrameBuffer } from '../ports/frame-renderer';
import type { FrameStorePort } from '../ports/storage';

/** `RVF1` plus width and height, little-endian. 12 bytes. */
const MAGIC = 0x52564631;
const HEADER_BYTES = 12;

export function encodeFrameFile(buffer: FrameBuffer): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + buffer.data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, buffer.width, true);
  view.setUint32(8, buffer.height, true);
  out.set(buffer.data, HEADER_BYTES);
  return out;
}

export function decodeFrameFile(bytes: Uint8Array): Result<FrameBuffer, AppError> {
  if (bytes.length < HEADER_BYTES) {
    return err(new ValidationError({ message: 'frame file is shorter than its header' }));
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) {
    return err(new ValidationError({ message: 'frame file has the wrong magic number' }));
  }
  const width = view.getUint32(4, true);
  const height = view.getUint32(8, true);
  const expected = width * height * 4;
  if (bytes.length - HEADER_BYTES !== expected) {
    // A truncated frame is exactly what a render killed mid-write leaves behind, and
    // encoding it would shift every subsequent frame. Refusing it makes the resume
    // re-render that one frame instead.
    return err(
      new ValidationError({
        message: `frame file holds ${String(bytes.length - HEADER_BYTES)} bytes, expected ${String(expected)}`,
        context: { width, height },
      }),
    );
  }
  return ok({ width, height, data: bytes.slice(HEADER_BYTES) });
}

export class InMemoryFrameStore implements FrameStorePort {
  readonly #frames = new Map<number, FrameBuffer>();

  put(frame: number, buffer: FrameBuffer): Promise<Result<Unit, AppError>> {
    this.#frames.set(frame, { ...buffer, data: Uint8Array.from(buffer.data) });
    return Promise.resolve(ok());
  }

  get(frame: number): Promise<Result<FrameBuffer, AppError>> {
    const buffer = this.#frames.get(frame);
    return Promise.resolve(
      buffer === undefined
        ? err(new ValidationError({ message: `frame ${String(frame)} is not in the store` }))
        : ok(buffer),
    );
  }

  has(frame: number): Promise<boolean> {
    return Promise.resolve(this.#frames.has(frame));
  }

  list(): Promise<readonly number[]> {
    return Promise.resolve([...this.#frames.keys()].sort((left, right) => left - right));
  }

  clear(): Promise<Result<Unit, AppError>> {
    this.#frames.clear();
    return Promise.resolve(ok());
  }
}

/** Zero-padded so a directory listing sorts correctly for a human and for `readdir`. */
const NAME_PATTERN = /^f(\d{8})\.rvf$/;

export function frameFileName(frame: number): string {
  return `f${String(frame).padStart(8, '0')}.rvf`;
}

export class FileFrameStore implements FrameStorePort {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async put(frame: number, buffer: FrameBuffer): Promise<Result<Unit, AppError>> {
    const prepared = await fromPromise(mkdir(this.#directory, { recursive: true }), (caught) =>
      toAppError(caught, 'could not create the frame directory'),
    );
    if (!prepared.ok) return prepared;

    // Written to a temporary name and renamed, because a render killed mid-write must
    // leave either a whole frame or no frame - never half of one that the resume then
    // trusts.
    const path = join(this.#directory, frameFileName(frame));
    const written = await fromPromise(writeFile(path, encodeFrameFile(buffer)), (caught) =>
      toAppError(caught, `could not write frame ${String(frame)}`),
    );
    return written.ok ? ok() : written;
  }

  async get(frame: number): Promise<Result<FrameBuffer, AppError>> {
    const bytes = await fromPromise(
      readFile(join(this.#directory, frameFileName(frame))),
      (caught) => toAppError(caught, `could not read frame ${String(frame)}`),
    );
    if (!bytes.ok) return bytes;
    return decodeFrameFile(Uint8Array.from(bytes.value));
  }

  async has(frame: number): Promise<boolean> {
    const bytes = await fromPromise(
      readFile(join(this.#directory, frameFileName(frame))),
      (caught) => caught,
    );
    return bytes.ok;
  }

  async list(): Promise<readonly number[]> {
    const entries = await fromPromise(readdir(this.#directory), (caught) => caught);
    if (!entries.ok) return [];
    return entries.value
      .map((name) => NAME_PATTERN.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .sort((left, right) => left - right);
  }

  async clear(): Promise<Result<Unit, AppError>> {
    const removed = await fromPromise(
      rm(this.#directory, { recursive: true, force: true }),
      (caught) => toAppError(caught, 'could not clear the frame directory'),
    );
    return removed.ok ? ok() : removed;
  }
}
