/**
 * What was produced, and from what.
 *
 * RV-170 asks for "a `manifest.json` listing each file's profile, size, duration, codec
 * and sha256". The second half of that - *from what* - matters more than the first.
 * Every entry records the master it was cut from and the reframe plan that cut it, so
 * "why is the TikTok version framed like that" is answerable from the artefact rather
 * than from a re-run, and so re-delivering the same episode can be shown to have
 * produced the same bytes.
 *
 * Timestamps come from an injected `Clock`. Two deliveries of the same episode must
 * differ in nothing but their timestamps, and if the clock were read directly they
 * would differ in a way no test could pin.
 */

import { toIso, type Clock } from '@rv/shared-kernel';
import type { FormatProfileId, RenderArtifact, Size } from '@rv/contracts';

import type { MediaProbe } from '../encode/ffprobe';
import type { SpecIssue } from './spec-validator';

export const MANIFEST_VERSION = 1;

export interface ManifestSource {
  /** Workspace-relative, like every path in a `RenderArtifact`. */
  readonly masterPath: string;
  readonly masterSha256: string;
  readonly animationId: string;
  readonly compositionSize: Size;
  readonly frameCount: number;
}

export interface DeliveryEntry {
  readonly format: FormatProfileId;
  readonly artifact: RenderArtifact;
  /** What the prober saw, kept so a validation can be re-run without the file. */
  readonly probe: MediaProbe;
  /** Empty when the file satisfies its profile. */
  readonly issues: readonly SpecIssue[];
  /** The plan's own verdict on itself. A `true` here needs eyes before publishing. */
  readonly needsReview: boolean;
  /** Strategy per shot, so a surprising crop is traceable without re-solving. */
  readonly strategies: Readonly<Record<string, string>>;
}

export interface DeliveryManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly createdAt: string;
  readonly source: ManifestSource;
  readonly entries: readonly DeliveryEntry[];
  /** True when any entry failed its spec or any plan wants review. */
  readonly needsAttention: boolean;
}

export function buildManifest(
  source: ManifestSource,
  entries: readonly DeliveryEntry[],
  clock: Clock,
): DeliveryManifest {
  return {
    version: MANIFEST_VERSION,
    createdAt: toIso(clock.now()),
    source,
    entries,
    needsAttention: entries.some(
      (entry) => entry.needsReview || entry.issues.some((issue) => issue.severity === 'error'),
    ),
  };
}

/** Stable JSON: sorted keys, so two identical deliveries produce identical manifests. */
export function serialiseManifest(manifest: DeliveryManifest): string {
  return `${JSON.stringify(manifest, orderedReplacer, 2)}\n`;
}

function orderedReplacer(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  );
}
