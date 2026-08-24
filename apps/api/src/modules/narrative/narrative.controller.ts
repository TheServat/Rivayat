/**
 * The narrative graph over HTTP: the world model, one character's head, and the grid.
 *
 * Three of the routes here are what the Characters screen named. The fourth -
 * `GET /entities/:entityId/view` - is the one that makes the screen's central claim
 * checkable rather than decorative.
 *
 * ## The trap in the epistemic view, and the diff
 *
 * `apps/web/src/features/characters/api/epistemic.ts` is a deliberate line-for-line port
 * of `BiTemporalIndex` from `@rv/core-domain`, written so the two could be diffed the
 * day this endpoint landed. They have been diffed and **they agree**: `isValidAt` (both
 * half-open, both with `DAWN`/`HORIZON` at `Number.MIN_SAFE_INTEGER` /
 * `MAX_SAFE_INTEGER`), `wasKnownAt`, `isCurrent`, `knowledgeOf`, and - the one that
 * matters - `couldKnow`, including its `INFORMS_THE_OBJECT = {'told'}` exemption and its
 * narrowing to `secret` only.
 *
 * The rule both encode: **being the object of a secret is not knowing it.** "Aria is a
 * parent of Kael", kept secret, is precisely the fact kept *from* Kael, and Kael is its
 * object. A projection that treats every participant as a knower answers "yes" for the
 * single fact the whole epistemic layer exists to withhold.
 *
 * The one asymmetry is not a disagreement: the client's `Standpoint` requires both
 * clocks, while the domain's `TemporalStandpoint` makes both optional and treats an
 * absent authoring standpoint as "current belief" rather than as an instant. This
 * endpoint always supplies both - `at` defaults to the latest moment the series uses and
 * `asOf` to the injected clock's now - so the two evaluate identically. That is why the
 * defaults are in `SnapshotService` and not in the client.
 *
 * ## Report - the state grid's estimate line is 0
 *
 * `CharacterStateCell.estimateNanoUsd` is `0` on every cell S3 writes. Pricing one needs
 * an `AssetSpec` (`FlatRateAssetCostEstimator` is `rate[quality] * parts.length`) and S3
 * does not build one; S4 does. `POST /api/assets/resolve` is the right place for the
 * estimate and now has what it was missing - the studio's own note said it "needs an
 * `AssetSpec` the studio cannot assemble without the state grid it is trying to price",
 * and the grid exists as of this change.
 */

import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  EntityId,
  EpisodeId,
  Scene,
  SeriesId,
  type ContinuityIssue,
  type EpistemicView,
  type MemoryRetrievalResult,
} from '@rv/contracts';
import type { Result } from '@rv/shared-kernel';

import type { NarrativeMemoryPort } from '../../application/ports/engine.ports';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { EpistemicViewQuery, type NarrativeSnapshot } from '../../narrative/snapshot.contracts';
import type { SnapshotService } from '../../narrative/snapshot.service';
import { SNAPSHOT_SERVICE } from '../../narrative/narrative.tokens';
import {
  CharacterStateEdit,
  type CharacterStateCell,
  type CharacterStates,
} from '../../story/cast.contracts';
import type { CharacterStateStore } from '../../story/cast.store';
import { CHARACTER_STATE_STORE } from '../../story/story.tokens';
import { NARRATIVE_MEMORY_PORT } from '../../tokens';
import { RetrieveMemoryBody, VariantKeyParam } from './narrative.contracts';

@Controller()
export class NarrativeController {
  readonly #memory: NarrativeMemoryPort;
  readonly #snapshots: SnapshotService;
  readonly #states: CharacterStateStore;

  constructor(
    @Inject(NARRATIVE_MEMORY_PORT) memory: NarrativeMemoryPort,
    @Inject(SNAPSHOT_SERVICE) snapshots: SnapshotService,
    @Inject(CHARACTER_STATE_STORE) states: CharacterStateStore,
  ) {
    this.#memory = memory;
    this.#snapshots = snapshots;
    this.#states = states;
  }

  // ── the graph ─────────────────────────────────────────────────────────────

  /**
   * The whole world model for a series, with the stops for both sliders.
   *
   * A series with no entities answers with an empty snapshot rather than a 404: "no
   * world model yet" is an empty screen and an invitation to build one, and the studio's
   * gateway distinguishes that from a missing route by the status code alone.
   */
  @Get('series/:seriesId/graph')
  graph(
    @Param('seriesId', new ZodValidationPipe(SeriesId)) seriesId: SeriesId,
  ): Promise<Result<NarrativeSnapshot>> {
    return this.#snapshots.snapshot(seriesId);
  }

  /**
   * One character's head, at one point on each clock.
   *
   * `at` is a story ordinal and `asOf` an ISO instant, both optional and meaning
   * different things when omitted - see `EpistemicViewQuery`.
   */
  @Get('series/:seriesId/entities/:entityId/view')
  view(
    @Param('seriesId', new ZodValidationPipe(SeriesId)) seriesId: SeriesId,
    @Param('entityId', new ZodValidationPipe(EntityId)) entityId: EntityId,
    @Query(new ZodValidationPipe(EpistemicViewQuery)) query: EpistemicViewQuery,
  ): Promise<Result<EpistemicView>> {
    return this.#snapshots.view(seriesId, entityId, query);
  }

  // ── the state grid ────────────────────────────────────────────────────────

  /** Every `(outfit × state)` S3 decided this character needs, with its prompt. */
  @Get('series/:seriesId/entities/:entityId/states')
  states(
    @Param('seriesId', new ZodValidationPipe(SeriesId)) seriesId: SeriesId,
    @Param('entityId', new ZodValidationPipe(EntityId)) entityId: EntityId,
  ): Promise<Result<CharacterStates>> {
    return this.#states.load(seriesId, entityId);
  }

  /**
   * Rewrites one cell's prompt, and marks exactly that cell stale.
   *
   * An edited prompt is a different `specHash`, so exactly this cell becomes a cache
   * miss - and the grid says so *before* anything is regenerated. Marking the whole
   * character stale would invalidate artwork that is still correct; marking nothing
   * would let the next produce run silently serve the old image for the new prompt.
   */
  @Patch('series/:seriesId/entities/:entityId/states/:variantKey')
  editState(
    @Param('seriesId', new ZodValidationPipe(SeriesId)) seriesId: SeriesId,
    @Param('entityId', new ZodValidationPipe(EntityId)) entityId: EntityId,
    @Param('variantKey', new ZodValidationPipe(VariantKeyParam)) variantKey: string,
    @Body(new ZodValidationPipe(CharacterStateEdit)) edit: CharacterStateEdit,
  ): Promise<Result<CharacterStateCell>> {
    return this.#states.replaceCell(seriesId, entityId, variantKey, (cell) => ({
      ...cell,
      prompt: edit.prompt,
      status: 'stale',
    }));
  }

  /**
   * Queues one cell for generation.
   *
   * **This does not draw anything, and says so.** S6 Produce owns image generation and is
   * still a stub; a route here that returned `ready` with an invented `imageHash` would
   * be a fake the studio integrates against and discovers later. So the cell moves to
   * `generating` - which is a true statement about a cell somebody has asked for - and
   * the artwork arrives when S6 lands.
   *
   * Held at `generating` rather than answering 501, because the cell *has* changed: the
   * request is recorded, it survives a reload, and the screen has something honest to
   * render. A 501 would leave the grid saying `missing` for a cell the user just clicked.
   */
  @Post('series/:seriesId/entities/:entityId/states/:variantKey/generate')
  generateState(
    @Param('seriesId', new ZodValidationPipe(SeriesId)) seriesId: SeriesId,
    @Param('entityId', new ZodValidationPipe(EntityId)) entityId: EntityId,
    @Param('variantKey', new ZodValidationPipe(VariantKeyParam)) variantKey: string,
  ): Promise<Result<CharacterStateCell>> {
    return this.#states.replaceCell(seriesId, entityId, variantKey, (cell) => ({
      ...cell,
      status: 'generating',
    }));
  }

  // ── the memory port ───────────────────────────────────────────────────────

  /**
   * Folds a written scene into the graph.
   *
   * Still bound to `NarrativeMemoryPort`, which is a stub. The *pipeline* path is real -
   * S4 World runs `ExtractSceneDeltaUseCase` and `FoldStateDeltaUseCase` over the
   * outline's scenes - and this route is the single-scene interactive form of the same
   * work, which needs a place to put the entities a scene introduces before it can be
   * honest. See `narrative/world-stage.handler.ts`.
   */
  @Post('narrative/series/:seriesId/scenes')
  ingest(
    @Param('seriesId', new ZodValidationPipe(SeriesId)) seriesId: SeriesId,
    @Body(new ZodValidationPipe(Scene)) scene: Scene,
  ): Promise<Result<readonly ContinuityIssue[]>> {
    return this.#memory.ingestScene(seriesId, scene);
  }

  @Get('narrative/episodes/:episodeId/continuity')
  continuity(
    @Param('episodeId', new ZodValidationPipe(EpisodeId)) episodeId: EpisodeId,
  ): Promise<Result<readonly ContinuityIssue[]>> {
    return this.#memory.checkContinuity(episodeId);
  }

  @Post('narrative/retrieve')
  retrieve(
    @Body(new ZodValidationPipe(RetrieveMemoryBody)) body: RetrieveMemoryBody,
  ): Promise<Result<MemoryRetrievalResult>> {
    return this.#memory.retrieve(body);
  }
}
