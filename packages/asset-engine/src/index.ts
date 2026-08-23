/**
 * `@rv/asset-engine` - `AssetSpec` → generate → matte → parts → rig → clips → sheet.
 *
 * The package that turns a description into something riggable. Two research findings
 * shape it more than anything else, and both are visible in the file layout rather than
 * buried:
 *
 *  1. **Props decompose, characters do not** (research §3). SD 1.5 collapses a
 *     character parts request into a costume turnaround; that is a text-encoder limit,
 *     not a prompt one. So `generate/decomposition-policy.ts` routes by subject - props
 *     to the free local parts-sheet lane, characters to the multi-reference cloud lane
 *     followed by segmentation - and the routing is a table you can edit, not a
 *     heuristic you have to find.
 *  2. **The grid is advisory.** `parts/connected-components.ts` segments by alpha
 *     connectivity and never divides the canvas arithmetically, so a wing drawn 30 px
 *     off the requested grid is still a usable wing.
 *
 * "No asset is generated twice" lives in `@rv/asset-registry`, not here.
 * `GenerateAssetVersionUseCase` calls it before it does anything else.
 */

// ── ports ───────────────────────────────────────────────────────────────────
export type {
  EncodedImage,
  MatteRequest,
  MatteResult,
  MattingEngineId,
  MattingPort,
  RasterPort,
  RgbaImage,
  SegmentationModel,
} from './ports/index';

// ── raster ──────────────────────────────────────────────────────────────────
export { PNG_MIME, decodePng, encodePng } from './raster/png';
export { PngRaster } from './raster/png-raster';
export {
  OPAQUE_FLOOR,
  alphaCleanliness,
  alphaCoverage,
  cornersAreTransparent,
} from './raster/alpha';

// ── spec authoring ──────────────────────────────────────────────────────────
export {
  CANVAS_BY_QUALITY,
  DEFAULT_ARCHETYPE_BY_ENTITY_KIND,
  DEFAULT_NOMINAL_HEIGHT,
  NOMINAL_HEIGHT_BY_ARCHETYPE,
  SUBJECT_CLASS_BY_ENTITY_KIND,
  archetypeFromPayload,
} from './spec/archetype-map';
export { DeriveAssetSpecUseCase, identityAnchors, styleAnchors } from './spec/derive-asset-spec';
export type {
  AssetSpecSource,
  DeriveAssetSpecInput,
  SceneRequirement,
} from './spec/derive-asset-spec';

// ── generation ──────────────────────────────────────────────────────────────
export {
  DEFAULT_DECOMPOSITION_POLICY,
  FREE_LANE_POLICY,
  routeSubject,
} from './generate/decomposition-policy';
export type {
  DecompositionPolicy,
  DecompositionStrategy,
  GenerationLane,
  SubjectRoute,
} from './generate/decomposition-policy';
export { composeGenerationRequest, requestFingerprint } from './generate/request-composer';
export type {
  ComposeRequestInput,
  ComposedRequest,
  PromptEncoder,
} from './generate/request-composer';
export { GenerateAssetVersionUseCase } from './generate/generate-asset-version';
export type {
  BudgetCheckPort,
  CacheHitOutcome,
  CallLedgerPort,
  DemandResolverPort,
  GeneratedOutcome,
  GenerateAssetVersionDeps,
  GenerateAssetVersionInput,
  GenerateAssetVersionOutput,
} from './generate/generate-asset-version';

// ── matting ─────────────────────────────────────────────────────────────────
export { THRESHOLD_ENGINE, ThresholdMatting, sampleBackground } from './matte/threshold-matting';
export type { ThresholdMattingOptions } from './matte/threshold-matting';
export { ModelMatting } from './matte/model-matting';
export type { ModelMattingOptions } from './matte/model-matting';
export { ChainedMatting, DEFAULT_ACCEPTANCE } from './matte/chained-matting';
export type { ChainedMattingOptions, MatteAcceptance } from './matte/chained-matting';
export { MatteCanvasUseCase } from './matte/matte-canvas';
export type { MatteCanvasDeps, MatteCanvasInput, MatteCanvasOutput } from './matte/matte-canvas';
export {
  BIREFNET_ENGINE,
  BiRefNetSegmentation,
  DEFAULT_BIREFNET_MODEL,
} from './matte/adapters/birefnet-segmentation';
export type {
  BackgroundRemover,
  BiRefNetOptions,
  RawImageLike,
  TransformersLike,
} from './matte/adapters/birefnet-segmentation';

// ── part splitting ──────────────────────────────────────────────────────────
export { extractComponent, findComponents } from './parts/connected-components';
export type { Component, ComponentField, ComponentOptions } from './parts/connected-components';
export { assignComponents, toPlanTargets } from './parts/assign-components';
export type {
  Assignment,
  AssignmentOptions,
  AssignmentReport,
  PlanTarget,
} from './parts/assign-components';
export { SplitPartsUseCase } from './parts/split-parts';
export type { SplitPartsDeps, SplitPartsInput, SplitPartsOutput } from './parts/split-parts';

// ── rigging ─────────────────────────────────────────────────────────────────
export {
  TEMPLATE_BY_ARCHETYPE,
  blueprintFor,
  blueprintWorldRest,
  extentByRole,
  partPlansFor,
  templateFor,
} from './rig/templates/index';
export type { RigBlueprint } from './rig/templates/index';
export { buildDeformMesh } from './rig/mesh';
export type { BuildMeshInput, MeshBoneCandidate } from './rig/mesh';
export { FitRigUseCase } from './rig/fit-rig';
export type { FitRigDeps, FitRigInput } from './rig/fit-rig';

// ── clips ───────────────────────────────────────────────────────────────────
export { CLIP_KINDS, TARGET_PATTERNS } from './clips/clip-kinds';
export type { ClipFamily, ClipKind, TargetKind } from './clips/clip-kinds';
export { buildClipIr } from './clips/build-clip-ir';
export type { BuildClipIrInput, ClipIrDraft } from './clips/build-clip-ir';
export { DeriveClipsUseCase } from './clips/derive-clips';
export type {
  DeriveClipsDeps,
  DeriveClipsInput,
  DeriveClipsOutput,
  DerivedClip,
} from './clips/derive-clips';

// ── baking ──────────────────────────────────────────────────────────────────
export { drawAffine, identityMatrix, multiply, placementMatrix } from './bake/rasterise';
export type { Matrix2D } from './bake/rasterise';
export { BakeSheetUseCase } from './bake/bake-sheet';
export type {
  BakedPage,
  BakeSheetDeps,
  BakeSheetInput,
  BakeSheetOutput,
  BakeSheetSettings,
} from './bake/bake-sheet';

// ── quality ─────────────────────────────────────────────────────────────────
export {
  ALPHA_CLEANLINESS,
  IDENTITY_MATCH,
  PART_COMPLETENESS,
  SILHOUETTE,
  STYLE_MATCH,
  buildRubric,
  mergeMeasuredScores,
} from './quality/rubric';
export type { MeasuredScores } from './quality/rubric';
export { DEFAULT_THRESHOLDS, QualityGateUseCase } from './quality/quality-gate';
export type {
  QualityGateDeps,
  QualityGateInput,
  QualityGateOutput,
  QualityThresholds,
  QualityVerdict,
  ScoreAttempt,
} from './quality/quality-gate';

// ── produce: the orchestrator (RV-130) ──────────────────────────────────────
export {
  PRODUCE_STAGE,
  PRODUCE_STEPS,
  checkpointKeyString,
  produceStageCheckpoint,
  stageCheckpoint,
  stepInputHash,
} from './produce/checkpoints';
export type {
  ProduceCheckpointKey,
  ProduceCheckpointStore,
  ProduceStep,
  StepArtifacts,
} from './produce/checkpoints';
export { GENERATION_LANES, resolveLane } from './produce/lanes';
export type { LaneBinding, ProduceLanes, ResolvedLane } from './produce/lanes';
export { STEP_RECORD_KIND, readRecord, writeRecord } from './produce/records';
export type {
  BakeRecord,
  ClipsRecord,
  GenerateRecord,
  MatteRecord,
  RegisterRecord,
  RigRecord,
  ScoreRecord,
  SheetRecord,
  SplitRecord,
} from './produce/records';
export { DEFAULT_CONCURRENCY, ProduceAssetsUseCase } from './produce/produce-assets';
export type {
  AssetVersionRegistrarPort,
  BakePlan,
  DemandPlannerPort,
  ProduceAssetsDeps,
  ProduceAssetsInput,
  ProduceAssetsOutput,
  ProduceFailure,
  ProduceLedgerPort,
  ProduceLedgerSummary,
  ProduceProgress,
  ProduceStatus,
  ProducedAsset,
  RejectedAsset,
  ReusedAsset,
  SkippedAsset,
  StepTally,
  UsagePricerPort,
} from './produce/produce-assets';

// ── shared ──────────────────────────────────────────────────────────────────
export { contentId } from './content-ids';
