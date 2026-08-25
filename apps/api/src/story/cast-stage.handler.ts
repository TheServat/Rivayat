/**
 * S3 Cast, wired for real: the shortlist becomes sheets, and the sheets become a grid.
 *
 * The stage reads the cast candidates S2 stored beside the outline - auto-casting starts
 * at intake (prior-art §A), because the asset registry is keyed on character identity
 * rather than on scene, so the recurring cast has to be identified before any scene is
 * composed - and runs `CastService` over them in order.
 *
 * **A locked style is required, and that is a refusal rather than an omission.** The
 * appearance call derives a silhouette, a palette and a shape language *from the locked
 * bible*, and every prompt this stage composes carries the style clause. Running it
 * against an unlocked bible would key an entire character's artwork to a checksum that
 * can still move, which is non-negotiable #2 defeated at the source. So S3 without S1 is
 * a validation failure naming S1, in the same shape S5 uses to say it needs S1 and S4.
 *
 * **A character already in the graph is skipped, not rewritten.** Re-running S3 on a
 * series whose cast exists is the normal way to add the one character intake missed on
 * the first pass. Regenerating the other five would throw away every prompt an art
 * director has since edited, and `onConflictDoNothing` in the graph store would silently
 * keep the old entity anyway - so the skip is explicit, counted, and reported.
 */

import {
  StyleBible,
  StyleBibleId,
  type EntityId,
  type PipelineStageKey,
  type SeriesId,
} from '@rv/contracts';
import { assertUsableForGeneration } from '@rv/core-domain';
import type { StructuredTrace } from '@rv/prompt-kit';
import {
  ART_DIRECTOR,
  styleBriefFrom,
  type CastCandidate,
  type NamedVoice,
  type StoryEngineDeps,
} from '@rv/story-engine';
import {
  NotFoundError,
  ValidationError,
  err,
  isErr,
  ok,
  type AppError,
  type Logger,
  type Result,
} from '@rv/shared-kernel';
import { z } from 'zod';

import type { ProjectRepository } from '../application/ports/repository.ports';
import { toValidationError } from '../common/zod-validation.pipe';
import type { NarrativeGraphStore } from '../narrative/graph.store';
import type { StageContext, StageHandler, StageOutput } from '../pipeline/stage';
import type { StyleBibleRepository } from '../style/style-bible.repository';
import { characterNames, type CastService } from './cast.service';
import type { CharacterStateStore } from './cast.store';
import { outlineContextOf } from './outline.service';
import { meteredStageWork, type StageSpendDeps } from './stage-spend';
import type { StoryStore } from './story.store';

/** How many model calls one character costs: two for the sheet, one or two for the states. */
export const CALLS_PER_CHARACTER = 4;

export const CastStageRequest = z.strictObject({
  /**
   * The score below which a generated image is flagged rather than trusted.
   *
   * Carried on the grid so the screen does not have to know the settings stack, and
   * defaulted to the same 0.82 the studio shows.
   */
  identityFloor: z.number().min(0).max(1).default(0.82),
  /** Cap on how many characters one run of this stage writes sheets for. */
  limit: z.number().int().positive().max(32).default(32),
  /**
   * Which style bible to derive appearances from.
   *
   * A reference, resolved here, rather than the document itself arriving in the run
   * payload. Everything else this stage needs works that way already - the outline comes
   * from `StoryStore` by series id - and the style was the one exception.
   *
   * Being the exception had a cost: `payload.style` meant a *request* to S1 and a whole
   * *`StyleBible`* to S3, one key with two shapes, so a run of `['style', 'cast']` could
   * never satisfy both and no test ran the two together to notice. Optional because a
   * caller may omit it and let the run's own project supply it.
   */
  styleBibleId: StyleBibleId.optional(),
});
export type CastStageRequest = z.infer<typeof CastStageRequest>;

export interface CastStageHandlerDeps extends StageSpendDeps {
  readonly cast: CastService;
  readonly story: StoryStore;
  readonly states: CharacterStateStore;
  readonly graph: NarrativeGraphStore;
  readonly styleBibles: StyleBibleRepository;
  readonly projects: ProjectRepository;
  readonly engine: (logger: Logger) => StoryEngineDeps;
  /** `provider:model` a generate on the grid would run on, for the estimate line. */
  readonly imageModel: string | null;
  readonly logger: Logger;
}

export class CastStageHandler implements StageHandler {
  readonly stage: PipelineStageKey = 'cast';
  readonly implemented = true;
  readonly #deps: CastStageHandlerDeps;

  constructor(deps: CastStageHandlerDeps) {
    this.#deps = deps;
  }

  async execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    const request = CastStageRequest.safeParse(context.job.payload.cast ?? {});
    if (!request.success) return err(toValidationError(request.error, 'run.payload.cast'));

    const seriesId = context.run.seriesId;
    if (seriesId === null) {
      return err(
        new ValidationError({
          message: 'S3 cast writes character sheets for a series; this run names none',
          context: { reason: 'run-has-no-series', runId: context.run.id },
        }),
      );
    }

    const style = await this.#resolveStyle(context, request.data.styleBibleId ?? null);
    if (isErr(style)) return style;

    const document = await this.#deps.story.load(seriesId);
    if (isErr(document)) return document;
    const stored = document.value.context;
    if (stored === null || document.value.castCandidates.length === 0) {
      return err(
        new ValidationError({
          message: 'S3 cast writes sheets for the shortlist S2 produced; this series has none yet',
          context: { reason: 'cast-without-outline', owner: '@rv/story-engine', seriesId },
        }),
      );
    }

    const candidates = document.value.castCandidates.slice(0, request.data.limit);
    const logger = this.#deps.logger.child({ stage: 'cast', runId: context.run.id });
    const engine = this.#deps.engine(logger);

    return meteredStageWork(
      this.#deps,
      {
        context,
        stage: 'cast',
        task: ART_DIRECTOR.task,
        tier: ART_DIRECTOR.tier,
        calls: candidates.length * CALLS_PER_CHARACTER,
      },
      (signal) =>
        this.#run(
          { context, engine, logger, seriesId, signal },
          candidates,
          outlineContextOf(stored),
          style.value,
          request.data,
        ),
    );
  }

  async #run(
    scope: {
      readonly context: StageContext;
      readonly engine: StoryEngineDeps;
      readonly logger: Logger;
      readonly seriesId: SeriesId;
      readonly signal: AbortSignal | undefined;
    },
    candidates: readonly CastCandidate[],
    context: ReturnType<typeof outlineContextOf>,
    style: StyleBible,
    request: CastStageRequest,
  ): Promise<Result<{ value: StageOutput; traces: readonly StructuredTrace[] }, AppError>> {
    const graph = this.#deps.graph.load(scope.seriesId);
    if (isErr(graph)) return graph;

    const existingByName = characterNames(graph.value.entities);
    const styleBrief = styleBriefFrom(style);
    const traces: StructuredTrace[] = [];
    const artifacts: string[] = [];

    // Voices already in the series seed the distinctness check, so the sixth character
    // added a week later is still held against the first five.
    const voices: NamedVoice[] = graph.value.entities
      .filter((entity) => entity.kind === 'character')
      .map((entity) => ({ name: entity.canonicalName, voice: entity.payload.voice }));

    let written = 0;
    let skipped = 0;

    for (const [index, candidate] of candidates.entries()) {
      // Between characters, not only on entry: a stage that noticed at the end of its
      // six-character batch was not cancelled, it was delayed.
      if (scope.signal?.aborted === true) break;

      const existing = existingByName.get(candidate.name.trim().toLowerCase());
      if (existing !== undefined) {
        skipped += 1;
        artifacts.push(`character-kept:${existing}`);
        continue;
      }

      scope.context.reportProgress({
        progress: index / Math.max(1, candidates.length),
        detail: `S3 writing "${candidate.name}"`,
        item: { kind: 'character', key: candidate.name, index, total: candidates.length },
      });

      const member = await this.#deps.cast.generate(scope.engine, {
        seriesId: scope.seriesId,
        candidate,
        context,
        style: styleBrief,
        existingCast: voices,
        imageModel: this.#deps.imageModel,
        identityFloor: request.identityFloor,
        ...(scope.signal === undefined ? {} : { signal: scope.signal }),
      });
      if (isErr(member)) return member;
      traces.push(...member.value.traces);

      const persisted = this.#deps.graph.write({ entities: [member.value.entity], relations: [] });
      if (isErr(persisted)) return persisted;

      const grid = await this.#deps.states.save(
        scope.seriesId,
        member.value.entity.id,
        member.value.states,
      );
      if (isErr(grid)) return grid;

      voices.push(member.value.voice);
      written += 1;
      artifacts.push(
        `character-sheet:${member.value.entity.id}`,
        `character-states:${member.value.entity.id}/${String(member.value.states.cells.length)}`,
      );
      if (member.value.regeneratedForDistinctness) {
        scope.logger.info('a voice was regenerated to clear the distinctness bar', {
          character: candidate.name,
        });
      }
    }

    scope.context.reportProgress({
      progress: 1,
      detail: `${String(written)} sheet(s) written, ${String(skipped)} already in the graph`,
    });
    return ok({ value: { artifacts }, traces });
  }

  /**
   * The locked style bible this run derives appearances from.
   *
   * Three places can name it, and the order is deliberate: the stage request wins,
   * because a caller who named one meant it; then the project, because a run belongs to
   * one and a project holds its locked style. Anything else is a run that cannot know
   * what its characters should look like, and saying so is better than picking.
   *
   * The same `assertUsableForGeneration` that guards every image generation downstream
   * runs here too, deliberately early. A cast written against an unlocked style produces
   * appearances whose checksum nothing can generate against - a failure three stages
   * later, about a decision made at this one. It also catches a bible edited after
   * locking, which an `isLocked` check alone would wave through.
   */
  async #resolveStyle(
    context: StageContext,
    requested: StyleBibleId | null,
  ): Promise<Result<StyleBible, AppError>> {
    const fromProject =
      requested === null ? await this.#deps.projects.findById(context.run.projectId) : null;
    if (fromProject !== null && isErr(fromProject)) return fromProject;

    const id = requested ?? fromProject?.value?.styleBibleId ?? null;
    if (id === null) {
      return err(
        new ValidationError({
          message:
            'S3 cast derives every appearance from a locked style bible, and this run names none - ' +
            'pass `cast.styleBibleId`, or lock one on the project first',
          context: {
            reason: 'cast-without-style',
            owner: '@rv/style-engine',
            runId: context.run.id,
          },
        }),
      );
    }

    const found = await this.#deps.styleBibles.find(id);
    if (isErr(found)) return found;
    if (found.value === null) {
      return err(new NotFoundError('style bible', id));
    }
    const usable = assertUsableForGeneration(found.value);
    if (isErr(usable)) return usable;
    return ok(found.value);
  }
}

/** The entity ids this stage wrote, for a caller that wants to price them. */
export function writtenEntityIds(artifacts: readonly string[]): readonly EntityId[] {
  return artifacts
    .filter((artifact) => artifact.startsWith('character-sheet:'))
    .map((artifact) => artifact.slice('character-sheet:'.length));
}
