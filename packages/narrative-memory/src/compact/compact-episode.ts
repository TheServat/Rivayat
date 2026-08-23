/**
 * The bottom rung: scenes → one `EpisodeSummary`.
 *
 * A twelve-episode season is two hundred scenes and no budget survives loading them, so
 * long-range planning reads summaries and never raw scenes. The cost of that is
 * permanent information loss, which is why the loss is *explicit*: everything that
 * constrains a later episode - what was introduced, what changed, what was promised,
 * what was paid, how far the story moved - is computed from the deltas and preserved
 * exactly. Only the prose is compacted, and only the prose can be wrong.
 *
 * Recompaction is content-addressed. `inputHash` is over the scenes and deltas that
 * produced the summary, so re-running compaction on an untouched episode returns the
 * stored summary and makes **no provider call at all** - which is what makes "edit one
 * scene, recompute one chain" true rather than aspirational.
 */

import {
  type Clock,
  type Result,
  type Sha256,
  contentHash,
  err,
  isErr,
  ok,
  ValidationError,
} from '@rv/shared-kernel';
import type { StructuredBackend, StructuredTrace } from '@rv/prompt-kit';
import { StructuredCall } from '@rv/prompt-kit';
import type {
  EntityId,
  EpisodeId,
  EpisodeSummary,
  OpenLoopId,
  RelationId,
  SeasonId,
  StateDelta,
  StoryTime,
} from '@rv/contracts';

import { compareStrings, type NarrativeGraph } from '../graph/narrative-graph';
import { estimateTokens } from '../retrieve/tokens';
import { COMPACTION_SYSTEM_PROMPT, EpisodeSummaryDraft } from './drafts';

/** Default ceiling for one episode summary. Twelve of these still fit a small context. */
export const DEFAULT_EPISODE_SUMMARY_TOKENS = 700;

/** One scene as compaction sees it: its position, and its prose. */
export interface SceneForCompaction {
  readonly sceneId: string;
  readonly at: StoryTime;
  readonly text: string;
}

/**
 * What was kept and what was thrown away, counted.
 *
 * Present because "lossy by design" is only acceptable if the loss is visible. A
 * manifest that says 9 800 characters of prose became 640 tokens, and that four canon
 * facts and two promises survived intact, is the difference between a compaction step
 * and a shrug.
 */
export interface CompactionManifest {
  readonly preserved: {
    readonly entitiesIntroduced: number;
    readonly relationsChanged: number;
    readonly openLoopsPlanted: number;
    readonly openLoopsPaid: number;
    readonly storySpanOrdinals: number;
  };
  readonly dropped: {
    readonly scenes: number;
    readonly proseCharacters: number;
  };
  readonly summaryTokens: number;
  /** Fingerprint of the material. Equal hashes mean the summary need not be recomputed. */
  readonly inputHash: Sha256;
}

export interface CompactEpisodeInput {
  readonly graph: NarrativeGraph;
  readonly episodeId: EpisodeId;
  readonly seasonId: SeasonId;
  /** Position within the season, zero-based. */
  readonly index: number;
  readonly scenes: readonly SceneForCompaction[];
  readonly deltas: readonly StateDelta[];
  /** The stored summary and the hash it was computed from, when there is one. */
  readonly previous?: { readonly summary: EpisodeSummary; readonly inputHash: Sha256 };
  readonly maxTokens?: number;
}

export interface CompactEpisodeOutput {
  readonly summary: EpisodeSummary;
  readonly manifest: CompactionManifest;
  /** `null` when the cached summary was reused - the signal that nothing was spent. */
  readonly trace: StructuredTrace | null;
  readonly reused: boolean;
}

export interface CompactEpisodeDeps {
  readonly backends: readonly StructuredBackend[];
  readonly clock: Clock;
  readonly structuredCall?: StructuredCall;
}

export class CompactEpisodeUseCase {
  readonly #call: StructuredCall;
  readonly #backends: readonly StructuredBackend[];

  constructor(deps: CompactEpisodeDeps) {
    this.#backends = deps.backends;
    this.#call = deps.structuredCall ?? new StructuredCall({ clock: deps.clock });
  }

  async execute(input: CompactEpisodeInput): Promise<Result<CompactEpisodeOutput>> {
    if (input.scenes.length === 0) {
      return err(
        new ValidationError({
          message: 'Cannot compact an episode with no scenes.',
          context: { episodeId: input.episodeId },
        }),
      );
    }

    const facts = foldDeltas(input.deltas);
    const inputHash = contentHash({
      episodeId: input.episodeId,
      scenes: input.scenes.map((scene) => [scene.sceneId, scene.at.ordinal, scene.text]),
      deltas: input.deltas,
    });

    if (input.previous?.inputHash === inputHash) {
      return ok({
        summary: input.previous.summary,
        manifest: manifestFor(input, facts, inputHash, input.previous.summary),
        trace: null,
        reused: true,
      });
    }

    const called = await this.#call.run({
      schemaName: 'EpisodeSummaryDraft',
      schema: EpisodeSummaryDraft,
      backends: this.#backends,
      system: COMPACTION_SYSTEM_PROMPT,
      user: this.#buildPrompt(input),
    });
    if (isErr(called)) return err(called.error.error);

    const draft = called.value.value;
    const summary: EpisodeSummary = {
      episodeId: input.episodeId,
      seasonId: input.seasonId,
      seriesId: input.graph.seriesId,
      index: input.index,
      title: draft.title,
      logline: draft.logline,
      synopsis: draft.synopsis,
      beats: draft.beats,
      storySpan: facts.storySpan,
      entitiesIntroduced: [...facts.entitiesIntroduced],
      relationsChanged: [...facts.relationsChanged],
      openLoopsPlanted: [...facts.openLoopsPlanted],
      openLoopsPaid: [...facts.openLoopsPaid],
      canonFrozen: input.graph.airedEpisodes.has(input.episodeId),
    };

    const manifest = manifestFor(input, facts, inputHash, summary);
    const ceiling = input.maxTokens ?? DEFAULT_EPISODE_SUMMARY_TOKENS;
    if (manifest.summaryTokens > ceiling) {
      // Returned rather than silently accepted: a ladder whose bottom rung overruns its
      // ceiling stops fitting a context window several rungs later, where the cause is
      // no longer visible.
      return err(
        new ValidationError({
          message: `Episode summary is ${String(manifest.summaryTokens)} tokens, over the ${String(ceiling)}-token ceiling.`,
          context: {
            reason: 'summary-over-ceiling',
            episodeId: input.episodeId,
            tokens: manifest.summaryTokens,
            ceiling,
          },
        }),
      );
    }

    return ok({ summary, manifest, trace: called.value.trace, reused: false });
  }

  #buildPrompt(input: CompactEpisodeInput): string {
    const cast = new Set<EntityId>();
    for (const delta of input.deltas) for (const id of delta.entitiesIntroduced) cast.add(id);
    const named = [...cast]
      .map((id) => input.graph.entity(id)?.canonicalName)
      .filter((name) => name !== undefined);

    const parts = [`Episode ${String(input.index)} of the season. Compact it.`];
    if (named.length > 0) parts.push(`New this episode: ${named.join(', ')}.`);
    parts.push(
      ...input.scenes.map(
        (scene) => `[scene ${scene.sceneId} @ ${String(scene.at.ordinal)}]\n${scene.text}`,
      ),
    );
    return parts.join('\n\n');
  }
}

interface FoldedDeltas {
  readonly entitiesIntroduced: readonly EntityId[];
  readonly relationsChanged: readonly RelationId[];
  readonly openLoopsPlanted: readonly OpenLoopId[];
  readonly openLoopsPaid: readonly OpenLoopId[];
  readonly storySpan: EpisodeSummary['storySpan'];
}

/**
 * The bookkeeping half, computed rather than asked for.
 *
 * The span's `until` is one ordinal past the last scene, because `StoryInterval` is
 * half-open: an interval ending exactly at the last scene's ordinal excludes the scene
 * it is supposed to cover.
 */
function foldDeltas(deltas: readonly StateDelta[]): FoldedDeltas {
  const entities = new Set<EntityId>();
  const relations = new Set<RelationId>();
  const planted = new Set<OpenLoopId>();
  const paid = new Set<OpenLoopId>();
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;

  for (const delta of deltas) {
    for (const id of delta.entitiesIntroduced) entities.add(id);
    for (const id of delta.relationsAsserted) relations.add(id);
    for (const id of delta.relationsRetracted) relations.add(id);
    for (const id of delta.openLoopsPlanted) planted.add(id);
    for (const id of delta.openLoopsPaid) paid.add(id);
    lowest = Math.min(lowest, delta.at.ordinal);
    highest = Math.max(highest, delta.at.ordinal);
  }

  const bounded = Number.isFinite(lowest);
  return {
    entitiesIntroduced: [...entities].sort(compareStrings),
    relationsChanged: [...relations].sort(compareStrings),
    openLoopsPlanted: [...planted].sort(compareStrings),
    openLoopsPaid: [...paid].sort(compareStrings),
    storySpan: bounded
      ? { from: { ordinal: lowest }, until: { ordinal: highest + 1 } }
      : { from: null, until: null },
  };
}

function manifestFor(
  input: CompactEpisodeInput,
  facts: FoldedDeltas,
  inputHash: Sha256,
  summary: EpisodeSummary,
): CompactionManifest {
  const prose = input.scenes.reduce((total, scene) => total + scene.text.length, 0);
  const from = summary.storySpan.from?.ordinal ?? 0;
  const until = summary.storySpan.until?.ordinal ?? from;
  return {
    preserved: {
      entitiesIntroduced: facts.entitiesIntroduced.length,
      relationsChanged: facts.relationsChanged.length,
      openLoopsPlanted: facts.openLoopsPlanted.length,
      openLoopsPaid: facts.openLoopsPaid.length,
      storySpanOrdinals: Math.max(0, until - from),
    },
    dropped: { scenes: input.scenes.length, proseCharacters: prose },
    summaryTokens: episodeSummaryTokens(summary),
    inputHash,
  };
}

/** What the summary costs when it is loaded into a prompt - which is the only cost that matters. */
export function episodeSummaryTokens(summary: EpisodeSummary): number {
  return estimateTokens(
    [summary.title, summary.logline, summary.synopsis, ...summary.beats].join('\n'),
  );
}
