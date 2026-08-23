/**
 * Indexed reads from a pixel buffer, with the bounds check in one place.
 *
 * `noUncheckedIndexedAccess` types `buffer[i]` as `number | undefined`, which is
 * exactly right at the edges of the system and wrong in the middle of a raster loop:
 * every index in this package's inner loops is derived from the buffer's own
 * dimensions and has already been bounded by the loop that produced it. Writing `?? 0`
 * at each of them would add a hundred conditions that can never be false - slower, and
 * more to the point a hundred branches no test can cover, after which the coverage
 * number stops meaning anything.
 *
 * So the check lives here, once, and it **throws**. That is the right shape by
 * `@rv/shared-kernel/guard`'s rule: an out-of-range pixel index is not a failure the
 * caller can handle, it is a bug in the arithmetic, and the fix is a code change rather
 * than a retry. Silently returning 0 would instead paint a black pixel and leave the
 * off-by-one to be found in a rendered frame.
 */

import { InternalError } from '@rv/shared-kernel';

/** One byte of a pixel plane. Throws when the index is outside the buffer. */
export function px(buffer: Uint8Array, index: number): number {
  const value = buffer[index];
  if (value === undefined) {
    throw new InternalError({
      message: 'pixel index out of range',
      context: { index, length: buffer.length },
    });
  }
  return value;
}

/** One element of a numeric work array sized from the same dimensions. */
export function at32(buffer: Int32Array | Uint32Array | Float64Array, index: number): number {
  const value = buffer[index];
  if (value === undefined) {
    throw new InternalError({
      message: 'work-buffer index out of range',
      context: { index, length: buffer.length },
    });
  }
  return value;
}
