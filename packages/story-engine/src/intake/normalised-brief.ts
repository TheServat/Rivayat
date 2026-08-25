/**
 * The one shape all five front doors produce.
 *
 * `Brief` is a discriminated union because an idea and a screenplay need opposite
 * treatment (see `@rv/contracts/story/brief`). Everything *after* intake wants the
 * opposite property: the story stage should not know, and must not branch on, whether
 * the premise it was handed was invented from a sentence or compressed out of a novel.
 * So the five intake use-cases converge here, and `sourceKind` survives only as
 * provenance - nothing downstream is allowed to switch on it.
 *
 * The split between {@link NormalisedBriefDraft} and {@link NormalisedBrief} is the
 * load-bearing part. The draft is what a model is asked to fill; the finished brief adds
 * the fields the *code* knows and the model must not be trusted with - the language, the
 * verbatim source text, the compression record. RV-080 requires the original text to
 * survive intake verbatim alongside any translation, and a model asked to echo 40 000
 * words back will not.
 */

import { z } from 'zod';
import {
  BriefKind,
  CastCandidate,
  Importance,
  Label,
  Locale,
  NonNegativeInt,
  PositiveInt,
  Prose,
} from '@rv/contracts';

// ── cast ────────────────────────────────────────────────────────────────────

/**
 * Re-exported, not redefined.
 *
 * `CastCandidate` moved to `@rv/contracts` when it began crossing the HTTP boundary -
 * the studio renders the shortlist and cannot import an engine. Everything in this
 * package that already imported it from here keeps working, and there is still exactly
 * one definition.
 */
export { CAST_ROLES, CastRole, CastCandidate } from '@rv/contracts';

// ── compression ─────────────────────────────────────────────────────────────

export const COMPRESSION_STRATEGIES = ['verbatim', 'single-pass', 'chunked-digest'] as const;

export const CompressionStrategy = z.enum(COMPRESSION_STRATEGIES);
export type CompressionStrategy = z.infer<typeof CompressionStrategy>;

/**
 * What intake did to the source, and what it cost.
 *
 * Recorded rather than implied, because "the character list is thin" and "the second half
 * of the novel was compressed into four sentences" are the same symptom and only one of
 * them is a modelling failure. A user looking at a disappointing brief needs to be able
 * to see which.
 */
export const CompressionReport = z.strictObject({
  strategy: CompressionStrategy,
  sourceChars: NonNegativeInt.describe('Length of the source document as supplied.'),
  chunkCount: NonNegativeInt.describe(
    'How many windows the source was cut into. 0 when nothing had to be compressed.',
  ),
  digestChars: NonNegativeInt.describe(
    'Length of the compressed material the normalisation call actually read.',
  ),
  /** `sourceChars / digestChars`, or 1 when nothing was compressed. Reported, not stored. */
  ratio: z.number().min(1),
  note: Prose.describe(
    'What was deliberately let go. A compression that claims to have dropped nothing has ' +
      'not been examined.',
  ),
});
export type CompressionReport = z.infer<typeof CompressionReport>;

// ── the draft, and the finished thing ───────────────────────────────────────

/**
 * The half a model fills.
 *
 * Deliberately free of anything the code already knows. Every field the intake call is
 * asked for is a field that requires reading and judgement; asking it to also restate the
 * locale and echo the source back is how a structured-output call fails on a field nobody
 * needed.
 */
export const NormalisedBriefDraft = z.strictObject({
  workingTitle: Label.describe(
    "A working title. Take the source's own if it has one; otherwise coin something plain " +
      'and descriptive rather than clever.',
  ),
  premise: Prose.describe(
    'The engine of the series in two or three sentences: the situation, the pressure it ' +
      'puts on the lead, and why it does not resolve in one episode.',
  ),
  logline: Prose.describe(
    'One sentence naming the protagonist, the want, the obstacle and the stakes.',
  ),
  themes: z
    .array(Label)
    .min(1)
    .max(8)
    .describe('What the work argues about, as noun phrases. Not genres, not adjectives.'),
  tone: z.array(Label).min(1).max(12).describe('Adjectives fixing the emotional register.'),
  genre: z.array(Label).min(1).max(4).describe('One to four genre labels, most defining first.'),
  castCandidates: z
    .array(CastCandidate)
    .min(1)
    .max(32)
    .describe(
      'Every character the story cannot be told without, most important first. At least ' +
        'one - a story with no one in it has not been read.',
    ),
  settingNotes: z
    .array(Prose)
    .max(16)
    .default([])
    .describe('Places and world facts the source establishes. One per entry.'),
  openQuestions: z
    .array(Prose)
    .max(16)
    .default([])
    .describe(
      'What the source does not answer and the story stage will have to decide. This is ' +
        'the field that stops invention being disguised as extraction.',
    ),
  scopeConcerns: z
    .array(Prose)
    .max(8)
    .default([])
    .describe(
      'Anything that will not fit the declared episode count, runtime or content ' +
        'constraints. Empty is a legitimate answer; a guess is not.',
    ),
});
export type NormalisedBriefDraft = z.infer<typeof NormalisedBriefDraft>;

/**
 * What every intake use-case returns.
 *
 * `sourceText` is the author's own words, unmodified, and it is set by the use-case from
 * the `Brief` rather than by the model. Persian input stays Persian here whatever
 * language the pipeline later works in - RV-080 - and `translation` is additive.
 */
export const NormalisedBrief = NormalisedBriefDraft.extend({
  sourceKind: BriefKind.describe(
    'Which front door this came through. Provenance only - nothing downstream may branch ' +
      'on it.',
  ),
  language: Locale.describe('The language the finished episodes are written and performed in.'),
  sourceText: Prose.describe(
    "The author's own words, verbatim and unedited. For a long document this is the " +
      'opening passage; the whole of it lives in the `Brief` the run was started from.',
  ),
  translation: Prose.optional().describe(
    'An English rendering of `sourceText`, when the source is not English. Additive - it ' +
      'never replaces the original.',
  ),
  targetEpisodeDurationMs: PositiveInt,
  plannedEpisodeCount: PositiveInt.describe('Seasons multiplied by episodes per season.'),
  compression: CompressionReport,
});
export type NormalisedBrief = z.infer<typeof NormalisedBrief>;
