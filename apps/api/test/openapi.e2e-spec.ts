/**
 * The emitted document, checked as a document and as a description of this API.
 *
 * Two failure modes, and they need different assertions.
 *
 * **It is not valid OpenAPI.** Checked structurally: the version, the required
 * top-level members, an operation object per path item, at least one response per
 * operation, and - the one that actually breaks generators - every `$ref` resolving to
 * a node that exists. A recursive schema whose `$defs` were not hoisted produces
 * exactly that failure and looks fine to the eye.
 *
 * **It is valid and describes a different API.** Checked by driving the live app: every
 * path the document declares is routed, and every schema it names is the schema a
 * controller validates with. A document that describes an endpoint nobody implemented
 * is worse than no document, because a client integrates against it.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_SCHEMAS } from '../src/openapi/schema-registry';
import { API_ROUTES } from '../src/openapi/routes';
import { bootHarness, type Harness } from './harness';

type Json = Record<string, unknown>;

interface OpenApiDocument extends Json {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json> };
}

/** Every `$ref` string anywhere in the tree. */
function collectRefs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
    return found;
  }
  if (node === null || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === '$ref' && typeof value === 'string') found.push(value);
    else collectRefs(value, found);
  }
  return found;
}

/** Resolves a `#/a/b/c` pointer against the document, or `undefined`. */
function resolvePointer(document: Json, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let cursor: unknown = document;
  for (const segment of ref.slice(2).split('/')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Json)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cursor;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

describe('the OpenAPI document', () => {
  let harness: Harness;
  let document: OpenApiDocument;

  beforeAll(async () => {
    harness = await bootHarness();
    const response = await request(harness.server).get('/api/openapi.json').expect(200);
    document = response.body as OpenApiDocument;
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('validates as OpenAPI 3', () => {
    it('declares 3.1.0 and the required top-level members', () => {
      expect(document.openapi).toBe('3.1.0');
      expect(document.openapi).toMatch(/^3\./);
      expect(document.info.title).toBe('Rivayat API');
      expect(document.info.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(document.paths).toBeTypeOf('object');
      expect(document.components.schemas).toBeTypeOf('object');
    });

    it('gives every operation an operationId, a summary and at least one response', () => {
      const seenIds = new Set<string>();
      for (const [path, item] of Object.entries(document.paths)) {
        for (const method of METHODS) {
          const operation = item[method] as
            { operationId?: string; summary?: string; responses?: Json } | undefined;
          if (operation === undefined) continue;

          expect(operation.operationId, `${method} ${path}`).toBeTypeOf('string');
          expect(operation.summary, `${method} ${path}`).toBeTypeOf('string');
          expect(
            Object.keys(operation.responses ?? {}).length,
            `${method} ${path}`,
          ).toBeGreaterThan(0);

          // A duplicate operationId makes every generated client name one of the two
          // methods wrongly, and the generator does not warn.
          expect(seenIds.has(operation.operationId ?? ''), `${method} ${path}`).toBe(false);
          seenIds.add(operation.operationId ?? '');
        }
      }
      expect(seenIds.size).toBe(API_ROUTES.length);
    });

    it('declares every path parameter the template names', () => {
      for (const [path, item] of Object.entries(document.paths)) {
        const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
        for (const method of METHODS) {
          const operation = item[method] as
            { parameters?: { name: string; in: string }[] } | undefined;
          if (operation === undefined) continue;
          const declared = (operation.parameters ?? [])
            .filter((parameter) => parameter.in === 'path')
            .map((parameter) => parameter.name);
          for (const name of templated) {
            expect(declared, `${method} ${path}`).toContain(name);
          }
        }
      }
    });

    it('resolves every $ref, including the ones hoisted out of a recursive schema', () => {
      const refs = [...new Set(collectRefs(document))];
      expect(refs.length).toBeGreaterThan(0);

      const unresolved = refs.filter((ref) => resolvePointer(document, ref) === undefined);
      expect(unresolved).toEqual([]);
    });

    it('leaves no $defs behind, which would resolve against the document root', () => {
      // The bug this catches: Zod emits `#/$defs/X` for a reused or recursive schema,
      // and `#` is the *document* root, not the component. Nested under
      // `components.schemas` those refs point at nothing.
      expect(JSON.stringify(document)).not.toContain('"$defs"');
      expect(collectRefs(document).every((ref) => ref.startsWith('#/components/schemas/'))).toBe(
        true,
      );
    });

    it('describes an error envelope on every operation', () => {
      for (const [path, item] of Object.entries(document.paths)) {
        for (const method of METHODS) {
          const operation = item[method] as { responses?: Record<string, Json> } | undefined;
          if (operation === undefined) continue;
          expect(Object.keys(operation.responses ?? {}), `${method} ${path}`).toContain('500');
        }
      }
    });
  });

  describe('describes this API and not another', () => {
    it('names every schema the registry holds', () => {
      for (const name of Object.keys(API_SCHEMAS)) {
        expect(document.components.schemas, name).toHaveProperty(name);
      }
    });

    it('lists every route under the configured global prefix', () => {
      for (const route of API_ROUTES) {
        const key = `/api${route.path}`;
        expect(document.paths, key).toHaveProperty(key);
        expect(document.paths[key], `${route.method} ${key}`).toHaveProperty(route.method);
      }
    });

    it('routes every path it declares on the live app', async () => {
      // A concrete id per parameter, so the request reaches the handler rather than
      // being rejected by the path pipe. 404 and 501 are both "the route exists".
      const substitutions: Record<string, string> = {
        id: 'prj_01J0000000000000000000000Z',
        projectId: 'prj_01J0000000000000000000000Z',
        seriesId: 'ser_01J0000000000000000000000Z',
        episodeId: 'ep_01J0000000000000000000000Z',
        scope: 'global',
      };

      for (const route of API_ROUTES) {
        if (route.path.endsWith('/events')) continue; // covered by sse.e2e-spec.ts
        const path = `/api${route.path}`.replace(/\{([^}]+)\}/g, (_match, name: string) => {
          const value = substitutions[name];
          if (value === undefined) throw new Error(`no substitution for {${name}}`);
          return value;
        });

        const response = await request(harness.server)[route.method](path).send({});
        // 404 is only acceptable for a *resource* that is absent, never for a route
        // Nest did not register - and Nest's own "no such route" 404 says so in the
        // message, which is what distinguishes the two.
        const body = response.body as { error?: { code?: string } };
        expect(body.error?.code, `${route.method} ${path}`).not.toBe('HTTP_404');
        expect(response.status, `${route.method} ${path}`).not.toBe(405);
      }
    });

    it('marks a stubbed route with a 501 response so a client knows before integrating', () => {
      const presets = document.paths['/api/style/presets']?.get as
        { responses?: Record<string, Json> } | undefined;
      expect(Object.keys(presets?.responses ?? {})).toContain('501');
    });

    it('describes the request body of every route that takes one', () => {
      for (const route of API_ROUTES) {
        if (route.requestBody === undefined) continue;
        const operation = document.paths[`/api${route.path}`]?.[route.method] as
          { requestBody?: { content: Record<string, { schema: { $ref: string } }> } } | undefined;
        const ref = operation?.requestBody?.content['application/json']?.schema.$ref;
        expect(ref, `${route.method} ${route.path}`).toBe(
          `#/components/schemas/${route.requestBody}`,
        );
      }
    });

    it('describes the SSE endpoint as an event stream, not as JSON', () => {
      const operation = document.paths['/api/runs/{id}/events']?.get as
        { responses: Record<string, { content?: Record<string, unknown> }> } | undefined;
      expect(Object.keys(operation?.responses['200']?.content ?? {})).toEqual([
        'text/event-stream',
      ]);
    });
  });
});
