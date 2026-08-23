/**
 * The half of intake that is identical whatever came through the door.
 *
 * The five front doors differ only in **what material the producer is handed** and **what
 * it is warned about**. Everything else - the envelope, the prompt shape, the assembly of
 * the finished brief, the guarantee that the author's own words survive - is one code
 * path, because five copies of it would be five places for the Persian original to get
 * quietly replaced by its translation.
 */

import type { Brief, ReferenceMaterial } from '@rv/contracts';
import { PromptTemplate, type StructuredTrace, composePrompt, section } from '@rv/prompt-kit';
import { type AppError, type Result, ValidationError, err, isErr, ok } from '@rv/shared-kernel';

import { PRODUCER } from '../roles/index';
import { bulletList, inlineList } from '../support/format';
import { type StoryEngineDeps, runRoleCall } from '../support/stage-call';
import type { ChunkOptions } from './compress';
import { type CompressionReport, NormalisedBrief, NormalisedBriefDraft } from './normalised-brief';

/** The longest verbatim excerpt a `NormalisedBrief` carries. `Prose`'s own ceiling. */
export const SOURCE_EXCERPT_CHARS = 20_000;

export interface IntakeSettings {
  /**
   * An English rendering of the source, when it is not English.
   *
   * Supplied by the caller rather than produced here: translation is a decision with a
   * cost, and a stage that silently translates is a stage that has replaced the author's
   * words with a model's. RV-080 requires the original to survive intake verbatim, which
   * is what `sourceText` is for; this is strictly additive.
   */
  readonly translation?: string;
  /** Ceiling on the material the normalisation call reads. See `CompressSourceUseCase`. */
  readonly tokenCeiling?: number;
  readonly charsPerToken?: number;
  readonly window?: Partial<ChunkOptions>;
  readonly signal?: AbortSignal;
}

export interface IntakeResult {
  readonly brief: NormalisedBrief;
  readonly traces: readonly StructuredTrace[];
}

const INTAKE_PROMPT = new PromptTemplate<{
  readonly materialLabel: string;
  readonly guidance: string;
  readonly language: string;
  readonly targetAudience: string;
  readonly toneWords: string;
  readonly episodePlan: string;
  readonly constraints: string;
  readonly references: string;
  readonly material: string;
}>(
  'intake.normalise',
  [
    'Read the {{materialLabel}} below and produce the normalised brief the rest of the',
    'pipeline will work from.',
    '',
    '## How to treat this particular source',
    '{{guidance}}',
    '',
    '## What is already decided',
    '- Language of the finished episodes: {{language}}',
    '- Audience: {{targetAudience}}',
    '- Tone the author asked for: {{toneWords}}',
    '- Shape: {{episodePlan}}',
    '',
    '## Constraints',
    '{{constraints}}',
    '',
    '## References the author supplied',
    '{{references}}',
    '',
    '## The material',
    '{{material}}',
  ].join('\n'),
);

/** Fields the source already decided, which the model must not be allowed to re-invent. */
export type NormalisationOverrides = Partial<
  Pick<NormalisedBriefDraft, 'workingTitle' | 'premise' | 'themes' | 'tone' | 'genre'>
>;

export interface NormaliseArgs {
  readonly brief: Brief;
  readonly settings: IntakeSettings;
  /** What the producer reads: the source itself, or its digests. */
  readonly material: string;
  readonly materialLabel: string;
  readonly guidance: string;
  /** The author's own words. Sliced, never summarised. */
  readonly sourceText: string;
  readonly compression: CompressionReport;
  /** Traces from any compression pass, so the caller gets one complete ledger. */
  readonly priorTraces?: readonly StructuredTrace[];
  readonly overrides?: NormalisationOverrides;
}

/**
 * Runs the producer over prepared material and assembles the finished brief.
 *
 * The assembly order matters: the model's draft goes in first, then `overrides` - which
 * is how a `series-bible` intake keeps the imported premise verbatim instead of letting
 * the model paraphrase it - then the fields only the code knows.
 */
export async function normaliseBrief(
  deps: StoryEngineDeps,
  args: NormaliseArgs,
): Promise<Result<IntakeResult, AppError>> {
  const { brief } = args;

  const outcome = await runRoleCall<NormalisedBriefDraft>(deps, {
    role: PRODUCER,
    schemaName: 'NormalisedBriefDraft',
    schema: NormalisedBriefDraft,
    user: INTAKE_PROMPT.render({
      materialLabel: args.materialLabel,
      guidance: args.guidance,
      language: brief.language,
      targetAudience: brief.targetAudience,
      toneWords: inlineList(brief.toneWords),
      episodePlan: describeEpisodePlan(brief),
      constraints: describeConstraints(brief),
      references: describeReferences(brief.references),
      material: args.material,
    }).text,
    ...(args.settings.signal === undefined ? {} : { signal: args.settings.signal }),
  });
  if (isErr(outcome)) return outcome;

  const translation = args.settings.translation?.trim();
  const candidate = {
    ...outcome.value.value,
    ...(args.overrides ?? {}),
    sourceKind: brief.kind,
    language: brief.language,
    sourceText: args.sourceText.slice(0, SOURCE_EXCERPT_CHARS).trim(),
    ...(translation === undefined || translation === '' ? {} : { translation }),
    targetEpisodeDurationMs: brief.targetEpisodeDurationMs,
    plannedEpisodeCount: brief.episodes.seasons * brief.episodes.episodesPerSeason,
    compression: args.compression,
  };

  const parsed = NormalisedBrief.safeParse(candidate);
  if (!parsed.success) {
    return err(
      new ValidationError({
        message: 'Intake produced a brief that does not satisfy NormalisedBrief',
        context: {
          kind: brief.kind,
          paths: parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
        },
      }),
    );
  }

  return ok({
    brief: parsed.data,
    traces: [...(args.priorTraces ?? []), outcome.value.trace],
  });
}

/** "3 seasons of 8 episodes, about 7 minutes each, open-ended." */
export function describeEpisodePlan(brief: Brief): string {
  const { seasons, episodesPerSeason, openEnded } = brief.episodes;
  const minutes = (brief.targetEpisodeDurationMs / 60_000).toFixed(1);
  const ending = openEnded
    ? 'open-ended - the central question must not resolve'
    : 'closed - the central question resolves by the end';
  return `${String(seasons)} season(s) of ${String(episodesPerSeason)} episode(s), about ${minutes} minutes each, ${ending}`;
}

export function describeConstraints(brief: Brief): string {
  return composePrompt(
    `Rating ceiling: ${brief.constraints.ratingCeiling}.`,
    section('Must never appear', bulletList(brief.constraints.mustNotAppear, 'nothing declared')),
    section('Other constraints', brief.constraints.notes ?? ''),
  );
}

export function describeReferences(references: readonly ReferenceMaterial[]): string {
  return bulletList(
    references.map(
      (reference) =>
        `${reference.kind} steering ${reference.influence}: ${reference.source} - ${reference.note}`,
    ),
    'none supplied',
  );
}

/** No compression happened and none was needed. */
export function verbatimCompression(sourceChars: number): CompressionReport {
  return {
    strategy: 'verbatim',
    sourceChars,
    chunkCount: 0,
    digestChars: sourceChars,
    ratio: 1,
    note: 'Short-form source; read whole, nothing dropped.',
  };
}
