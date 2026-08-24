/**
 * S4 World, wired for real: scenes become a bi-temporal graph, and the graph is checked.
 *
 * Four use-cases from `@rv/narrative-memory`, in the order the package's own header puts
 * them: extract, fold, loops, continuity.
 *
 *  1. `ExtractSceneDeltaUseCase` reads a scene and returns observations carrying
 *     **names**; the ids are resolved on our side by the mention resolver, never
 *     invented by the model, because an edge pointing at a node that does not exist is
 *     undetectable until something tries to render it.
 *  2. `FoldStateDeltaUseCase` applies the delta. **A fact that stops being true is
 *     bounded, not deleted** - `validUntil` is set and the row survives, so "what did
 *     Kael believe in episode five" is still answerable after the reveal in episode
 *     eight. That is the entire reason the store carries a story clock, and it is why
 *     the persistence below has an `update` path (`bound`) that only ever writes
 *     `validUntil`. `retractedAt` is an *authoring*-time event - we were wrong to have
 *     written it - and no scene can perform one.
 *  3. `TrackOpenLoopsUseCase` reports the promises still owed. Structural, not semantic:
 *     a `pays-off` edge reaching the loop, at or after it was planted. No model is asked
 *     whether a scene "felt like" a payoff, because the answer would differ on Tuesday.
 *  4. `CheckEpisodeContinuityUseCase` runs the free exact rules first and the model
 *     second, over only what the rules could not decide.
 *
 * **What this stage will not do: invent an entity sheet.** The extractor returns
 * `IntroducedEntity` drafts - a name, a kind, an importance and a sentence - and that is
 * deliberately not an `Entity`: a `CharacterPayload` needs psychology, voice, arc,
 * visual and motion signature, and a model asked for all of it while extracting
 * continuity produces confident filler. So an introduced entity is *reported* and the
 * edges that touch it are held back, rather than persisted against a node nobody wrote.
 * S3 writes the sheet; a second run of S4 then folds the edges that were waiting.
 */

import {
  Ids,
  type EntityId,
  type EpisodeId,
  type PipelineStageKey,
  type Relation,
  type SeriesId,
} from '@rv/contracts';
import {
  CheckEpisodeContinuityUseCase,
  ExtractSceneDeltaUseCase,
  FoldStateDeltaUseCase,
  TrackOpenLoopsUseCase,
  deriveEntityId,
  seed,
  type NarrativeGraph,
  type SceneUnderCheck,
} from '@rv/narrative-memory';
import type { StructuredTrace } from '@rv/prompt-kit';
import type { StageBackends } from '@rv/story-engine';
import {
  ValidationError,
  err,
  isErr,
  ok,
  type AppError,
  type Clock,
  type Logger,
  type Result,
} from '@rv/shared-kernel';
import { z } from 'zod';

import { toValidationError } from '../common/zod-validation.pipe';
import type { StageContext, StageHandler, StageOutput } from '../pipeline/stage';
import { meteredStageWork, type StageSpendDeps } from '../story/stage-spend';
import type { StoryStore } from '../story/story.store';
import type { NarrativeGraphStore } from './graph.store';

/** One scene as this stage consumes it, whether it came from the payload or the outline. */
export const WorldScene = z.strictObject({
  sceneId: z.string().min(1).max(64),
  episodeId: z.string().min(1).max(64),
  at: z.strictObject({ ordinal: z.number().int(), label: z.string().min(1).max(120).optional() }),
  text: z.string().trim().min(1).max(20_000),
});
export type WorldScene = z.infer<typeof WorldScene>;

export const WorldStageRequest = z.strictObject({
  /**
   * The scenes to fold. Absent means "read them off the outline".
   *
   * Present when a caller has real prose - S8 dialogue, an imported script - which is
   * strictly better material than a scene summary. Absent is the normal pipeline case,
   * because S4 runs before anything has been written.
   */
  scenes: z.array(WorldScene).max(512).optional(),
  /**
   * Spend money on the semantic continuity pass. Off by default.
   *
   * A pipeline running the check on every fold wants the free rule pass; the one gating
   * an air date wants both. That is the package's own default and this preserves it.
   */
  semantic: z.boolean().default(false),
  /** Episodes a promise may stay open before it is worth telling the showrunner. */
  staleAfterEpisodes: z.number().int().positive().max(64).optional(),
});
export type WorldStageRequest = z.infer<typeof WorldStageRequest>;

export interface WorldStageHandlerDeps extends StageSpendDeps {
  readonly graph: NarrativeGraphStore;
  readonly story: StoryStore;
  /**
   * The model chain for this stage.
   *
   * The port is declared by `@rv/story-engine` rather than by `@rv/narrative-memory`,
   * which takes a bare `StructuredBackend[]`. Reusing it here rather than writing a
   * second router-to-backend adapter is deliberate: two adapters would be two places
   * where "which model serves this stage" could be answered differently.
   */
  readonly backends: StageBackends;
  readonly ids: Ids;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class WorldStageHandler implements StageHandler {
  readonly stage: PipelineStageKey = 'world';
  readonly implemented = true;
  readonly #deps: WorldStageHandlerDeps;

  constructor(deps: WorldStageHandlerDeps) {
    this.#deps = deps;
  }

  async execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    const request = WorldStageRequest.safeParse(context.job.payload.world ?? {});
    if (!request.success) return err(toValidationError(request.error, 'run.payload.world'));

    const seriesId = context.run.seriesId;
    if (seriesId === null) {
      return err(
        new ValidationError({
          message: 'S4 world folds scenes into a series graph; this run names none',
          context: { reason: 'run-has-no-series', runId: context.run.id },
        }),
      );
    }

    const scenes = await this.#scenes(seriesId, request.data);
    if (isErr(scenes)) return scenes;

    const backends = this.#deps.backends.resolve({
      stage: 'world',
      task: 'continuity-check',
      tier: 'preview',
    });
    if (isErr(backends)) return backends;

    const logger = this.#deps.logger.child({ stage: 'world', runId: context.run.id });

    return meteredStageWork(
      this.#deps,
      {
        context,
        stage: 'world',
        task: 'continuity-check',
        tier: 'preview',
        // One extraction per scene, plus at most one semantic pass per episode.
        calls: scenes.value.length + (request.data.semantic ? scenes.value.length : 0),
      },
      (signal) =>
        this.#run(
          { context, logger, seriesId, signal },
          scenes.value,
          backends.value,
          request.data,
        ),
    );
  }

  async #run(
    scope: {
      readonly context: StageContext;
      readonly logger: Logger;
      readonly seriesId: SeriesId;
      readonly signal: AbortSignal | undefined;
    },
    scenes: readonly WorldScene[],
    backends: Parameters<typeof extractorFor>[0],
    request: WorldStageRequest,
  ): Promise<Result<{ value: StageOutput; traces: readonly StructuredTrace[] }, AppError>> {
    const loaded = this.#deps.graph.load(scope.seriesId);
    if (isErr(loaded)) return loaded;

    const extractor = extractorFor(backends, this.#deps.clock);
    const folder = new FoldStateDeltaUseCase({ clock: this.#deps.clock });

    let graph: NarrativeGraph = loaded.value;
    const traces: StructuredTrace[] = [];
    const artifacts: string[] = [];
    const introduced: string[] = [];
    const unresolved: string[] = [];
    const checked: SceneUnderCheck[] = [];
    const byEpisode = new Map<EpisodeId, SceneUnderCheck[]>();
    const heldBack: Relation[] = [];
    let folded = 0;

    // Every scene the outline could not place shares one sentinel location, so the
    // "same character in two places at once" rule cannot fire on the *absence* of a
    // location. A false negative there is a missing warning; a false positive would be
    // an error on every episode, and an error blocks airing.
    const unplaced = deriveEntityId(seed(scope.seriesId, 'location', 'unplaced'));

    for (const [index, scene] of scenes.entries()) {
      // Between scenes, not only on entry. A stage whose work is a loop and that checks
      // the signal once at the top was not cancelled, it was delayed.
      if (scope.signal?.aborted === true) break;

      scope.context.reportProgress({
        progress: index / Math.max(1, scenes.length),
        detail: `S4 extracting scene ${String(index + 1)}`,
        item: { kind: 'scene', key: scene.sceneId, index, total: scenes.length },
      });

      const extracted = await extractor.execute({
        graph,
        sceneId: scene.sceneId,
        episodeId: scene.episodeId,
        at: scene.at,
        sceneText: scene.text,
      });
      if (isErr(extracted)) return extracted;
      traces.push(extracted.value.trace);

      for (const entity of extracted.value.introduced) {
        introduced.push(`${entity.kind}:${entity.mention}`);
      }
      for (const mention of extracted.value.unresolved) {
        unresolved.push(mention.mention);
      }

      // Edges touching a node nobody has written a sheet for are held back rather than
      // dropped: `relations.from_entity_id` references `entities.id`, so persisting one
      // would fail the whole transaction, and dropping it silently would lose the only
      // record that the scene asserted it.
      const known = new Set(graph.entities.map((entity) => entity.id));
      const introducedIds = new Set(extracted.value.introduced.map((entity) => entity.entityId));
      const persistable = extracted.value.relations.filter(
        (relation) => known.has(relation.from) && known.has(relation.to),
      );
      heldBack.push(
        ...extracted.value.relations.filter(
          (relation) =>
            introducedIds.has(relation.from) ||
            introducedIds.has(relation.to) ||
            !known.has(relation.from) ||
            !known.has(relation.to),
        ),
      );

      const fold = folder.execute({
        graph,
        delta: extracted.value.delta,
        relations: persistable,
        openLoops: extracted.value.openLoops,
      });
      if (isErr(fold)) return fold;
      graph = fold.value.graph;
      folded += 1;

      const written = this.#deps.graph.write({ entities: [], relations: fold.value.added });
      if (isErr(written)) return written;
      const bounded = this.#deps.graph.bound(fold.value.bounded.map((edge) => edge.after));
      if (isErr(bounded)) return bounded;

      const under: SceneUnderCheck = {
        sceneId: scene.sceneId,
        at: scene.at,
        locationId: unplaced,
        presentEntityIds: participantsOf(persistable),
        synopsis: scene.text,
      };
      checked.push(under);
      const bucket = byEpisode.get(scene.episodeId);
      if (bucket === undefined) byEpisode.set(scene.episodeId, [under]);
      else bucket.push(under);

      artifacts.push(`scene-delta:${scene.sceneId}/${String(fold.value.added.length)}`);
      if (fold.value.bounded.length > 0) {
        artifacts.push(`bounded-facts:${scene.sceneId}/${String(fold.value.bounded.length)}`);
      }
      for (const skip of fold.value.skipped) {
        scope.logger.debug('the fold declined a change', {
          sceneId: scene.sceneId,
          reason: skip.reason,
          what: skip.what,
        });
      }
    }

    scope.context.reportProgress({ progress: 0.85, detail: 'open loops and continuity' });

    const loops = new TrackOpenLoopsUseCase().execute({
      graph,
      ...(request.staleAfterEpisodes === undefined
        ? {}
        : { staleAfterEpisodes: request.staleAfterEpisodes }),
    });
    artifacts.push(
      `open-loops:${String(loops.open.length)}`,
      `paid-loops:${String(loops.paid.length)}`,
    );

    const continuity = new CheckEpisodeContinuityUseCase({
      backends,
      clock: this.#deps.clock,
    });

    let blocking = 0;
    for (const [episodeId, episodeScenes] of byEpisode) {
      const report = await continuity.execute({
        graph,
        episodeId,
        scenes: episodeScenes,
        asOf: this.#deps.clock.now(),
        semantic: request.semantic,
        ...(request.staleAfterEpisodes === undefined
          ? {}
          : { staleAfterEpisodes: request.staleAfterEpisodes }),
      });
      if (isErr(report)) return report;
      if (report.value.semanticTrace !== null) traces.push(report.value.semanticTrace);
      blocking += report.value.errors.length;
      artifacts.push(
        `continuity:${episodeId}/${String(report.value.errors.length)}e/${String(report.value.warnings.length)}w`,
      );
    }

    if (introduced.length > 0) {
      artifacts.push(`entities-awaiting-a-sheet:${String(introduced.length)}`);
      scope.logger.warn('scenes introduced entities S3 has not written sheets for', {
        seriesId: scope.seriesId,
        mentions: introduced.slice(0, 32),
        heldBackEdges: heldBack.length,
      });
    }
    if (unresolved.length > 0) {
      artifacts.push(`unresolved-mentions:${String(unresolved.length)}`);
      scope.logger.warn('mentions that resolved to nothing were dropped from the delta', {
        seriesId: scope.seriesId,
        mentions: unresolved.slice(0, 32),
      });
    }

    scope.context.reportProgress({
      progress: 1,
      detail:
        `${String(folded)} scene(s) folded, ${String(loops.open.length)} promise(s) open, ` +
        `${String(blocking)} continuity error(s)`,
    });
    artifacts.push(`graph-state:${graph.stateHash}`);
    return ok({ value: { artifacts }, traces });
  }

  /**
   * The scenes to fold: the caller's, or the outline's scene level.
   *
   * Falling back to the outline is what lets S4 run before a word of dialogue exists,
   * which is where it sits in the pipeline. A scene summary is a paragraph describing
   * what happens, which is exactly what the extractor reads - it is thinner material
   * than finished prose, not different material.
   *
   * It requires the outline to have been expanded to `scene`, and says so rather than
   * guessing: a scene id has to be a real `SceneId` for the delta to reference it, and
   * minting one for an episode node would put an id in the graph that names nothing.
   */
  async #scenes(
    seriesId: SeriesId,
    request: WorldStageRequest,
  ): Promise<Result<readonly WorldScene[], AppError>> {
    if (request.scenes !== undefined) return ok(request.scenes);

    const document = await this.#deps.story.load(seriesId);
    if (isErr(document)) return document;

    const scenes = scenesFromOutline(document.value.nodes);
    if (scenes.length === 0) {
      return err(
        new ValidationError({
          message:
            'S4 world folds scenes; this series has no scene-level outline and the run ' +
            'supplied none - expand the outline to "scene" first',
          context: { reason: 'world-without-scenes', owner: '@rv/story-engine', seriesId },
        }),
      );
    }
    return ok(scenes);
  }
}

// ── deriving scenes from the outline ────────────────────────────────────────

interface OutlineNodeLike {
  readonly id: string;
  readonly parentId: string | null;
  readonly level: string;
  readonly ordinal: number;
  readonly title: string;
  readonly summary: string;
}

/**
 * The outline's scene nodes, in playing order, with a story ordinal each.
 *
 * The ordinal is `(position + 1) * 10`, spaced so a later insertion between two scenes
 * has somewhere to go without renumbering everything after it. Derived from the tree's
 * own order rather than stored, so two folds of the same tree place the same scene at
 * the same moment - which is what makes an as-of query reproducible.
 *
 * A scene whose episode ancestor cannot be found is skipped: the delta names an
 * `episodeId` and the continuity check groups by it, so a scene with no episode is a
 * scene no report can be run for.
 */
export function scenesFromOutline(nodes: readonly OutlineNodeLike[]): readonly WorldScene[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byParent = new Map<string | null, OutlineNodeLike[]>();
  for (const node of nodes) {
    const bucket = byParent.get(node.parentId);
    if (bucket === undefined) byParent.set(node.parentId, [node]);
    else bucket.push(node);
  }

  const episodeOf = (node: OutlineNodeLike): string | undefined => {
    let current: OutlineNodeLike | undefined = node;
    while (current !== undefined) {
      if (current.level === 'episode') return current.id;
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return undefined;
  };

  const ordered: OutlineNodeLike[] = [];
  const walk = (parentId: string | null): void => {
    for (const child of [...(byParent.get(parentId) ?? [])].sort((a, b) => a.ordinal - b.ordinal)) {
      if (child.level === 'scene') ordered.push(child);
      walk(child.id);
    }
  };
  walk(null);

  const scenes: WorldScene[] = [];
  for (const [position, node] of ordered.entries()) {
    const episodeId = episodeOf(node);
    if (episodeId === undefined) continue;
    scenes.push({
      sceneId: node.id,
      episodeId,
      at: { ordinal: (position + 1) * 10, label: node.title },
      text: node.summary,
    });
  }
  return scenes;
}

/** Everyone an edge touches, deduped, for the continuity rules' presence check. */
export function participantsOf(relations: readonly Relation[]): readonly EntityId[] {
  const present = new Set<EntityId>();
  for (const relation of relations) {
    present.add(relation.from);
    present.add(relation.to);
  }
  return [...present];
}

/** The extractor, with its own `StructuredCall` so the clock reaches the trace. */
function extractorFor(
  backends: ConstructorParameters<typeof ExtractSceneDeltaUseCase>[0]['backends'],
  clock: Clock,
): ExtractSceneDeltaUseCase {
  return new ExtractSceneDeltaUseCase({ backends, clock });
}
