import { describe, expect, it } from 'vitest';
import { type z } from 'zod';

import { toLlmJsonSchema } from '../json-schema';
import { BiTemporal, checkBiTemporalOrder } from './bi-temporal';
import { Fact, FACT_CONTENT_KINDS, FactContent, factRelationId } from './fact';
import { Relation } from './relation';

// ── fixtures ────────────────────────────────────────────────────────────────

const ulid = (tail: string): string => `01J9ZQ3K5M7N9P1R3T5V7X${tail}`;

const SERIES_ID = `ser_${ulid('0001')}`;
const FACT_ID = `fct_${ulid('0002')}`;
const OTHER_FACT_ID = `fct_${ulid('0003')}`;
const THIRD_FACT_ID = `fct_${ulid('0004')}`;
const RELATION_ID = `rel_${ulid('0005')}`;
const EPISODE_ID = `ep_${ulid('0006')}`;
const NOW = '2026-06-01T00:00:00Z';
const EARLIER = '2026-01-01T00:00:00Z';

function failurePaths<T>(result: z.ZodSafeParseResult<T>): string[] {
  if (result.success) throw new Error('expected the parse to fail, but it succeeded');
  return result.error.issues.map((issue) => issue.path.join('.'));
}

/** The smallest fact that parses: a relation-backed one, asserted by an author. */
function fact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FACT_ID,
    seriesId: SERIES_ID,
    content: { kind: 'relation', relationId: RELATION_ID },
    assertedAt: NOW,
    sourceRef: { kind: 'author' },
    ...overrides,
  };
}

// ── the content union ───────────────────────────────────────────────────────

describe('FactContent', () => {
  it('accepts a relation-backed fact, which is the graph edge and nothing more', () => {
    const parsed = Fact.parse(fact());
    expect(parsed.content).toEqual({ kind: 'relation', relationId: RELATION_ID });
  });

  it('accepts a fact with no second party, which is why `Fact` is not `Relation`', () => {
    // The whole reason the two are different types: "the bridge burned" has a subject
    // and no object, and forcing it into the graph means inventing an entity for the
    // bridge's counterparty.
    const parsed = Fact.parse(
      fact({
        content: { kind: 'statement', text: 'The bridge at Elsmere burned in the spring floods.' },
      }),
    );
    expect(parsed.content.kind).toBe('statement');
  });

  it('accepts a summary standing in for the facts it compacts', () => {
    const parsed = Fact.parse(
      fact({
        content: {
          kind: 'summary',
          text: 'The crossing was lost and never rebuilt, and the northern road with it.',
          covers: [OTHER_FACT_ID, THIRD_FACT_ID],
        },
      }),
    );
    expect(parsed.content.kind === 'summary' && parsed.content.covers).toHaveLength(2);
  });

  it('refuses a summary of one fact, which is that fact', () => {
    const result = Fact.safeParse(
      fact({ content: { kind: 'summary', text: 'One thing.', covers: [OTHER_FACT_ID] } }),
    );
    expect(failurePaths(result)).toEqual(['content.covers']);
  });

  it('refuses a summary that covers itself, because expanding it never terminates', () => {
    const result = Fact.safeParse(
      fact({
        content: { kind: 'summary', text: 'Everything so far.', covers: [FACT_ID, OTHER_FACT_ID] },
      }),
    );
    expect(failurePaths(result)).toContain('content.covers');
  });

  it('lists exactly the kinds the union carries, so a new kind cannot be added silently', () => {
    expect(FactContent.options.map((option) => option.shape.kind.value)).toEqual([
      ...FACT_CONTENT_KINDS,
    ]);
  });

  it('rejects a content kind nobody implemented', () => {
    expect(Fact.safeParse(fact({ content: { kind: 'rumour', text: 'Maybe.' } })).success).toBe(
      false,
    );
  });
});

// ── the two clocks, shared with Relation ────────────────────────────────────

describe('the bi-temporal pair is shared with Relation, not copied', () => {
  it('spells the four fields identically, so one query shape reads both', () => {
    const clockFields = Object.keys(BiTemporal.shape);
    expect(clockFields).toEqual(['validFrom', 'validUntil', 'assertedAt', 'retractedAt']);
    for (const field of clockFields) {
      expect(Object.keys(Fact.shape), field).toContain(field);
      expect(Object.keys(Relation.shape), field).toContain(field);
    }
  });

  it('describes each clock field with the same words in both schemas', () => {
    // A copied field drifts in its wording first and in its meaning second. The
    // description is what the model filling either schema reads, so identical wording
    // is not cosmetic - it is the only instruction either extractor gets.
    const factShape: Readonly<Record<string, z.ZodType>> = Fact.shape;
    const relationShape: Readonly<Record<string, z.ZodType>> = Relation.shape;
    for (const [field, schema] of Object.entries(BiTemporal.shape)) {
      expect(factShape[field]?.description, field).toBe(schema.description);
      expect(relationShape[field]?.description, field).toBe(schema.description);
    }
  });

  it('defaults both clocks to unbounded and un-retracted in both schemas', () => {
    const parsedFact = Fact.parse(fact());
    expect([parsedFact.validFrom, parsedFact.validUntil, parsedFact.retractedAt]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('rejects an inverted story-time interval on a fact, exactly as on a relation', () => {
    const result = Fact.safeParse(
      fact({ validFrom: { ordinal: 900 }, validUntil: { ordinal: 100 } }),
    );
    expect(failurePaths(result)).toEqual(['validUntil']);
  });

  it('rejects a retraction that precedes its own assertion', () => {
    const result = Fact.safeParse(fact({ assertedAt: NOW, retractedAt: EARLIER }));
    expect(failurePaths(result)).toEqual(['retractedAt']);
  });

  it('allows an interval that starts and ends at the same story moment', () => {
    // A fact true for exactly one beat is legal - the guard is `<`, not `<=`, and that
    // boundary is the one a repair loop is most likely to trip over.
    expect(
      Fact.safeParse(fact({ validFrom: { ordinal: 500 }, validUntil: { ordinal: 500 } })).success,
    ).toBe(true);
  });

  it('runs the very same function over both schemas', () => {
    // Not "the same rule" - the same function object. If someone re-inlines the check
    // into one of the two, this is what notices.
    const issues: { path: readonly PropertyKey[] }[] = [];
    const ctx = {
      addIssue: (issue: { path?: readonly PropertyKey[] }) => {
        issues.push({ path: issue.path ?? [] });
      },
    } as unknown as z.RefinementCtx;
    checkBiTemporalOrder(
      {
        validFrom: { ordinal: 9 },
        validUntil: { ordinal: 1 },
        assertedAt: NOW,
        retractedAt: EARLIER,
      },
      ctx,
    );
    expect(issues.map((issue) => issue.path.join('.'))).toEqual(['validUntil', 'retractedAt']);
  });
});

// ── provenance, weight and the semantic index ───────────────────────────────

describe('Fact', () => {
  it('reuses the relation provenance union rather than inventing a second one', () => {
    const parsed = Fact.parse(
      fact({ sourceRef: { kind: 'episode', episodeId: EPISODE_ID }, confidence: 0.6 }),
    );
    expect(parsed.sourceRef).toEqual({ kind: 'episode', episodeId: EPISODE_ID });
    expect(parsed.confidence).toBe(0.6);
  });

  it('defaults to public, background and fully confident', () => {
    const parsed = Fact.parse(fact());
    expect([parsed.visibility, parsed.importance, parsed.confidence]).toEqual([
      'public',
      'background',
      1,
    ]);
  });

  it('carries a vector and the model that produced it', () => {
    const parsed = Fact.parse(
      fact({ embedding: [0.1, -0.2, 0.3], embeddingModel: 'ollama:nomic-embed-text' }),
    );
    expect(parsed.embedding).toEqual([0.1, -0.2, 0.3]);
    expect(parsed.embeddingModel).toBe('ollama:nomic-embed-text');
  });

  it('leaves both out until the indexing pass has run', () => {
    const parsed = Fact.parse(fact());
    expect(parsed.embedding).toBeUndefined();
    expect(parsed.embeddingModel).toBeUndefined();
  });

  it('refuses a vector nobody can attribute, because it is not comparable to anything', () => {
    const result = Fact.safeParse(fact({ embedding: [0.1, 0.2] }));
    expect(failurePaths(result)).toEqual(['embeddingModel']);
  });

  it('refuses a model with no vector, which claims an index entry that does not exist', () => {
    const result = Fact.safeParse(fact({ embeddingModel: 'ollama:nomic-embed-text' }));
    expect(failurePaths(result)).toEqual(['embedding']);
  });

  it('rejects an unknown field rather than dropping it', () => {
    expect(Fact.safeParse(fact({ text: 'the sentence' })).success).toBe(false);
  });

  it('re-parses its own output to the identical value', () => {
    const once = Fact.parse(fact({ validFrom: { ordinal: 100 } }));
    expect(Fact.parse(once)).toEqual(once);
  });
});

// ── resolving a finding back to the graph ───────────────────────────────────

describe('factRelationId', () => {
  it('resolves a relation-backed fact to the edge a continuity finding can highlight', () => {
    expect(factRelationId(Fact.parse(fact()))).toBe(RELATION_ID);
  });

  it('returns null for a fact that is not about an edge', () => {
    const statement = Fact.parse(
      fact({ content: { kind: 'statement', text: 'It rained for three days.' } }),
    );
    expect(factRelationId(statement)).toBeNull();
  });

  it('returns null for a summary, which covers facts rather than being one edge', () => {
    const summary = Fact.parse(
      fact({
        content: {
          kind: 'summary',
          text: 'The road north stayed shut all winter.',
          covers: [OTHER_FACT_ID, THIRD_FACT_ID],
        },
      }),
    );
    expect(factRelationId(summary)).toBeNull();
  });
});

// ── what the model filling this in is actually told ─────────────────────────

describe('the emitted JSON Schema', () => {
  it('closes the object and keeps the content union discriminated', () => {
    const json = toLlmJsonSchema(Fact, { dialect: 'ollama' });
    expect(json.type).toBe('object');
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(['id', 'seriesId', 'content', 'assertedAt', 'sourceRef']);
  });

  it('drops the bi-temporal guard, which is why parse is the only backstop', () => {
    const emitted = JSON.stringify(toLlmJsonSchema(Fact, { dialect: 'ollama' }));
    expect(emitted).not.toContain('precede');
    expect(
      Fact.safeParse(fact({ validFrom: { ordinal: 900 }, validUntil: { ordinal: 100 } })).success,
    ).toBe(false);
  });
});
