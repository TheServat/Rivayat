/**
 * `AnimationIR → frame_0000.png … + manifest.json` - the honest fallback.
 *
 * Every other exporter tries to preserve structure. This one gives up on structure
 * entirely and hands over pixels and a timing table, because some pipelines take nothing
 * else: an editorial NLE, a compositor, `ffmpeg -i frame_%04d.png`, a client whose whole
 * toolchain is a folder of images. It is the format with the widest reach and the least
 * to say about the animation it came from, and pretending otherwise would be the
 * dishonest part - so every IR feature is reported as flattened into pixels.
 *
 * Drawing is **not** done here. `FrameSource` supplies composed frames, because the
 * rasteriser belongs to the render engine and a second one in this package would have to
 * be kept in step with the real one forever. What this exporter owns is the part that is
 * genuinely its own: which times to sample, what to call the files, and a manifest that
 * says what each file is.
 */

import {
  type AppError,
  type Clock,
  type Result,
  ValidationError,
  err,
  isErr,
  ok,
  toIso,
} from '@rv/shared-kernel';
import { type IrFeature, detectIrFeatures } from '@rv/contracts';

import type { ExportOptions, FramesOptions } from '../options';
import type { ImageEncoderPort } from '../pixels';
import {
  type ExportArtifact,
  type ExportInput,
  type ExportOutput,
  type Exporter,
  binaryArtifact,
  frameCountOf,
  jsonArtifact,
  sampleFrames,
  totalBytes,
} from '../port';
import {
  type ApproximationNote,
  type FormatCapabilities,
  UnsupportedFeaturesError,
  diffFeatures,
  lossyWarnings,
} from '../warnings';

export const FRAMES_FORMAT_ID = 'frame-sequence';

const DEFAULT_PREFIX = 'frame_';
const DEFAULT_PAD_WIDTH = 4;

/**
 * A frame sequence carries no structure at all.
 *
 * Nothing is `exact`, and nothing is even `approximated` in the sense of "a lossy version
 * of the same thing" - the animation is *gone*, replaced by its appearance. Declaring an
 * empty capability set is the accurate statement, and it means a `strict` export of a
 * frame sequence always fails, which is correct: nothing about the IR survives.
 */
export const FRAMES_CAPABILITIES: FormatCapabilities = {
  exact: new Set<IrFeature>(),
  approximate: new Map<IrFeature, ApproximationNote>(),
};

interface ResolvedFramesOptions {
  readonly stride: number;
  readonly prefix: string;
  readonly padWidth: number;
  readonly directory: string;
}

interface FrameManifestEntry {
  readonly index: number;
  readonly frame: number;
  readonly timeMs: number;
  readonly file: string;
  readonly sha256: string;
}

interface FrameManifest {
  readonly manifestVersion: 1;
  readonly generator: string;
  readonly animationId: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** The IR's frame rate. Unchanged by `stride`; see `effectiveFps`. */
  readonly fps: number;
  readonly stride: number;
  /** Frames per second **of the emitted sequence**, which is what a muxer needs. */
  readonly effectiveFps: number;
  readonly durationMs: number;
  readonly frameCount: number;
  /** `ffmpeg -framerate <effectiveFps> -i <pattern>` reads the sequence directly. */
  readonly pattern: string;
  readonly createdAt: string;
  readonly frames: readonly FrameManifestEntry[];
}

export class FramesExporter implements Exporter {
  readonly id = FRAMES_FORMAT_ID;
  readonly label = 'Frame sequence';
  readonly formatSpec =
    'numbered PNG sequence plus a `manifest.json` listing each frame’s index, time and content hash; the pattern is directly consumable by `ffmpeg -i`';
  readonly requires = ['frameSource'] as const;
  readonly capabilities = FRAMES_CAPABILITIES;

  readonly #encoder: ImageEncoderPort;
  readonly #clock: Clock;

  constructor(deps: { readonly encoder: ImageEncoderPort; readonly clock: Clock }) {
    this.#encoder = deps.encoder;
    this.#clock = deps.clock;
  }

  async export(
    input: ExportInput,
    options: ExportOptions = {},
  ): Promise<Result<ExportOutput, AppError>> {
    const source = input.frameSource;
    if (source === undefined) {
      return err(
        new ValidationError({
          message:
            'the frame-sequence export needs a `frameSource`: this package times and names frames, it does not draw them',
        }),
      );
    }

    const resolved = resolveOptions(options.frames ?? {});
    if (isErr(resolved)) return resolved;
    const opts = resolved.value;

    const ir = input.ir;
    const total = frameCountOf(ir);
    // Exclusive of the final frame: frame `total` is the first frame of whatever comes
    // next, so including it would duplicate a frame at every cut.
    const frames = sampleFrames(total, opts.stride).filter((frame) => frame < total);

    const artifacts: ExportArtifact[] = [];
    const entries: FrameManifestEntry[] = [];

    for (const [index, frame] of frames.entries()) {
      const timeMs = (frame * 1000) / ir.fps;
      const rendered = await source.render(ir, timeMs);
      if (isErr(rendered)) return rendered;

      const encoded = await this.#encoder.encode(rendered.value);
      if (isErr(encoded)) return encoded;

      const file = `${opts.prefix}${String(index).padStart(opts.padWidth, '0')}.png`;
      const artifact = binaryArtifact(
        `${opts.directory}${file}`,
        this.#encoder.mediaType,
        encoded.value.data,
      );
      artifacts.push(artifact);
      entries.push({ index, frame, timeMs, file, sha256: artifact.sha256 });
    }

    const manifest: FrameManifest = {
      manifestVersion: 1,
      generator: '@rv/export-kit',
      animationId: ir.id,
      name: ir.name,
      width: ir.sceneSpace.width,
      height: ir.sceneSpace.height,
      fps: ir.fps,
      stride: opts.stride,
      effectiveFps: ir.fps / opts.stride,
      durationMs: ir.durationMs,
      frameCount: entries.length,
      pattern: `${opts.prefix}%0${String(opts.padWidth)}d.png`,
      // The only wall-clock read in this package, and it is injected. A manifest without
      // a produced-at time is harder to reason about in a delivery folder; a manifest
      // that reads `Date.now()` is not reproducible.
      createdAt: toIso(this.#clock.now()),
      frames: entries,
    };
    artifacts.push(jsonArtifact(`${opts.directory}manifest.json`, manifest));

    const warnings = diffFeatures(detectIrFeatures(ir), FRAMES_CAPABILITIES);
    if (options.strict === true) {
      const lossy = lossyWarnings(warnings);
      if (lossy.length > 0) return err(new UnsupportedFeaturesError(this.id, lossy));
    }

    return ok({
      format: this.id,
      artifacts,
      warnings,
      stats: {
        totalBytes: totalBytes(artifacts),
        keyframeCount: 0,
        bakedKeyframeCount: 0,
        sampledFrames: entries.length,
        sampleStride: opts.stride,
      },
    });
  }
}

function resolveOptions(raw: FramesOptions): Result<ResolvedFramesOptions, AppError> {
  const stride = raw.stride ?? 1;
  const padWidth = raw.padWidth ?? DEFAULT_PAD_WIDTH;

  if (!Number.isInteger(stride) || stride < 1) {
    return err(
      new ValidationError({
        message: 'frames stride must be a positive integer number of frames',
        context: { stride },
      }),
    );
  }
  if (!Number.isInteger(padWidth) || padWidth < 1 || padWidth > 10) {
    return err(
      new ValidationError({
        message: 'frames padWidth must be an integer between 1 and 10',
        context: { padWidth },
      }),
    );
  }

  const directory = raw.directory ?? '';
  return ok({
    stride,
    prefix: raw.prefix ?? DEFAULT_PREFIX,
    padWidth,
    // Normalised here so callers may pass `frames` or `frames/` and get the same paths.
    directory: directory === '' || directory.endsWith('/') ? directory : `${directory}/`,
  });
}
