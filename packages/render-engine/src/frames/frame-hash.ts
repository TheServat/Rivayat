/**
 * Frame identity, as a digest of pixels.
 *
 * The golden-file fixture for the whole render path (architecture §9) is a frame hash,
 * not a file size and not an image on disk. A file size says nothing - two completely
 * different 1080p RGBA frames are both 8,294,400 bytes - and an image on disk turns
 * every intentional change into a binary review.
 *
 * The digest covers the dimensions as well as the bytes, so a 100x50 frame and a 50x100
 * frame with the same pixel run cannot collide.
 */

import { sha256, type Sha256 } from '@rv/shared-kernel';

import type { FrameBuffer } from '../ports/frame-renderer';

export function hashFrame(frame: FrameBuffer): Sha256 {
  const header = new TextEncoder().encode(`rgba:${String(frame.width)}x${String(frame.height)}:`);
  const payload = new Uint8Array(header.length + frame.data.length);
  payload.set(header, 0);
  payload.set(frame.data, header.length);
  return sha256(payload);
}

/**
 * One digest over an ordered run of frames.
 *
 * This is what a sharding or resume test actually compares: whether two different ways
 * of producing frames 0..N produced the same *sequence*. Chained rather than
 * concatenated so the memory cost is one hash regardless of the run length.
 */
export function hashFrameSequence(hashes: readonly Sha256[]): Sha256 {
  return sha256(hashes.join('\n'));
}
