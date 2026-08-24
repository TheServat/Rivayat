/**
 * Everything the Story screen asks the server for.
 *
 * A narrow interface rather than four methods bolted onto `StudioApi`, for the reason
 * the working agreement gives for ports generally: none of these routes exists yet, so
 * the shape of the request is a *proposal*, and a proposal belongs next to the screen
 * that is proposing it rather than in the shared client where it would look settled.
 *
 * **Report — the four routes this screen needs and the API does not have:**
 *
 * | route                                          | answers with     | story  |
 * | ---------------------------------------------- | ---------------- | ------ |
 * | `GET /api/series/:seriesId/outline`             | `StoryTree`      | RV-205 |
 * | `POST /api/series/:seriesId/outline/expand`     | `StoryExpansion` | RV-091 |
 * | `PATCH /api/story/nodes/:nodeId`                | `StoryNode`      | RV-091 |
 * | `POST /api/story/nodes/:nodeId/regenerate`      | `StoryExpansion` | RV-205 |
 *
 * Until they exist the HTTP gateway does exactly what it should: it calls them, gets a
 * 404, and the screen says which route is missing instead of pretending to be empty.
 * The fixture gateway below is reached only when the whole studio is running on
 * recorded data — the shell shows a badge for that, so a screen served from it cannot
 * be mistaken for a working one.
 */

import { type ProjectId, SeriesCard, type SeriesId } from '@rv/contracts';
import { z } from 'zod';

import type { ApiError } from '../../../api/errors';
import type { StudioTransport } from '../../../api/transport';

import { createStoryFixtureGateway } from './story.fixture';
import {
  type OutlineLevel,
  StoryExpansion,
  StoryNode,
  type StoryNodeEdit,
  StoryTree,
} from './story-tree';

/**
 * The one route on this screen that already exists.
 *
 * `GET /api/projects/:projectId/series` answers with a bare array of `SeriesCard`, not
 * an envelope, so the schema is the array. Validated like everything else: a series
 * list that does not fit the contract becomes an error, never a value.
 */
const SeriesList = z.array(SeriesCard);

/**
 * A 404 for the *route* rather than for the thing the route would have returned.
 *
 * The distinction is load-bearing and it is not visible in the status code. The API
 * answers `NOT_FOUND` when a series genuinely has no graph yet — which is an *empty*
 * screen, an invitation to build one — and `HTTP_404` when the route does not exist at
 * all, which is a missing feature and must say so. Treating the second as the first is
 * how a screen quietly reports "no data" for an endpoint nobody has written.
 *
 * `http-404` is the transport's own fallback code, used when a non-2xx response did not
 * carry the agreed envelope at all; it means the same thing here.
 *
 * **Report:** this predicate belongs in `src/api/errors.ts` beside `ApiError`, and is
 * duplicated in the two feature gateways only because that file is shared with work in
 * flight elsewhere in the studio.
 */
export function isMissingRoute(error: ApiError): boolean {
  return error.status === 404 && (error.code === 'HTTP_404' || error.code === 'http-404');
}

/** The route the server said it had no handler for, for a message a reader can act on. */
export function routeFromMessage(error: ApiError): string {
  return /Cannot\s+[A-Z]+\s+(\S+)/.exec(error.message)?.[1] ?? error.message;
}

export interface StoryGateway {
  listSeries: (projectId: ProjectId, signal?: AbortSignal) => Promise<readonly SeriesCard[]>;
  loadTree: (seriesId: SeriesId, signal?: AbortSignal) => Promise<StoryTree>;
  /**
   * Grows the tree by exactly one level.
   *
   * One level per call, deliberately: the outliner is DOC-shaped and binds every child
   * to what its parent asked for. A `expandTo(level)` that descended three levels in
   * one request would be the same mistake as a "regenerate everything" button, made in
   * the transport instead of in the interface.
   */
  expandLevel: (
    seriesId: SeriesId,
    level: OutlineLevel,
    signal?: AbortSignal,
  ) => Promise<StoryExpansion>;
  editNode: (nodeId: string, edit: StoryNodeEdit, signal?: AbortSignal) => Promise<StoryNode>;
  regenerateNode: (nodeId: string, signal?: AbortSignal) => Promise<StoryExpansion>;
}

export class HttpStoryGateway implements StoryGateway {
  readonly #transport: StudioTransport;

  constructor(transport: StudioTransport) {
    this.#transport = transport;
  }

  listSeries(projectId: ProjectId, signal?: AbortSignal): Promise<readonly SeriesCard[]> {
    return this.#transport.send({
      method: 'GET',
      path: `/projects/${projectId}/series`,
      schema: SeriesList,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  loadTree(seriesId: SeriesId, signal?: AbortSignal): Promise<StoryTree> {
    return this.#transport.send({
      method: 'GET',
      path: `/series/${seriesId}/outline`,
      schema: StoryTree,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  expandLevel(
    seriesId: SeriesId,
    level: OutlineLevel,
    signal?: AbortSignal,
  ): Promise<StoryExpansion> {
    return this.#transport.send({
      method: 'POST',
      path: `/series/${seriesId}/outline/expand`,
      schema: StoryExpansion,
      body: { level },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  editNode(nodeId: string, edit: StoryNodeEdit, signal?: AbortSignal): Promise<StoryNode> {
    return this.#transport.send({
      method: 'PATCH',
      path: `/story/nodes/${nodeId}`,
      schema: StoryNode,
      body: edit,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  regenerateNode(nodeId: string, signal?: AbortSignal): Promise<StoryExpansion> {
    return this.#transport.send({
      method: 'POST',
      path: `/story/nodes/${nodeId}/regenerate`,
      schema: StoryExpansion,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

/**
 * One fixture gateway per fixture transport, and never one for an HTTP transport.
 *
 * Keyed on the transport instance so a fresh transport — which is what every test and
 * every page load produces — gets a fresh, un-mutated fixture. A module-level singleton
 * would leak one test's edits into the next, and the behaviours this screen is judged
 * on are all mutations.
 */
const fixtures = new WeakMap<StudioTransport, StoryGateway>();

export function storyGatewayFor(transport: StudioTransport): StoryGateway {
  if (transport.kind !== 'fixture') return new HttpStoryGateway(transport);
  const existing = fixtures.get(transport);
  if (existing !== undefined) return existing;
  const created = createStoryFixtureGateway();
  fixtures.set(transport, created);
  return created;
}
