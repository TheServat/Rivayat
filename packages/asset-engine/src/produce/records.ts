/**
 * What each produce step wrote down, so a resumed run can pick it up.
 *
 * A `StageCheckpoint` says *that* a step finished and points at `ArtifactRef`s; it
 * deliberately does not carry the artefacts, because a checkpoint that embeds them
 * stops loading the day one of their schemas gains a field. So each step also writes a
 * small JSON document into the content store and references it by hash. The document
 * is the step's resume format.
 *
 * These schemas are **not contracts**, and they live here rather than in
 * `@rv/contracts` on purpose: `PipelineJob.payload` is documented as "validated by the
 * stage that owns it, not here", and this is that validation. They are still parsed
 * rather than cast, because the alternative - trusting a blob written by an older
 * build - is how a resumed run produces a subtly different asset and reports success.
 *
 * The records carry hashes, never pixels. Bytes live in the blob store exactly once;
 * duplicating them here would make a resume read the same megabytes twice and would
 * break the property that makes the store worth having.
 */

import { z } from 'zod';
import { type AppError, type Result, isErr, ok, stableStringify } from '@rv/shared-kernel';
import {
  AnimationClip,
  type ArtifactRef,
  AssetId,
  AssetVersionId,
  Part,
  QualityScores,
  Rig,
  Sha256Hex,
  SheetId,
  Size,
  ClipId,
} from '@rv/contracts';
import type { BlobStore } from '@rv/asset-registry';

import type { ProduceStep } from './checkpoints';

/** `ArtifactRef.kind` for the resume document of a step. One slug per step. */
export const STEP_RECORD_KIND: Readonly<Record<ProduceStep, string>> = {
  generate: 'produce-generate',
  matte: 'produce-matte',
  split: 'produce-split',
  score: 'produce-score',
  rig: 'produce-rig',
  clips: 'produce-clips',
  bake: 'produce-bake',
  register: 'produce-register',
};

// ── the per-step documents ──────────────────────────────────────────────────

export const GenerateRecord = z.object({
  imageHash: Sha256Hex,
  mimeType: z.string(),
  lane: z.enum(['local-parts-sheet', 'cloud-multi-reference']),
  decomposition: z.enum(['parts-sheet', 'segmented', 'single-layer']),
  seed: z.number().int(),
  promptHash: Sha256Hex,
  /** Anchors that could not be loaded. Non-empty means the take is degraded (RV-121). */
  degraded: z.array(z.string()),
  costNanoUsd: z.number().int().nonnegative(),
});
export type GenerateRecord = z.infer<typeof GenerateRecord>;

export const MatteRecord = z.object({
  imageHash: Sha256Hex,
  engine: z.string(),
  fallbacks: z.array(z.object({ engine: z.string(), reason: z.string() })),
  coverage: z.number(),
  cleanliness: z.number(),
  cornersTransparent: z.boolean(),
});
export type MatteRecord = z.infer<typeof MatteRecord>;

export const SplitRecord = z.object({
  parts: z.array(Part).min(1),
  decomposition: z.enum(['parts-sheet', 'segmented', 'single-layer']),
  plannedParts: z.number().int().nonnegative(),
  foundParts: z.number().int().nonnegative(),
  unmatchedComponents: z.number().int().nonnegative(),
  discardedComponents: z.number().int().nonnegative(),
  unfilled: z.array(z.string()),
  complete: z.boolean(),
});
export type SplitRecord = z.infer<typeof SplitRecord>;

export const ScoreRecord = z.object({
  verdict: z.enum(['accepted', 'needs-review']),
  scores: QualityScores,
  failures: z.array(z.object({ key: z.string(), score: z.number(), floor: z.number() })),
  repairClause: z.string().optional(),
  repairsRemaining: z.number().int().nonnegative(),
});
export type ScoreRecord = z.infer<typeof ScoreRecord>;

export const RigRecord = z.object({ rig: Rig });
export type RigRecord = z.infer<typeof RigRecord>;

export const ClipsRecord = z.object({ clips: z.array(AnimationClip) });
export type ClipsRecord = z.infer<typeof ClipsRecord>;

/**
 * A baked page, minus the atlas JSON text.
 *
 * The text is in the store under `atlasJsonHash`; carrying it here as well would put
 * the same document in the blob store twice under two different hashes, which is the
 * one thing a content-addressed store must never contain.
 */
export const SheetRecord = z.object({
  id: SheetId,
  clipId: ClipId,
  clipName: z.string(),
  atlasImageHash: Sha256Hex,
  atlasJsonHash: Sha256Hex,
  frameCount: z.number().int().min(1),
  fps: z.number().int().min(1),
  atlasSize: Size,
});
export type SheetRecord = z.infer<typeof SheetRecord>;

export const BakeRecord = z.object({ sheets: z.array(SheetRecord) });
export type BakeRecord = z.infer<typeof BakeRecord>;

export const RegisterRecord = z.object({
  assetId: AssetId,
  versionId: AssetVersionId,
  createdAsset: z.boolean(),
});
export type RegisterRecord = z.infer<typeof RegisterRecord>;

// ── writing and reading them ────────────────────────────────────────────────

/**
 * Serialises a record, stores it, and returns the reference to it.
 *
 * `stableStringify` rather than `JSON.stringify`: two runs that produced the same
 * outcome must write the same bytes, or the same asset lands in the store twice under
 * two hashes and "rebuild it and get the same thing" stops being checkable.
 */
export async function writeRecord(
  blobs: BlobStore,
  step: ProduceStep,
  record: unknown,
): Promise<Result<ArtifactRef, AppError>> {
  const bytes = new TextEncoder().encode(stableStringify(record));
  const stored = await blobs.put(bytes);
  if (isErr(stored)) return stored;
  return ok({
    kind: STEP_RECORD_KIND[step],
    ref: stored.value.hash,
    contentHash: stored.value.hash,
  });
}

/**
 * Reads a step's record back, or explains why the resume cannot be trusted.
 *
 * A missing blob and an unparseable one both return `null` rather than an error: both
 * mean "this step has to run again", which is a recoverable situation and the whole
 * point of keeping `inputHash` alongside. Only a caller bug - asking for a step whose
 * checkpoint has no record reference - is worth failing on.
 */
export async function readRecord<T>(
  blobs: BlobStore,
  step: ProduceStep,
  outputs: readonly ArtifactRef[],
  schema: z.ZodType<T>,
): Promise<T | null> {
  const reference = outputs.find((candidate) => candidate.kind === STEP_RECORD_KIND[step]);
  if (reference?.contentHash == null) return null;
  const bytes = await blobs.get(reference.contentHash);
  if (isErr(bytes)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes.value));
  } catch {
    return null;
  }
  const parsed = schema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}
