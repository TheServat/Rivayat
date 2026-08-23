/**
 * Every clip an archetype ships with, built once and stored by content hash.
 *
 * The archetype's template names the clip set, so a newly generated asset is animatable
 * within seconds and without an LLM call (architecture §6). `StyleBible.motion`
 * parameterises every one of them, which is the half of the style bible that is
 * usually decorative and here is not: two bibles produce two different `irHash`es for
 * the same clip name, and `derive-clips.spec.ts` asserts it.
 *
 * Storage is content-addressed on purpose. The bytes written are `stableStringify(ir)`,
 * so the blob's sha256 *is* `contentHash(ir)` - which means two assets of the same
 * archetype under the same style share one `idle` on disk rather than each carrying a
 * copy, and it means a clip can be diffed by hash before it is fetched.
 */

import {
  type AppError,
  type Clock,
  type Result,
  contentHash,
  isErr,
  ok,
  stableStringify,
  toIso,
} from '@rv/shared-kernel';
import type {
  AnimationClip,
  AnimationIR,
  AssetSpec,
  ClipId,
  MotionSignature,
  Sha256Hex,
  StyleBible,
} from '@rv/contracts';
import type { BlobStore } from '@rv/asset-registry';

import { contentId } from '../content-ids';
import { templateFor } from '../rig/templates/index';
import { buildClipIr } from './build-clip-ir';

export interface DeriveClipsDeps {
  readonly blobs: BlobStore;
  readonly clock: Clock;
}

export interface DeriveClipsInput {
  readonly spec: AssetSpec;
  readonly style: StyleBible;
  /** Present for characters. Two signatures produce measurably different walks. */
  readonly signature?: MotionSignature;
  /** Restricts the set. Absent means the archetype's whole default clip list. */
  readonly only?: readonly string[];
}

export interface DerivedClip {
  readonly clip: AnimationClip;
  readonly ir: AnimationIR;
}

export interface DeriveClipsOutput {
  readonly clips: readonly DerivedClip[];
}

export class DeriveClipsUseCase {
  readonly #deps: DeriveClipsDeps;

  constructor(deps: DeriveClipsDeps) {
    this.#deps = deps;
  }

  async execute(input: DeriveClipsInput): Promise<Result<DeriveClipsOutput, AppError>> {
    const template = templateFor(input.spec.archetype);
    const wanted = input.only ?? template.clipNames;
    const names = template.clipNames.filter((name) => wanted.includes(name));

    const deformableRoles = input.spec.parts
      .filter((part) => part.deformable)
      .map((part) => part.role);
    const createdAt = toIso(this.#deps.clock.now());

    const clips: DerivedClip[] = [];
    for (const name of names) {
      const draft = buildClipIr({
        archetype: input.spec.archetype,
        clipName: name,
        motion: input.style.motion,
        styleSeed: input.style.seed,
        sceneSpace: input.spec.canvas,
        nominalHeight: input.spec.nominalHeight,
        exaggeration: input.style.visual.shape.exaggeration,
        deformableRoles,
        ...(input.signature === undefined ? {} : { signature: input.signature }),
      });

      const bytes = new TextEncoder().encode(stableStringify(draft.ir));
      const stored = await this.#deps.blobs.put(bytes);
      if (isErr(stored)) return stored;

      const irHash: Sha256Hex = contentHash(draft.ir);
      clips.push({
        ir: draft.ir,
        clip: {
          // Derived from the IR hash, so the same motion under the same style is the
          // same clip wherever it turns up - which is what makes the sharing visible
          // rather than merely true on disk.
          id: contentId<ClipId>('clp', `${input.spec.archetype}:${name}:${irHash}`),
          name,
          label: `${input.spec.label} - ${name}`,
          source: 'template',
          durationMs: draft.ir.durationMs,
          fps: draft.ir.fps,
          loop: draft.kind.loop,
          irHash,
          tags: [input.spec.archetype, draft.kind.family],
          provenance: {
            source: 'derived',
            parents: [input.style.checksum],
            createdAt,
            costNanoUsd: 0,
          },
        },
      });
    }

    return ok({ clips });
  }
}
