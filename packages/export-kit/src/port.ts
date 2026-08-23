/**
 * The `Exporter` port.
 *
 * **Every export is a projection of the Animation IR, never a source of truth.**
 * Exports are derived, cached and rebuildable; nothing in this system reads one back as
 * authoritative. That is enforced structurally rather than by convention: this package
 * contains no importer, no parser and no reverse mapping, and the port has one verb.
 * There is nowhere for a round trip to be added without adding a second interface, at
 * which point somebody has to argue for it in an ADR.
 *
 * The rest of the shape follows CLAUDE.md §2: a format is an implementation registered
 * in a map, never a `switch`. Adding DragonBones cost a class and a `register` call, and
 * nothing in this file changed.
 */

import { type AppError, type Result, type Sha256, sha256 } from '@rv/shared-kernel';
import type { AnimationClip, AnimationIR, MotionStyle, Part, Rig } from '@rv/contracts';

import type { ExportOptions } from './options';
import type { RgbaImage } from './pixels';
import type { FormatCapabilities, ExportWarning } from './warnings';

/**
 * A format's stable identifier.
 *
 * Free-form rather than a union so a format can be registered from outside this package
 * without editing it. Nothing branches on the value; the registry looks it up.
 */
export type ExportFormatId = string;

/** The motion settings an export must ease by, so it agrees with the renderer. */
export type MotionSettings = Pick<MotionStyle, 'stepMode' | 'easings' | 'tempo'>;

/** One part of an asset, with its pixels, for the formats that carry imagery. */
export interface PartImage {
  readonly part: Part;
  readonly image: RgbaImage;
}

/**
 * Renders one composed frame of the IR.
 *
 * Drawing belongs to the render engine, not to an exporter: the frame-sequence format
 * owns timing, naming and the manifest, and borrows the pixels. Keeping it a port also
 * keeps this package free of a rasteriser it would otherwise have to keep in step with
 * the real one.
 */
export interface FrameSource {
  render(ir: AnimationIR, timeMs: number): Promise<Result<RgbaImage, AppError>>;
}

/**
 * Everything a format might need.
 *
 * Optional beyond `ir` because the four formats need genuinely different things and a
 * caller should not have to assemble a rig to write a Lottie file. An exporter declares
 * what it needs in {@link Exporter.requires} and fails with a `Result` when it is absent,
 * rather than emitting a half-file.
 */
export interface ExportInput {
  /** The document being projected. The only thing that is ever authoritative. */
  readonly ir: AnimationIR;
  /** The active style's motion settings. Omitted means the evaluator's defaults. */
  readonly motion?: MotionSettings;
  /** Part geometry and pixels, for atlases and texture pages. */
  readonly parts?: readonly PartImage[];
  /** The skeleton behind the IR's asset instances, for skeletal formats. */
  readonly rig?: Rig;
  /** Named clips to emit as animations, for skeletal formats. */
  readonly clips?: readonly AnimationClip[];
  /** Supplies composed frames, for the frame-sequence format. */
  readonly frameSource?: FrameSource;
}

/** Which optional members of {@link ExportInput} a format cannot work without. */
export type ExportInputKey = 'parts' | 'rig' | 'clips' | 'frameSource';

/** One emitted file. Bytes, not a path on disk: writing them is the caller's business. */
export interface ExportArtifact {
  /** Path relative to the export root, e.g. `atlas.png`. Always forward slashes. */
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  /** Content hash of `bytes`. Two identical exports produce two identical hashes. */
  readonly sha256: Sha256;
}

/** Max and root-mean-square error of one measured quantity. */
export interface ErrorStat {
  readonly max: number;
  readonly rms: number;
}

/**
 * How far the emitted file drifts from `evaluate(ir, t)`.
 *
 * Measured, not asserted: the exporter reads its own output back and compares it against
 * the engine at every frame. Reported per quantity because the units differ and a single
 * number would be meaningless - 0.4 is nothing in scale percent and a lot in pixels.
 */
export interface FidelityReport {
  readonly samples: number;
  readonly positionPx: ErrorStat;
  readonly rotationDeg: ErrorStat;
  readonly scalePercent: ErrorStat;
  readonly opacityPercent: ErrorStat;
  /** The largest of the four maxima. A single number for a threshold to sit on. */
  readonly worst: number;
}

/**
 * What the export cost.
 *
 * `bakedKeyframeCount` is the honest one. Behaviours are eight lines of JSON in the IR
 * and thousands of keyframes in a Lottie file, and that number is the size of the lie
 * the format forces us to tell.
 */
export interface ExportStats {
  readonly totalBytes: number;
  /** Keyframes written across every animated property. */
  readonly keyframeCount: number;
  /** Of those, the ones that exist only because a procedural behaviour was sampled. */
  readonly bakedKeyframeCount: number;
  /** Frames actually evaluated. */
  readonly sampledFrames: number;
  /** The sampling stride used. 1 means the frame grid was sampled exactly. */
  readonly sampleStride: number;
  readonly fidelity?: FidelityReport;
}

export interface ExportOutput {
  readonly format: ExportFormatId;
  readonly artifacts: readonly ExportArtifact[];
  /** Everything the format could not carry exactly. Empty is possible and rare. */
  readonly warnings: readonly ExportWarning[];
  readonly stats: ExportStats;
}

/**
 * One projection of the IR into one file format.
 *
 * There is no `import`. See the module note: the absence is the design.
 */
export interface Exporter {
  readonly id: ExportFormatId;
  /** Short human name for a format picker. */
  readonly label: string;
  /** The published convention this writes, so a reader knows what opens it. */
  readonly formatSpec: string;
  /** Optional inputs this format cannot work without. */
  readonly requires: readonly ExportInputKey[];
  /** What the format can carry, declared up front so a caller can ask before paying. */
  readonly capabilities: FormatCapabilities;

  export(input: ExportInput, options?: ExportOptions): Promise<Result<ExportOutput, AppError>>;
}

// ── helpers shared by the implementations ───────────────────────────────────

const UTF8 = new TextEncoder();

/** Wraps bytes as an artifact, hashing them so the caller can dedupe or verify. */
export function binaryArtifact(path: string, mediaType: string, bytes: Uint8Array): ExportArtifact {
  return { path, mediaType, bytes, sha256: sha256(bytes) };
}

/**
 * A JSON artifact, pretty-printed.
 *
 * Two spaces rather than compact: every one of these is meant to be readable by whoever
 * has to work out why a downstream tool disliked it, and the size difference is
 * irrelevant next to the baked keyframe arrays that dominate the file anyway.
 */
export function jsonArtifact(path: string, value: unknown): ExportArtifact {
  return binaryArtifact(path, 'application/json', UTF8.encode(JSON.stringify(value, null, 2)));
}

export function totalBytes(artifacts: readonly ExportArtifact[]): number {
  return artifacts.reduce((sum, artifact) => sum + artifact.bytes.length, 0);
}

/**
 * A file-safe name derived from a human label.
 *
 * Exports are addressed by path, and a label is free text that may contain a slash, a
 * quote or Persian script. Non-ASCII collapses rather than being transliterated, and an
 * empty result falls back, because a file called `.json` is worse than one called
 * `animation.json`.
 */
export function slugifyName(label: string, fallback = 'animation'): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug.length > 0 ? slug : fallback;
}

/** Frames in the clip, inclusive of the final one. */
export function frameCountOf(ir: AnimationIR): number {
  return Math.max(1, Math.round((ir.durationMs / 1000) * ir.fps));
}

/**
 * The frame indices an export samples.
 *
 * The last frame is always included even when the stride steps over it: a clip whose
 * final pose is missing ends on whatever the previous sample happened to be, which is
 * the one frame a reviewer is guaranteed to look at.
 */
export function sampleFrames(frameCount: number, stride: number): readonly number[] {
  const step = Math.max(1, Math.floor(stride));
  const frames: number[] = [];
  for (let frame = 0; frame <= frameCount; frame += step) frames.push(frame);
  const last = frames[frames.length - 1];
  if (last !== frameCount) frames.push(frameCount);
  return frames;
}
