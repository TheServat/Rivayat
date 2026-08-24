/**
 * The outline tree, on disk, one JSON document per series.
 *
 * **A stopgap with the same date on it as `json-file.repositories.ts`.**
 * `@rv/persistence` has a `story` schema but no table this shape fits - an outline that
 * is *half built* is precisely what `SeriesBible` cannot express (see
 * `story.contracts.ts`) - and `apps/api` may not add a migration to a package another
 * workstream owns. So the same arrangement the projects and series stores use: one file
 * under the workspace, written through a temp file and a rename.
 *
 * Two things make it more than a `Map` with a save button.
 *
 * **The document carries the outline *context*, not just the nodes.** An expansion is
 * bound to the premise, the themes, the tone and the world's laws (docs/02 §4), and the
 * second expansion happens in a different HTTP request from the first - often on a
 * different worker. A store that kept only the tree would force every later expansion
 * to re-derive the context from the tree it is about to grow, and the context would
 * drift one level at a time.
 *
 * **Reads and writes go through the schema.** A tree written by an older build fails
 * loudly here rather than reaching the outliner as half a document, which is the same
 * rule `CompositionStore` applies for the same reason.
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CanonPolicy, Label, Prose, SeriesId, type StyleBibleId } from '@rv/contracts';
import { CastCandidate } from '@rv/story-engine';
import {
  ValidationError,
  err,
  ok,
  type AppError,
  type Logger,
  type Result,
} from '@rv/shared-kernel';
import { z } from 'zod';

import { StoryNode, type StoryTree } from './story.contracts';

/** Bumped when the document shape changes incompatibly. A mismatch is a failed read. */
export const STORY_DOCUMENT_VERSION = 1;

/**
 * The unconditional context every outline call carries, persisted.
 *
 * Mirrors `OutlineContext` in `@rv/story-engine` field for field. Declared here rather
 * than imported because what is stored is a *document* - it has to parse on the way back
 * in, and the engine's shape is an interface with no schema.
 */
export const StoredOutlineContext = z.strictObject({
  seriesTitle: Label,
  premise: Prose,
  themes: z.array(Label).max(16).default([]),
  tone: z.array(Label).max(24).default([]),
  genre: z.array(Label).max(8).default([]),
  worldRules: z.array(Prose).max(64).default([]),
  canonPolicy: CanonPolicy,
  episodeDurationMs: z.number().int().positive().optional(),
});
export type StoredOutlineContext = z.infer<typeof StoredOutlineContext>;

export const StoryDocument = z.strictObject({
  version: z.literal(STORY_DOCUMENT_VERSION),
  seriesId: SeriesId,
  /** `null` until S2 has run: a tree can be read before it has been grown. */
  context: StoredOutlineContext.nullable().default(null),
  /** The bible the outline is written against, for the record. */
  styleBibleId: z.string().min(1).max(64).nullable().default(null),
  /**
   * The shortlist S3 writes sheets for, as intake ranked it.
   *
   * Stored beside the outline rather than re-derived, because auto-casting starts at
   * intake (prior-art §A) and S3 runs in a different job, often on a different worker.
   * Re-deriving it would mean re-reading the source, which for a novel is the single
   * most expensive call in the pipeline.
   */
  castCandidates: z.array(CastCandidate).max(32).default([]),
  nodes: z.array(StoryNode).max(8192).default([]),
});
export type StoryDocument = z.infer<typeof StoryDocument>;

export interface StoryStoreOptions {
  readonly workspaceDir: string;
  readonly logger: Logger;
}

/** An empty document, which is what a series with no outline honestly has. */
export function emptyStoryDocument(seriesId: SeriesId): StoryDocument {
  return {
    version: STORY_DOCUMENT_VERSION,
    seriesId,
    context: null,
    styleBibleId: null,
    castCandidates: [],
    nodes: [],
  };
}

export class StoryStore {
  readonly #directory: string;
  readonly #logger: Logger;

  constructor(options: StoryStoreOptions) {
    this.#directory = join(options.workspaceDir, 'story');
    this.#logger = options.logger.child({ component: 'story-store' });
  }

  /**
   * The document for a series, or an empty one.
   *
   * "No outline yet" is an empty tree and not a 404: the Story screen's empty state is
   * an invitation to build one, and a not-found there would be indistinguishable from a
   * missing route (which is the distinction the studio's gateway is written around).
   */
  async load(seriesId: SeriesId): Promise<Result<StoryDocument, AppError>> {
    let raw: string;
    try {
      raw = await readFile(this.#path(seriesId), 'utf8');
    } catch {
      return ok(emptyStoryDocument(seriesId));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (caught: unknown) {
      return err(
        new ValidationError({
          message: `The stored outline for ${seriesId} is not readable JSON`,
          cause: caught,
          context: { seriesId },
        }),
      );
    }

    const document = StoryDocument.safeParse(parsed);
    if (!document.success) {
      return err(
        new ValidationError({
          message: `The stored outline for ${seriesId} no longer satisfies the schema`,
          context: {
            seriesId,
            issues: document.error.issues.map((issue) => issue.path.map(String).join('.')),
          },
        }),
      );
    }
    return ok(document.data);
  }

  /** The tree alone, which is what `GET /outline` answers with. */
  async tree(seriesId: SeriesId): Promise<Result<StoryTree, AppError>> {
    const document = await this.load(seriesId);
    return document.ok ? ok({ seriesId, nodes: document.value.nodes }) : document;
  }

  /**
   * Every stored outline.
   *
   * The only way to answer `PATCH /api/story/nodes/:nodeId`, which addresses a node
   * without naming its series. A document that no longer parses is reported and skipped
   * rather than fatal: one unreadable series must not make every other series' nodes
   * unaddressable.
   */
  async all(): Promise<Result<readonly StoryDocument[], AppError>> {
    let files: readonly string[];
    try {
      files = await readdir(this.#directory);
    } catch {
      return ok([]);
    }

    const documents: StoryDocument[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const seriesId = SeriesId.safeParse(file.slice(0, -'.json'.length));
      if (!seriesId.success) continue;
      const document = await this.load(seriesId.data);
      if (document.ok) {
        documents.push(document.value);
        continue;
      }
      this.#logger.warn('stored outline no longer parses; skipping it', {
        seriesId: seriesId.data,
        code: document.error.code,
      });
    }
    return ok(documents);
  }

  async save(document: StoryDocument): Promise<Result<StoryDocument, AppError>> {
    const path = this.#path(document.seriesId);
    try {
      await mkdir(this.#directory, { recursive: true });
      const staging = `${path}.tmp`;
      await writeFile(staging, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      // A rename within one directory is atomic on both filesystems this runs on. The
      // alternative is a truncated document as the only copy of an outline that cost
      // real money to produce.
      await rename(staging, path);
      return ok(document);
    } catch (caught: unknown) {
      this.#logger.error('could not persist the outline', {
        seriesId: document.seriesId,
        cause: String(caught),
      });
      return err(
        new ValidationError({
          message: `Could not write the outline for ${document.seriesId}`,
          cause: caught,
          context: { seriesId: document.seriesId, path },
        }),
      );
    }
  }

  /**
   * Read, transform, write, in one call.
   *
   * Here rather than at three call sites because every mutation on this store is that
   * shape, and a caller that forgot the write would leave an expansion that cost money
   * only in the response.
   */
  async mutate(
    seriesId: SeriesId,
    change: (document: StoryDocument) => Result<StoryDocument, AppError>,
  ): Promise<Result<StoryDocument, AppError>> {
    const current = await this.load(seriesId);
    if (!current.ok) return current;
    const next = change(current.value);
    if (!next.ok) return next;
    return this.save(next.value);
  }

  #path(seriesId: SeriesId): string {
    return join(this.#directory, `${seriesId}.json`);
  }
}

/** The style a stored outline was written against, narrowed for a caller that wants it. */
export function styleBibleIdOf(document: StoryDocument): StyleBibleId | null {
  return document.styleBibleId ?? null;
}
