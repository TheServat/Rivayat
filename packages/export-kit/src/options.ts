/**
 * Per-format options, in one module so the port can name them without importing an
 * exporter (which would close a cycle the linter rejects).
 *
 * They live in a namespaced bag rather than behind a generic parameter on `Exporter`.
 * A generic would be prettier at the call site and unusable in the registry: an
 * `Exporter<LottieOptions>` is not an `Exporter<ExportOptions>` under
 * `strictFunctionTypes`, so the registry would need a cast, and a cast in the one place
 * whose job is to keep formats interchangeable defeats the point. Each exporter reads
 * its own slice and ignores the rest, so one options object can be handed to any format.
 */

/**
 * Lottie.
 *
 * The two that change the output most are {@link stride} - how coarsely procedural
 * behaviours are sampled - and {@link applyCamera}, which decides whether the camera is
 * folded into every layer or left out of the file entirely.
 */
export interface LottieOptions {
  /** Base name for the emitted file. Defaults to a slug of the IR's name. */
  readonly name?: string;
  /**
   * Sample every `stride`-th frame when baking.
   *
   * 1 samples the frame grid exactly, so a player stepping frame by frame sees what the
   * renderer would draw. Larger values trade fidelity for size, and the export reports
   * the error that trade actually cost.
   */
  readonly stride?: number;
  /**
   * Collinear samples closer than this to the straight line between their neighbours
   * are dropped. The reduction is provably bounded by this value, so it is a fidelity
   * budget rather than a heuristic.
   */
  readonly simplifyTolerance?: number;
  /**
   * Fold the camera into every layer transform. Default `true`.
   *
   * Lottie has no camera. Leaving it out produces a file whose layers hold pure scene
   * coordinates - convenient, and not what the preview looks like. Folding it in makes
   * the picture match at the cost of a camera nobody can move afterwards.
   */
  readonly applyCamera?: boolean;
  /**
   * Measure the emitted file against `evaluate(ir, t)` at every frame. Default `true`.
   *
   * Costs one extra evaluation per frame and is the only thing that makes the reported
   * fidelity a measurement rather than a claim.
   */
  readonly measureFidelity?: boolean;
  /** Directory prefix written into image asset references. Default `images/`. */
  readonly imageDir?: string;
  /** Decimal places every emitted number is rounded to. Default 6. */
  readonly precision?: number;
  /** Value of the document's `v` field. Default `5.13.0`, matching research §5. */
  readonly version?: string;
}

/** Sprite atlas. */
export interface AtlasOptions {
  /** Base name; page 0 becomes `<name>.png` / `<name>.json`. Default `atlas`. */
  readonly name?: string;
  /** Maximum page edge in pixels. Overflow spills to another page. Default 2048. */
  readonly maxSize?: number;
  /** Gap between packed frames. Default 2, which stops bilinear filtering bleeding. */
  readonly padding?: number;
  /** Gap between a frame and the page edge. Default 0. */
  readonly border?: number;
  /** Crop the transparent margin and record the offset. Default `true`. */
  readonly trim?: boolean;
  /** Alpha at or below this counts as transparent when trimming. Default 0. */
  readonly alphaThreshold?: number;
  /** Round page dimensions up to a power of two. Default `false`. */
  readonly powerOfTwo?: boolean;
  /** Force square pages. Default `false`. */
  readonly square?: boolean;
}

/** DragonBones. */
export interface DragonBonesOptions {
  /** Armature and file base name. Defaults to a slug of the IR's name. */
  readonly name?: string;
  /** Sample every `stride`-th frame when writing animation frames. Default 1. */
  readonly stride?: number;
  /** `version` / `compatibleVersion` in the skeleton file. Default `5.5`. */
  readonly version?: string;
  /** Packing options for the companion `_tex` atlas, when parts are supplied. */
  readonly atlas?: AtlasOptions;
}

/** Numbered frame sequence. */
export interface FramesOptions {
  /** Emit every `stride`-th frame. Default 1. */
  readonly stride?: number;
  /** File name prefix. Default `frame_`. */
  readonly prefix?: string;
  /** Zero-padding width of the frame number. Default 4. */
  readonly padWidth?: number;
  /** Directory prefix for the emitted paths, e.g. `frames/`. Default none. */
  readonly directory?: string;
}

export interface ExportOptions {
  /**
   * Fail instead of returning warnings when the format cannot carry something.
   *
   * `restructured` losses do not trip it - a flattened layer tree still draws the right
   * picture - but anything `approximated` or `dropped` does.
   */
  readonly strict?: boolean;
  readonly lottie?: LottieOptions;
  readonly atlas?: AtlasOptions;
  readonly dragonBones?: DragonBonesOptions;
  readonly frames?: FramesOptions;
}
