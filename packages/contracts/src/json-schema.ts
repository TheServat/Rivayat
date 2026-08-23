/**
 * Turning a Zod schema into a JSON Schema an LLM provider will actually accept.
 *
 * `z.toJSONSchema()` produces correct, general JSON Schema. Provider structured-output
 * modes do not accept correct, general JSON Schema - each one takes a different
 * subset, and violating it fails the request rather than degrading:
 *
 *  - **OpenAI strict mode** requires `additionalProperties: false` on every object and
 *    requires *every* property to be listed in `required`. Optional fields have to be
 *    expressed as nullable-and-required instead.
 *  - **Gemini** takes an OpenAPI 3 subset. `$ref`/`$defs`, `oneOf` and most string
 *    formats are rejected, so references must be inlined.
 *  - **Ollama** compiles the schema to a GBNF grammar. It is the most permissive, but
 *    the grammar only constrains *shape* - and on `qwen3.5`/`gemma4` it is not reliably
 *    enforced at all (see docs/00-research.md §1), which is why `StructuredCall` still
 *    validates and repairs afterwards.
 *
 * So the schema is generated once and then adapted per dialect. Getting this wrong
 * shows up as an opaque 400 from the provider, which is why it is a real module with
 * real tests rather than a call site option.
 */

import { z } from 'zod';

export type SchemaDialect = 'openai-strict' | 'gemini' | 'ollama' | 'plain';

export interface LlmSchemaOptions {
  readonly dialect: SchemaDialect;
  /** Human-readable name; some providers require one alongside the schema. */
  readonly name?: string;
}

type JsonObject = Record<string, unknown>;

const OBJECT_KEYS_TO_DROP_FOR_GEMINI = new Set([
  '$schema',
  '$defs',
  '$ref',
  'additionalProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'patternProperties',
  'const',
  'default',
]);

/**
 * Produces a provider-ready JSON Schema.
 *
 * Always generated from the **input** side of the schema: the model is filling in a
 * value that we will then `parse`, so it must satisfy the pre-transform shape,
 * including seeing which fields have defaults it may omit.
 */
export function toLlmJsonSchema(schema: z.ZodType, options: LlmSchemaOptions): JsonObject {
  const base = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-2020-12',
    // Inline everything: two of the three dialects reject `$ref`, and an LLM follows
    // an inlined schema more reliably than a referenced one regardless.
    reused: 'inline',
    // A cyclic schema cannot be inlined, and a model cannot fill one sensibly either.
    // Failing here is far better than emitting a schema the provider silently ignores.
    cycles: 'throw',
    unrepresentable: 'any',
  }) as JsonObject;

  switch (options.dialect) {
    case 'plain':
      return base;
    case 'ollama':
      return walk(base, closeObjects);
    case 'openai-strict':
      return walk(base, (node) => requireAllProperties(closeObjects(node)));
    case 'gemini':
      return walk(base, (node) => stripForGemini(closeObjects(node)));
  }
}

/** Depth-first rewrite of every object node in the schema tree. */
function walk(node: unknown, transform: (node: JsonObject) => JsonObject): JsonObject {
  return visit(node, transform) as JsonObject;
}

function visit(node: unknown, transform: (node: JsonObject) => JsonObject): unknown {
  if (Array.isArray(node)) return node.map((item) => visit(item, transform));
  if (node === null || typeof node !== 'object') return node;

  const record = node as JsonObject;
  const mapped: JsonObject = {};
  for (const [key, value] of Object.entries(record)) {
    mapped[key] = visit(value, transform);
  }
  return transform(mapped);
}

/** Every object must be closed, or the model is free to invent fields. */
function closeObjects(node: JsonObject): JsonObject {
  if (node.type !== 'object') return node;
  return { ...node, additionalProperties: false };
}

/**
 * OpenAI strict mode: every declared property must appear in `required`.
 *
 * Optionality is expressed by widening the *type* to include `null` instead, which is
 * why this runs after the tree has been closed - it needs the final property list.
 */
function requireAllProperties(node: JsonObject): JsonObject {
  if (node.type !== 'object') return node;
  const properties = node.properties as JsonObject | undefined;
  if (properties === undefined) return node;

  const all = Object.keys(properties);
  const currentlyRequired = new Set((node.required as string[] | undefined) ?? []);
  const nowOptional = all.filter((key) => !currentlyRequired.has(key));

  const widened: JsonObject = {};
  for (const [key, value] of Object.entries(properties)) {
    widened[key] = nowOptional.includes(key) ? makeNullable(value) : value;
  }

  return { ...node, properties: widened, required: all };
}

/**
 * Widens one property so strict mode can call it required and still allow it to be
 * absent in spirit.
 *
 * Two cases, and no third: a node with a plain `type` is widened in place, and
 * everything else is wrapped. Wrapping covers a union, an enum, the empty schema Zod
 * emits for `any`, and a type that is somehow already a list - guessing at any of their
 * internals would change what the model is permitted to emit, and editing an
 * already-widened type list would nest it. Earlier versions of this had two further
 * guards for shapes the emitter cannot produce; unreachable code in a package that owes
 * 100 % coverage is a permanent hole in the report rather than a safety net.
 */
function makeNullable(value: unknown): unknown {
  const type = (value as JsonObject | null | undefined)?.type;
  if (typeof type === 'string') return { ...(value as JsonObject), type: [type, 'null'] };
  return { anyOf: [value, { type: 'null' }] };
}

/**
 * Gemini takes an OpenAPI 3 subset: no `$ref`, no `additionalProperties`, no `const`,
 * and `oneOf` has to become `anyOf`.
 */
function stripForGemini(node: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (OBJECT_KEYS_TO_DROP_FOR_GEMINI.has(key)) continue;
    out[key] = value;
  }
  if ('oneOf' in out) {
    out.anyOf = out.oneOf;
    delete out.oneOf;
  }
  // `const: "x"` is how Zod encodes a literal; Gemini expresses the same thing as a
  // single-member enum.
  if ('const' in node && !('enum' in out)) {
    out.enum = [node.const];
  }
  return out;
}

/**
 * Every object in the tree is closed. Exported so tests - and the provider adapters -
 * can assert the property rather than trusting it.
 */
export function everyObjectIsClosed(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(everyObjectIsClosed);
  if (schema === null || typeof schema !== 'object') return true;

  const record = schema as JsonObject;
  if (record.type === 'object' && record.additionalProperties !== false) return false;
  return Object.values(record).every(everyObjectIsClosed);
}

/** True when no `$ref` or `$defs` survives anywhere in the tree. */
export function isFullyInlined(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(isFullyInlined);
  if (schema === null || typeof schema !== 'object') return true;

  const record = schema as JsonObject;
  if ('$ref' in record || '$defs' in record) return false;
  return Object.values(record).every(isFullyInlined);
}
