/**
 * `rv story new --idea "..." --style <id>` - S0 Intake and S2 Story, headless.
 *
 * Two engine use-cases, in the order the pipeline runs them and with nothing invented
 * in between. `IntakeUseCase` turns the idea into a `NormalisedBrief` - the one shape
 * every front door produces - and `ExpandOutlineLevelUseCase` descends **one level at a
 * time**, series → season → episode, because that is the whole of the DOC technique in
 * prior-art §B: ask a model for "the scenes of this series" and episode seven forgets
 * the antagonist, because nothing ever told episode seven what it was for.
 *
 * The CLI's job is the three things the engine deliberately does not do: pick the
 * backend chain (`FixedStageBackends` - a CLI invocation has already decided which
 * model), enforce the locked style (a story written against an unlocked bible would
 * key its assets to a checksum that can still move), and write the result somewhere
 * `cast states` and `assets plan` can find it.
 */

import { Brief, type EpisodeId, type Locale } from '@rv/contracts';
import { StyleBible } from '@rv/contracts';
import { isLocked } from '@rv/core-domain';
import { StructuredCall } from '@rv/prompt-kit';
import {
  ExpandOutlineLevelUseCase,
  FixedStageBackends,
  IntakeUseCase,
  slugify,
  type OutlineChildDraft,
  type OutlineContext,
  type StoryEngineDeps,
} from '@rv/story-engine';
import {
  MemoryLogger,
  NotFoundError,
  ValidationError,
  isErr,
  nanoUsd,
  toIso,
  type AppError,
  type Result,
} from '@rv/shared-kernel';

import { buildTextBackends } from '../adapters/lanes';
import { flag, option, type ParsedArgs } from '../cli/args';
import type { Command } from '../cli/command';
import type { CliContext } from '../cli/context';
import { EXIT, type ExitCode } from '../cli/exit';
import { emitJson, fail, usageError } from '../cli/report';
import { guardSpend, parseLane } from '../cli/spend';
import { keyValues, table } from '../cli/text';
import { DOCUMENT_VERSION, StoryDocument, type OutlineEntry } from '../store/documents';
import { readJson, writeJson } from '../store/json-file';
import { resolveProject } from '../store/project';
import { loadStack, stageSettingKey } from './models';
import { resolveAll } from '@rv/settings';

/** `E01`. Two digits because a season of more than ninety-nine episodes is not our problem. */
export function episodeCode(ordinal: number): string {
  return `E${String(ordinal).padStart(2, '0')}`;
}

export function seasonCode(ordinal: number): string {
  return `S${String(ordinal).padStart(2, '0')}`;
}

function toEntries(
  children: readonly OutlineChildDraft[],
  code: (ordinal: number) => string,
  mint: () => string,
): readonly OutlineEntry[] {
  return children.map((child) => ({
    id: mint(),
    ordinal: child.ordinal,
    code: code(child.ordinal),
    title: child.title,
    plannedSummary: child.plannedSummary,
    summary: child.summary,
  }));
}

export const storyNewCommand: Command = {
  path: ['story', 'new'],
  summary: 'idea in, a validated outline tree out (S0 + S2)',
  usage: [
    'rv story new --idea "<text>" [--style <styleBibleId>] [--episodes <n>] [--minutes <n>]',
    '             [--audience "<who>"] [--tone "<a,b,c>"] [--lang fa|en] [--model <provider:model>]',
    '             [--lane free|paid] [--project <id>] [--json]',
    "  --style    defaults to the project's locked style; the story must have one",
    '  --model    overrides the S2 pin from the settings stack for this run only',
  ],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const idea = option(args, 'idea');
    if (idea === undefined || idea.trim() === '') {
      return usageError(
        context.io,
        'Give me an idea, e.g. rv story new --idea "روباهی که شهر را دزدید"',
        json,
      );
    }
    const lane = parseLane(option(args, 'lane'));
    if (lane === undefined) return usageError(context.io, '--lane must be "free" or "paid"', json);

    const project = await resolveProject({
      workspaceRoot: context.workspaceRoot,
      explicit: option(args, 'project'),
      env: context.env,
    });
    if (isErr(project)) return fail(context.io, project.error, { json });

    const style = await loadLockedStyle(project.value.paths.style, option(args, 'style'));
    if (isErr(style)) return fail(context.io, style.error, { json });

    // The S2 pin, from the same stack `rv models list` prints. `--model` beats it, and
    // both beat the built-in default - which is the layering the settings registry owns.
    const resolved = resolveAll(await loadStack(context, project.value));
    const pinned = resolved.get(stageSettingKey('story'))?.value;
    const backends = buildTextBackends({
      env: context.env,
      clock: context.clock,
      binding: option(args, 'model') ?? (typeof pinned === 'string' ? pinned : undefined),
    });
    if (isErr(backends)) return fail(context.io, backends.error, { json });
    if (backends.value.chain.length === 0) {
      return fail(
        context.io,
        new ValidationError({
          message: `No backend is available for "${backends.value.modelRef}" on this machine`,
          context: { modelRef: backends.value.modelRef },
        }),
        { json },
      );
    }

    const episodes = positiveInt(option(args, 'episodes'), 3);
    const minutes = positiveInt(option(args, 'minutes'), 3);

    const decision = guardSpend(context.io, {
      what: `S0 intake + S2 outline on ${backends.value.modelRef}`,
      lane,
      // Local models are free; a cloud model's real cost is metered per call by the
      // provider layer, so the pre-call number here is a ceiling, not a quote.
      estimateNanoUsd: nanoUsd(lane === 'free' ? 0 : 50_000_000),
      approved: flag(args, 'yes'),
      json,
    });
    if (!decision.proceed) return decision.exit;

    const logger = new MemoryLogger();
    const deps: StoryEngineDeps = {
      structured: new StructuredCall({ logger }),
      backends: new FixedStageBackends(backends.value.chain),
      clock: context.clock,
      ids: context.ids,
      logger,
    };

    const language = (option(args, 'lang') ?? project.value.record.locale) as Locale;
    const brief = Brief.safeParse({
      kind: 'idea',
      idea: idea.trim(),
      language,
      targetAudience: option(args, 'audience') ?? 'adults who grew up on hand-drawn animation',
      toneWords: (option(args, 'tone') ?? 'wry,melancholy,warm').split(',').map((w) => w.trim()),
      targetEpisodeDurationMs: minutes * 60_000,
      episodes: { seasons: 1, episodesPerSeason: episodes },
      constraints: {},
    });
    if (!brief.success) {
      return fail(
        context.io,
        new ValidationError({
          message: 'the brief assembled from your flags is not valid',
          context: {
            issues: brief.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          },
        }),
        { json },
      );
    }

    context.io.err(`  S0 intake on ${backends.value.modelRef} …`);
    const intake = await new IntakeUseCase(deps).execute({ brief: brief.data });
    if (isErr(intake)) return fail(context.io, intake.error, { json });

    const outlineContext: OutlineContext = {
      seriesTitle: intake.value.brief.workingTitle,
      premise: intake.value.brief.premise,
      themes: intake.value.brief.themes,
      tone: intake.value.brief.tone,
      genre: intake.value.brief.genre,
      worldRules: [],
      canonPolicy: { freezeOnAir: true, retcon: 'reveal-only', strictness: 'strict' },
      episodeDurationMs: intake.value.brief.targetEpisodeDurationMs,
    };

    const expand = new ExpandOutlineLevelUseCase(deps);

    context.io.err('  S2 series -> seasons …');
    const seasons = await expand.execute({
      context: outlineContext,
      parent: {
        level: 'series',
        title: outlineContext.seriesTitle,
        summary: outlineContext.premise,
        plannedSummary: null,
      },
      targetLevel: 'season',
      childCount: { min: 1, max: 1 },
    });
    if (isErr(seasons)) return fail(context.io, seasons.error, { json });

    const seasonEntries = toEntries(seasons.value.children, seasonCode, () => context.ids.season());
    const firstSeason = seasonEntries[0];
    if (firstSeason === undefined) {
      return fail(context.io, new ValidationError({ message: 'the model returned no seasons' }), {
        json,
      });
    }

    context.io.err(`  S2 season -> ${String(episodes)} episodes …`);
    const episodeExpansion = await expand.execute({
      context: outlineContext,
      parent: {
        level: 'season',
        title: firstSeason.title,
        summary: firstSeason.summary,
        plannedSummary: firstSeason.plannedSummary,
      },
      targetLevel: 'episode',
      childCount: { min: episodes, max: episodes },
    });
    if (isErr(episodeExpansion)) return fail(context.io, episodeExpansion.error, { json });

    const episodeEntries = toEntries(episodeExpansion.value.children, episodeCode, () =>
      context.ids.episode(),
    );

    const document = await writeJson(project.value.paths.story, StoryDocument, {
      version: DOCUMENT_VERSION,
      projectId: project.value.record.id,
      seriesId: context.ids.series(),
      styleBibleId: style.value.id,
      title: outlineContext.seriesTitle,
      premise: outlineContext.premise,
      themes: [...outlineContext.themes],
      tone: [...outlineContext.tone],
      genre: [...outlineContext.genre],
      canonPolicy: outlineContext.canonPolicy,
      language,
      episodeDurationMs: intake.value.brief.targetEpisodeDurationMs,
      seasons: [...seasonEntries],
      episodes: [...episodeEntries],
      cast: intake.value.brief.castCandidates.map((candidate) => ({
        slug: slugify(candidate.name, 'character'),
        name: candidate.name,
        role: candidate.role,
        importance: candidate.importance,
        premiseRole: candidate.premiseRole,
        distinguishingTrait: candidate.distinguishingTrait,
      })),
      models: [backends.value.modelRef],
      createdAt: toIso(context.clock.now()),
    });
    if (isErr(document)) return fail(context.io, document.error, { json });

    if (json) {
      emitJson(context.io, { story: document.value, path: project.value.paths.story });
      return EXIT.ok;
    }

    context.io.out();
    for (const line of keyValues([
      ['title', document.value.title],
      ['premise', document.value.premise],
      ['style', document.value.styleBibleId],
      ['model', backends.value.modelRef],
    ])) {
      context.io.out(line);
    }
    context.io.out();
    for (const line of table({
      columns: [{ header: 'episode' }, { header: 'title' }, { header: 'summary' }],
      indent: '  ',
      rows: document.value.episodes.map((episode) => [
        episode.code,
        episode.title,
        episode.summary.slice(0, 90),
      ]),
    })) {
      context.io.out(line);
    }
    context.io.out();
    for (const line of table({
      columns: [{ header: 'character' }, { header: 'role' }, { header: 'why the plot needs them' }],
      indent: '  ',
      rows: document.value.cast.map((member) => [
        member.slug,
        member.role,
        member.premiseRole.slice(0, 80),
      ]),
    })) {
      context.io.out(line);
    }
    context.io.out();
    return EXIT.ok;
  },
};

/**
 * The style the story is written against, and the check that it cannot still move.
 *
 * `assertUsableForGeneration` guards image generation; nothing guards *story* against an
 * unlocked bible, and it has to be guarded here because the story document records
 * `styleBibleId` and every asset the story implies is keyed on that bible's checksum.
 */
async function loadLockedStyle(
  path: string,
  explicit: string | undefined,
): Promise<Result<StyleBible, AppError>> {
  const bible = await readJson(path, StyleBible, 'style bible');
  if (isErr(bible)) {
    return bible.error.kind === 'not-found'
      ? {
          ok: false,
          error: new NotFoundError('locked style bible', path, {
            context: {
              hint: 'lock one first: rv style probe --preset <id> && rv style lock --style <id>',
            },
          }),
        }
      : bible;
  }
  if (!isLocked(bible.value)) {
    return {
      ok: false,
      error: new ValidationError({
        message: `style ${bible.value.id} is not locked; a story keyed to a moving checksum cannot be reproduced`,
        context: { styleBibleId: bible.value.id },
      }),
    };
  }
  if (explicit !== undefined && explicit !== bible.value.id) {
    return {
      ok: false,
      error: new ValidationError({
        message: `--style ${explicit} is not the project's locked style (${bible.value.id})`,
        context: { requested: explicit, locked: bible.value.id },
      }),
    };
  }
  return { ok: true, value: bible.value };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads the story document a later command depends on. */
export async function loadStory(path: string): Promise<Result<StoryDocument, AppError>> {
  const document = await readJson(path, StoryDocument, 'story');
  if (isErr(document) && document.error.kind === 'not-found') {
    return {
      ok: false,
      error: new NotFoundError('story', path, {
        context: { hint: 'write one first: rv story new --idea "…"' },
      }),
    };
  }
  return document;
}

/** Resolves `E01` or a ULID to the stored episode entry. */
export function findEpisode(story: StoryDocument, handle: string): OutlineEntry | undefined {
  const wanted = handle.trim().toUpperCase();
  return story.episodes.find(
    (episode) => episode.code.toUpperCase() === wanted || episode.id === handle,
  );
}

/** The branded id for an episode entry, for the use-cases that want one. */
export function episodeIdOf(entry: OutlineEntry): EpisodeId {
  return entry.id;
}
