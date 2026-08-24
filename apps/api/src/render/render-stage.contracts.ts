/**
 * What S10 Render needs on the job payload, and the identity of the render it names.
 *
 * The `AnimationIR` travels whole rather than by reference, for the reason
 * `render.contracts.ts` already gives: a render is the one operation that has to be
 * reproducible from its input alone (ADR-0001), and a payload that named an IR by id
 * would render whatever that id points at *now*.
 *
 * {@link renderKey} is the load-bearing part of this file. It is the identity of the
 * *content* being rendered, not of the run rendering it, and everything on disk -
 * frames, checkpoint, master - is filed under it. Three consequences, and each is a
 * requirement rather than a nicety:
 *
 *  - **Resume survives the process.** A killed run's frames are found by a new process
 *    because the address does not mention the run, the job or the worker.
 *  - **Resume survives the run.** A cancelled run cannot legally be resumed
 *    (`PIPELINE_STATUS_TRANSITIONS`), so continuing is a *new* run - which finds the
 *    same frames and picks up where the cancelled one stopped.
 *  - **The same composition is never drawn twice.** Two runs over the same IR, size and
 *    encode settings share one frame store, which is CLAUDE.md #2 applied to frames.
 *
 * The encode settings are folded into the key even though they do not change a single
 * frame. They change the *master*, and the master lives in the same directory; keying
 * frames and master differently would mean two keys to reason about and a directory
 * whose contents did not all describe the same thing.
 */

import { AnimationIR, FrameRange, RenderBackend, Sha256Hex, Size, VideoCodec } from '@rv/contracts';
import { contentHash } from '@rv/shared-kernel';
import { z } from 'zod';

/**
 * What S10 was asked to render, before the composition has been resolved.
 *
 * A run may name the composition by content hash instead of carrying it: the studio has
 * no `AnimationIR` of its own and a 100 KB body per poll is not a wire format. The hash
 * is safe where an id would not be - it cannot come to mean something else - so
 * ADR-0001's "reproducible from its input alone" survives the indirection.
 */
export const RenderStageRequest = z
  .strictObject({
    ir: AnimationIR.optional(),
    compositionId: Sha256Hex.optional().describe(
      'A composition stored through `POST /api/compositions`. Resolved before anything is drawn.',
    ),
    size: Size.nullable().default(null),
    backend: RenderBackend.default('auto'),
    frames: FrameRange.nullable().default(null),
    codec: VideoCodec.default('h264'),
    keepFrames: z.boolean().default(false),
  })
  .superRefine((request, ctx) => {
    // Exactly one. Both would let the two disagree about what is being rendered, and
    // the resolution order would silently decide which one shipped.
    const named =
      (request.ir === undefined ? 0 : 1) + (request.compositionId === undefined ? 0 : 1);
    if (named !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['compositionId'],
        message: 'a render names its composition either inline as `ir` or by `compositionId`',
      });
    }
  });
export type RenderStageRequest = z.infer<typeof RenderStageRequest>;

export const RenderStagePayload = z.strictObject({
  ir: AnimationIR,
  /**
   * Output pixel size. Defaults to the IR's own scene space.
   *
   * Separate from `sceneSpace` because the composition is authored format-agnostically
   * (architecture section 7) and the same IR is rendered at several sizes.
   */
  size: Size.nullable().default(null),
  backend: RenderBackend.default('auto'),
  /** `null` renders the whole timeline. A range is how a shard names its slice. */
  frames: FrameRange.nullable().default(null),
  /**
   * Master codec. H.264 by default rather than ProRes, because the default has to be
   * the one that finishes on a laptop; a ProRes master is an explicit request.
   */
  codec: VideoCodec.default('h264'),
  /**
   * Keep the frame files after a successful encode.
   *
   * Off by default: a 1080p minute is 1,800 files and roughly 15 GB. Worth turning on
   * for a composition that is about to be re-encoded to seven formats.
   */
  keepFrames: z.boolean().default(false),
});
export type RenderStagePayload = z.infer<typeof RenderStagePayload>;

/** The output pixel size this payload asks for. */
export function renderSize(payload: RenderStagePayload): Size {
  return payload.size ?? payload.ir.sceneSpace;
}

/**
 * The content address of a render: everything that changes the bytes, and nothing else.
 *
 * Note what is *absent*: the run id, the job id, the attempt, the wall clock. Any of
 * them would make a resumed render a different render, which is the whole failure this
 * function exists to prevent.
 */
export function renderKey(payload: RenderStagePayload): string {
  return contentHash({
    ir: payload.ir,
    size: renderSize(payload),
    backend: payload.backend,
    frames: payload.frames,
    codec: payload.codec,
  });
}
