/**
 * One master, every platform file, one manifest.
 *
 * The shape of this use case is the architecture's claim made executable: the frames
 * are drawn once, and each delivery is a *transcode of the master through a solved
 * crop*. Nothing is re-evaluated, nothing is re-drawn, and nothing is generated - which
 * is why RV-170 can assert that a delivery run's ledger reads `nanoUsd === 0`.
 *
 * Each format goes through the same four steps, and the last one is the one that earns
 * its keep:
 *
 *  1. solve a `ReframePlan` against the profile's verified safe area
 *  2. turn the plan into an FFmpeg filter graph
 *  3. transcode the master through it
 *  4. **probe the result and check it against the profile it claims to satisfy**
 *
 * Step 4 is not belt and braces. Everything before it reasons about intent; only a
 * probe of the finished bytes can catch a file that came out 1920x1080 when the profile
 * says 1080x1920. A delivery that violates its own spec is reported as an entry with
 * issues rather than thrown away, because the file is usually still useful and the
 * person deciding is not this function.
 */

import {
  contentHash,
  sha256,
  toIso,
  type AppError,
  type Clock,
  type Result,
  ok,
} from '@rv/shared-kernel';
import {
  FORMAT_PRESETS,
  type EncodeSettings,
  type FormatProfileId,
  type RenderArtifact,
  type Size,
} from '@rv/contracts';

import type { FfmpegEncoder } from '../encode/ffmpeg-encoder';
import type { FfprobeReader } from '../encode/ffprobe';
import { buildReframeFilter, type ShotTiming } from '../reframe/reframe-filter';
import { buildReframePlan, type ReframeInput } from '../reframe/reframe-plan';
import type { SolveOptions } from '../reframe/solve-crop';
import type { ArtifactStorePort } from '../ports/storage';
import { deliverySettings } from './encode-settings';
import {
  buildManifest,
  serialiseManifest,
  type DeliveryEntry,
  type DeliveryManifest,
  type ManifestSource,
} from './manifest';
import { validateAgainstProfile, type SpecIssue, type ValidateSpecOptions } from './spec-validator';

export interface DeliverDeps {
  readonly encoder: FfmpegEncoder;
  readonly prober: FfprobeReader;
  readonly artifacts: ArtifactStorePort;
  readonly clock: Clock;
}

export interface DeliverInput {
  /** Workspace-relative path to the master this delivery is cut from. */
  readonly masterPath: string;
  readonly masterSize: Size;
  readonly animationId: string;
  readonly frameCount: number;
  /** Where the deliverables go. Workspace-relative; never inside the repository. */
  readonly outputDir: string;
  readonly formats: readonly FormatProfileId[];
  readonly reframe: ReframeInput;
  readonly timings: readonly ShotTiming[];
  /** Per-format encoder overrides. Anything absent uses {@link deliverySettings}. */
  readonly encodeOverrides?: Partial<Record<FormatProfileId, EncodeSettings>>;
  readonly solve?: SolveOptions;
  readonly validate?: ValidateSpecOptions;
}

export interface DeliverOutput {
  readonly manifest: DeliveryManifest;
  readonly manifestPath: string;
}

export class DeliverEpisodeUseCase {
  readonly #deps: DeliverDeps;

  constructor(deps: DeliverDeps) {
    this.#deps = deps;
  }

  async execute(input: DeliverInput): Promise<Result<DeliverOutput, AppError>> {
    const masterBytes = await this.#deps.artifacts.read(input.masterPath);
    if (!masterBytes.ok) return masterBytes;
    const masterSha = sha256(masterBytes.value);

    const entries: DeliveryEntry[] = [];
    for (const format of input.formats) {
      const entry = await this.#deliverOne(input, format);
      if (!entry.ok) return entry;
      entries.push(entry.value);
    }

    const source: ManifestSource = {
      masterPath: input.masterPath,
      masterSha256: masterSha,
      animationId: input.animationId,
      compositionSize: input.reframe.composition,
      frameCount: input.frameCount,
    };
    const manifest = buildManifest(source, entries, this.#deps.clock);

    const manifestPath = `${input.outputDir}/manifest.json`;
    const written = await this.#deps.artifacts.write(
      manifestPath,
      new TextEncoder().encode(serialiseManifest(manifest)),
    );
    if (!written.ok) return written;

    return ok({ manifest, manifestPath });
  }

  async #deliverOne(
    input: DeliverInput,
    format: FormatProfileId,
  ): Promise<Result<DeliveryEntry, AppError>> {
    const profile = FORMAT_PRESETS[format];
    const settings = input.encodeOverrides?.[format] ?? deliverySettings(profile);

    const plan = buildReframePlan(input.reframe, profile, input.solve ?? {});
    if (!plan.ok) return plan;

    const filter = buildReframeFilter(plan.value, input.masterSize, input.timings);
    if (!filter.ok) return filter;

    const relativePath = `${input.outputDir}/${format}.${settings.container}`;
    // FFmpeg does not create directories, and discovering that after the graph is built
    // costs a whole transcode.
    const outputPath = await this.#deps.artifacts.prepareWrite(relativePath);
    if (!outputPath.ok) return outputPath;

    const transcoded = await this.#deps.encoder.transcode({
      inputPath: this.#deps.artifacts.resolve(input.masterPath),
      settings,
      outputPath: outputPath.value,
      complexFilter: filter.value,
    });
    if (!transcoded.ok) return transcoded;

    const probe = await this.#deps.prober.probe(this.#deps.artifacts.resolve(relativePath));
    if (!probe.ok) return probe;

    const bytes = await this.#deps.artifacts.read(relativePath);
    if (!bytes.ok) return bytes;

    const issues: readonly SpecIssue[] = validateAgainstProfile(
      probe.value,
      profile,
      input.validate ?? {},
    );

    const artifact: RenderArtifact = {
      kind: 'delivery',
      format,
      path: relativePath,
      sha256: sha256(bytes.value),
      bytes: bytes.value.length,
      durationMs: probe.value.durationMs,
      size: { width: probe.value.width, height: probe.value.height },
      // `nb_frames` is absent from plenty of containers; deriving it from the measured
      // duration and the profile's frame rate is better than reporting zero.
      frameCount:
        probe.value.frameCount ?? Math.round((probe.value.durationMs / 1000) * profile.fps),
      encode: settings,
      createdAt: toIso(this.#deps.clock.now()),
    };

    return ok({
      format,
      artifact,
      probe: probe.value,
      issues,
      needsReview: plan.value.needsReview,
      strategies: Object.fromEntries(plan.value.shots.map((shot) => [shot.shotId, shot.strategy])),
    });
  }
}

/**
 * A digest of the inputs a delivery is a function of.
 *
 * Two runs with the same value here must produce the same files. Useful as a cache key
 * and, more importantly, as the thing a reproducibility test asserts on when comparing
 * runs whose manifests legitimately differ by a timestamp.
 */
export function deliveryFingerprint(input: DeliverInput): string {
  return contentHash({
    master: input.masterPath,
    masterSize: input.masterSize,
    formats: [...input.formats].sort(),
    shots: input.reframe.shots,
    composition: input.reframe.composition,
    timings: input.timings,
    overrides: input.encodeOverrides ?? {},
    solve: input.solve ?? {},
  });
}
