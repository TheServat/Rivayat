/**
 * Everything the Characters screen asks the server for.
 *
 * Same arrangement as the Story screen's gateway and for the same reason: none of these
 * routes exists, so the request shape is a proposal and belongs beside the screen
 * proposing it. Against a live API the HTTP gateway calls them and gets an honest 404,
 * and the screen names the route instead of pretending the series has no cast.
 *
 * The fixture is reached only when the whole studio is on recorded data, which is
 * opt-in and badged in the shell.
 */

import { type ProjectId, SeriesCard, type SeriesId } from '@rv/contracts';
import { z } from 'zod';

import type { ApiError } from '../../../api/errors';
import type { StudioTransport } from '../../../api/transport';

import { createCharactersFixtureGateway } from './characters.fixture';
import {
  type CharacterStateEdit,
  CharacterStateCell,
  CharacterStates,
  NarrativeSnapshot,
} from './graph';

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

export interface CharactersGateway {
  listSeries: (projectId: ProjectId, signal?: AbortSignal) => Promise<readonly SeriesCard[]>;
  loadGraph: (seriesId: SeriesId, signal?: AbortSignal) => Promise<NarrativeSnapshot>;
  loadStates: (
    seriesId: SeriesId,
    entityId: string,
    signal?: AbortSignal,
  ) => Promise<CharacterStates>;
  editStatePrompt: (
    seriesId: SeriesId,
    entityId: string,
    variantKey: string,
    edit: CharacterStateEdit,
    signal?: AbortSignal,
  ) => Promise<CharacterStateCell>;
  generateState: (
    seriesId: SeriesId,
    entityId: string,
    variantKey: string,
    signal?: AbortSignal,
  ) => Promise<CharacterStateCell>;
}

export class HttpCharactersGateway implements CharactersGateway {
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

  loadGraph(seriesId: SeriesId, signal?: AbortSignal): Promise<NarrativeSnapshot> {
    return this.#transport.send({
      method: 'GET',
      path: `/series/${seriesId}/graph`,
      schema: NarrativeSnapshot,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  loadStates(seriesId: SeriesId, entityId: string, signal?: AbortSignal): Promise<CharacterStates> {
    return this.#transport.send({
      method: 'GET',
      path: `/series/${seriesId}/entities/${entityId}/states`,
      schema: CharacterStates,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  editStatePrompt(
    seriesId: SeriesId,
    entityId: string,
    variantKey: string,
    edit: CharacterStateEdit,
    signal?: AbortSignal,
  ): Promise<CharacterStateCell> {
    return this.#transport.send({
      method: 'PATCH',
      path: `/series/${seriesId}/entities/${entityId}/states/${variantKey}`,
      schema: CharacterStateCell,
      body: edit,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  generateState(
    seriesId: SeriesId,
    entityId: string,
    variantKey: string,
    signal?: AbortSignal,
  ): Promise<CharacterStateCell> {
    return this.#transport.send({
      method: 'POST',
      path: `/series/${seriesId}/entities/${entityId}/states/${variantKey}/generate`,
      schema: CharacterStateCell,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

/** One fixture per fixture transport, so a fresh page load starts from a clean graph. */
const fixtures = new WeakMap<StudioTransport, CharactersGateway>();

export function charactersGatewayFor(transport: StudioTransport): CharactersGateway {
  if (transport.kind !== 'fixture') return new HttpCharactersGateway(transport);
  const existing = fixtures.get(transport);
  if (existing !== undefined) return existing;
  const created = createCharactersFixtureGateway();
  fixtures.set(transport, created);
  return created;
}
