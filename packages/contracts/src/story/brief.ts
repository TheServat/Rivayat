/**
 * Intake - the polymorphic brief.
 *
 * S0 is the only stage that accepts unstructured input, and what arrives is never one
 * shape: ViMax splits its front door into Idea2Video / Script2Video / Novel2Video
 * (prior-art §A) because a one-line idea and a finished screenplay need opposite
 * treatment - one has to be *invented up*, the other *parsed down*. Modelling that as a
 * discriminated union rather than a bag of optional fields means the story stage cannot
 * silently receive a `script` it never read, and the JSON Schema handed to the intake
 * model describes exactly one legal payload per branch.
 *
 * Everything the five branches share - audience, tone, duration, episode count,
 * language, constraints, references - lives in one envelope, because those are the
 * answers every downstream stage needs regardless of how the story arrived.
 */

import { z } from 'zod';

import {
  Label,
  Locale,
  NanoUsdAmount,
  NonEmptyString,
  PositiveInt,
  Prose,
} from '../primitives/common';
import { PipelineStageKey, ProviderKind } from '../provider/capability';
import { SeriesBible } from './story-bible';

// ── source text ─────────────────────────────────────────────────────────────

/**
 * A whole source document: a feature screenplay, a novel chapter, a transcript.
 *
 * `Prose` stops at 20k characters because that is the size of a thing a human wrote
 * *for* the pipeline. This is the size of a thing that existed before the pipeline, so
 * the ceiling sits where a cheap long-context intake pass stops being economical
 * rather than where text stops being text.
 */
export const SourceDocument = z.string().trim().min(1).max(400_000);
export type SourceDocument = z.infer<typeof SourceDocument>;

/**
 * How an imported script is punctuated.
 *
 * The splitter has to know whether `INT. KITCHEN - NIGHT` is a slugline or a sentence
 * before it can cut the document into scenes, and guessing gets it wrong on prose that
 * happens to shout.
 */
export const ScriptFormat = z
  .enum(['fountain', 'final-draft-text', 'plain'])
  .describe(
    'Punctuation convention of the script. Use "fountain" for Fountain markup, ' +
      '"final-draft-text" for a plain-text export from Final Draft, "plain" for anything else.',
  );
export type ScriptFormat = z.infer<typeof ScriptFormat>;

// ── envelope pieces ─────────────────────────────────────────────────────────

/**
 * What the author supplied to steer the look and sound of the thing.
 *
 * `influence` is the routing field: a mood board must reach the style stage and a
 * chapter of someone else's novel must reach the story stage, and nothing downstream
 * should have to infer which from a file extension.
 */
export const ReferenceMaterial = z.strictObject({
  kind: z
    .enum(['image', 'text', 'url', 'video', 'audio'])
    .describe('What medium this reference is.'),
  source: NonEmptyString.describe(
    'Where the reference lives: a URL, a storage key, or - for kind "text" - the text itself.',
  ),
  influence: z
    .enum(['style', 'tone', 'structure', 'character', 'world', 'music'])
    .describe(
      'Which aspect of the production this reference should steer. It decides which ' +
        'pipeline stage is shown the reference at all.',
    ),
  note: Prose.describe(
    'Say what to take from this reference and, just as important, what to ignore. ' +
      'Write it as an instruction to whoever reads it next, for example: copy the flat ' +
      'cel shading and the limited palette, ignore the character designs entirely.',
  ),
});
export type ReferenceMaterial = z.infer<typeof ReferenceMaterial>;

/**
 * The negative space of the brief.
 *
 * Stated as prohibitions rather than as a rating alone, because "no on-screen blood"
 * and "never show the mother's face before episode 4" are the same kind of constraint
 * to a generator and only one of them is a content rating.
 */
export const ContentConstraints = z.strictObject({
  mustNotAppear: z
    .array(NonEmptyString)
    .max(64)
    .default([])
    .describe(
      'Things that must never appear on screen or in dialogue. One prohibition per ' +
        'entry, phrased concretely enough to check against a finished shot, for example: ' +
        'visible blood; real-world brand logos; the villain unmasked.',
    ),
  ratingCeiling: z
    .enum(['all-ages', 'family', 'teen', 'mature'])
    .default('teen')
    .describe('The most permissive rating any episode is allowed to reach.'),
  notes: Prose.optional().describe(
    'Any constraint that is not a simple prohibition - legal, cultural, or personal.',
  ),
});
export type ContentConstraints = z.infer<typeof ContentConstraints>;

/**
 * How long the author expects the thing to run.
 *
 * Held as intent, not as a promise: the planner is allowed to come back with a
 * different shape, but it has to know what it is arguing against.
 */
export const EpisodeCountIntent = z.strictObject({
  seasons: PositiveInt.default(1).describe('How many seasons the author has in mind. At least 1.'),
  episodesPerSeason: PositiveInt.describe(
    'How many episodes each season should hold. A standalone short is 1.',
  ),
  openEnded: z
    .boolean()
    .default(false)
    .describe(
      'True if the series is meant to keep running past the planned count. It changes ' +
        'the ending: an open-ended series must not resolve its central question.',
    ),
});
export type EpisodeCountIntent = z.infer<typeof EpisodeCountIntent>;

/**
 * The part of the brief that is identical whatever the source material was.
 *
 * Kept as a shared shape and spread into every union member rather than nested under a
 * `common` key, because the flattened object is what the intake model has to fill and
 * one level of nesting fewer is measurably fewer structured-output failures.
 */
const briefEnvelopeShape = {
  workingTitle: Label.optional().describe(
    'A working title if the author has one. Leave it out rather than inventing one here; ' +
      'the story stage titles the series properly.',
  ),
  language: Locale.default('fa').describe(
    'The language the finished episodes are written and performed in.',
  ),
  targetAudience: Label.describe(
    'Who this is for, concretely. Name the age band and the taste, for example ' +
      '"Persian-speaking adults who grew up on 90s fantasy anime". "Everyone" is not an answer.',
  ),
  toneWords: z
    .array(Label)
    .min(1)
    .max(12)
    .describe(
      'One to twelve adjectives fixing the emotional register, for example ' +
        '["melancholy", "wry", "warm"]. Pick words that exclude something; "good" and ' +
        '"interesting" exclude nothing and are useless here.',
    ),
  targetEpisodeDurationMs: PositiveInt.describe(
    'Intended runtime of a single episode, in milliseconds. Must be greater than zero.',
  ),
  episodes: EpisodeCountIntent.describe('How many seasons and episodes the author wants.'),
  constraints: ContentConstraints.describe('What must never appear, and the rating ceiling.'),
  references: z
    .array(ReferenceMaterial)
    .max(24)
    .default([])
    .describe('Reference material the author supplied. An empty list is normal.'),
} as const;

/**
 * The shared half of a brief, on its own.
 *
 * Exported so a UI can validate the envelope while the author is still deciding which
 * kind of source material to paste.
 */
export const BriefEnvelope = z.strictObject(briefEnvelopeShape);
export type BriefEnvelope = z.infer<typeof BriefEnvelope>;

// ── the union ───────────────────────────────────────────────────────────────

export const BRIEF_KINDS = ['idea', 'logline', 'script', 'prose', 'series-bible'] as const;

/** The five front doors. See the module note for why they are not one door. */
export const BriefKind = z.enum(BRIEF_KINDS);
export type BriefKind = z.infer<typeof BriefKind>;

/**
 * Everything the pipeline needs before it is allowed to spend anything.
 *
 * The branches are ordered by how much structure they already carry, which is also the
 * order of how much the story stage has to invent: `idea` is invented almost entirely,
 * `series-bible` is invented not at all and is only validated and re-hosted.
 */
export const Brief = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('idea'),
    ...briefEnvelopeShape,
    idea: Prose.describe(
      'The raw idea, a sentence or a paragraph, exactly as the author wrote it. Do not ' +
        'expand it, tidy it, or add a premise it does not have - later stages need to ' +
        'see what was actually asked for.',
    ),
  }),
  z.strictObject({
    kind: z.literal('logline'),
    ...briefEnvelopeShape,
    logline: Prose.describe(
      'One or two sentences naming the protagonist, the want, the obstacle and the ' +
        'stakes. Example: a retired lighthouse keeper must out-argue the sea itself to ' +
        'keep her drowned daughter from being remembered wrongly.',
    ),
  }),
  z.strictObject({
    kind: z.literal('script'),
    ...briefEnvelopeShape,
    script: SourceDocument.describe(
      'The screenplay text verbatim, sluglines and all. Never summarise it into this field.',
    ),
    scriptFormat: ScriptFormat,
  }),
  z.strictObject({
    kind: z.literal('prose'),
    ...briefEnvelopeShape,
    prose: SourceDocument.describe(
      'The short story or novel excerpt verbatim. Never summarise it into this field.',
    ),
    excerptOf: Label.optional().describe(
      'Title of the work this passage is taken from, if it is an excerpt rather than a ' +
        'complete piece.',
    ),
  }),
  z.strictObject({
    kind: z.literal('series-bible'),
    ...briefEnvelopeShape,
    bible: SeriesBible.describe(
      'A series bible that already exists and is being imported. It is validated, not ' +
        'regenerated: the story stage may extend it but must not contradict it.',
    ),
  }),
]);
export type Brief = z.infer<typeof Brief>;

// ── intake options ──────────────────────────────────────────────────────────

/**
 * The stages intake is allowed to schedule on its own.
 *
 * Intake itself is absent because it is what produced the `Brief`, and preview is
 * absent because it is the human's stage - a pipeline that "auto-runs" the preview has
 * simply skipped it.
 *
 * *Subtracted* from `PipelineStageKey` rather than re-listed beside it. The two lists
 * were written by different hands and agreed only by coincidence: renaming a stage in
 * the pipeline vocabulary would have left this copy naming a stage that no longer
 * exists, and `autoRun` would have silently stopped scheduling it. Stated as a
 * subtraction, the exceptions are the only thing anyone has to read, and they are
 * exactly the two the paragraph above explains.
 */
export const IntakeStage = PipelineStageKey.exclude(['intake', 'preview']);
export type IntakeStage = z.infer<typeof IntakeStage>;

export const INTAKE_STAGES = IntakeStage.options;

/**
 * The three model backends the owner requires to stay selectable.
 *
 * A *narrowing* of `ProviderKind` rather than a second enum of the same strings. The
 * other three provider families exist - `comfyui` and `pollinations` make images and
 * `openai-compatible` is an escape hatch - and none of them can write a story, so the
 * subset is real. What is not real is spelling it out again: an independently written
 * copy of three provider names is a copy that survives a rename in the original and
 * starts pointing at a provider the router has never heard of.
 */
export const StoryModelProvider = ProviderKind.extract(['ollama', 'gemini', 'openrouter']);
export type StoryModelProvider = z.infer<typeof StoryModelProvider>;

/**
 * Pin one stage to one model.
 *
 * Per stage rather than per run, because the stages want different things: outlining
 * wants the strongest reasoning available and is worth paying for, while the world pass
 * is bulk enumeration a local Ollama model does for free. One model for both either
 * burns money or produces a flat story.
 */
export const StoryModelOverride = z.strictObject({
  provider: StoryModelProvider.describe('Which backend serves this stage.'),
  model: NonEmptyString.describe(
    'Provider-native model id, for example "qwen3.5:32b" for ollama or ' +
      '"google/gemini-3.1-pro" for openrouter.',
  ),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe('Sampling temperature. Omit to take the stage default.'),
  maxOutputTokens: PositiveInt.optional().describe(
    'Hard cap on generated tokens for this stage. Omit to take the stage default.',
  ),
});
export type StoryModelOverride = z.infer<typeof StoryModelOverride>;

/**
 * How much of the pipeline to run, with which models, for at most how much money.
 *
 * The ceiling is mandatory and deliberately has no default. Non-negotiable #3 says cost
 * is metered *before* it is spent, and a ceiling that defaults to something is a ceiling
 * nobody chose. Zero is legal and useful: it means estimate the whole run and spend
 * nothing.
 */
export const IntakeOptions = z.strictObject({
  autoRun: z
    .array(IntakeStage)
    .default([])
    .describe(
      'Stages to run without stopping for approval. Any stage left out pauses the run ' +
        'and waits for the human.',
    ),
  modelOverrides: z
    .partialRecord(IntakeStage, StoryModelOverride)
    .default({})
    .describe(
      'Model pinned per stage. Absent stages fall through to the router, which picks on ' +
        'cost and quality.',
    ),
  costCeilingNanoUsd: NanoUsdAmount.describe(
    'Hard spend limit for the whole run, in nano-dollars. The budget guard refuses the ' +
      'call that would cross it rather than reporting it afterwards. Zero means estimate ' +
      'only and spend nothing.',
  ),
});
export type IntakeOptions = z.infer<typeof IntakeOptions>;
