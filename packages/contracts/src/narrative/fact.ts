/**
 * `Fact` - the retrievable unit of narrative memory.
 *
 * ## Why this exists, and why it is not just `Relation`
 *
 * `FactId` was in the id registry, `MemoryFactRef` and `ContinuityIssue.conflictingFacts`
 * pointed at facts, and nothing defined one. The graph asserts `Relation`s keyed by
 * `RelationId`, so a continuity finding naming `FactId`s could not be resolved back to
 * the edges it was about: the checker could say "these two cannot both be true" and the
 * UI could not show either of them.
 *
 * The fix is not to re-key findings on `RelationId`, because a relation cannot carry
 * everything worth remembering. A relation is a sentence with a subject *and an object*
 * - `(Aria) —parent-of→ (Kael)`. "The bridge at Elsmere burned", "it rained for three
 * days", "the council never voted" have no object, and forcing them into the graph
 * means inventing a placeholder entity for the weather. Retrieval, meanwhile, wants
 * exactly one kind of thing to score and rank.
 *
 * So: **a fact is the retrievable unit, and a relation is one kind of fact.** The
 * discriminated `content` says which kind:
 *
 * | kind        | what it is                                                   |
 * |-------------|--------------------------------------------------------------|
 * | `relation`  | a graph edge, by id. The fact *is* that edge.                |
 * | `statement` | a proposition with no object, held as prose.                 |
 * | `summary`   | one fact standing in for many, the rung of the compaction ladder retrieval actually loads. |
 *
 * ## What it shares with `Relation`, deliberately
 *
 * Both clocks, spelled with the same four field names, from the same shape fragment in
 * `bi-temporal.ts` - so "what was true during episode 2, as we believe it today" is one
 * query shape over both tables rather than two that have to be kept in step. Same
 * `sourceRef` union (`RelationSource`: an aired episode outranks an author note
 * outranks an inference), same `visibility`, same `confidence`. A fact whose content is
 * a relation therefore agrees with that relation field for field, which is what makes
 * the two stores joinable instead of merely adjacent.
 *
 * ## What it does not carry
 *
 * No prompt-ready `text`. For a `relation` fact the sentence already exists on
 * `Relation.fact`, and copying it here would create two spellings of one assertion that
 * drift the first time an author edits the edge. The retriever resolves the text and
 * puts it on `RetrievedFact.text`, which is where a prompt-shaped string belongs.
 */

import { z } from 'zod';

import { Confidence, Prose, checkEmbeddingPair, embeddingShape } from '../primitives/common';
import { FactId, RelationId, SeriesId } from '../primitives/ids';
import { biTemporalShape, checkBiTemporalOrder } from './bi-temporal';
import { Importance } from './entity';
import { AudienceVisibility, RelationSource } from './relation';

// ── what the fact says ──────────────────────────────────────────────────────

export const FACT_CONTENT_KINDS = ['relation', 'statement', 'summary'] as const;

/**
 * The three things a fact can be.
 *
 * Discriminated rather than "a string plus some optional ids" because each kind is
 * *resolved* differently and the resolver must not guess: a relation is looked up in
 * the graph, a statement is already its own text, and a summary has to be expandable
 * back into the facts it replaced when the budget allows.
 */
export const FactContent = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('relation'),
    relationId: RelationId.describe(
      'The graph edge this fact is. Its sentence, strength and endpoints live on the edge; do not restate them here.',
    ),
  }),
  z.strictObject({
    kind: z.literal('statement'),
    text: Prose.describe(
      'The assertion in one sentence, for a fact with no second party: "The bridge at Elsmere burned in the spring floods." Write it so it reads correctly on its own, out of context, inside a prompt.',
    ),
  }),
  z.strictObject({
    kind: z.literal('summary'),
    text: Prose.describe(
      'The compacted account, one paragraph at most. It has to be usable *instead of* everything it covers, so state outcomes rather than listing events.',
    ),
    covers: z
      .array(FactId)
      .min(2)
      .max(512)
      .describe(
        'The facts this stands in for. At least two - a summary of one fact is that fact. Retrieval charges the summary against the budget and expands it only when the budget allows.',
      ),
  }),
]);
export type FactContent = z.infer<typeof FactContent>;

// ── the fact ────────────────────────────────────────────────────────────────

/**
 * One thing the series remembers, on two clocks.
 *
 * `importance` and the embedding are here rather than derived because they are the two
 * inputs to retrieval that cannot be computed at query time: `importance` decides
 * whether a lead's grudge outranks a background character's address, and the embedding
 * is the semantic half of the hybrid score (docs/02 §4). Both are written by the
 * extractor, and both are the difference between a scored retrieval and a dump.
 *
 * The bi-temporal guard is `checkBiTemporalOrder`, the same function `Relation` uses -
 * not a copy of it. See `bi-temporal.ts` for why the fields are shared too.
 */
export const Fact = z
  .strictObject({
    id: FactId,
    seriesId: SeriesId,
    content: FactContent,

    // ── the two clocks, shared verbatim with `Relation` (see `bi-temporal.ts`) ──
    ...biTemporalShape,

    sourceRef: RelationSource.describe(
      'Where the assertion came from. The same union relations use, and for the same reason: an episode-sourced fact from an aired episode is frozen canon, an author-sourced fact outranks anything inferred, and an inferred fact may be quietly dropped when it conflicts.',
    ),
    confidence: Confidence.default(1).describe(
      'How sure we are. 1 for anything an author stated directly; lower for extraction and inference.',
    ),
    visibility: AudienceVisibility.default('public'),
    importance: Importance.default('background').describe(
      'Narrative weight, copied from the entities the fact touches so retrieval can rank without walking the graph.',
    ),
    ...embeddingShape,
  })
  .superRefine((fact, ctx) => {
    checkBiTemporalOrder(fact, ctx);
    checkEmbeddingPair(fact, ctx);

    // A summary that covers itself expands forever: retrieval drops the summary in,
    // sees it has room, expands it, and gets the summary back. Cheap to state here,
    // impossible to state in the JSON Schema the extractor is constrained by.
    if (fact.content.kind === 'summary' && fact.content.covers.includes(fact.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['content', 'covers'],
        message: 'a summary cannot cover itself',
      });
    }
  });
export type Fact = z.infer<typeof Fact>;

/**
 * The relation a fact is about, or `null` when it is not about one.
 *
 * Exported because it is the join the continuity checker needs and the one place the
 * `content` union should have to be opened: given the `FactId`s in a
 * `ContinuityIssue.conflictingFacts`, this is what turns them back into edges the UI
 * can highlight in the graph. Every caller that inlines the same `kind === 'relation'`
 * test is a caller that will forget the `summary` case when summaries start covering
 * relations.
 */
export function factRelationId(fact: Fact): RelationId | null {
  return fact.content.kind === 'relation' ? fact.content.relationId : null;
}
