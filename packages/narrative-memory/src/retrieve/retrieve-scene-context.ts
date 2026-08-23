/**
 * Budgeted hybrid retrieval - "assemble the context for writing this scene".
 *
 * Three guarantees, and every design choice in this file serves one of them.
 *
 * **Deterministic.** Same graph state, same request, same facts, in the same order.
 * Nothing here reads a clock or a random source; the candidate set is built by walking
 * arrays the graph already sorted; ties break on `factId`, never on map iteration; and
 * the `stateHash` echoed back is what lets a result found in a log a week later be
 * checked against a re-run.
 *
 * **Bounded.** Facts are taken until the budget is spent, and what did not fit is
 * reported in `droppedForBudget` rather than discarded, so raising the budget is a
 * predictable operation and `truncated` is never silent.
 *
 * **Unconditional floor.** The series premise, the current episode outline, the sheets
 * of the characters present, and the POV character's epistemic view go in before scoring
 * begins and are never traded against the budget. A scene written without them is not a
 * scene that more facts can fix. When the floor alone exceeds the budget the floor still
 * wins and `truncated` says so - the honest failure is an over-long prompt, not a scene
 * written blind.
 *
 * Every included fact carries the arithmetic that put it there, because "why did the
 * writer not know about the knife" has to be answerable without re-running anything.
 */

import { type Result, err, isErr, ok } from '@rv/shared-kernel';
import { fromIso } from '@rv/shared-kernel';
import type { EmbeddingPort } from '@rv/providers';
import type {
  EntityId,
  FactId,
  Importance,
  MemoryFactRef,
  MemoryRetrievalRequest,
  MemoryRetrievalResult,
  RetrievalScoreBreakdown,
  RetrievedFact,
  StoryTime,
} from '@rv/contracts';

import { deriveFactId, seed } from '../graph/derive-id';
import { buildEpistemicView, isOmniscient } from '../graph/epistemic-view';
import { compareStrings, type NarrativeGraph } from '../graph/narrative-graph';
import {
  renderEntitySheet,
  renderEpisodeOutline,
  renderEpistemicView,
  renderFact,
  renderOpenLoop,
  renderPremise,
} from './render';
import {
  ZERO_BREAKDOWN,
  importanceScore,
  proximityScore,
  recencyScore,
  similarityScore,
  weightedTotal,
} from './scoring';
import { DEFAULT_TOKEN_COUNTER, type TokenCounter } from './tokens';

/** The schema caps both fact arrays at this; exceeding it fails validation downstream. */
const MAX_FACTS = 2048;

interface Candidate {
  readonly factId: FactId;
  readonly ref: MemoryFactRef;
  readonly text: string;
  readonly tokens: number;
  readonly entities: readonly EntityId[];
  readonly validFrom: StoryTime | null;
  readonly importance: Importance;
  readonly embedding: readonly number[] | undefined;
  readonly loopUrgency: number;
}

export interface RetrieveSceneContextInput {
  readonly graph: NarrativeGraph;
  /** Already parsed, so every default in the schema has been applied. */
  readonly request: MemoryRetrievalRequest;
}

export interface RetrieveSceneContextDeps {
  readonly embeddings: EmbeddingPort;
  readonly tokenCounter?: TokenCounter;
}

export class RetrieveSceneContextUseCase {
  readonly #embeddings: EmbeddingPort;
  readonly #tokens: TokenCounter;

  constructor(deps: RetrieveSceneContextDeps) {
    this.#embeddings = deps.embeddings;
    this.#tokens = deps.tokenCounter ?? DEFAULT_TOKEN_COUNTER;
  }

  async execute(input: RetrieveSceneContextInput): Promise<Result<MemoryRetrievalResult>> {
    const { graph, request } = input;
    const asOf = fromIso(request.asOf);
    const standpoint = { storyAt: request.at, authoredAt: asOf };

    const view =
      request.povEntityId === null
        ? null
        : buildEpistemicView(graph, request.povEntityId, {
            at: request.at,
            asOf,
            omniscient: isOmniscient(graph, request.povEntityId),
          });

    const floor = this.#buildFloor(graph, request, view);
    const scored = this.#buildCandidates(
      graph,
      request,
      standpoint,
      new Set(floor.map((c) => c.factId)),
    );

    const embedded = await this.#embed(request, scored);
    if (isErr(embedded)) return embedded;

    const ranked = this.#rank(graph, request, standpoint, scored, embedded.value);
    return ok(this.#assemble(graph, request, view, floor, ranked));
  }

  // ── the unconditional floor ───────────────────────────────────────────────

  #buildFloor(
    graph: NarrativeGraph,
    request: MemoryRetrievalRequest,
    view: ReturnType<typeof buildEpistemicView> | null,
  ): readonly Candidate[] {
    const floor: Candidate[] = [];
    const push = (kindSeed: string, ref: MemoryFactRef, text: string): void => {
      floor.push({
        factId: deriveFactId(seed(graph.seriesId, kindSeed)),
        ref,
        text,
        tokens: this.#tokens.count(text),
        entities: [],
        validFrom: null,
        importance: 'lead',
        embedding: undefined,
        loopUrgency: 0,
      });
    };

    if (request.alwaysInclude.seriesPremise && graph.seriesSummary !== null) {
      push(
        `premise:${graph.seriesId}`,
        { kind: 'premise', seriesId: graph.seriesId },
        renderPremise(graph.seriesSummary),
      );
    }

    if (request.alwaysInclude.episodeOutline) {
      const summary = graph.episodeSummary(request.episodeId);
      if (summary !== undefined) {
        push(
          `outline:${request.episodeId}`,
          { kind: 'episode-summary', episodeId: request.episodeId },
          renderEpisodeOutline(summary),
        );
      }
    }

    if (request.alwaysInclude.presentCharacterSheets) {
      // Sorted by id, not by the order the caller listed them: the same scene described
      // with its characters in a different order must produce the same prompt.
      for (const entityId of [...request.sceneEntities].sort(compareStrings)) {
        const entity = graph.entity(entityId);
        if (entity === undefined) continue;
        push(`sheet:${entityId}`, { kind: 'entity', entityId }, renderEntitySheet(entity));
      }
    }

    if (request.alwaysInclude.povEpistemicView && view !== null && request.povEntityId !== null) {
      const name = graph.entity(request.povEntityId)?.canonicalName ?? request.povEntityId;
      push(
        `pov-view:${request.povEntityId}`,
        { kind: 'entity', entityId: request.povEntityId },
        renderEpistemicView(view, name),
      );
    }

    return floor;
  }

  // ── the scored pool ───────────────────────────────────────────────────────

  #buildCandidates(
    graph: NarrativeGraph,
    request: MemoryRetrievalRequest,
    standpoint: { storyAt: StoryTime; authoredAt: ReturnType<typeof fromIso> },
    taken: ReadonlySet<string>,
  ): readonly Candidate[] {
    const visible = new Set(request.visibility);
    const urgencyByRelation = openLoopUrgency(graph);
    const candidates: Candidate[] = [];

    for (const fact of graph.facts) {
      if (visible.size > 0 && !visible.has(fact.visibility)) continue;
      if (!withinStandpoint(fact, standpoint)) continue;

      const relationId = fact.content.kind === 'relation' ? fact.content.relationId : undefined;
      const relation = relationId === undefined ? undefined : graph.relation(relationId);
      // A relation-backed fact whose edge has been bounded or retracted is no longer a
      // fact about *this* moment, whatever the fact row's own clocks say.
      if (relationId !== undefined && relation === undefined) continue;
      if (relation !== undefined && !withinStandpoint(relation, standpoint)) continue;

      const text = renderFact(fact, relation);
      if (text === undefined) continue;
      if (taken.has(fact.id)) continue;

      candidates.push({
        factId: fact.id,
        ref: { kind: 'fact', factId: fact.id },
        text,
        tokens: this.#tokens.count(text),
        entities: relation === undefined ? [] : [relation.from, relation.to],
        validFrom: fact.validFrom,
        importance: fact.importance,
        embedding: fact.embedding,
        loopUrgency: relationId === undefined ? 0 : (urgencyByRelation.get(relationId) ?? 0),
      });
    }

    for (const loop of graph.openLoops) {
      if (loop.status !== 'open') continue;
      if (loop.plantedAt.ordinal > request.at.ordinal) continue;
      const factId = deriveFactId(seed(graph.seriesId, `open-loop:${loop.id}`));
      if (taken.has(factId)) continue;
      const text = renderOpenLoop(loop);
      candidates.push({
        factId,
        ref: { kind: 'open-loop', openLoopId: loop.id },
        text,
        tokens: this.#tokens.count(text),
        entities: loop.entities,
        validFrom: loop.plantedAt,
        importance: 'supporting',
        embedding: undefined,
        loopUrgency: loop.urgency,
      });
    }

    return candidates.sort((left, right) => compareStrings(left.factId, right.factId));
  }

  // ── the semantic half ─────────────────────────────────────────────────────

  /**
   * One batch, or none at all.
   *
   * Skipped entirely when the semantic weight is zero: a caller who has switched the
   * term off should not pay for an embedding round trip, and a series being written with
   * the local embedder down should still be able to retrieve on the other four terms.
   */
  async #embed(
    request: MemoryRetrievalRequest,
    candidates: readonly Candidate[],
  ): Promise<Result<ReadonlyMap<string, readonly number[]>>> {
    const vectors = new Map<string, readonly number[]>();
    if (request.weights.semanticSimilarity === 0) return ok(vectors);

    const missing = candidates.filter((candidate) => candidate.embedding === undefined);
    const texts = [request.sceneGoal, ...missing.map((candidate) => candidate.text)];

    const embedded = await this.#embeddings.embed({ texts });
    if (isErr(embedded)) return err(embedded.error);

    const produced = embedded.value.vectors;
    const goal = produced[0];
    if (goal === undefined) return ok(vectors);
    vectors.set(GOAL_KEY, goal);
    for (const [index, candidate] of missing.entries()) {
      const vector = produced[index + 1];
      if (vector !== undefined) vectors.set(candidate.factId, vector);
    }
    return ok(vectors);
  }

  // ── scoring and ordering ──────────────────────────────────────────────────

  #rank(
    graph: NarrativeGraph,
    request: MemoryRetrievalRequest,
    standpoint: { storyAt: StoryTime; authoredAt: ReturnType<typeof fromIso> },
    candidates: readonly Candidate[],
    vectors: ReadonlyMap<string, readonly number[]>,
  ): readonly { candidate: Candidate; breakdown: RetrievalScoreBreakdown; score: number }[] {
    const neighbourhood = graph.index.neighbourhood(
      request.sceneEntities,
      request.maxHops,
      standpoint,
    );
    const goal = vectors.get(GOAL_KEY);
    const oldest = oldestOrdinal(candidates, request.at);

    const scored = candidates.map((candidate) => {
      const distances = candidate.entities
        .map((entityId) => neighbourhood.distance.get(entityId))
        .filter((distance) => distance !== undefined);
      const nearest = distances.length === 0 ? undefined : Math.min(...distances);

      const embedding = candidate.embedding ?? vectors.get(candidate.factId);
      const breakdown: RetrievalScoreBreakdown = {
        graphProximity: proximityScore(nearest),
        semanticSimilarity:
          goal === undefined || embedding === undefined ? 0 : similarityScore(goal, embedding),
        storyRecency: recencyScore(candidate.validFrom, request.at, oldest),
        importance: importanceScore(candidate.importance),
        isOpenLoop: candidate.loopUrgency,
      };
      return { candidate, breakdown, score: weightedTotal(breakdown, request.weights) };
    });

    // Score descending, then `factId` ascending. The second half is not cosmetic: float
    // scores tie constantly on small graphs, and without a stable key the order would
    // fall back to whatever the candidate array happened to be, which is what makes a
    // "deterministic" retriever quietly non-deterministic.
    return scored.sort(
      (left, right) =>
        right.score - left.score || compareStrings(left.candidate.factId, right.candidate.factId),
    );
  }

  // ── the budget ────────────────────────────────────────────────────────────

  #assemble(
    graph: NarrativeGraph,
    request: MemoryRetrievalRequest,
    view: ReturnType<typeof buildEpistemicView> | null,
    floor: readonly Candidate[],
    ranked: readonly { candidate: Candidate; breakdown: RetrievalScoreBreakdown; score: number }[],
  ): MemoryRetrievalResult {
    const facts: RetrievedFact[] = floor.map((candidate) => ({
      factId: candidate.factId,
      ref: candidate.ref,
      text: candidate.text,
      reason: 'always' as const,
      rank: 0,
      score: 1,
      breakdown: ZERO_BREAKDOWN,
      tokens: candidate.tokens,
    }));

    let used = facts.reduce((total, fact) => total + fact.tokens, 0);
    const dropped: RetrievedFact[] = [];

    for (const [index, entry] of ranked.entries()) {
      const retrieved: RetrievedFact = {
        factId: entry.candidate.factId,
        ref: entry.candidate.ref,
        text: entry.candidate.text,
        reason: 'scored',
        rank: index + 1,
        score: entry.score,
        breakdown: entry.breakdown,
        tokens: entry.candidate.tokens,
      };

      // Stop at the first fact that does not fit, rather than skipping it and admitting
      // smaller ones behind it. That keeps `droppedForBudget` a contiguous suffix of the
      // ranked order, which is what makes "raising the budget admits these first" a
      // statement the caller can rely on rather than a hope.
      if (
        facts.length < MAX_FACTS &&
        used + retrieved.tokens <= request.tokenBudget &&
        dropped.length === 0
      ) {
        facts.push(retrieved);
        used += retrieved.tokens;
      } else if (dropped.length < MAX_FACTS) {
        dropped.push({ ...retrieved, reason: 'dropped-over-budget' });
      }
    }

    return {
      seriesId: graph.seriesId,
      sceneId: request.sceneId,
      stateHash: graph.stateHash,
      facts,
      droppedForBudget: dropped,
      weights: request.weights,
      tokenBudget: request.tokenBudget,
      tokensUsed: used,
      epistemicView: view,
      truncated: dropped.length > 0 || used > request.tokenBudget,
    };
  }
}

const GOAL_KEY = ' goal';

/**
 * Which relations an unpaid promise rides on.
 *
 * An open loop earns its weight by making the facts that *carry* it outrank the rest -
 * a `foreshadows` edge nobody has paid off is the fact a planner forgets first, and the
 * loop's own urgency is the right number to give it.
 */
function openLoopUrgency(graph: NarrativeGraph): ReadonlyMap<string, number> {
  const urgency = new Map<string, number>();
  for (const loop of graph.openLoops) {
    if (loop.status !== 'open') continue;
    for (const relationId of loop.relations) {
      urgency.set(relationId, Math.max(urgency.get(relationId) ?? 0, loop.urgency));
    }
  }
  return urgency;
}

/** The earliest story ordinal in play, which is what recency is normalised against. */
function oldestOrdinal(candidates: readonly Candidate[], at: StoryTime): number {
  let oldest = at.ordinal;
  for (const candidate of candidates) {
    const from = candidate.validFrom?.ordinal;
    if (from !== undefined && from < oldest) oldest = from;
  }
  return oldest;
}

/**
 * Half-open on story time, half-open on authoring time. The same test the index runs.
 *
 * Both clocks, and `assertedAt` is not optional: a fact retro-fitted while writing
 * episode 7 must be invisible to a query standing before episode 7 was written, which is
 * the whole answer to "what was episode 2 written against?".
 */
function withinStandpoint(
  clocks: {
    readonly validFrom: StoryTime | null;
    readonly validUntil: StoryTime | null;
    readonly assertedAt: string;
    readonly retractedAt: string | null;
  },
  standpoint: { storyAt: StoryTime; authoredAt: ReturnType<typeof fromIso> },
): boolean {
  const { validFrom, validUntil, assertedAt, retractedAt } = clocks;
  if (validFrom !== null && validFrom.ordinal > standpoint.storyAt.ordinal) return false;
  if (validUntil !== null && validUntil.ordinal <= standpoint.storyAt.ordinal) return false;
  if (fromIso(assertedAt) > standpoint.authoredAt) return false;
  if (retractedAt !== null && fromIso(retractedAt) <= standpoint.authoredAt) return false;
  return true;
}
