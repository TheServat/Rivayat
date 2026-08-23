/**
 * The binary side of the store, as the application layer needs it.
 *
 * Deliberately five methods. Verification and garbage collection are operator jobs
 * that belong to the concrete store, not to any use-case, and adding them here would
 * put an `unlink` within reach of code that must never have one (ADR-0006: deleting a
 * row never deletes a file).
 *
 * The content hash *is* the address, which is what makes an S3/MinIO adapter a second
 * implementation of this interface rather than a second call site.
 */

import type { Result } from '@rv/shared-kernel';
import type { Sha256Hex } from '@rv/contracts';

export interface BlobPutResult {
  readonly hash: Sha256Hex;
  readonly byteSize: number;
  /**
   * `false` when the bytes were already present and nothing was written.
   *
   * The caller uses it to distinguish "we stored a new artefact" from "we proved we
   * already had it", which is the difference between a cost and a saving.
   */
  readonly created: boolean;
}

export interface BlobStore {
  /** Idempotent: identical bytes yield the same hash and touch the disk at most once. */
  put(bytes: Uint8Array): Promise<Result<BlobPutResult>>;
  get(hash: Sha256Hex): Promise<Result<Uint8Array>>;
  has(hash: Sha256Hex): Promise<Result<boolean>>;
  /** Where the bytes live. Pure - it does not check that anything is there. */
  path(hash: Sha256Hex): string;
  /**
   * Exposes a blob under a human-readable name.
   *
   * FFmpeg, `sharp` and Playwright all want a filename with an extension; the store
   * wants an immutable content address. This is the seam between the two.
   */
  link(hash: Sha256Hex, name: string): Promise<Result<string>>;
}
