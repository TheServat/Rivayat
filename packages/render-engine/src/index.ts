/**
 * `@rv/render-engine` - `AnimationIR` → frames → video → seven deliverables.
 *
 * Three ideas carry the whole package, and every file is downstream of one of them.
 *
 * **1. We seek; we never play.** The loop is `for f in range: evaluate(ir, f/fps) →
 * draw → capture`. `evaluate` (from `@rv/anim-engine`) is a pure function of time, so
 * frame `f` depends on nothing but `(ir, f)`. Resumability, sharding, reproducibility
 * and golden-hash tests are not four features - they are four consequences of that one
 * sentence, and there is no wall clock anywhere in the loop to break it.
 *
 * **2. Two backends, one port.** `napi-canvas` is offscreen Skia, in-process, no GPU
 * and no Chromium download; `pixi-playwright` is a real browser for the shots that need
 * shaders. Research §6 measured the browser at 8-15 s per 150 frames at 1080p, so it is
 * emphatically not the default. `auto` chooses from what the composition actually
 * contains, and a backend that cannot draw a composition refuses it at `open` rather
 * than rendering it *almost* right.
 *
 * **3. Reframing is computed, not re-authored.** One composition in a format-agnostic
 * scene space becomes seven deliverables by solving a crop per shot per format against
 * the verified safe zones from research §7 - 900x1400 centred in 1080x1920, plus
 * TikTok's top 15 %, bottom 20 % and right 15 %. The crop is a continuous function of
 * shot progress, because a per-frame solve jitters. When no crop satisfies a shot, the
 * plan says so: `needsReview` exists because a silent bad crop is worse than a flagged
 * one.
 *
 * Everything external is a port. FFmpeg is spawned with an argv array through
 * {@link ProcessPort}; Playwright and `sharp` are injected structurally, because
 * `.dependency-cruiser.cjs` forbids an engine package from importing either.
 */

// ── ports ───────────────────────────────────────────────────────────────────
export type {
  ArtifactStorePort,
  AssetImagePort,
  BackendCapabilities,
  BrowserContextLike,
  BrowserLauncherLike,
  BrowserLike,
  BrowserPageLike,
  CheckpointRecord,
  CheckpointStorePort,
  FrameBackendId,
  FrameBuffer,
  FrameRenderer,
  FrameSessionSpec,
  FrameSource,
  FrameStorePort,
  PipedProcess,
  ProcessPort,
  ProcessResult,
  ProcessSpec,
  ProgressPort,
  RenderFeature,
  SharpInstanceLike,
  SharpLike,
} from './ports/index';
export { NULL_PROGRESS, RENDER_FEATURES, RecordingProgress } from './ports/index';

// ── frames ──────────────────────────────────────────────────────────────────
export {
  clampToTimeline,
  containsFrame,
  frameCount,
  frameTimeMs,
  framesIn,
  fullRange,
  rangeLength,
} from './frames/frame-clock';
export { hashFrame, hashFrameSequence } from './frames/frame-hash';
export type {
  BuildDrawListOptions,
  DrawItem,
  DrawList,
  ImageDraw,
  ParticlesDraw,
  ShapeDraw,
  TextDraw,
  TextStyleSpec,
  TextStyleTable,
} from './frames/draw-list';
export {
  DEFAULT_TEXT_STYLE,
  assetImageKey,
  bitmapKey,
  buildDrawList,
  normPointToScene,
  normRectCentre,
} from './frames/draw-list';
export type { Matrix2D } from './frames/matrix';
export {
  IDENTITY,
  applyPoint,
  cameraMatrix,
  fromTransform,
  multiply,
  rotation,
  scaling,
  translation,
} from './frames/matrix';

// ── backends ────────────────────────────────────────────────────────────────
export type { BackendDecision } from './backends/selector';
export {
  BROWSER_FEATURES,
  CANVAS_FEATURES,
  detectFeatures,
  missingFeatures,
  selectBackend,
} from './backends/selector';
export type {
  CanvasContext2DLike,
  DrawableImage,
  Surface2D,
  SurfaceProvider,
} from './backends/surface';
export type { BitmapTable, PaintDeps } from './backends/painter';
export { paint, parsePoints } from './backends/painter';
export type { MeasureText, TextBlock, TextLine } from './backends/text-layout';
export { fontShorthand, layoutText, lineOffsetX } from './backends/text-layout';
export type { Rgba } from './backends/tint';
export { applyTint, parseHexColour } from './backends/tint';
export type { SurfaceRendererOptions } from './backends/surface-renderer';
export { SurfaceFrameRenderer } from './backends/surface-renderer';
export type { NapiCanvasBackendOptions } from './backends/napi-canvas/napi-canvas-backend';
export {
  NapiCanvasProvider,
  createNapiCanvasBackend,
} from './backends/napi-canvas/napi-canvas-backend';
export type { PixiPlaywrightOptions } from './backends/pixi-playwright/playwright-backend';
export {
  PixiPlaywrightBackend,
  decodeSeekReply,
  withTimeout,
} from './backends/pixi-playwright/playwright-backend';
export {
  HARNESS_GLOBAL,
  RENDER_HARNESS_SOURCE,
  SCENE_GLOBAL,
  buildHarnessHtml,
} from './backends/pixi-playwright/render-harness';

// ── encoding ────────────────────────────────────────────────────────────────
export type { CodecProfile } from './encode/codec-profiles';
export { CODEC_PROFILES, DETERMINISM_ARGS } from './encode/codec-profiles';
export type {
  BuildEncodeArgsOptions,
  EncodeInput,
  FileInput,
  RawFrameInput,
} from './encode/ffmpeg-args';
export {
  buildConcatArgs,
  buildConcatList,
  buildEncodeArgs,
  loudnessFilter,
} from './encode/ffmpeg-args';
export type {
  EncodeStreamOptions,
  EncodeSummary,
  FfmpegPaths,
  FrameSink,
} from './encode/ffmpeg-encoder';
export { DEFAULT_FFMPEG_PATHS, FfmpegEncoder } from './encode/ffmpeg-encoder';
export type { MediaProbe } from './encode/ffprobe';
export { FfprobeReader, parseProbe, parseRational } from './encode/ffprobe';
export { NodeProcessRunner } from './encode/node-process';

// ── reframing ───────────────────────────────────────────────────────────────
export type { Interval } from './reframe/geometry';
export {
  EPSILON,
  FULL,
  SMOOTHSTEP_PEAK_SLOPE,
  clamp,
  clamp01,
  clampRect,
  containFit,
  contains,
  intersectIntervals,
  lerpRect,
  mapIntoCrop,
  mapIntoFit,
  maximalCrop,
  rectBottom,
  rectCentre,
  rectRight,
} from './reframe/geometry';
export type {
  FocusSample,
  ShotFraming,
  SolveOptions,
  SolvedCrop,
  SolvedStrategy,
} from './reframe/solve-crop';
export { cropAtProgress, feasibleInterval, solveShotCrop } from './reframe/solve-crop';
export type { BuildPlanOptions, ReframeInput } from './reframe/reframe-plan';
export { buildReframePlan, buildReframePlans } from './reframe/reframe-plan';
export type { SampleFocusOptions } from './reframe/focus-track';
export {
  centreRegionOn,
  sampleFocusTrack,
  staticFocusTrack,
  worldToNorm,
} from './reframe/focus-track';
export type { DeliveryIssue, DeliveryIssueSeverity, SafeZoneTemplate } from './reframe/safe-zones';
export {
  allSafeZoneTemplates,
  isDeliverable,
  safeZoneTemplate,
  validateAllDeliveries,
  validateDelivery,
} from './reframe/safe-zones';
export type { ReframeFilter, ShotTiming } from './reframe/reframe-filter';
export { buildReframeFilter, smoothstep } from './reframe/reframe-filter';

// ── job ─────────────────────────────────────────────────────────────────────
export {
  countFrames,
  isResumable,
  lastContiguousFrame,
  normaliseRanges,
  rangesContain,
  subtractRanges,
  toRenderCheckpoint,
  withFrame,
} from './job/checkpoint';
export { shardAll, shardRange } from './job/shard';
export type { ProgressTrackerOptions } from './job/progress-tracker';
export { ProgressTracker } from './job/progress-tracker';
export {
  FileFrameStore,
  InMemoryFrameStore,
  decodeFrameFile,
  encodeFrameFile,
  frameFileName,
} from './job/frame-stores';
export { FileCheckpointStore, InMemoryCheckpointStore, parseRecord } from './job/checkpoint-stores';
export type {
  MasterEncodeSpec,
  RunRenderJobDeps,
  RunRenderJobInput,
  RunRenderJobOutput,
} from './job/render-job';
export { RunRenderJobUseCase } from './job/render-job';

// ── delivery ────────────────────────────────────────────────────────────────
export type { DeliverySettingsOptions, MasterSettingsOptions } from './deliver/encode-settings';
export { deliverySettings, masterSettings } from './deliver/encode-settings';
export type { SpecIssue, SpecIssueCode, ValidateSpecOptions } from './deliver/spec-validator';
export {
  FFPROBE_CODEC_NAMES,
  describeIssue,
  satisfiesProfile,
  validateAgainstProfile,
} from './deliver/spec-validator';
export type { DeliveryEntry, DeliveryManifest, ManifestSource } from './deliver/manifest';
export { MANIFEST_VERSION, buildManifest, serialiseManifest } from './deliver/manifest';
export { FileArtifactStore, WORKSPACE_LAYOUT } from './deliver/artifact-store';
export type { DeliverDeps, DeliverInput, DeliverOutput } from './deliver/deliver';
export { DeliverEpisodeUseCase, deliveryFingerprint } from './deliver/deliver';

// ── visual comparison ───────────────────────────────────────────────────────
export type { PerceptualSignature } from './visual/perceptual-diff';
export {
  SIGNATURE_SIZE,
  compareFrames,
  decodeWithSharp,
  perceptualDistance,
  perceptualSignature,
} from './visual/perceptual-diff';
