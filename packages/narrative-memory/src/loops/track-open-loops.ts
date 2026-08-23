/**
 * Chekhov's gun, as a query.
 *
 * An unpaid setup is invisible to every other check in this package. Nothing contradicts
 * it, no interval overlaps, no character knows something they should not - the episode
 * passes continuity cleanly and the audience still feels cheated. It is also the most
 * common structural failure of serialised fiction, and it is mechanically detectable,
 * which is a rare combination worth spending code on.
 *
 * Two mechanisms, and they are independent on purpose:
 *
 * - **Declared loops.** An `OpenLoop` row, planted by the extractor or the planner, with
 *   a promise written as the debt rather than as the plant.
 * - **Implied loops.** A `foreshadows` edge with no `pays-off` edge answering it. The
 *   taxonomy already has both types, so a series that never declares a single `OpenLoop`
 *   still gets the report.
 *
 * Payoff detection is structural rather than semantic: a `pays-off` edge that reaches
 * the loop, at or after it was planted. No model is asked whether a scene "felt like" a
 * payoff, because the answer would be different on Tuesday.
 */

import type {
  ContinuityIssue,
  EntityId,
  EpisodeId,
  OpenLoop,
  Relation,
  RelationId,
  StoryTime,
} from '@rv/contracts';

import { deriveIssueId, deriveOpenLoopId, seed } from '../graph/derive-id';
import { compareStrings, type NarrativeGraph } from '../graph/narrative-graph';

/** Episodes a promise may stay open before it is worth telling the showrunner. */
export const DEFAULT_STALE_AFTER_EPISODES = 3;

/**
 * The `plantedIn` of a promise that has no episode behind it.
 *
 * `OpenLoop.plantedIn.episodeId` is required, and rightly so - a promise with no origin
 * cannot be chased - but an author-written or inferred `foreshadows` edge has no
 * episode to name. This sentinel never resolves to a real episode, and
 * `episodeIndex` therefore reports `-1` for it, which is how a loop with no measurable
 * age says so instead of pretending to one.
 */
export const UNSCHEDULED_EPISODE = 'ep_00000000000000000000000000' as EpisodeId;

export interface OpenLoopStanding {
  readonly loop: OpenLoop;
  /**
   * Broadcast distance from where it was planted, or `null` when either end is not on
   * the schedule. Not story time: a promise planted in a flashback is owed from the
   * episode that aired it.
   */
  readonly ageInEpisodes: number | null;
  /** Past its `expectedPayoff` window, or older than the configured threshold. */
  readonly overdue: boolean;
}

export interface PaidLoop {
  readonly loop: OpenLoop;
  /** The edge that discharged it. */
  readonly by: Relation;
}

export interface OpenLoopReportOptions {
  /** The episode the report is being run for. Ages are measured against its slot. */
  readonly episodeId?: EpisodeId;
  readonly at?: StoryTime;
  readonly staleAfterEpisodes?: number;
}

export interface OpenLoopReport {
  readonly open: readonly OpenLoopStanding[];
  readonly paid: readonly PaidLoop[];
  /**
   * Loops the graph implies but nobody declared.
   *
   * Returned so the planner can promote them to real `OpenLoop` rows rather than having
   * them re-derived on every report.
   */
  readonly undeclared: readonly OpenLoop[];
  /** `warning`, never `error`: an unpaid promise is a note to the showrunner, not a bug. */
  readonly issues: readonly ContinuityIssue[];
}

/**
 * The whole report, as a pure function of the graph.
 *
 * Exported as a function as well as behind the use-case because the continuity check
 * folds it into its own findings and has no business constructing a second use-case to
 * do it.
 */
export function reportOpenLoops(
  graph: NarrativeGraph,
  options: OpenLoopReportOptions = {},
): OpenLoopReport {
  const payoffs = graph.relations.filter((relation) => relation.type === 'pays-off');
  const declared = graph.openLoops;
  const undeclared = deriveUndeclared(graph, declared);
  const all = [...declared, ...undeclared].sort((a, b) => compareStrings(a.id, b.id));

  const currentIndex = options.episodeId === undefined ? -1 : graph.episodeIndex(options.episodeId);
  const stale = options.staleAfterEpisodes ?? DEFAULT_STALE_AFTER_EPISODES;

  const open: OpenLoopStanding[] = [];
  const paid: PaidLoop[] = [];

  for (const loop of all) {
    if (loop.status === 'abandoned') continue;

    const discharge = findPayoff(loop, payoffs);
    if (loop.status === 'paid') continue;
    if (discharge !== undefined) {
      paid.push({
        loop: {
          ...loop,
          status: 'paid',
          paidIn: paidInFrom(discharge, loop.plantedAt),
        },
        by: discharge,
      });
      continue;
    }

    const plantedIndex = graph.episodeIndex(loop.plantedIn.episodeId);
    const ageInEpisodes =
      currentIndex < 0 || plantedIndex < 0 ? null : Math.max(0, currentIndex - plantedIndex);
    const pastWindow =
      options.at !== undefined &&
      loop.expectedPayoff.until !== null &&
      loop.expectedPayoff.until.ordinal <= options.at.ordinal;

    open.push({
      loop,
      ageInEpisodes,
      overdue: pastWindow || (ageInEpisodes !== null && ageInEpisodes > stale),
    });
  }

  const episodeId = options.episodeId;
  const issues: ContinuityIssue[] =
    episodeId === undefined
      ? []
      : open
          .filter((standing) => standing.overdue)
          .map((standing) => ({
            id: deriveIssueId(
              seed(graph.seriesId, episodeId, 'unpaid-open-loop', standing.loop.id),
            ),
            seriesId: graph.seriesId,
            episodeId,
            severity: 'warning' as const,
            rule: 'unpaid-open-loop' as const,
            detectedBy: 'rule' as const,
            entities: [...standing.loop.entities].sort(compareStrings),
            // The one rule the schema exempts from "name both sides": nothing
            // contradicts a promise nobody kept.
            conflictingFacts: [],
            explanation: `"${standing.loop.promise}" was planted in ${standing.loop.plantedIn.episodeId}${standing.ageInEpisodes === null ? '' : `, ${String(standing.ageInEpisodes)} episode(s) ago`}, and nothing has paid it off.`,
            suggestedFix: `Pay it in this episode, push its expected window out deliberately, or mark the loop abandoned with a reason.`,
            confidence: 1,
          }));

  return {
    open: open.sort((a, b) => compareStrings(a.loop.id, b.loop.id)),
    paid: paid.sort((a, b) => compareStrings(a.loop.id, b.loop.id)),
    undeclared,
    issues: issues.sort((a, b) => compareStrings(a.id, b.id)),
  };
}

/**
 * A `pays-off` edge that answers this loop.
 *
 * Match on either end of the edge touching the loop - its entities, or an endpoint of
 * one of the `foreshadows` edges it carries - and require it not to precede the plant.
 * A payoff before its setup is a different story, and usually a different bug.
 */
function findPayoff(loop: OpenLoop, payoffs: readonly Relation[]): Relation | undefined {
  const targets = new Set<string>([...loop.entities, ...loop.relations]);
  return payoffs
    .filter((payoff) => {
      if (payoff.retractedAt !== null) return false;
      if (payoff.validFrom !== null && payoff.validFrom.ordinal < loop.plantedAt.ordinal) {
        return false;
      }
      return targets.has(payoff.to) || targets.has(payoff.from) || targets.has(payoff.id);
    })
    .sort((a, b) => compareStrings(a.id, b.id))[0];
}

function paidInFrom(payoff: Relation, fallback: StoryTime): OpenLoop['paidIn'] {
  const at = payoff.validFrom ?? fallback;
  if (payoff.sourceRef.kind !== 'episode') return null;
  const sceneId = payoff.sourceRef.sceneId;
  return {
    episodeId: payoff.sourceRef.episodeId,
    ...(sceneId !== undefined ? { sceneId } : {}),
    at,
  };
}

/**
 * `foreshadows` edges nobody turned into a promise.
 *
 * The synthesised loop borrows the edge's own sentence for both `setup` and `promise`,
 * which is honest - we do not know what the audience was promised, only that something
 * was pointed at - and it carries the edge in `relations` so a later `pays-off` matches.
 */
function deriveUndeclared(
  graph: NarrativeGraph,
  declared: readonly OpenLoop[],
): readonly OpenLoop[] {
  const covered = new Set<RelationId>();
  for (const loop of declared) for (const relationId of loop.relations) covered.add(relationId);

  const loops: OpenLoop[] = [];
  for (const relation of graph.relations) {
    if (relation.type !== 'foreshadows') continue;
    if (relation.retractedAt !== null) continue;
    if (covered.has(relation.id)) continue;

    const entities: EntityId[] = [relation.from, relation.to].sort(compareStrings);
    loops.push({
      id: deriveOpenLoopId(seed(graph.seriesId, 'implied', relation.id)),
      seriesId: graph.seriesId,
      setup: relation.fact,
      promise: relation.fact,
      plantedAt: relation.validFrom ?? { ordinal: 0 },
      plantedIn: plantedInFrom(relation),
      entities,
      relations: [relation.id],
      expectedPayoff: { from: relation.validFrom, until: null },
      urgency: 0.5,
      status: 'open',
      paidIn: null,
    });
  }
  return loops.sort((a, b) => compareStrings(a.id, b.id));
}

function plantedInFrom(relation: Relation): OpenLoop['plantedIn'] {
  if (relation.sourceRef.kind !== 'episode') {
    // An author-planted or inferred setup has no episode. The id is not a real episode
    // and is never resolved as one; it exists so `plantedIn` can stay required, which is
    // right - a promise with no origin cannot be chased.
    return { episodeId: UNSCHEDULED_EPISODE };
  }
  const sceneId = relation.sourceRef.sceneId;
  return {
    episodeId: relation.sourceRef.episodeId,
    ...(sceneId !== undefined ? { sceneId } : {}),
  };
}

export interface TrackOpenLoopsInput extends OpenLoopReportOptions {
  readonly graph: NarrativeGraph;
}

/**
 * The report as a use-case, for callers that reach it from outside the continuity check.
 *
 * Synchronous and provider-free: every question it answers is a set operation over the
 * graph, and a promise ledger that needed a model to read it would not be run often
 * enough to be useful.
 */
export class TrackOpenLoopsUseCase {
  execute(input: TrackOpenLoopsInput): OpenLoopReport {
    return reportOpenLoops(input.graph, input);
  }
}
