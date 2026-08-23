/**
 * `@rv/narrative-memory` - the engine that makes a *series* possible.
 *
 * A single short needs no memory: the whole story fits in one prompt. By episode six the
 * scene writer needs to know who is alive, who is where, who is carrying what, who
 * believes a lie, and which setup from episode two is still unpaid - as a **bounded**
 * context, not a dump (ADR-0004).
 *
 * Six capabilities, in the order the pipeline uses them:
 *
 * 1. **extract** - scene text becomes a `StateDelta`, with names resolved to ids by us
 *    rather than invented by the model.
 * 2. **fold** - the delta is applied to the graph. A fact that stops being true is
 *    *bounded*, never deleted.
 * 3. **retrieve** - a scored, budgeted, deterministic slice of the graph, with the
 *    premise, the outline, the present cast and the POV character's view as an
 *    unconditional floor.
 * 4. **continuity** - a free exact rule pass, then a semantic pass over only what the
 *    rules could not decide. An `error` blocks airing; a `warning` does not.
 * 5. **compact** - the scene → episode → season → series ladder, so episode 20 can be
 *    planned without re-reading episodes 1-19.
 * 6. **loops** - planted setups, detected payoffs, and the promises still owed.
 *
 * The bi-temporal graph itself is not here. `BiTemporalIndex` in `@rv/core-domain` owns
 * as-of queries on both clocks, `knowledgeOf`, `couldKnow`, `neighbourhood` and
 * structural contradiction detection; this package builds on it and never duplicates it.
 */

// ── the graph state everything is a function of ─────────────────────────────
export { NarrativeGraph, compareStrings } from './graph/narrative-graph';
export type { NarrativeGraphInput, VitalityRecord } from './graph/narrative-graph';

export {
  deriveId,
  deriveEntityId,
  deriveFactId,
  deriveIssueId,
  deriveOpenLoopId,
  deriveRelationId,
  seed,
} from './graph/derive-id';

export { DEFAULT_VIEW_CAP, buildEpistemicView, isOmniscient } from './graph/epistemic-view';
export type { EpistemicViewOptions } from './graph/epistemic-view';

// ── 1. extraction ───────────────────────────────────────────────────────────
export {
  OBSERVED_POLARITIES,
  ObservedEntity,
  ObservedKnowledge,
  ObservedMovement,
  ObservedPolarity,
  ObservedPossession,
  ObservedRelation,
  ObservedSetup,
  ObservedVitality,
  SCENE_OBSERVATION_SYSTEM_PROMPT,
  SceneObservations,
} from './extract/observations';

export { UNRESOLVED_REASONS, MentionResolver, ResolutionLog } from './extract/coreference';
export type { MentionResolution, UnresolvedMention, UnresolvedReason } from './extract/coreference';

export { ExtractSceneDeltaUseCase } from './extract/extract-scene-delta';
export type {
  ExtractSceneDeltaDeps,
  ExtractSceneDeltaInput,
  ExtractedScene,
  IntroducedEntity,
  UnmatchedRetraction,
} from './extract/extract-scene-delta';

// ── 2. folding ──────────────────────────────────────────────────────────────
export { SKIP_REASONS, FoldStateDeltaUseCase } from './fold/fold-state-delta';
export type {
  BoundedRelation,
  FoldResult,
  FoldStateDeltaDeps,
  FoldStateDeltaInput,
  SkipReason,
  SkippedChange,
} from './fold/fold-state-delta';

export { foldWorldState } from './fold/world-state';
export type { WorldStateOptions } from './fold/world-state';

// ── 3. retrieval ────────────────────────────────────────────────────────────
export { DEFAULT_TOKEN_COUNTER, PER_FACT_OVERHEAD_TOKENS, estimateTokens } from './retrieve/tokens';
export type { TokenCounter } from './retrieve/tokens';

export {
  IMPORTANCE_SCORE,
  ZERO_BREAKDOWN,
  importanceScore,
  proximityScore,
  recencyScore,
  similarityScore,
  weightedTotal,
} from './retrieve/scoring';

export {
  renderEntitySheet,
  renderEpisodeOutline,
  renderEpistemicView,
  renderFact,
  renderOpenLoop,
  renderPremise,
  renderRelation,
} from './retrieve/render';

export { RetrieveSceneContextUseCase } from './retrieve/retrieve-scene-context';
export type {
  RetrieveSceneContextDeps,
  RetrieveSceneContextInput,
} from './retrieve/retrieve-scene-context';

// ── 4. continuity ───────────────────────────────────────────────────────────
export { FactCitations } from './continuity/citations';

export { runContinuityRules } from './continuity/rules';
export type {
  ContinuityRuleInput,
  ContinuityRuleOptions,
  ContinuityRuleReport,
  KnowledgeUse,
  PropUse,
  SceneUnderCheck,
  StatedAge,
  WardrobeUse,
} from './continuity/rules';

export {
  SEMANTIC_RULES,
  SEMANTIC_SYSTEM_PROMPT,
  RunSemanticContinuityPassUseCase,
  SemanticContinuityFindings,
  SemanticFinding,
} from './continuity/semantic-pass';
export type {
  SemanticContinuityDeps,
  SemanticContinuityInput,
  SemanticContinuityOutput,
} from './continuity/semantic-pass';

export { CheckEpisodeContinuityUseCase } from './continuity/check-episode-continuity';
export type {
  CheckEpisodeContinuityDeps,
  CheckEpisodeContinuityInput,
  ContinuityReport,
} from './continuity/check-episode-continuity';

export { AirEpisodeUseCase } from './continuity/air-episode';
export type { AirEpisodeDeps, AirEpisodeInput, AiredEpisode } from './continuity/air-episode';

// ── 5. compaction ───────────────────────────────────────────────────────────
export {
  COMPACTION_SYSTEM_PROMPT,
  ArcMovementDraft,
  EpisodeSummaryDraft,
  SeasonSummaryDraft,
  SeriesSummaryDraft,
} from './compact/drafts';

export {
  DEFAULT_EPISODE_SUMMARY_TOKENS,
  CompactEpisodeUseCase,
  episodeSummaryTokens,
} from './compact/compact-episode';
export type {
  CompactEpisodeDeps,
  CompactEpisodeInput,
  CompactEpisodeOutput,
  CompactionManifest,
  SceneForCompaction,
} from './compact/compact-episode';

export {
  DEFAULT_SEASON_SUMMARY_TOKENS,
  CompactSeasonUseCase,
  carriedLoops,
  spanOf,
} from './compact/compact-season';
export type {
  CompactSeasonDeps,
  CompactSeasonInput,
  CompactSeasonOutput,
} from './compact/compact-season';

export { DEFAULT_SERIES_SUMMARY_TOKENS, CompactSeriesUseCase } from './compact/compact-series';
export type {
  CompactSeriesDeps,
  CompactSeriesInput,
  CompactSeriesOutput,
} from './compact/compact-series';

// ── 6. open loops ───────────────────────────────────────────────────────────
export {
  DEFAULT_STALE_AFTER_EPISODES,
  TrackOpenLoopsUseCase,
  reportOpenLoops,
} from './loops/track-open-loops';
export type {
  OpenLoopReport,
  OpenLoopReportOptions,
  OpenLoopStanding,
  PaidLoop,
  TrackOpenLoopsInput,
} from './loops/track-open-loops';
