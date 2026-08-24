/**
 * The bi-temporal graph, read out of SQLite and back into `NarrativeGraph`.
 *
 * `@rv/narrative-memory` is a pure engine: every use-case in it takes a `NarrativeGraph`
 * and returns a new one, and nothing in it knows what a row is. `@rv/persistence` owns
 * the two tables. This is the joint, and it does three things and no more.
 *
 * **It flattens and unflattens both clocks.** The tables store `StoryTime` as integer
 * `*_ordinal` columns with the display label alongside, because the one query the
 * continuity engine has to answer cheaply - "was this true at ordinal N, and did we
 * still believe it at instant T" - has to be an indexed range scan rather than a scan
 * plus a JSON parse. Rebuilding the nested shape is this file's job precisely so no
 * use-case has to know the columns exist.
 *
 * **Every row is parsed on the way out.** A row written by an older build fails loudly
 * here rather than reaching the epistemic projection as half an entity. A single bad
 * row is *skipped and reported*, not fatal: one unreadable prop must not make a
 * character's whole graph unanswerable, and the alternative is a Characters screen that
 * shows nothing with no way to find out why.
 *
 * **Writes are one transaction, entities before edges.** `relations.from_entity_id`
 * references `entities.id` and `foreign_keys` is ON, so a crash between the two halves
 * would leave a graph that cannot be read back. Conflicts are ignored rather than
 * overwritten: a fact that stops being true is *bounded* (see `FoldStateDeltaUseCase`),
 * and an upsert here would let a re-run silently rewrite an edge's story clock.
 */

import { Entity, Relation, type EntityId, type SeriesId, type StoryTime } from '@rv/contracts';
import { NarrativeGraph } from '@rv/narrative-memory';
import { entities, relations, type DatabaseHandle, type RivayatDatabase } from '@rv/persistence';
import {
  fromThrowable,
  isErr,
  ok,
  toAppError,
  type AppError,
  type Logger,
  type Result,
} from '@rv/shared-kernel';
import { eq } from 'drizzle-orm';

export interface NarrativeGraphStoreDeps {
  readonly database: DatabaseHandle;
  readonly logger: Logger;
}

function attempt<T>(message: string, fn: () => T): Result<T, AppError> {
  return fromThrowable(fn, (caught) => toAppError(caught, message));
}

/** `{ ordinal, label? }` from the two columns. `label` omitted, never `undefined`. */
function storyTimeOf(ordinal: number, label: string | null): StoryTime {
  return { ordinal, ...(label === null ? {} : { label }) };
}

/** The same, for a nullable interval end. */
function optionalStoryTime(ordinal: number | null, label: string | null): StoryTime | null {
  return ordinal === null ? null : storyTimeOf(ordinal, label);
}

export class NarrativeGraphStore {
  readonly #db: RivayatDatabase;
  readonly #logger: Logger;

  constructor(deps: NarrativeGraphStoreDeps) {
    this.#db = deps.database.db;
    this.#logger = deps.logger.child({ component: 'narrative-graph' });
  }

  /**
   * The whole graph for one series.
   *
   * A series with no rows yields an *empty* graph rather than a not-found: "this series
   * has no world model yet" is an empty screen and an invitation to build one, and the
   * studio's gateway distinguishes that from a missing route by the status code alone.
   */
  load(seriesId: SeriesId): Result<NarrativeGraph, AppError> {
    const entityRows = attempt(`Could not read the entities of ${seriesId}`, () =>
      this.#db.select().from(entities).where(eq(entities.seriesId, seriesId)).all(),
    );
    if (isErr(entityRows)) return entityRows;

    const relationRows = attempt(`Could not read the relations of ${seriesId}`, () =>
      this.#db.select().from(relations).where(eq(relations.seriesId, seriesId)).all(),
    );
    if (isErr(relationRows)) return relationRows;

    const nodes: Entity[] = [];
    for (const row of entityRows.value) {
      const parsed = Entity.safeParse({
        id: row.id,
        seriesId: row.seriesId,
        kind: row.kind,
        canonicalName: row.canonicalName,
        aliases: row.aliases,
        summary: row.summary,
        firstAppearance: storyTimeOf(row.firstAppearanceOrdinal, row.firstAppearanceLabel),
        importance: row.importance,
        assetRefs: row.assetRefs,
        embedding: [],
        payload: row.payload,
      });
      if (parsed.success) {
        nodes.push(parsed.data);
        continue;
      }
      this.#logger.warn('stored entity no longer satisfies Entity; skipping it', {
        entityId: row.id,
        issues: parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
      });
    }

    const known = new Set(nodes.map((node) => node.id));
    const edges: Relation[] = [];
    for (const row of relationRows.value) {
      const parsed = Relation.safeParse({
        id: row.id,
        seriesId: row.seriesId,
        from: row.fromEntityId,
        to: row.toEntityId,
        type: row.type,
        fact: row.fact,
        strength: row.strength,
        validFrom: optionalStoryTime(row.validFromOrdinal, row.validFromLabel),
        validUntil: optionalStoryTime(row.validUntilOrdinal, row.validUntilLabel),
        assertedAt: row.assertedAt,
        retractedAt: row.retractedAt,
        sourceRef: row.sourceRef,
        confidence: row.confidence,
        visibility: row.visibility,
      });
      if (!parsed.success) {
        this.#logger.warn('stored relation no longer satisfies Relation; skipping it', {
          relationId: row.id,
          issues: parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
        });
        continue;
      }
      // An edge whose endpoints were skipped above would make `couldKnow` consult a
      // node that is not in the graph, and the epistemic answer would depend on which
      // rows happened to be readable.
      if (!known.has(parsed.data.from) || !known.has(parsed.data.to)) {
        this.#logger.warn('relation points at an entity this graph does not hold', {
          relationId: row.id,
        });
        continue;
      }
      edges.push(parsed.data);
    }

    return ok(new NarrativeGraph({ seriesId, entities: nodes, relations: edges }));
  }

  /** Just the nodes, for a caller that is about to write more of them. */
  entityIds(seriesId: SeriesId): Result<ReadonlySet<EntityId>, AppError> {
    const rows = attempt(`Could not read the entities of ${seriesId}`, () =>
      this.#db
        .select({ id: entities.id })
        .from(entities)
        .where(eq(entities.seriesId, seriesId))
        .all(),
    );
    return isErr(rows) ? rows : ok(new Set(rows.value.map((row) => row.id)));
  }

  /**
   * Nodes then edges, in one transaction.
   *
   * `onConflictDoNothing` rather than an upsert: this is how a re-run of S3 over a cast
   * that already exists is idempotent, and it is also what stops a re-run silently
   * rewriting the story clock of an edge somebody has already built a scene on.
   */
  write(input: {
    readonly entities: readonly Entity[];
    readonly relations: readonly Relation[];
  }): Result<number, AppError> {
    return attempt('Could not write the narrative graph', () =>
      this.#db.transaction(
        (tx) => {
          let changes = 0;

          for (const entity of input.entities) {
            changes += tx
              .insert(entities)
              .values({
                id: entity.id,
                seriesId: entity.seriesId,
                kind: entity.kind,
                canonicalName: entity.canonicalName,
                aliases: [...entity.aliases],
                summary: entity.summary,
                firstAppearanceOrdinal: entity.firstAppearance.ordinal,
                firstAppearanceLabel: entity.firstAppearance.label ?? null,
                importance: entity.importance,
                assetRefs: [...entity.assetRefs],
                payload: entity.payload,
              })
              .onConflictDoNothing({ target: entities.id })
              .run().changes;
          }

          for (const edge of input.relations) {
            changes += tx
              .insert(relations)
              .values({
                id: edge.id,
                seriesId: edge.seriesId,
                fromEntityId: edge.from,
                toEntityId: edge.to,
                type: edge.type,
                fact: edge.fact,
                strength: edge.strength,
                validFromOrdinal: edge.validFrom?.ordinal ?? null,
                validFromLabel: edge.validFrom?.label ?? null,
                validUntilOrdinal: edge.validUntil?.ordinal ?? null,
                validUntilLabel: edge.validUntil?.label ?? null,
                assertedAt: edge.assertedAt,
                retractedAt: edge.retractedAt,
                sourceRef: edge.sourceRef,
                confidence: edge.confidence,
                visibility: edge.visibility,
              })
              .onConflictDoNothing({ target: relations.id })
              .run().changes;
          }

          return changes;
        },
        { behavior: 'immediate' },
      ),
    );
  }

  /**
   * Closes an edge's story-time interval in place.
   *
   * The one write that is an *update*, and the reason it exists is the rule the whole
   * package is shaped around: a fact that stops being true is **bounded, not deleted**.
   * `validUntil` is set, the row survives, and an as-of query at an earlier story time
   * still returns it - which is what keeps "what did Kael believe in episode 5"
   * answerable after the reveal in episode 8.
   *
   * `retractedAt` is never written here. A scene ending a fact is a story-time event;
   * retraction is an authoring-time event - we were wrong to have written it - and no
   * scene can perform one.
   */
  bound(edges: readonly Relation[]): Result<number, AppError> {
    return attempt('Could not bound the relations this scene ended', () =>
      this.#db.transaction(
        (tx) => {
          let changes = 0;
          for (const edge of edges) {
            changes += tx
              .update(relations)
              .set({
                validUntilOrdinal: edge.validUntil?.ordinal ?? null,
                validUntilLabel: edge.validUntil?.label ?? null,
              })
              .where(eq(relations.id, edge.id))
              .run().changes;
          }
          return changes;
        },
        { behavior: 'immediate' },
      ),
    );
  }
}
