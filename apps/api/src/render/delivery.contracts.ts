/**
 * What a run actually put on disk, measured rather than asserted.
 *
 * `RunSummary.stages[].artifacts` are `kind:ref` strings - `render-master:<sha>` - which
 * is the right shape for a stage result and useless to the screen that has to tell the
 * user whether the file is deliverable. Size, duration, codec, pixel format, frame rate
 * and a verdict against the platform spec are not derivable from an id; they come from
 * probing the file, and this is the shape they come back in.
 *
 * **Why not `DeliveryManifest` from `@rv/render-engine` directly.** That type is built
 * around `DeliveryEntry`, whose `format` is a `FormatProfileId` - it describes the seven
 * platform files S11 cuts, and a *master* is not one of them. Returning it as-is for a
 * build whose S11 is still a stub would mean either an empty manifest (true, useless) or
 * a master filed under a format it was never cut for (useful, false). So this carries
 * both: the master as its own entry with everything measured, and the deliveries as they
 * appear. Every field below is a value the engine produced - `MediaProbe` for the
 * measurements, `validateAgainstProfile` for `issues`.
 *
 * `inSpec` is `null`, not `true`, for a file no profile applies to. "This passed" and
 * "there is nothing to check it against" are different statements and the screen shows
 * them differently.
 */

import { FormatProfileId, IsoInstant, NonEmptyString, Sha256Hex, Size } from '@rv/contracts';
import { z } from 'zod';

export const DeliveredFileKind = z.enum(['master', 'delivery']);
export type DeliveredFileKind = z.infer<typeof DeliveredFileKind>;

/** One issue found against a platform profile. Mirrors `SpecIssue` in the engine. */
export const DeliverySpecIssue = z.strictObject({
  code: NonEmptyString.max(80),
  severity: z.enum(['error', 'warning']),
  message: NonEmptyString.max(400),
  expected: z.union([z.string(), z.number()]),
  actual: z.union([z.string(), z.number()]),
});
export type DeliverySpecIssue = z.infer<typeof DeliverySpecIssue>;

export const DeliveredFile = z.strictObject({
  kind: DeliveredFileKind,
  /** Workspace-relative. Never absolute - a workspace moves and a manifest outlives it. */
  path: NonEmptyString.max(400),
  /** `null` for a master, which belongs to no single platform. */
  format: FormatProfileId.nullable().default(null),
  sha256: Sha256Hex,
  bytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  size: Size,
  /** FFmpeg's own name - `h264`, `hevc`, `prores` - not our `VideoCodec`. */
  codecName: NonEmptyString.max(40),
  pixelFormat: NonEmptyString.max(40),
  /** Exact, so 30000/1001 does not become 29.97. */
  fps: z.number().positive(),
  bitrateBps: z.number().int().nonnegative().nullable().default(null),
  frameCount: z.number().int().nonnegative().nullable().default(null),
  hasAudio: z.boolean().default(false),
  issues: z.array(DeliverySpecIssue).default([]),
  /** `null` when no platform profile applies, which is the case for every master. */
  inSpec: z.boolean().nullable().default(null),
});
export type DeliveredFile = z.infer<typeof DeliveredFile>;

export const RunDelivery = z.strictObject({
  /** The content address the files are filed under, so two runs of one cut agree. */
  renderKey: NonEmptyString.max(200),
  composition: Size,
  files: z.array(DeliveredFile).default([]),
  /** True when any file failed its spec. A list that needs eyes says so. */
  needsAttention: z.boolean().default(false),
  createdAt: IsoInstant,
});
export type RunDelivery = z.infer<typeof RunDelivery>;

/** Where the manifest for one render lives, relative to that render's directory. */
export const DELIVERY_MANIFEST_FILE = 'delivery.json';
