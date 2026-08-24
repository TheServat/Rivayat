/**
 * The orchestration surface `apps/cli` may import, so there is one pipeline and not two.
 *
 * ## Why this file exists
 *
 * `rv run` and `POST /api/runs` are the same operation reached two ways, and until this
 * existed they were two *implementations* of it: the CLI could not import
 * `PipelineRunner` - the app had no `exports` map and the runner sat in `src/pipeline/`
 * behind four internal collaborators - so it sequenced its own verbs instead. Two
 * orchestrators over one state machine drift, and they drift silently, because each one
 * passes its own tests.
 *
 * ## Why the runner rather than HTTP
 *
 * Driving the API over HTTP was the alternative and it is worse for the case the CLI
 * exists to serve: `rv run --fake-providers` in CI would need a server to be running,
 * a port to be free, and a process to be reaped, in order to execute work that is
 * entirely local. `PipelineRunner` is already framework-free - no Nest decorators, no
 * HTTP types, constructor injection of plain interfaces - so exporting it costs
 * nothing structurally and removes a whole class of divergence.
 *
 * What a caller has to supply is exactly the four ports the runner declares: a
 * `JobQueue` (use {@link InProcessJobQueue}), a `RunRepository`, a `RunPayloadStore` and
 * a `StageRegistry`. Everything needed to build those from nothing but a database handle
 * and a workspace directory is exported here.
 *
 * ## What is deliberately *not* here
 *
 * Controllers, modules, `AppModule` and `bootstrap`. Those are the delivery layer, and a
 * CLI that imported them would be starting an HTTP server to avoid starting an HTTP
 * server. The dependency rule still points inward: this file re-exports application-layer
 * types and this app's own infrastructure adapters, and nothing that imports it gains
 * access to a vendor SDK it could not already reach.
 */

// ── the runner and what a stage is ──────────────────────────────────────────
export { PipelineRunner, stageInputHash } from './pipeline/pipeline-runner.service';
export type { PipelineRunnerDeps, StartRunRequest } from './pipeline/pipeline-runner.service';
export { buildStageRegistry } from './pipeline/stage';
export type {
  StageContext,
  StageHandler,
  StageOutput,
  StageProgress,
  StageRegistry,
} from './pipeline/stage';
export {
  IntakeStageHandler,
  ResolveStageHandler,
  StubStageHandler,
  STAGE_OWNER,
} from './pipeline/handlers';

// ── S10, which is the stage with something to resume ────────────────────────
export { RenderStageHandler, renderLayout } from './render/render-stage.handler';
export type { RenderStageHandlerDeps, RenderLayout } from './render/render-stage.handler';
export {
  RenderStagePayload,
  RenderStageRequest,
  renderKey,
  renderSize,
} from './render/render-stage.contracts';
export {
  PinnedCheckpointStore,
  VerifiedFileFrameStore,
  expectedFrameBytes,
} from './render/render-stores';

// ── compositions, reframing and delivery ────────────────────────────────────
export { CompositionStore } from './modules/compositions/composition.store';
export type { CompositionStoreOptions } from './modules/compositions/composition.store';
export {
  CompositionList,
  CompositionSummary,
  StoreCompositionBody,
  StoredComposition,
} from './modules/compositions/compositions.contracts';
export { ReframeService, REFRAMABLE_FORMATS } from './render/reframe.service';
export { ReframeBody, ReframePlanSet, DEFAULT_FOCUS_REGION } from './render/reframe.contracts';
export { DeliveryService, renderKeyOf } from './render/delivery.service';
export { DeliveredFile, RunDelivery, DELIVERY_MANIFEST_FILE } from './render/delivery.contracts';

// ── transport ───────────────────────────────────────────────────────────────
export { InProcessJobQueue, DEFAULT_RETRY_POLICY } from './queue/in-process.queue';
export type { InProcessQueueOptions, RetryPolicy } from './queue/in-process.queue';
export type { JobHandler, JobQueue, QueueDriver, QueuedJob } from './queue/job-queue.port';

// ── events ──────────────────────────────────────────────────────────────────
export { RunEventBus } from './events/run-event-bus';
export type { RunEventBusOptions } from './events/run-event-bus';
export { RunEvent, ProgressItem, isTerminalEvent } from './events/run-event';
export type { RunEventDraft } from './events/run-event';

// ── cost ────────────────────────────────────────────────────────────────────
export { CostService } from './cost/cost.service';
export type { CostServiceOptions, RunBudget } from './cost/cost.service';
export { MeteredCallRunner } from './cost/metered-call';
export type { MeteredCallSpec, MeteredOutcome } from './cost/metered-call';
export { LedgerService } from './cost/ledger.service';
export {
  CostReport,
  RunCostRow,
  buildCostReport,
  buildRunLedger,
  perDeliveredMinute,
  reconcile,
  summarise,
} from './cost/cost-report';
export type { LedgerReconciliation, RunCostInput } from './cost/cost-report';

// ── storage ports and this app's adapters for them ──────────────────────────
export type {
  EpisodeRepository,
  ProjectPatch,
  ProjectRepository,
  RunRepository,
  SeriesRepository,
  StyleBibleReader,
} from './application/ports/repository.ports';
export type { RunPayloadStore } from './application/ports/run-payload.port';
export { DrizzleRunRepository } from './infrastructure/persistence/drizzle-run.repository';
export { JsonFileRunPayloadStore } from './infrastructure/persistence/json-file-run-payload.store';

// ── the resources a caller renders ──────────────────────────────────────────
export {
  Project,
  RunStageResult,
  RunStatus,
  RunSummary,
  SeriesCard,
  TERMINAL_RUN_STATUSES,
  deliveredMsOf,
  isTerminalRunStatus,
} from './application/resources';
