/**
 * S2 Story, wired for real: a brief becomes an outline tree, one level at a time.
 *
 * Three use-cases from `@rv/story-engine`, in the order the pipeline runs them and with
 * nothing invented in between:
 *
 *  1. **Intake.** `IntakeUseCase` routes the `Brief` to the front door that handles it -
 *     `IdeaIntakeUseCase` invents upward from a sentence, `ProseIntakeUseCase` compresses
 *     a novel downward - and all five converge on one `NormalisedBrief`. Nothing after
 *     this line branches on which door it came through.
 *  2. **Outlining.** `ExpandOutlineLevelUseCase`, called once per parent node, per level.
 *  3. **Critique.** `CritiqueDraftUseCase` scores the finished outline against the
 *     screenwriter's own rubric before anything downstream spends image money on it.
 *
 * **The loop is the point, and it is not a shortcut around the loop.** This stage
 * descends series → season → episode by calling the single-level expansion repeatedly,
 * which is exactly what the studio's "build the rest" button does. There is no code path
 * here, and none anywhere in this app, that asks a model for more than one level at a
 * time: DOC's whole finding (prior-art §B) is that a model asked for "the scenes of this
 * series" writes twelve good scenes for episode one and forgets the antagonist by
 * episode seven, because nothing in between ever said what episode seven was *for*.
 *
 * **The critique reports; it does not fail the run.** A stage that threw away six
 * expansions because a model scored 0.55 on "stakes" would make the pipeline unusable,
 * and the score is advice for a human rather than a machine-checkable invariant. The
 * verdict goes out as an artefact and as a progress line, and a blocking finding is
 * logged at `warn`. `payload.story.requireCritique` turns it into a hard gate for a
 * caller who wants one.
 */

import { Brief, StyleBible, type PipelineStageKey, type SeriesId } from '@rv/contracts';
import type { StructuredTrace } from '@rv/prompt-kit';
import {
  CritiqueDraftUseCase,
  IntakeUseCase,
  SCREENWRITER,
  STORY_BIBLE_RUBRIC,
  bulletList,
  inlineList,
  styleBriefFrom,
  type CastCandidate,
  type NormalisedBrief,
  type OutlineContext,
  type StoryEngineDeps,
} from '@rv/story-engine';
import {
  ValidationError,
  contentHash,
  err,
  isErr,
  ok,
  toIso,
  type AppError,
  type Clock,
  type Logger,
  type Result,
} from '@rv/shared-kernel';
import { z } from 'zod';

import type { SeriesRepository } from '../application/ports/repository.ports';
import { toValidationError } from '../common/zod-validation.pipe';
import type { StageContext, StageHandler, StageOutput } from '../pipeline/stage';
import {
  DEFAULT_CANON_POLICY,
  OutlineService,
  storedContextOf,
  type ExpandLevelOptions,
} from './outline.service';
import { meteredStageWork, type StageSpendDeps } from './stage-spend';
import { OUTLINE_LEVELS, type OutlineLevel, type StoryNode } from './story.contracts';
import type { StoryDocument, StoryStore } from './story.store';

/** What S2 reads off the job payload. Everything but the brief has a default. */
export const StoryStageRequest = z.strictObject({
  /**
   * How deep to descend. `episode` by default.
   *
   * Deeper is legal and expensive: expanding a six-episode season to beats is roughly
   * two hundred model calls, and nothing before S7 reads below `scene`. The default is
   * the level docs/01 §4 says S2 owns.
   */
  depth: z.enum(OUTLINE_LEVELS).default('episode'),
  /** Bounds handed to every expansion at every level. Absent means "as many as needed". */
  childCount: z
    .strictObject({
      min: z.number().int().positive().max(64),
      max: z.number().int().positive().max(64),
    })
    .optional(),
  /** Run the rubric pass. On by default; it is one cheap call against a finished tree. */
  critique: z.boolean().default(true),
  /** Turn the rubric into a gate. Off by default - see the file header. */
  requireCritique: z.boolean().default(false),
});
export type StoryStageRequest = z.infer<typeof StoryStageRequest>;

export interface StoryStageHandlerDeps extends StageSpendDeps {
  readonly outline: OutlineService;
  readonly store: StoryStore;
  readonly series: SeriesRepository;
  /** Built per stage run so `StructuredCall`'s logger is scoped to the run. */
  readonly engine: (logger: Logger) => StoryEngineDeps;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class StoryStageHandler implements StageHandler {
  readonly stage: PipelineStageKey = 'story';
  readonly implemented = true;
  readonly #deps: StoryStageHandlerDeps;

  constructor(deps: StoryStageHandlerDeps) {
    this.#deps = deps;
  }

  async execute(context: StageContext): Promise<Result<StageOutput, AppError>> {
    const brief = Brief.safeParse(context.job.payload.brief);
    if (!brief.success) return err(toValidationError(brief.error, 'run.payload.brief'));

    const request = StoryStageRequest.safeParse(context.job.payload.story ?? {});
    if (!request.success) return err(toValidationError(request.error, 'run.payload.story'));

    const seriesId = context.run.seriesId;
    if (seriesId === null) {
      return err(
        new ValidationError({
          message: 'S2 story writes an outline for a series; this run names none',
          context: { reason: 'run-has-no-series', runId: context.run.id },
        }),
      );
    }

    const style = optionalStyle(context.job.payload.style);
    if (isErr(style)) return style;

    const logger = this.#deps.logger.child({ stage: 'story', runId: context.run.id });
    const engine = this.#deps.engine(logger);

    const levels = levelsBelow(request.data.depth);
    // One intake call, one expansion call per parent at each level, one critique. The
    // parent count is not known until the level above lands, so the fan-out is assumed
    // to be `childCount.max` - a ceiling, which is what a pre-flight guard wants.
    const fanOut = request.data.childCount?.max ?? 8;
    const estimatedCalls =
      1 + levels.reduce((total, _level, index) => total + Math.pow(fanOut, index), 0) + 1;

    return meteredStageWork(
      this.#deps,
      {
        context,
        stage: 'story',
        task: SCREENWRITER.task,
        tier: SCREENWRITER.tier,
        calls: estimatedCalls,
      },
      (signal) =>
        this.#run(
          { context, engine, logger, seriesId, levels, signal },
          brief.data,
          request.data,
          style.value,
        ),
    );
  }

  async #run(
    scope: {
      readonly context: StageContext;
      readonly engine: StoryEngineDeps;
      readonly logger: Logger;
      readonly seriesId: SeriesId;
      readonly levels: readonly OutlineLevel[];
      readonly signal: AbortSignal | undefined;
    },
    brief: Brief,
    request: StoryStageRequest,
    style: StyleBible | undefined,
  ): Promise<Result<{ value: StageOutput; traces: readonly StructuredTrace[] }, AppError>> {
    const { context, engine, seriesId } = scope;
    const traces: StructuredTrace[] = [];

    context.reportProgress({ progress: 0.05, detail: `S0 intake of a ${brief.kind} brief` });
    const intake = await new IntakeUseCase(engine).execute({
      brief,
      ...(scope.signal === undefined ? {} : { settings: { signal: scope.signal } }),
    });
    if (isErr(intake)) return intake;
    traces.push(...intake.value.traces);

    const outlineContext = contextFor(intake.value.brief, style);
    const planted = await this.#deps.outline.plantRoot({
      seriesId,
      title: intake.value.brief.workingTitle,
      premise: intake.value.brief.premise,
      context: outlineContext,
      ...(style === undefined ? {} : { styleBibleId: style.id }),
    });
    // A root that already exists is not a failure of this stage: a re-run of S2 over a
    // series that has one is a *re-plan*, and the levels below are what it is for.
    if (isErr(planted) && planted.error.kind !== 'conflict') return planted;

    // Written on both paths, and after the root either way, so every expansion below
    // binds to *this* intake rather than to whatever a previous run left behind.
    const recorded = await this.#recordIntake(
      seriesId,
      outlineContext,
      style,
      intake.value.brief.castCandidates,
    );
    if (isErr(recorded)) return recorded;

    const options: ExpandLevelOptions = {
      ...(request.childCount === undefined ? {} : { childCount: request.childCount }),
      ...(scope.signal === undefined ? {} : { signal: scope.signal }),
    };

    const artifacts = [`normalised-brief:${contentHash(intake.value.brief)}`];
    let grown = 0;

    for (const [index, level] of scope.levels.entries()) {
      // Checked *between* levels, not only on entry: a stage whose work is a loop and
      // that only looks at the signal at the top was not cancelled, it was delayed.
      if (scope.signal?.aborted === true) break;

      context.reportProgress({
        progress: 0.1 + (0.7 * index) / Math.max(1, scope.levels.length),
        detail: `S2 expanding ${level}`,
        item: { kind: 'stage', key: level, index, total: scope.levels.length },
      });

      const expansion = await this.#deps.outline.expandLevel(engine, seriesId, level, options);
      if (isErr(expansion)) {
        // A level that already exists stops the descent rather than failing it: the
        // levels above are real and were paid for, and throwing them away to report a
        // conflict is the one outcome worse than stopping.
        if (expansion.error.kind === 'conflict') break;
        return expansion;
      }
      // Collected, not discarded: the ledger row for this stage has to cover every call
      // the expansions made, and only the traces carry the token counts.
      traces.push(...expansion.value.traces);
      grown += 1;
      artifacts.push(`outline-level:${level}/${String(expansion.value.expansion.nodes.length)}`);
    }

    const tree = await this.#deps.store.tree(seriesId);
    if (isErr(tree)) return tree;
    artifacts.push(`story-tree:${seriesId}`, `story-tree-hash:${contentHash(tree.value.nodes)}`);

    if (request.critique && tree.value.nodes.length > 0) {
      context.reportProgress({ progress: 0.85, detail: 'critique pass over the outline' });
      const critique = await new CritiqueDraftUseCase(engine).execute({
        role: SCREENWRITER,
        rubric: STORY_BIBLE_RUBRIC,
        subjectLabel: 'series outline',
        draft: renderOutline(tree.value.nodes),
        context: renderBriefContext(intake.value.brief),
        ...(scope.signal === undefined ? {} : { signal: scope.signal }),
      });
      if (isErr(critique)) return critique;
      traces.push(critique.value.trace);

      artifacts.push(`story-critique:${critique.value.overall.toFixed(2)}`);
      if (critique.value.blocking.length > 0) {
        scope.logger.warn('the outline did not clear its rubric', {
          seriesId,
          overall: critique.value.overall,
          failed: critique.value.blocking.map((finding) => finding.dimension.key),
        });
        if (request.requireCritique) {
          return err(
            new ValidationError({
              message:
                `The outline failed ${String(critique.value.blocking.length)} rubric ` +
                `dimension(s): ${critique.value.blocking.map((f) => f.dimension.key).join(', ')}`,
              context: {
                reason: 'critique-blocking',
                seriesId,
                weakest: critique.value.weakest,
              },
            }),
          );
        }
      }
    }

    // The card records that a plan exists; it never carries the plan. `hasBible` is what
    // the projects list reads to say a series has been through S2, and a stage that
    // produced an outline and left the flag false makes the list lie.
    const marked = await this.#deps.series.update(
      seriesId,
      { hasBible: true, premise: intake.value.brief.premise },
      toIso(this.#deps.clock.now()),
    );
    if (isErr(marked)) return marked;

    context.reportProgress({
      progress: 1,
      detail: `${String(grown)} level(s) grown, ${String(tree.value.nodes.length)} nodes`,
    });
    return ok({ value: { artifacts }, traces });
  }

  /**
   * Binds the stored document to this intake: the context, the style, and the shortlist.
   *
   * The cast candidates are the reason this is not folded into `plantRoot`. S3 runs as a
   * separate job and needs the shortlist intake produced; re-deriving it there would mean
   * re-reading the source, which for a novel is the most expensive call in the pipeline.
   */
  async #recordIntake(
    seriesId: SeriesId,
    context: OutlineContext,
    style: StyleBible | undefined,
    castCandidates: readonly CastCandidate[],
  ): Promise<Result<StoryDocument, AppError>> {
    return this.#deps.store.mutate(seriesId, (document) =>
      ok({
        ...document,
        context: storedContextOf(context),
        styleBibleId: style?.id ?? document.styleBibleId,
        castCandidates: [...castCandidates],
      }),
    );
  }
}

// ── rendering, for the critique's eyes ──────────────────────────────────────

/** Every level below `series`, up to and including `depth`, in descent order. */
export function levelsBelow(depth: OutlineLevel): readonly OutlineLevel[] {
  const end = OUTLINE_LEVELS.indexOf(depth);
  return OUTLINE_LEVELS.slice(1, end + 1);
}

/**
 * The outline as a reader would see it: indented, in playing order.
 *
 * `plannedSummary` is included beside `summary` because the gap between them is what
 * the critique is being asked to measure - a child that drifted from what its parent
 * asked for reads as fine on its own and wrong in context.
 */
export function renderOutline(nodes: readonly StoryNode[]): string {
  const byParent = new Map<string | null, StoryNode[]>();
  for (const node of nodes) {
    const bucket = byParent.get(node.parentId);
    if (bucket === undefined) byParent.set(node.parentId, [node]);
    else bucket.push(node);
  }

  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    const children = [...(byParent.get(parentId) ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    for (const child of children) {
      const indent = '  '.repeat(depth);
      lines.push(`${indent}${child.level} ${String(child.ordinal)}. ${child.title}`);
      lines.push(`${indent}  asked for: ${child.plannedSummary ?? '(the brief)'}`);
      lines.push(`${indent}  contains: ${child.summary}`);
      walk(child.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join('\n');
}

/** The brief, as the critic needs to see it to judge fit. */
export function renderBriefContext(brief: NormalisedBrief): string {
  return [
    `Working title: ${brief.workingTitle}`,
    `Logline: ${brief.logline}`,
    `Themes: ${inlineList(brief.themes)}`,
    `Tone: ${inlineList(brief.tone)}`,
    `Genre: ${inlineList(brief.genre)}`,
    `Planned: ${String(brief.plannedEpisodeCount)} episode(s) of about ${(brief.targetEpisodeDurationMs / 60_000).toFixed(1)} minutes`,
    `Open questions:\n${bulletList([...brief.openQuestions], 'none recorded')}`,
    `Scope concerns:\n${bulletList([...brief.scopeConcerns], 'none recorded')}`,
  ].join('\n');
}

/** The outline context S2 works from: the normalised brief, plus the style if locked. */
export function contextFor(brief: NormalisedBrief, style: StyleBible | undefined): OutlineContext {
  const worldRules = brief.settingNotes.map((note) => `[world] ${note}`);
  return {
    seriesTitle: brief.workingTitle,
    premise: brief.premise,
    themes: [...brief.themes],
    tone: [...brief.tone],
    genre: [...brief.genre],
    worldRules:
      style === undefined
        ? worldRules
        : [...worldRules, `[style] every design obeys: ${styleBriefFrom(style).silhouetteRule}`],
    canonPolicy: DEFAULT_CANON_POLICY,
    episodeDurationMs: brief.targetEpisodeDurationMs,
  };
}

/**
 * The style bible, if the run carries one.
 *
 * Absent is legal: an outline can be written before a style is locked, and refusing to
 * plan a series because nobody has chosen a palette is not a constraint the story needs.
 * Present-but-malformed is not legal, and says so.
 */
function optionalStyle(value: unknown): Result<StyleBible | undefined, AppError> {
  if (value === undefined || value === null) return ok(undefined);
  const parsed = StyleBible.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(toValidationError(parsed.error, 'run.payload.style'));
}
