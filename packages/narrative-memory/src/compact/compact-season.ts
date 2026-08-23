/**
 * The middle rung: episode summaries → one `SeasonSummary`.
 *
 * Reads summaries, never scenes. That is the whole architecture of the ladder - each
 * rung is built from the one below it, so the cost of summarising season 4 does not
 * grow with how long season 1 was.
 *
 * `arcsAdvanced` is the field that earns this rung. A season summary that only said what
 * happened would be a longer logline; what a planner needs is where each lead *stood* at
 * each end of it, including the ones who did not move - a lead who stood still for a
 * whole season is exactly the thing nobody notices while writing and everybody notices
 * while watching.
 */

import { type Clock, type Result, err, isErr, ok, ValidationError } from '@rv/shared-kernel';
import type { StructuredBackend, StructuredTrace } from '@rv/prompt-kit';
import { StructuredCall } from '@rv/prompt-kit';
import type {
  ArcMovement,
  EpisodeSummary,
  OpenLoopId,
  SeasonId,
  SeasonSummary,
  StoryInterval,
} from '@rv/contracts';

import { MentionResolver } from '../extract/coreference';
import { compareStrings, type NarrativeGraph } from '../graph/narrative-graph';
import { estimateTokens } from '../retrieve/tokens';
import { COMPACTION_SYSTEM_PROMPT, SeasonSummaryDraft } from './drafts';

export const DEFAULT_SEASON_SUMMARY_TOKENS = 1_200;

export interface CompactSeasonInput {
  readonly graph: NarrativeGraph;
  readonly seasonId: SeasonId;
  readonly index: number;
  /** In broadcast order. The order they are given is the order they are read. */
  readonly episodes: readonly EpisodeSummary[];
  readonly maxTokens?: number;
}

export interface CompactSeasonOutput {
  readonly summary: SeasonSummary;
  readonly trace: StructuredTrace;
  /** Arc movements the model named for someone the graph does not have. */
  readonly unresolvedCharacters: readonly string[];
}

export interface CompactSeasonDeps {
  readonly backends: readonly StructuredBackend[];
  readonly clock: Clock;
  readonly structuredCall?: StructuredCall;
}

export class CompactSeasonUseCase {
  readonly #call: StructuredCall;
  readonly #backends: readonly StructuredBackend[];

  constructor(deps: CompactSeasonDeps) {
    this.#backends = deps.backends;
    this.#call = deps.structuredCall ?? new StructuredCall({ clock: deps.clock });
  }

  async execute(input: CompactSeasonInput): Promise<Result<CompactSeasonOutput>> {
    if (input.episodes.length === 0) {
      return err(
        new ValidationError({
          message: 'Cannot compact a season with no episode summaries.',
          context: { seasonId: input.seasonId },
        }),
      );
    }

    const called = await this.#call.run({
      schemaName: 'SeasonSummaryDraft',
      schema: SeasonSummaryDraft,
      backends: this.#backends,
      system: COMPACTION_SYSTEM_PROMPT,
      user: this.#buildPrompt(input),
    });
    if (isErr(called)) return err(called.error.error);

    const draft = called.value.value;
    const resolver = new MentionResolver(input.graph.entities);
    const arcs: ArcMovement[] = [];
    const unresolved: string[] = [];
    for (const arc of draft.arcs) {
      const resolved = resolver.resolve(arc.character);
      if (!resolved.ok) {
        unresolved.push(arc.character);
        continue;
      }
      arcs.push({ entityId: resolved.entityId, from: arc.from, to: arc.to, moved: arc.moved });
    }

    const summary: SeasonSummary = {
      seasonId: input.seasonId,
      seriesId: input.graph.seriesId,
      index: input.index,
      title: draft.title,
      throughline: draft.throughline,
      synopsis: draft.synopsis,
      episodes: input.episodes.map((episode) => episode.episodeId),
      storySpan: spanOf(input.episodes),
      arcsAdvanced: arcs.sort((a, b) => compareStrings(a.entityId, b.entityId)),
      openLoopsCarried: [...carriedLoops(input.episodes)],
    };

    const ceiling = input.maxTokens ?? DEFAULT_SEASON_SUMMARY_TOKENS;
    const tokens = estimateTokens(
      [summary.title, summary.throughline, summary.synopsis].join('\n'),
    );
    if (tokens > ceiling) {
      return err(
        new ValidationError({
          message: `Season summary is ${String(tokens)} tokens, over the ${String(ceiling)}-token ceiling.`,
          context: { reason: 'summary-over-ceiling', seasonId: input.seasonId, tokens, ceiling },
        }),
      );
    }

    return ok({ summary, trace: called.value.trace, unresolvedCharacters: unresolved });
  }

  #buildPrompt(input: CompactSeasonInput): string {
    return [
      `Season ${String(input.index)}, ${String(input.episodes.length)} episodes. Compact it.`,
      ...input.episodes.map((episode) =>
        [
          `[episode ${String(episode.index)}] ${episode.title}`,
          episode.logline,
          episode.synopsis,
          ...episode.beats.map((beat) => `- ${beat}`),
        ].join('\n'),
      ),
    ].join('\n\n');
  }
}

/** The union of the episodes' spans. Half-open at both ends, like every other interval here. */
export function spanOf(episodes: readonly { readonly storySpan: StoryInterval }[]): StoryInterval {
  let from: number | null = null;
  let until: number | null = null;
  let unboundedStart = false;
  let unboundedEnd = false;

  for (const episode of episodes) {
    const start = episode.storySpan.from;
    const end = episode.storySpan.until;
    if (start === null) unboundedStart = true;
    else from = from === null ? start.ordinal : Math.min(from, start.ordinal);
    if (end === null) unboundedEnd = true;
    else until = until === null ? end.ordinal : Math.max(until, end.ordinal);
  }

  return {
    from: unboundedStart || from === null ? null : { ordinal: from },
    until: unboundedEnd || until === null ? null : { ordinal: until },
  };
}

/**
 * Promises planted in the season and not paid inside it.
 *
 * The debt carried into the next one, which is the number a showrunner actually asks
 * for and the one nobody tracks by hand past episode six.
 */
export function carriedLoops(episodes: readonly EpisodeSummary[]): readonly OpenLoopId[] {
  const planted = new Set<OpenLoopId>();
  const paid = new Set<OpenLoopId>();
  for (const episode of episodes) {
    for (const id of episode.openLoopsPlanted) planted.add(id);
    for (const id of episode.openLoopsPaid) paid.add(id);
  }
  return [...planted].filter((id) => !paid.has(id)).sort(compareStrings);
}
