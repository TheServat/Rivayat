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

import { StyleBible, type EntityId, type PipelineStageKey, type SeriesId } from '@rv/contracts';
import type { StructuredTrace } from '@rv/prompt-kit';
import {
  ART_DIRECTOR,
  styleBriefFrom,
  type CastCandidate,
  type NamedVoice,
  type StoryEngineDeps,
} from '@rv/story-engine';
import {
  ValidationError,
  err,
  isErr,
  ok,
  type AppError,
  type Logger,
  type Result,
} from '@rv/shared-kernel';
import { z } from 'zod';

import { toValidationError } from '../common/zod-validation.pipe';
import type { NarrativeGraphStore } from '../narrative/graph.store';
import type { StageContext, StageHandler, StageOutput } from '../pipeline/stage';
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
});
export type CastStageRequest = z.infer<typeof CastStageRequest>;

export interface CastStageHandlerDeps extends StageSpendDeps {
  readonly cast: CastService;
  readonly story: StoryStore;
  readonly states: CharacterStateStore;
  readonly graph: NarrativeGraphStore;
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

    const style = StyleBible.safeParse(context.job.payload.style);
    if (!style.success) {
      return err(
        new ValidationError({
          message:
            'S3 cast derives every appearance from the locked style bible - S1 must run first',
          context: {
            reason: 'cast-without-style',
            owner: '@rv/style-engine',
            issues: style.error.issues.map((issue) => issue.path.map(String).join('.')),
          },
        }),
      );
    }

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
          style.data,
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
}

/** The entity ids this stage wrote, for a caller that wants to price them. */
export function writtenEntityIds(artifacts: readonly string[]): readonly EntityId[] {
  return artifacts
    .filter((artifact) => artifact.startsWith('character-sheet:'))
    .map((artifact) => artifact.slice('character-sheet:'.length));
}
