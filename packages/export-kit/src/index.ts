/**
 * `@rv/export-kit` - the Animation IR, projected into formats we did not design.
 *
 * ## Every export is a projection, never a source of truth
 *
 * ADR-0001 makes `AnimationIR` (`.rvanim.json`) the single source of truth for animation.
 * Everything in this package is **derived from it**: cached, rebuildable, and safe to
 * delete. Nothing in the system may read one of these files back as authoritative, and
 * that is enforced structurally rather than by convention - **there is no importer**. No
 * parser, no reverse mapping, no `fromLottie`. The `Exporter` port has one verb, so a
 * round trip cannot be added by accident; it would take a second interface and an ADR
 * arguing for it.
 *
 * The reason is not tidiness. A Lottie file has no behaviour parameters, a DragonBones
 * armature has no seeds, and an atlas has no timeline, so re-importing any of them would
 * silently replace a semantic document with a baked one - and the next person to edit
 * "make the wind stronger" would find three thousand rotation keyframes instead of one
 * `amplitude` field. Exports leave; they do not come back.
 *
 * ## The four formats
 *
 * | Format                                     | Carries                                          | Notably does not carry                                    |
 * | ------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------- |
 * | **Lottie** (`lottie`)                      | flattened layers, transforms, markers, shapes    | procedural behaviours (baked), the node hierarchy, rigs    |
 * | **Sprite atlas** (`sprite-atlas`)          | packed part imagery + trim offsets               | the entire timeline                                       |
 * | **DragonBones** (`dragonbones`)            | bones, slots, skins, transform animation         | shapes, text, particles, the camera, independent x/y skew |
 * | **Frame sequence** (`frame-sequence`)      | pixels and timing                                | everything else, by definition                            |
 *
 * Each declares its ceiling in {@link FormatCapabilities} *before* anything is exported -
 * see {@link ExporterRegistry.preview} - and returns what it actually lost per export as
 * a list of {@link ExportWarning}s naming the feature and the nodes that carry it. Pass
 * `strict: true` to turn any lossy warning into a typed failure instead.
 *
 * ## Baking, and being honest about it
 *
 * Lottie and DragonBones have keyframes and nothing else, so `wind`, `blink` and `boil` -
 * closed-form functions of `t` in the IR - are **sampled** across the clip and written as
 * dense keys. That is a real cost: `stats.bakedKeyframeCount` is its size, `stride` is the
 * dial that trades fidelity for it, and `stats.fidelity` is the **measured** error it
 * bought, read back out of the emitted file and compared against `evaluate(ir, t)`.
 *
 * ## Determinism
 *
 * No `Date.now()`, no `Math.random()`. The one wall-clock read in the package is the frame
 * manifest's `createdAt`, and it comes from an injected {@link Clock}. Atlas packing sorts
 * by codepoint rather than by locale, and composites in that order, so the same inputs
 * produce the same PNG bytes on any machine.
 */

export type { IrFeature, FeatureUse } from './features';
export { IR_FEATURES, describeFeature, detectFeatures, featureForChannel } from './features';

export type {
  ApproximationNote,
  ExportWarning,
  FormatCapabilities,
  WarningDisposition,
} from './warnings';
export { UnsupportedFeaturesError, diffFeatures, lossyWarnings } from './warnings';

export type {
  AtlasOptions,
  DragonBonesOptions,
  ExportOptions,
  FramesOptions,
  LottieOptions,
} from './options';

export type { EncodedImage, ImageEncoderPort, RgbaImage } from './pixels';
export { blankImage, compositeImage, cropImage, trimBounds } from './pixels';

export type {
  ErrorStat,
  ExportArtifact,
  ExportFormatId,
  ExportInput,
  ExportInputKey,
  ExportOutput,
  ExportStats,
  Exporter,
  FidelityReport,
  FrameSource,
  MotionSettings,
  PartImage,
} from './port';
export {
  binaryArtifact,
  frameCountOf,
  jsonArtifact,
  sampleFrames,
  slugifyName,
  totalBytes,
} from './port';

export type { DefaultExportersDeps } from './registry';
export { ExporterRegistry, createDefaultRegistry } from './registry';

// ── Lottie ──────────────────────────────────────────────────────────────────
export type {
  LottieAnimatedProperty,
  LottieDocument,
  LottieEase,
  LottieFont,
  LottieImageAsset,
  LottieKeyframe,
  LottieLayer,
  LottieMarker,
  LottieProperty,
  LottieShapeItem,
  LottieStaticProperty,
  LottieTextData,
  LottieTransform,
} from './lottie/types';
export { LOTTIE_LAYER } from './lottie/types';
export type { LottieSegmentEase } from './lottie/easing';
export { isExactlyRepresentable, overshoots, toSegmentEase } from './lottie/easing';
export {
  animatedProperty,
  authoredProperty,
  bakedProperty,
  keyframeCount,
  roundTo,
  sampleLottieProperty,
  simplifySamples,
  staticProperty,
} from './lottie/sample';
export { LOTTIE_CAPABILITIES, LOTTIE_FORMAT_ID, LottieExporter } from './lottie/lottie-exporter';

// ── sprite atlas ────────────────────────────────────────────────────────────
export type { AtlasFrameSource, AtlasPage, PackedFrame, ResolvedAtlasOptions } from './atlas/pack';
export {
  DEFAULT_ATLAS_NAME,
  compareByCodepoint,
  packAtlas,
  resolveAtlasOptions,
} from './atlas/pack';
export {
  ATLAS_CAPABILITIES,
  ATLAS_FORMAT_ID,
  AtlasExporter,
  atlasSourcesFromImages,
} from './atlas/atlas-exporter';

// ── DragonBones ─────────────────────────────────────────────────────────────
export {
  DRAGONBONES_CAPABILITIES,
  DRAGONBONES_FORMAT_ID,
  DragonBonesExporter,
  decomposeLocal,
} from './dragonbones/dragonbones-exporter';

// ── frame sequence ──────────────────────────────────────────────────────────
export { FRAMES_CAPABILITIES, FRAMES_FORMAT_ID, FramesExporter } from './frames/frames-exporter';
