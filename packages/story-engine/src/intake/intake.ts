/**
 * S0 Intake: five front doors, one normalised output.
 *
 * One use-case per `Brief` kind, because the five need genuinely different treatment -
 * an idea is *invented up* and a novel is *parsed down*, and a single use-case that did
 * both would be a `switch` with five bodies wearing one name. What they share lives in
 * `normalise.ts`; what differs is the material each hands the producer and the warning
 * each attaches to it.
 *
 * `IntakeUseCase` at the bottom is the dispatcher a caller with an unknown `Brief`
 * reaches for. It is a lookup table, not a `switch` (CLAUDE.md §2), so adding a sixth
 * front door means adding a `BriefKind` in `@rv/contracts` and an entry here, and
 * forgetting the second half does not compile.
 */

import type { Brief, BriefKind, SeriesBible } from '@rv/contracts';
import { PromptTemplate } from '@rv/prompt-kit';
import { type AppError, type Result, isErr } from '@rv/shared-kernel';

import { bulletList, inlineList } from '../support/format';
import type { StoryEngineDeps } from '../support/stage-call';
import { CompressSourceUseCase } from './compress';
import type { NoVars } from '../roles/index';
import {
  type IntakeResult,
  type IntakeSettings,
  normaliseBrief,
  verbatimCompression,
} from './normalise';

type BriefOf<K extends BriefKind> = Extract<Brief, { kind: K }>;

export interface IntakeInputFor<K extends BriefKind> {
  readonly brief: BriefOf<K>;
  readonly settings?: IntakeSettings;
}

export type IntakeInput = IntakeInputFor<BriefKind>;

const NO_VARS = {} as const;

// ── guidance, per front door ────────────────────────────────────────────────

const IDEA_GUIDANCE = new PromptTemplate<NoVars>(
  'intake.guidance.idea',
  [
    'This is a raw idea - a sentence or a paragraph. Almost everything below has to be',
    'invented rather than extracted, and that is expected.',
    '',
    'Invent deliberately and record it. Anything you decided that the idea did not say',
    'belongs in openQuestions, phrased as the decision it is: "the idea does not say who',
    'the antagonist is; I have assumed the city itself". A brief that hides its inventions',
    'is a brief the author cannot correct.',
    '',
    'Do not tidy the idea into something more conventional than it is. If it is strange,',
    'the premise you write should still be strange.',
  ].join('\n'),
);

const LOGLINE_GUIDANCE = new PromptTemplate<NoVars>(
  'intake.guidance.logline',
  [
    'This is a logline: the protagonist, the want, the obstacle and the stakes are already',
    'chosen. Keep all four exactly as stated - a logline the author will not recognise is a',
    'failed intake, however good it reads.',
    '',
    'Your work is the layer underneath: who else the story needs, what the world has to be',
    'like for the obstacle to bite, and what the logline leaves unanswered.',
  ].join('\n'),
);

const SCRIPT_GUIDANCE = new PromptTemplate<{ readonly scriptFormat: string }>(
  'intake.guidance.script',
  [
    'This is a screenplay in {{scriptFormat}} format. It is a finished artefact, not a',
    'starting point: the scenes, the characters and the structure already exist and must be',
    'reported, not redesigned.',
    '',
    'Sluglines name locations - collect them into settingNotes. Character cues name the',
    'cast - the ones with lines are candidates, and how often they appear is your evidence',
    'for importance. Do not promote a character to lead because their one scene is the most',
    'interesting.',
    '',
    'If the script is a single film and the brief asks for a series, say so in scopeConcerns',
    'rather than silently inventing episode breaks.',
  ].join('\n'),
);

const PROSE_GUIDANCE = new PromptTemplate<NoVars>(
  'intake.guidance.prose',
  [
    'This is prose fiction, and what you are reading may be a compressed digest of it',
    'rather than the text itself - each passage below was summarised in order, with the',
    'previous summary in front of it.',
    '',
    'Treat the digests as evidence, not as the work. Where a digest says something was left',
    'out, do not fill the gap; note it in openQuestions. Prose carries interiority that no',
    'animated series can show directly, so anything that only happens inside a head is a',
    'scopeConcern, not a scene.',
  ].join('\n'),
);

const SERIES_BIBLE_GUIDANCE = new PromptTemplate<NoVars>(
  'intake.guidance.series-bible',
  [
    'A series bible already exists and is being imported. It is validated, not regenerated.',
    '',
    'The premise, themes, tone and genre below are canon and are copied across verbatim -',
    'do not restate or improve them. What is genuinely missing is the cast: the bible',
    'describes a shape, and you are reading it to work out who has to be in it.',
    '',
    'Anything the bible plans but does not explain goes in openQuestions. Anything it plans',
    'that will not fit the declared runtime goes in scopeConcerns.',
  ].join('\n'),
);

// ── the five use-cases ──────────────────────────────────────────────────────

export class IdeaIntakeUseCase {
  readonly #deps: StoryEngineDeps;

  constructor(deps: StoryEngineDeps) {
    this.#deps = deps;
  }

  async execute(input: IntakeInputFor<'idea'>): Promise<Result<IntakeResult, AppError>> {
    return normaliseBrief(this.#deps, {
      brief: input.brief,
      settings: input.settings ?? {},
      material: input.brief.idea,
      materialLabel: 'one-line idea',
      guidance: IDEA_GUIDANCE.render(NO_VARS).text,
      sourceText: input.brief.idea,
      compression: verbatimCompression(input.brief.idea.length),
    });
  }
}

export class LoglineIntakeUseCase {
  readonly #deps: StoryEngineDeps;

  constructor(deps: StoryEngineDeps) {
    this.#deps = deps;
  }

  async execute(input: IntakeInputFor<'logline'>): Promise<Result<IntakeResult, AppError>> {
    return normaliseBrief(this.#deps, {
      brief: input.brief,
      settings: input.settings ?? {},
      material: input.brief.logline,
      materialLabel: 'logline',
      guidance: LOGLINE_GUIDANCE.render(NO_VARS).text,
      sourceText: input.brief.logline,
      compression: verbatimCompression(input.brief.logline.length),
    });
  }
}

/**
 * A screenplay in, a normalised brief out.
 *
 * Compressed rather than truncated for the same reason prose is: the third act is where
 * the answers live, and a context-window-sized prefix of a feature is a story with no
 * ending.
 */
export class ScriptIntakeUseCase {
  readonly #deps: StoryEngineDeps;
  readonly #compress: CompressSourceUseCase;

  constructor(deps: StoryEngineDeps) {
    this.#deps = deps;
    this.#compress = new CompressSourceUseCase(deps);
  }

  async execute(input: IntakeInputFor<'script'>): Promise<Result<IntakeResult, AppError>> {
    const settings = input.settings ?? {};
    const compressed = await this.#compress.execute({
      source: input.brief.script,
      sourceLabel: `${input.brief.scriptFormat} screenplay`,
      language: input.brief.language,
      ...(settings.tokenCeiling === undefined ? {} : { tokenCeiling: settings.tokenCeiling }),
      ...(settings.charsPerToken === undefined ? {} : { charsPerToken: settings.charsPerToken }),
      ...(settings.window === undefined ? {} : { window: settings.window }),
      ...(settings.signal === undefined ? {} : { signal: settings.signal }),
    });
    if (isErr(compressed)) return compressed;

    return normaliseBrief(this.#deps, {
      brief: input.brief,
      settings,
      material: compressed.value.material,
      materialLabel: 'screenplay',
      guidance: SCRIPT_GUIDANCE.render({ scriptFormat: input.brief.scriptFormat }).text,
      sourceText: input.brief.script,
      compression: compressed.value.report,
      priorTraces: compressed.value.traces,
    });
  }
}

/** Novel2Video's door. See `compress.ts` for what "narrative compression" means here. */
export class ProseIntakeUseCase {
  readonly #deps: StoryEngineDeps;
  readonly #compress: CompressSourceUseCase;

  constructor(deps: StoryEngineDeps) {
    this.#deps = deps;
    this.#compress = new CompressSourceUseCase(deps);
  }

  async execute(input: IntakeInputFor<'prose'>): Promise<Result<IntakeResult, AppError>> {
    const settings = input.settings ?? {};
    const compressed = await this.#compress.execute({
      source: input.brief.prose,
      sourceLabel:
        input.brief.excerptOf === undefined
          ? 'prose work'
          : `excerpt from "${input.brief.excerptOf}"`,
      language: input.brief.language,
      ...(settings.tokenCeiling === undefined ? {} : { tokenCeiling: settings.tokenCeiling }),
      ...(settings.charsPerToken === undefined ? {} : { charsPerToken: settings.charsPerToken }),
      ...(settings.window === undefined ? {} : { window: settings.window }),
      ...(settings.signal === undefined ? {} : { signal: settings.signal }),
    });
    if (isErr(compressed)) return compressed;

    return normaliseBrief(this.#deps, {
      brief: input.brief,
      settings,
      material: compressed.value.material,
      materialLabel: 'prose work',
      guidance: PROSE_GUIDANCE.render(NO_VARS).text,
      sourceText: input.brief.prose,
      compression: compressed.value.report,
      priorTraces: compressed.value.traces,
    });
  }
}

/**
 * An existing bible in.
 *
 * The one door where the model is *not* asked for a premise: the bible already has one,
 * and asking a model to restate canon is asking it to paraphrase canon. It reads the
 * bible only for the thing a bible does not contain - the cast.
 */
export class SeriesBibleIntakeUseCase {
  readonly #deps: StoryEngineDeps;

  constructor(deps: StoryEngineDeps) {
    this.#deps = deps;
  }

  async execute(input: IntakeInputFor<'series-bible'>): Promise<Result<IntakeResult, AppError>> {
    const { bible } = input.brief;
    const outline = renderBibleOutline(bible);

    return normaliseBrief(this.#deps, {
      brief: input.brief,
      settings: input.settings ?? {},
      material: outline,
      materialLabel: 'series bible',
      guidance: SERIES_BIBLE_GUIDANCE.render(NO_VARS).text,
      sourceText: bible.premise,
      compression: verbatimCompression(outline.length),
      overrides: {
        workingTitle: bible.title,
        premise: bible.premise,
        themes: bible.themes,
        tone: bible.tone,
        genre: bible.genre,
      },
    });
  }
}

/**
 * Renders an imported bible as the outline the producer reads.
 *
 * Only down to episode loglines. Deeper would blow the intake budget on material the
 * story stage is about to re-read anyway, and the question being asked here - "who has to
 * be in this" - is answerable from loglines.
 */
export function renderBibleOutline(bible: SeriesBible): string {
  const header = [
    `# ${bible.title}`,
    bible.premise,
    `Themes: ${inlineList(bible.themes)}`,
    `Tone: ${inlineList(bible.tone)}`,
    `Genre: ${inlineList(bible.genre)}`,
    `Rules of the world:\n${bulletList(
      bible.rulesOfTheWorld.map((rule) => `[${rule.scope}] ${rule.statement}`),
      'none declared',
    )}`,
  ].join('\n\n');

  const seasons = bible.seasons.map((season) => {
    const episodes = season.episodes
      .map(
        (episode) =>
          `  ${String(episode.ordinal)}. ${episode.title} (${episode.status}) - ${episode.logline}`,
      )
      .join('\n');
    return `## Season ${String(season.ordinal)}: ${season.title}\n${season.arc}\n${episodes}`;
  });

  return [header, ...seasons].join('\n\n');
}

// ── the dispatcher ──────────────────────────────────────────────────────────

type IntakeHandlers = {
  readonly [K in BriefKind]: (input: IntakeInputFor<K>) => Promise<Result<IntakeResult, AppError>>;
};

/**
 * Routes a `Brief` of unknown kind to the use-case that handles it.
 *
 * Exists so callers - the CLI, the API, the orchestrator - do not each grow their own
 * five-way branch that has to be updated in lock-step when a sixth kind appears.
 */
export class IntakeUseCase {
  readonly #handlers: IntakeHandlers;

  constructor(deps: StoryEngineDeps) {
    const idea = new IdeaIntakeUseCase(deps);
    const logline = new LoglineIntakeUseCase(deps);
    const script = new ScriptIntakeUseCase(deps);
    const prose = new ProseIntakeUseCase(deps);
    const seriesBible = new SeriesBibleIntakeUseCase(deps);

    this.#handlers = {
      idea: (input) => idea.execute(input),
      logline: (input) => logline.execute(input),
      script: (input) => script.execute(input),
      prose: (input) => prose.execute(input),
      'series-bible': (input) => seriesBible.execute(input),
    };
  }

  async execute(input: IntakeInput): Promise<Result<IntakeResult, AppError>> {
    // The discriminant and the handler are correlated by construction - the mapped type
    // above guarantees `handlers[k]` accepts exactly `BriefOf<k>`. TypeScript cannot carry
    // that correlation through an index by a union-typed key, so it is asserted once,
    // here, rather than pushed into five per-kind guards that no test could ever reach.
    const handler = this.#handlers[input.brief.kind] as (
      narrowed: IntakeInput,
    ) => Promise<Result<IntakeResult, AppError>>;
    return handler(input);
  }
}
