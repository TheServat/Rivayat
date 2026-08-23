/**
 * The top rung: season summaries → one `SeriesSummary`.
 *
 * This is the rung that ships in *every* generation call - `premise` and
 * `rulesOfTheWorld` are part of the unconditional always-included set - so its job is to
 * stay small. A hundred wasted tokens here is a hundred wasted tokens per scene, per
 * episode, for the life of the series, which is why the ceiling on this rung is the
 * tightest of the three and why going over it is an error rather than a warning.
 *
 * `canonThroughEpisode` is bookkeeping, not prose: it is the last aired episode in
 * broadcast order, and everything up to it is frozen. Asking a model for it would get a
 * confident guess about the one field the immutability guard reads.
 */

import { type Clock, type Result, err, isErr, ok, ValidationError } from '@rv/shared-kernel';
import type { StructuredBackend, StructuredTrace } from '@rv/prompt-kit';
import { StructuredCall } from '@rv/prompt-kit';
import type { EpisodeId, SeasonSummary, SeriesSummary } from '@rv/contracts';

import { compareStrings, type NarrativeGraph } from '../graph/narrative-graph';
import { estimateTokens } from '../retrieve/tokens';
import { reportOpenLoops } from '../loops/track-open-loops';
import { COMPACTION_SYSTEM_PROMPT, SeriesSummaryDraft } from './drafts';
import { spanOf } from './compact-season';

/** Tight on purpose: this text is paid for on every call the pipeline ever makes. */
export const DEFAULT_SERIES_SUMMARY_TOKENS = 900;

export interface CompactSeriesInput {
  readonly graph: NarrativeGraph;
  /** In order. A series with no seasons yet is compacted from its bible, not from here. */
  readonly seasons: readonly SeasonSummary[];
  readonly maxTokens?: number;
}

export interface CompactSeriesOutput {
  readonly summary: SeriesSummary;
  readonly trace: StructuredTrace;
}

export interface CompactSeriesDeps {
  readonly backends: readonly StructuredBackend[];
  readonly clock: Clock;
  readonly structuredCall?: StructuredCall;
}

export class CompactSeriesUseCase {
  readonly #call: StructuredCall;
  readonly #backends: readonly StructuredBackend[];

  constructor(deps: CompactSeriesDeps) {
    this.#backends = deps.backends;
    this.#call = deps.structuredCall ?? new StructuredCall({ clock: deps.clock });
  }

  async execute(input: CompactSeriesInput): Promise<Result<CompactSeriesOutput>> {
    if (input.seasons.length === 0) {
      return err(
        new ValidationError({
          message: 'Cannot compact a series with no season summaries.',
          context: { seriesId: input.graph.seriesId },
        }),
      );
    }

    const called = await this.#call.run({
      schemaName: 'SeriesSummaryDraft',
      schema: SeriesSummaryDraft,
      backends: this.#backends,
      system: COMPACTION_SYSTEM_PROMPT,
      user: this.#buildPrompt(input),
    });
    if (isErr(called)) return err(called.error.error);

    const draft = called.value.value;
    const loops = reportOpenLoops(input.graph);

    const summary: SeriesSummary = {
      seriesId: input.graph.seriesId,
      premise: draft.premise,
      synopsis: draft.synopsis,
      themes: draft.themes,
      toneNote: draft.toneNote,
      rulesOfTheWorld: draft.rulesOfTheWorld,
      seasons: input.seasons.map((season) => season.seasonId),
      principalCast: input.graph.entities
        .filter((entity) => entity.kind === 'character' && entity.importance === 'lead')
        .map((entity) => entity.id)
        .sort(compareStrings),
      openLoops: loops.open.map((standing) => standing.loop.id).sort(compareStrings),
      storySpan: spanOf(input.seasons),
      canonThroughEpisode: lastAired(input.graph),
    };

    const ceiling = input.maxTokens ?? DEFAULT_SERIES_SUMMARY_TOKENS;
    const tokens = estimateTokens(
      [summary.premise, summary.synopsis, summary.toneNote, ...summary.rulesOfTheWorld].join('\n'),
    );
    if (tokens > ceiling) {
      return err(
        new ValidationError({
          message: `Series summary is ${String(tokens)} tokens, over the ${String(ceiling)}-token ceiling. It ships in every call, so the ceiling is not negotiable.`,
          context: {
            reason: 'summary-over-ceiling',
            seriesId: input.graph.seriesId,
            tokens,
            ceiling,
          },
        }),
      );
    }

    return ok({ summary, trace: called.value.trace });
  }

  #buildPrompt(input: CompactSeriesInput): string {
    return [
      `The whole series so far, ${String(input.seasons.length)} season(s). Compact it into something small enough to ship in every generation call.`,
      ...input.seasons.map((season) =>
        [
          `[season ${String(season.index)}] ${season.title}`,
          `Throughline: ${season.throughline}`,
          season.synopsis,
        ].join('\n'),
      ),
    ].join('\n\n');
  }
}

/** The last episode in broadcast order that has aired. Everything up to it is frozen. */
function lastAired(graph: NarrativeGraph): EpisodeId | null {
  for (let index = graph.episodeOrder.length - 1; index >= 0; index -= 1) {
    const episodeId = graph.episodeOrder[index];
    if (episodeId !== undefined && graph.airedEpisodes.has(episodeId)) return episodeId;
  }
  return null;
}
