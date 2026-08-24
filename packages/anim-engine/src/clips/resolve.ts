/**
 * Which clip plays, and where it came from.
 *
 * The migration guarantee lives here (ADR-0008 §5, "existing per-asset clips must keep
 * resolving while the library fills"): **the asset's own clip always wins**. It was
 * authored on this exact skeleton, so it needs no rescaling and no compatibility
 * argument, and preferring it means moving a clip into the library can never change what
 * an already-produced asset plays. The dedup key does not move because nothing about the
 * stored clip is touched.
 *
 * Resolution stops at the *entry*. Retargeting needs the IR fragment, which lives in the
 * content store under `irHash` - and a store is infrastructure this package must not
 * reach for. So the caller loads the fragment and calls `retargetClip`, and this file
 * stays pure arithmetic over records it was handed.
 */

import { NotFoundError, type AppError, type Result, err, ok } from '@rv/shared-kernel';
import type { AnimationClip, ClipLibraryEntry, Rig, RigSignature } from '@rv/contracts';

import { type ClipCompatibility, checkClipCompatibility } from './compatibility';
import { rigSignature } from './signature';

export interface ClipRequest {
  readonly name: string;
  /** The skeleton the clip has to play on. */
  readonly rig: Rig;
  /** Clips stored on the asset version. Searched first, always. */
  readonly assetClips: readonly AnimationClip[];
  readonly library: readonly ClipLibraryEntry[];
}

/**
 * Where the clip came from, and everything retargeting will need.
 *
 * A discriminated union rather than a clip plus a nullable signature, because the two
 * cases have genuinely different obligations: an `asset` clip is played verbatim and a
 * `library` clip **must** be passed through `retargetClip` before it is evaluated. A
 * shape that made the second optional would make forgetting it silent.
 */
export type ClipResolution =
  | { readonly origin: 'asset'; readonly clip: AnimationClip }
  | {
      readonly origin: 'library';
      readonly entry: ClipLibraryEntry;
      readonly source: RigSignature;
      readonly target: RigSignature;
    };

/** Why a library clip with the right name was not usable, for the error context. */
export interface RejectedClip {
  readonly clipId: string;
  readonly reason: ClipCompatibility;
}

export function resolveClip(request: ClipRequest): Result<ClipResolution, AppError> {
  const own = request.assetClips.find((clip) => clip.name === request.name);
  if (own !== undefined) return ok({ origin: 'asset', clip: own });

  const target = rigSignature(request.rig);
  if (!target.ok) return target;

  const rejected: RejectedClip[] = [];
  for (const entry of request.library) {
    if (entry.name !== request.name) continue;
    const compatibility = checkClipCompatibility(entry, target.value);
    if (compatibility.compatible) {
      return ok({
        origin: 'library',
        entry,
        source: entry.sourceRig,
        target: target.value,
      });
    }
    rejected.push({ clipId: entry.id, reason: compatibility });
  }

  // The rejected list is the whole value of failing here rather than returning nothing:
  // "no walk cycle fits this rig" is a shrug, "three fit the name and each is missing
  // `foot-right`" is a rigging bug someone can go and fix.
  return err(
    new NotFoundError('clip', request.name, {
      context: { rigId: request.rig.id, archetype: request.rig.archetype, rejected },
    }),
  );
}
