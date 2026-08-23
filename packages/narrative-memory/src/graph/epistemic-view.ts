/**
 * One character's head, resolved at one moment on each clock.
 *
 * `BiTemporalIndex.knowledgeOf` already returns the epistemic edges. What is missing
 * between that and the `EpistemicView` the scene writer is handed is the sorting: `knows`
 * and `witnessed` are things held *and true*, `believes-falsely` is held and false,
 * `suspects` is entertained but not acted on, and `blindSpots` is the inverse - true
 * edges the viewer does not hold, which is the dramatic irony currently available to the
 * scene and must never be rendered into the prompt as fact.
 *
 * The view is what makes the epistemic rule meaningful. Without it the scene writer sees
 * the narrator's graph, writes Kael acting on his parentage three episodes before he
 * learns it, and the only thing standing between that and the screen is a human noticing.
 */

import type { Instant } from '@rv/shared-kernel';
import { toIso } from '@rv/shared-kernel';
import type {
  EntityId,
  EpistemicView,
  KnownFact,
  Relation,
  RelationId,
  StoryTime,
} from '@rv/contracts';

import { compareStrings, type NarrativeGraph } from './narrative-graph';

/** Above this a view is reported `truncated` rather than silently clipped. */
export const DEFAULT_VIEW_CAP = 512;

export interface EpistemicViewOptions {
  readonly at: StoryTime;
  readonly asOf: Instant;
  /** Hard cap per bucket, matching the schema's own `.max(512)`. */
  readonly cap?: number;
  /**
   * Whether the viewer sees everything.
   *
   * `CharacterPayload.knowledgeScope` is `omniscient | limited`; an omniscient viewer's
   * view is the whole graph, which is what a narrator-POV scene needs and what makes
   * "no POV character" expressible without a second code path.
   */
  readonly omniscient?: boolean;
}

export function buildEpistemicView(
  graph: NarrativeGraph,
  viewerId: EntityId,
  options: EpistemicViewOptions,
): EpistemicView {
  const cap = options.cap ?? DEFAULT_VIEW_CAP;
  const standpoint = { storyAt: options.at, authoredAt: options.asOf };
  const base = {
    seriesId: graph.seriesId,
    viewerId,
    at: options.at,
    asOf: toIso(options.asOf),
  };

  if (options.omniscient === true) {
    // An omniscient viewer has no blind spots by definition, and every current fact is
    // held. Rendering that through the same `knows` bucket keeps the consumer identical.
    const all = graph.index.query(standpoint);
    const knows = all.slice(0, cap).map((relation) => toKnownFact(relation, 'knows'));
    return {
      ...base,
      knows,
      believesFalsely: [],
      suspects: [],
      blindSpots: [],
      truncated: all.length > cap,
      factCount: all.length,
    };
  }

  const epistemic = [...graph.index.knowledgeOf(viewerId, standpoint)].sort(byRelationId);

  const knows: KnownFact[] = [];
  const believesFalsely: KnownFact[] = [];
  const suspects: KnownFact[] = [];

  for (const edge of epistemic) {
    const known = toKnownFact(edge, edge.type);
    if (edge.type === 'believes-falsely') believesFalsely.push(known);
    else if (edge.type === 'suspects') suspects.push(known);
    else knows.push(known);
  }

  // A blind spot is a non-public fact the viewer could not act on, so it is defined by
  // the same predicate the continuity rule fires on. One definition, not two: a view
  // that called a fact known while `knowledge-without-source` called it unknown would
  // put the contradiction inside the engine rather than inside the script.
  //
  // `standpoint` carries both clocks and must - `couldKnow` without one consults every
  // epistemic edge the viewer will ever hold, which would let a later reveal retroact
  // into an earlier scene's view.
  const blindSpots: RelationId[] = [];
  for (const relation of graph.index.query(standpoint)) {
    if (relation.visibility === 'public') continue;
    if (graph.index.couldKnow(viewerId, relation, standpoint)) continue;
    blindSpots.push(relation.id);
  }

  const factCount = knows.length + believesFalsely.length + suspects.length;
  return {
    ...base,
    knows: knows.slice(0, cap),
    believesFalsely: believesFalsely.slice(0, cap),
    suspects: suspects.slice(0, cap),
    blindSpots: blindSpots.slice(0, cap),
    truncated:
      knows.length > cap ||
      believesFalsely.length > cap ||
      suspects.length > cap ||
      blindSpots.length > cap,
    factCount,
  };
}

/**
 * Whether the viewer is omniscient, per their character sheet.
 *
 * A non-character entity - a location, a prop - is never omniscient and never a viewer;
 * the caller gets `false` and an empty view rather than an exception, because a scene
 * whose POV field points at a prop is a data error the pipeline should report, not crash
 * on.
 */
export function isOmniscient(graph: NarrativeGraph, viewerId: EntityId): boolean {
  const entity = graph.entity(viewerId);
  return entity?.kind === 'character' && entity.payload.knowledgeScope === 'omniscient';
}

/**
 * The epistemic edge stands in for "the edge this belief is about".
 *
 * `KnownFact.relationId` is required, and for a belief with no underlying true edge -
 * "my parents died in the fire" - there is no other edge to point at. Pointing at the
 * belief edge itself is the only total answer, and it is the useful one: it is the row
 * the UI highlights and the row the reveal later bounds.
 */
function toKnownFact(relation: Relation, via: string): KnownFact {
  const epistemicVia = isEpistemicVia(via) ? via : 'knows';
  return {
    relationId: relation.id,
    fact: relation.fact,
    via: epistemicVia,
    learnedAt: relation.validFrom,
    confidence: relation.confidence,
  };
}

const EPISTEMIC_VIA = new Set(['knows', 'believes-falsely', 'suspects', 'witnessed', 'told']);

function isEpistemicVia(value: string): value is KnownFact['via'] {
  return EPISTEMIC_VIA.has(value);
}

function byRelationId(left: Relation, right: Relation): number {
  return compareStrings(left.id, right.id);
}
