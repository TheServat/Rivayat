/**
 * `@rv/style-engine` - stage S1, where the look and the movement are decided together.
 *
 * Three ways in - a preset off the shelf, a derivation from reference images, or the
 * guided wizard - all converging on one `StyleBibleDraft`, which becomes a `StyleBible`,
 * which gets probed and locked. After the lock its checksum is part of every asset key,
 * so nothing downstream can drift from it without forking the library.
 *
 * The rule that shapes every module here: **the prompt text is compiled from the
 * structured fields, never written**. That is what makes `shading.steps` a control
 * rather than a decoration, and it is why no preset, no wizard answer and no vision
 * model ever supplies a `promptFragments` string.
 */

// ── the bible ───────────────────────────────────────────────────────────────
export type { MaterialiseStyleBibleInput } from './style-bible-factory';
export { materialiseStyleBible } from './style-bible-factory';

// ── presets ─────────────────────────────────────────────────────────────────
export {
  MOTION_DISTINCTNESS_FLOOR,
  PRESET_DEFINITIONS,
  STYLE_PRESETS,
  findPreset,
  motionDifferences,
  motionDistance,
  motionSignature,
  presetIds,
  presetsForMedium,
  toStylePreset,
} from './presets/index';
export type {
  MotionSignature,
  PresetDraftOptions,
  StylePreset,
  StylePresetDefinition,
} from './presets/index';

// ── prompt compilation ──────────────────────────────────────────────────────
export type { PromptCompilerInput } from './prompts/compile';
export {
  compileNegativeClause,
  compilePositiveClause,
  compilePromptFragments,
} from './prompts/compile';
export type { ComposeStylePromptInput, ComposedPrompt } from './prompts/compose';
export { composeStylePrompt } from './prompts/compose';
export type { MediumPhrasing } from './prompts/medium';
export { BACKGROUND_PHRASING, MEDIUM_PHRASING, UNIVERSAL_NEGATIVES } from './prompts/medium';
export { compileModelOverrides, compileTagPrompt } from './prompts/model-phrasing';
export { SUBJECT_CLAUSES } from './prompts/subject';
export type { BandWords } from './prompts/words';
export {
  BAND_EDGES,
  band,
  bandIndex,
  dedupeStable,
  joinClauses,
  lightDirectionPhrase,
  plural,
} from './prompts/words';

// ── ports ───────────────────────────────────────────────────────────────────
export type { RasterPort, RgbaImage } from './ports/raster';

// ── colour ──────────────────────────────────────────────────────────────────
export type { Oklab } from './colour/oklab';
export { oklabDistance, parseHex, rgbToOklab, toHex } from './colour/oklab';
export type {
  ExtractPaletteOptions,
  MeasureAdherenceOptions,
  MeasuredPalette,
  PaletteAdherence,
  PaletteSwatch,
} from './colour/palette';
export { PALETTE_TOLERANCE, extractPalette, measurePaletteAdherence } from './colour/palette';

// ── derivation ──────────────────────────────────────────────────────────────
export type { StyleObservations, Presence, SurfaceImpression } from './derive/observations';
export { StyleObservations as StyleObservationsSchema } from './derive/observations';
export { DERIVE_SYSTEM_PROMPT, buildDerivePrompt } from './derive/prompt';
export type { MapObservationsInput } from './derive/map-observations';
export { basePresetForMedium, observationsToDraft } from './derive/map-observations';
export type {
  DeriveStyleFromReferencesDeps,
  DeriveStyleFromReferencesInput,
  DerivedStyleProposal,
  StyleReference,
} from './derive/derive-style';
export { DeriveStyleFromReferencesUseCase } from './derive/derive-style';

// ── wizard ──────────────────────────────────────────────────────────────────
export type {
  WizardAnswers,
  WizardOption,
  WizardQuestion,
  WizardVisibility,
} from './wizard/questions';
export {
  BASE_QUESTION_ID,
  WIZARD_QUESTIONS,
  defaultAnswers,
  nextQuestion,
  visibleQuestions,
} from './wizard/questions';
export type { MotionPatch, StyleFieldPatch } from './wizard/patch';
export { applyMotionPatch, applyVisualPatch } from './wizard/patch';
export { checkStyleCoherence } from './wizard/coherence';
export type { ComposeWizardStyleInput } from './wizard/compose';
export { composeStyleDraft } from './wizard/compose';

// ── probe ───────────────────────────────────────────────────────────────────
export type { ProbeSubject } from './probe/subjects';
export { PROBE_SUBJECTS } from './probe/subjects';
export type {
  GenerateStyleProbeDeps,
  GenerateStyleProbeInput,
  StyleProbeLane,
  StyleProbeSheet,
  StyleProbeTile,
} from './probe/generate-probe';
export { GenerateStyleProbeUseCase } from './probe/generate-probe';

// ── scoring ─────────────────────────────────────────────────────────────────
export type { BuildStyleRubricOptions } from './score/rubric';
export {
  ALPHA_KEY,
  IDENTITY_KEY,
  RUBRIC_WEIGHTS,
  SILHOUETTE_KEY,
  STYLE_MATCH_KEY,
  buildStyleRubric,
} from './score/rubric';
export type {
  ScoreStyleMatchDeps,
  ScoreStyleMatchInput,
  StyleScoreReport,
} from './score/score-style';
export { ScoreStyleMatchUseCase } from './score/score-style';
