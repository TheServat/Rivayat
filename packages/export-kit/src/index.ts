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
 * ## One origin, stated once
 *
 * `AnimationIR` never says where the origin of `sceneSpace` is. `@rv/render-engine` fixes
 * it at the **centre** of the canvas, and every exporter here follows it - the renderer is
 * what produces the video, so it is the reference implementation and a projection does not
 * get a second opinion. Formats whose own origin is the top-left (Lottie compositions,
 * DragonBones armatures) are converted in {@link toCompositionSpace}, which is the only
 * place that arithmetic exists. A root-level export therefore carries the offset visibly,
 * where an integrator can see and adjust it, instead of silently sitting half a canvas
 * from where the video puts it.
 *
 * ## Determinism
 *
 * No `Date.now()`, no `Math.random()`. The one wall-clock read in the package is the frame
 * manifest's `createdAt`, and it comes from an injected {@link Clock}. Atlas packing sorts
 * by codepoint rather than by locale, and composites in that order, so the same inputs
 * produce the same PNG bytes on any machine.
 */

export type { ResolvedCamera } from './scene-space';
export { sceneCentreOf, toCompositionSpace, transformInCompositionSpace } from './scene-space';

/**
 * The IR's own feature vocabulary, re-exported.
 *
 * It lives in `@rv/contracts` because it describes what an `AnimationIR` *contains*, which
 * is a property of the document and not of any one projection of it. This package used to
 * declare its own copy; the render engine derived a weaker one from node kinds at the same
 * time, and two packages answering "what does this document use" in two vocabularies is
 * the drift the move exists to end.
 *
 * Re-exported rather than left to the caller because every warning this package returns is
 * named in this vocabulary, and a caller reading `ExportWarning.feature` should not have to
 * work out which package the enum came from.
 */
export type { IrFeature, IrFeatureUse } from '@rv/contracts';
export {
  IR_FEATURES,
  describeIrFeature,
  detectIrFeatures,
  irFeatureForChannel,
} from '@rv/contracts';

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
