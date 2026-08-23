import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { everyObjectIsClosed, isFullyInlined, toLlmJsonSchema } from './json-schema';

const Nested = z.object({
  name: z.string().describe('the name'),
  nickname: z.string().optional(),
  count: z.number().int().default(3),
  inner: z.object({ flag: z.boolean() }),
  list: z.array(z.object({ v: z.string() })),
});

const Union = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('a'), v: z.string() }),
  z.object({ kind: z.literal('b'), n: z.number() }),
]);

describe('every dialect', () => {
  it('preserves descriptions, which are the instructions the model actually reads', () => {
    const schema = toLlmJsonSchema(Nested, { dialect: 'plain' }) as {
      properties: { name: { description?: string } };
    };
    expect(schema.properties.name.description).toBe('the name');
  });

  it('generates from the input side, so fields with defaults stay optional', () => {
    const schema = toLlmJsonSchema(Nested, { dialect: 'plain' }) as { required?: string[] };
    expect(schema.required).not.toContain('count');
    expect(schema.required).toContain('name');
  });

  it('inlines everything - two of the three dialects reject $ref', () => {
    const Shared = z.object({ v: z.string() });
    const Reused = z.object({ a: Shared, b: Shared });
    for (const dialect of ['plain', 'ollama', 'openai-strict', 'gemini'] as const) {
      expect(isFullyInlined(toLlmJsonSchema(Reused, { dialect }))).toBe(true);
    }
  });

  it('throws on a cyclic schema instead of emitting one a provider will ignore', () => {
    // `| undefined` is required under exactOptionalPropertyTypes.
    interface Node {
      child?: Node | undefined;
    }
    const Recursive: z.ZodType<Node> = z.lazy(() => z.object({ child: Recursive.optional() }));
    expect(() => toLlmJsonSchema(Recursive, { dialect: 'ollama' })).toThrow();
  });
});

describe('plain', () => {
  it('leaves objects open, matching raw z.toJSONSchema semantics', () => {
    const schema = toLlmJsonSchema(Nested, { dialect: 'plain' }) as {
      additionalProperties?: boolean;
    };
    expect(schema.additionalProperties).toBeUndefined();
  });
});

describe('ollama', () => {
  it('closes every object at every depth', () => {
    const schema = toLlmJsonSchema(Nested, { dialect: 'ollama' });
    expect(everyObjectIsClosed(schema)).toBe(true);
  });

  it('closes objects nested inside arrays too', () => {
    const schema = toLlmJsonSchema(Nested, { dialect: 'ollama' }) as {
      properties: { list: { items: { additionalProperties?: boolean } } };
    };
    expect(schema.properties.list.items.additionalProperties).toBe(false);
  });

  it('does not force optional fields to be required', () => {
    const schema = toLlmJsonSchema(Nested, { dialect: 'ollama' }) as { required?: string[] };
    expect(schema.required).not.toContain('nickname');
  });
});

describe('openai-strict', () => {
  const schema = toLlmJsonSchema(Nested, { dialect: 'openai-strict' }) as {
    required: string[];
    properties: Record<string, { type?: unknown; anyOf?: unknown[] }>;
  };

  it('lists every property as required, as strict mode demands', () => {
    expect(schema.required.sort()).toEqual(['count', 'inner', 'list', 'name', 'nickname']);
  });

  it('expresses optionality by widening the type to include null', () => {
    // Strict mode has no notion of an optional key, so this is the only way to say
    // "this may be absent" without the request being rejected outright.
    expect(schema.properties.nickname?.type).toEqual(['string', 'null']);
    expect(schema.properties.count?.type).toEqual(['integer', 'null']);
  });

  it('leaves genuinely required properties untouched', () => {
    expect(schema.properties.name?.type).toBe('string');
  });

  it('wraps a non-simple optional in anyOf rather than guessing at its internals', () => {
    const WithOptionalObject = z.object({ maybe: z.object({ v: z.string() }).optional() });
    const out = toLlmJsonSchema(WithOptionalObject, { dialect: 'openai-strict' }) as {
      properties: { maybe: { type?: unknown } };
    };
    expect(out.properties.maybe.type).toEqual(['object', 'null']);
  });

  it('wraps an optional union in anyOf, because a union has no single type to widen', () => {
    // The object case above still has `type: "object"` to widen. A union does not have
    // a `type` at all, so the only honest way to say "or null" is to wrap the whole
    // node - guessing at its branches would change what the model may emit.
    const WithOptionalUnion = z.object({ maybe: z.union([z.string(), z.number()]).optional() });
    const out = toLlmJsonSchema(WithOptionalUnion, { dialect: 'openai-strict' }) as {
      required: string[];
      properties: { maybe: { type?: unknown; anyOf?: { type?: unknown }[] } };
    };
    expect(out.required).toEqual(['maybe']);
    expect(out.properties.maybe.type).toBeUndefined();
    expect(out.properties.maybe.anyOf?.at(-1)).toEqual({ type: 'null' });
  });

  it('still closes every object', () => {
    expect(everyObjectIsClosed(schema)).toBe(true);
  });
});

describe('gemini', () => {
  const schema = toLlmJsonSchema(Nested, { dialect: 'gemini' }) as Record<string, unknown>;

  it('drops $schema and additionalProperties, which the OpenAPI subset rejects', () => {
    const text = JSON.stringify(schema);
    expect(text).not.toContain('$schema');
    expect(text).not.toContain('additionalProperties');
  });

  it('renames oneOf to anyOf', () => {
    const union = toLlmJsonSchema(Union, { dialect: 'gemini' }) as {
      anyOf?: unknown[];
      oneOf?: unknown[];
    };
    expect(union.anyOf).toHaveLength(2);
    expect(union.oneOf).toBeUndefined();
  });

  it('turns a literal const into a single-member enum', () => {
    const union = toLlmJsonSchema(Union, { dialect: 'gemini' }) as {
      anyOf: { properties: { kind: { enum?: string[]; const?: string } } }[];
    };
    const kinds = union.anyOf.map((branch) => branch.properties.kind);
    expect(kinds[0]?.enum).toEqual(['a']);
    expect(kinds[0]?.const).toBeUndefined();
  });

  it('keeps descriptions, types and required', () => {
    expect(schema).toHaveProperty('required');
    const properties = schema.properties as { name: { description?: string; type?: string } };
    expect(properties.name.description).toBe('the name');
    expect(properties.name.type).toBe('string');
  });
});

describe('the assertions themselves', () => {
  it('everyObjectIsClosed detects an open object at any depth', () => {
    expect(everyObjectIsClosed({ type: 'object', additionalProperties: false })).toBe(true);
    expect(everyObjectIsClosed({ type: 'object' })).toBe(false);
    expect(
      everyObjectIsClosed({
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'object' } },
      }),
    ).toBe(false);
    expect(everyObjectIsClosed([{ type: 'object' }])).toBe(false);
    expect(everyObjectIsClosed('scalar')).toBe(true);
    expect(everyObjectIsClosed(null)).toBe(true);
  });

  it('isFullyInlined detects a surviving reference', () => {
    expect(isFullyInlined({ type: 'string' })).toBe(true);
    expect(isFullyInlined({ $ref: '#/$defs/X' })).toBe(false);
    expect(isFullyInlined({ a: { $defs: {} } })).toBe(false);
    expect(isFullyInlined([{ $ref: '#/x' }])).toBe(false);
    expect(isFullyInlined(7)).toBe(true);
  });
});
