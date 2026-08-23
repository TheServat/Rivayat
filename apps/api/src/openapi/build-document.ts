/**
 * The OpenAPI document, emitted from the Zod schemas the API validates with.
 *
 * Non-negotiable #5 in its third form: JSON Schema for LLMs, DTOs for the API and
 * OpenAPI for clients are all *emitted* from `@rv/contracts`, never written alongside
 * it. `@rv/contracts` already ships the LLM emitter (`toLlmJsonSchema`); this is the
 * OpenAPI one, and it lives here rather than there only because the API-layer envelopes
 * it also has to describe are not domain shapes.
 *
 * **3.1.0, not 3.0.** OpenAPI 3.1 *is* JSON Schema 2020-12, which is a target
 * `z.toJSONSchema` emits natively. Targeting 3.0 would mean a lossy down-conversion -
 * `nullable: true` instead of a type union, no `const`, no `examples` array - and every
 * one of those losses is a place the document stops describing what the API enforces.
 *
 * **`$defs` are hoisted.** Zod emits a recursive schema with internal `$ref`s pointing
 * at `#/$defs/X`. A `#/...` reference resolves against the *document* root, so nesting
 * that under `components.schemas.Foo` produces refs that resolve to nothing. So every
 * `$defs` entry is lifted into `components.schemas` under a prefixed name and the refs
 * are rewritten to match. Without it, `AnimationIR` - whose node tree is genuinely
 * recursive - produces a document that looks fine and cannot be resolved.
 */

import { z } from 'zod';

import { API_ROUTES, type ApiRoute } from './routes';
import { API_SCHEMAS, type ApiSchemaName } from './schema-registry';

export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description: string;
}

type JsonObject = Record<string, unknown>;

const COMPONENT_PREFIX = '#/components/schemas/';

/** Rewrites every `#/$defs/X` in a subtree to `#/components/schemas/<prefix>X`. */
function rewriteRefs(node: unknown, prefix: string): unknown {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, prefix));
  if (node === null || typeof node !== 'object') return node;

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node as JsonObject)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/$defs/')) {
      out[key] = `${COMPONENT_PREFIX}${prefix}${value.slice('#/$defs/'.length)}`;
      continue;
    }
    out[key] = rewriteRefs(value, prefix);
  }
  return out;
}

/**
 * One Zod schema to one component, plus any hoisted definitions.
 *
 * `io: 'input'` throughout: the document describes what a client *sends*, and a schema
 * with `.default()` accepts the field being absent on the way in and always produces it
 * on the way out. Describing the output shape would tell clients that a field with a
 * default is required.
 */
function toComponent(name: string, schema: z.ZodType): JsonObject {
  const emitted = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    // Cycles must stay as refs - `AnimationIR`'s node tree cannot be inlined - and a
    // reused subschema is worth a ref too once the document has thirty of them.
    reused: 'ref',
    unrepresentable: 'any',
  }) as JsonObject;

  const defs = emitted.$defs;
  const prefix = `${name}.`;
  const rewritten = rewriteRefs(
    { ...emitted, $defs: undefined, $schema: undefined },
    prefix,
  ) as JsonObject;
  delete rewritten.$defs;
  delete rewritten.$schema;

  const components: JsonObject = { [name]: rewritten };
  if (defs !== undefined && typeof defs === 'object' && defs !== null) {
    for (const [defName, defSchema] of Object.entries(defs as JsonObject)) {
      components[`${prefix}${defName}`] = rewriteRefs(defSchema, prefix);
    }
  }
  return components;
}

/** `Project` for a single resource, an array of it for a list route. */
function isCollectionRoute(route: ApiRoute): boolean {
  return (
    route.method === 'get' &&
    (route.path.endsWith('/series') ||
      route.path.endsWith('/episodes') ||
      route.path.endsWith('/runs') ||
      route.path.endsWith('/formats'))
  );
}

function responseSchema(route: ApiRoute): JsonObject | undefined {
  if (route.response === undefined) return undefined;
  const ref = { $ref: `${COMPONENT_PREFIX}${route.response}` };
  return isCollectionRoute(route) ? { type: 'array', items: ref } : ref;
}

/**
 * Failures every route can produce.
 *
 * Attached to every operation rather than to the ones that "can fail", because they all
 * can: the global pipe produces 400, the filter produces 500, and a route behind a
 * stubbed engine produces 501. A document that lists only the happy path is a document
 * whose generated client has no error type.
 */
function commonResponses(route: ApiRoute): JsonObject {
  const envelope = {
    description: 'Error envelope: `code`, `kind`, `context`. Never a stack trace.',
    content: { 'application/json': { schema: { $ref: `${COMPONENT_PREFIX}ErrorEnvelope` } } },
  };

  const responses: JsonObject = {
    '400': { ...envelope, description: 'The request failed schema validation.' },
    '500': { ...envelope, description: 'Unexpected failure.' },
  };
  if (route.params?.some((param) => param.in === 'path') === true) {
    responses['404'] = { ...envelope, description: 'No such resource.' };
  }
  if (route.notImplemented === true || route.status === 501) {
    responses['501'] = {
      ...envelope,
      description: 'The engine behind this route is scaffolded. The context names the package.',
    };
  }
  if (route.tags.includes('pipeline') || route.tags.includes('assets')) {
    responses['402'] = { ...envelope, description: 'Refused by the budget guard before spending.' };
    responses['429'] = {
      ...envelope,
      description: 'Rate limited upstream. `Retry-After` is set when the provider said.',
    };
  }
  return responses;
}

function operationFor(route: ApiRoute): JsonObject {
  const success = responseSchema(route);
  const operation: JsonObject = {
    operationId: route.operationId,
    summary: route.summary,
    tags: [...route.tags],
    responses: {
      ...commonResponses(route),
      [String(route.status)]:
        success === undefined
          ? { description: route.notImplemented === true ? 'Not implemented.' : 'Success.' }
          : {
              description: 'Success.',
              content: {
                [route.path.endsWith('/events') ? 'text/event-stream' : 'application/json']: {
                  schema: success,
                },
              },
            },
    },
  };

  if (route.params !== undefined && route.params.length > 0) {
    operation.parameters = route.params.map((param) => ({
      name: param.name,
      in: param.in,
      required: param.required,
      description: param.description,
      schema: param.schema,
    }));
  }

  if (route.requestBody !== undefined) {
    operation.requestBody = {
      required: true,
      content: {
        'application/json': { schema: { $ref: `${COMPONENT_PREFIX}${route.requestBody}` } },
      },
    };
  }

  return operation;
}

export interface BuildDocumentOptions {
  readonly info: OpenApiInfo;
  /** The global prefix, e.g. `api`. Becomes the server's base path. */
  readonly basePath: string;
  readonly routes?: readonly ApiRoute[];
}

export function buildOpenApiDocument(options: BuildDocumentOptions): JsonObject {
  const routes = options.routes ?? API_ROUTES;

  const schemas: JsonObject = {};
  for (const [name, schema] of Object.entries(API_SCHEMAS)) {
    Object.assign(schemas, toComponent(name, schema as z.ZodType));
  }

  const paths: JsonObject = {};
  for (const route of routes) {
    const key = `/${options.basePath}${route.path}`.replace(/\/+/g, '/');
    const existing = (paths[key] ?? {}) as JsonObject;
    existing[route.method] = operationFor(route);
    paths[key] = existing;
  }

  return {
    openapi: '3.1.0',
    info: { ...options.info },
    servers: [{ url: '/' }],
    tags: [...new Set(routes.flatMap((route) => route.tags))].map((name) => ({ name })),
    paths,
    components: { schemas },
  };
}

/** Names every schema the registry knows, so a test can assert the set is complete. */
export function apiSchemaNames(): readonly ApiSchemaName[] {
  return Object.keys(API_SCHEMAS) as ApiSchemaName[];
}
