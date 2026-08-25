/**
 * The story tree over HTTP: read it, grow it by one level, edit a node, regrow a subtree.
 *
 * These are the four routes the Story screen named, plus the one it could not do without
 * and had no way to ask for - correcting the premise it shows in its own empty state.
 *
 * **There is no "build the whole tree" route, and there will not be one.** The studio
 * implements "build the rest" as a *loop* over `POST /outline/expand`, publishing each
 * level as it lands, precisely because the outliner is DOC-shaped: every child is bound
 * to what its parent asked for, and the engine refuses an expansion that cannot quote
 * that instruction back. A route that descended three levels in one request would move
 * the bypass into the transport, where the engine's guard cannot see it - and the
 * failure it would reintroduce is the one the whole technique exists to prevent: twelve
 * good scenes for episode one, and no antagonist by episode seven.
 *
 * ## Report - the cost of an interactive expansion is not in the ledger
 *
 * Non-negotiable #3 wants a guard before the spend and a row after it. `CostService` is
 * keyed on a `RunId` - `RunBudget` is `{ runId, perRunNanoUsd }` and `appendUsage`
 * writes against `runs` - and an expansion made from this screen is not a run. So the
 * spend on these three routes is **reported in the response** (`spentNanoUsd`, and
 * per-node in `provenance.costNanoUsd`) and is not written to `usage_records`. The
 * pipeline path is fully metered; this one is not. Closing it needs either a `RunId` on
 * the request or a project-scoped ledger row with a nullable run, and that is a decision
 * about the cost model rather than about this controller.
 */

import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { SeriesId } from '@rv/contracts';
import {
  NotFoundError,
  err,
  isErr,
  ok,
  toIso,
  type Clock,
  type Logger,
  type Result,
} from '@rv/shared-kernel';
import { IntakeUseCase } from '@rv/story-engine';
import { z } from 'zod';

import type { SeriesRepository } from '../../application/ports/repository.ports';
import type { SeriesCard } from '../../application/resources';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { storedContextOf, type OutlineService } from '../../story/outline.service';
import { contextFor } from '../../story/story-stage.handler';
import type { StoryEngineFactory } from '../../story/story-engine.deps';
import {
  ExpandOutlineBody,
  IntakeReport,
  RunIntakeBody,
  StoryNodeEdit,
  UpdateSeriesBody,
  type StoryExpansion,
  type StoryNode,
  type StoryTree,
} from '../../story/story.contracts';
import type { StoryStore } from '../../story/story.store';
import { OUTLINE_SERVICE, STORY_ENGINE_FACTORY, STORY_STORE } from '../../story/story.tokens';
import { CLOCK, LOGGER, SERIES_REPOSITORY } from '../../tokens';

/**
 * A node id arrives as a bare string, and that is deliberate.
 *
 * Every level below `series` is minted with its own branded id and the root is addressed
 * by the `SeriesId` itself, so a validated parameter would be a seven-way union narrowed
 * at every call site to say nothing extra. The *lookup* decides whether the id names
 * anything, and answers `NOT_FOUND` when it does not - which is the same answer a
 * well-formed id for a deleted node deserves.
 */
const NodeIdParam = z.string().trim().min(1).max(64);

@Controller()
export class StoryController {
  readonly #outline: OutlineService;
  readonly #store: StoryStore;
  readonly #series: SeriesRepository;
  readonly #engine: StoryEngineFactory;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(
    @Inject(OUTLINE_SERVICE) outline: OutlineService,
    @Inject(STORY_STORE) store: StoryStore,
    @Inject(SERIES_REPOSITORY) series: SeriesRepository,
    @Inject(STORY_ENGINE_FACTORY) engine: StoryEngineFactory,
    @Inject(CLOCK) clock: Clock,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.#outline = outline;
    this.#store = store;
    this.#series = series;
    this.#engine = engine;
    this.#clock = clock;
    this.#logger = logger.child({ component: 'story' });
  }

  /**
   * The whole tree, flat.
   *
   * Flat rather than nested because a tree that is still growing has an act with no
   * sequences yet, and a nested schema calls that invalid. An empty tree is a 200 with
   * no nodes, never a 404: "this series has not been outlined" is the screen's empty
   * state, and a not-found there is indistinguishable from a route that does not exist.
   */
  @Get('series/:seriesId/outline')
  async outline(
    @Param('seriesId', new ZodValidationPipe(SeriesId)) seriesId: SeriesId,
  ): Promise<Result<StoryTree>> {
    const found = await this.#series.findById(seriesId);
    if (isErr(found)) return found;
    if (found.value === null) return err(new NotFoundError('series', seriesId));
    return this.#store.tree(seriesId);
  }

  /**
   * Grows the tree by exactly one level.
   *
   * `series` is the one level that is *planted* rather than expanded: its parent is the
   * brief, and asking a model to restate a premise the author just typed is asking it to
   * paraphrase canon. So it is free, instant, and marked `author`.
   */
  /**
   * S0, run on demand from the Story screen.
   *
   * The stage that produces the normalised brief every later stage binds to - including
   * the cast shortlist S3 refuses to run without. It ran only inside a pipeline run, so
   * a series outlined level-by-level from this screen ended up with a complete tree and
   * no shortlist, and the Characters screen could never build anything. The screen
   * listed S0 in its own model panel the whole time and had no way to run it.
   *
   * It writes the context and the shortlist onto the stored document but does **not**
   * expand any level. Intake and outlining are separate decisions - one reads the idea,
   * the other spends money per level - and folding them together would make re-running
   * intake after an edited premise cost a whole tree.
   */
  /**
   * What S0 left behind, or an empty shortlist if it never ran.
   *
   * A 200 with `castCandidates: []` rather than a 404, for the same reason the empty
   * outline is a 200: "S0 has not run for this series" is a state the screen renders and
   * offers to fix, and a not-found there is indistinguishable from a route that does not
   * exist. Without this the studio could run intake and never find out whether it had.
   */
  @Get('series/:seriesId/intake')
  async intakeReport(
    @Param('seriesId', new ZodValidationPipe(SeriesId)) seriesId: SeriesId,
  ): Promise<Result<IntakeReport>> {
    const found = await this.#series.findById(seriesId);
    if (isErr(found)) return found;
    if (found.value === null) return err(new NotFoundError('series', seriesId));

    const document = await this.#store.load(seriesId);
    if (isErr(document)) return document;

    return ok({
      seriesId,
      workingTitle: found.value.title,
      premise: found.value.premise,
      castCandidates: [...document.value.castCandidates],
    });
  }

  @Post('series/:seriesId/intake')
  async intake(
    @Param('seriesId', new ZodValidationPipe(SeriesId)) seriesId: SeriesId,
    @Body(new ZodValidationPipe(RunIntakeBody)) body: RunIntakeBody,
  ): Promise<Result<IntakeReport>> {
    const found = await this.#series.findById(seriesId);
    if (isErr(found)) return found;
    if (found.value === null) return err(new NotFoundError('series', seriesId));

    const result = await new IntakeUseCase(this.#engine.create(this.#logger)).execute({
      brief: body.brief,
    });
    if (isErr(result)) return result;

    const context = contextFor(result.value.brief, undefined);
    const recorded = await this.#store.mutate(seriesId, (document) =>
      ok({
        ...document,
        context: storedContextOf(context),
        castCandidates: [...result.value.brief.castCandidates],
      }),
    );
    if (isErr(recorded)) return recorded;

    // The premise the author typed is corrected to the one intake normalised, because
    // every expansion below binds to *that* text - and a screen still showing the
    // original would be showing something no stage is reading.
    const updated = await this.#series.update(
      seriesId,
      { title: result.value.brief.workingTitle, premise: result.value.brief.premise },
      toIso(this.#clock.now()),
    );
    if (isErr(updated)) return updated;

    return ok({
      seriesId,
      workingTitle: result.value.brief.workingTitle,
      premise: result.value.brief.premise,
      castCandidates: [...result.value.brief.castCandidates],
    });
  }

  @Post('series/:seriesId/outline/expand')
  async expand(
    @Param('seriesId', new ZodValidationPipe(SeriesId)) seriesId: SeriesId,
    @Body(new ZodValidationPipe(ExpandOutlineBody)) body: ExpandOutlineBody,
  ): Promise<Result<StoryExpansion>> {
    const found = await this.#series.findById(seriesId);
    if (isErr(found)) return found;
    if (found.value === null) return err(new NotFoundError('series', seriesId));

    const grown =
      body.level === 'series'
        ? await this.#outline.plantRoot({
            seriesId,
            title: found.value.title,
            premise: found.value.premise,
          })
        : await this.#outline.expandLevel(
            this.#engine.create(this.#logger),
            seriesId,
            body.level,
            body.childCount === undefined ? {} : { childCount: body.childCount },
          );

    // The traces are dropped here on purpose. They carry token counts for a ledger row
    // this route cannot write - see the file header - and `spentNanoUsd` on the
    // expansion is what the screen renders.
    return isErr(grown) ? grown : ok(grown.value.expansion);
  }

  /**
   * Rewrites one node.
   *
   * The previous version is appended to `history`, and the descendants are either marked
   * `stale` or dropped - the caller's explicit choice, made while looking at how many
   * there are. Nothing is deleted behind the user's back, which is what makes "keep the
   * children" a real answer rather than a label on a destructive act.
   */
  @Patch('story/nodes/:nodeId')
  async editNode(
    @Param('nodeId', new ZodValidationPipe(NodeIdParam)) nodeId: string,
    @Body(new ZodValidationPipe(StoryNodeEdit)) edit: StoryNodeEdit,
  ): Promise<Result<StoryNode>> {
    const edited = await this.#outline.editNode(nodeId, edit);
    return isErr(edited) ? edited : ok(edited.value.node);
  }

  /** Rebuilds one node's children. A sibling's subtree is untouched. */
  @Post('story/nodes/:nodeId/regenerate')
  async regenerate(
    @Param('nodeId', new ZodValidationPipe(NodeIdParam)) nodeId: string,
  ): Promise<Result<StoryExpansion>> {
    const grown = await this.#outline.regenerateNode(this.#engine.create(this.#logger), nodeId);
    return isErr(grown) ? grown : ok(grown.value.expansion);
  }

  /**
   * Corrects the title or the premise.
   *
   * The premise is the one piece of authored text every later stage is derived from -
   * the outline binds to it, the cast is written against it, and the Story screen shows
   * it in its empty state beside the button that spends money on it. It could not be
   * edited anywhere in the product.
   *
   * The stored outline's *context* is left alone deliberately: an outline already grown
   * against the old premise is not retroactively bound to the new one, and silently
   * rewriting the context would make the next expansion bind to an instruction none of
   * its siblings were given. Re-running S2 re-binds it; editing the series root node
   * re-binds that node.
   */
  @Patch('series/:id')
  async updateSeries(
    @Param('id', new ZodValidationPipe(SeriesId)) id: SeriesId,
    @Body(new ZodValidationPipe(UpdateSeriesBody)) body: UpdateSeriesBody,
  ): Promise<Result<SeriesCard>> {
    return this.#series.update(
      id,
      {
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.premise === undefined ? {} : { premise: body.premise }),
      },
      toIso(this.#clock.now()),
    );
  }
}
