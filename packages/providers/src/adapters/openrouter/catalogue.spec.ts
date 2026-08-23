import { describe, expect, it } from 'vitest';
import { FREE_TIER_FACTS, KNOWN_MODELS, type ModelDescriptor } from '@rv/contracts';

import { openrouter as fixture } from '../../__fixtures__/responses';
import { buildSnapshot, reconcile, toCatalogueEntry } from './catalogue';
import { OpenRouterModelsResponse } from './wire';

const payload = OpenRouterModelsResponse.parse(fixture.models);

/** The three ids in the fixture, with the prices `KNOWN_MODELS` would have to agree on. */
function agreeingCatalogue(): readonly ModelDescriptor[] {
  return KNOWN_MODELS.filter(
    (model) => model.id === 'z-ai/glm-5.2:free' || model.id === 'google/gemma-4-31b-it:free',
  );
}

describe('toCatalogueEntry', () => {
  it('keeps the provider’s rate strings verbatim', () => {
    const entry = toCatalogueEntry(
      OpenRouterModelsResponse.parse(fixture.models).data[2] ?? { id: 'x' },
    );
    // Parsing to a float on the way in would throw away digits the ledger needs.
    expect(entry.pricing.promptPerTokenUsd).toBe('0.0000003');
    expect(entry.pricing.completionPerTokenUsd).toBe('0.0000025');
    expect(entry.pricing.perInputImageUsd).toBe('0.001238');
  });

  it('falls back to text modality when the catalogue is silent', () => {
    const entry = toCatalogueEntry({ id: 'mystery/model' });
    expect(entry.inputModalities).toEqual(['text']);
    expect(entry.outputModalities).toEqual(['text']);
    expect(entry.contextLength).toBeNull();
    expect(entry.maxOutputTokens).toBeNull();
    // No published rate is not the same as free - but a model quoting nothing at all
    // is treated as free here because zero is what OpenRouter means by an absent rate.
    expect(entry.free).toBe(true);
  });

  it('drops modalities we have no member for rather than inventing one', () => {
    const entry = toCatalogueEntry({
      id: 'x/y',
      architecture: { input_modalities: ['text', 'file'], output_modalities: ['text'] },
    });
    expect(entry.inputModalities).toEqual(['text']);
  });

  it('prefers the top-level context length, falling back to the provider’s', () => {
    expect(
      toCatalogueEntry({ id: 'x/y', top_provider: { context_length: 8_192 } }).contextLength,
    ).toBe(8_192);
  });
});

describe('reconcile', () => {
  it('reports nothing when the live catalogue matches the seed table', () => {
    const live = new Map(payload.data.map((model) => [model.id, toCatalogueEntry(model)]));
    const drift = reconcile(live, agreeingCatalogue()).filter(
      (entry) => entry.kind !== 'free-pool-size-changed',
    );
    expect(drift).toEqual([]);
  });

  it('reports a model we ship that the live catalogue no longer lists', () => {
    const live = new Map(payload.data.map((model) => [model.id, toCatalogueEntry(model)]));
    const drift = reconcile(
      live,
      KNOWN_MODELS.filter((model) => model.id === 'nvidia/nemotron-3-ultra-550b-a55b:free'),
    );
    expect(drift.some((entry) => entry.kind === 'missing-from-live')).toBe(true);
  });

  it('converts per-token rates to per-million before comparing', () => {
    // The single most likely place for an off-by-1e6 to hide.
    const live = new Map(payload.data.map((model) => [model.id, toCatalogueEntry(model)]));
    const seed: ModelDescriptor[] = [
      {
        provider: 'openrouter',
        id: 'google/gemini-2.5-flash-image',
        label: 'x',
        capabilities: ['image-generation'],
        contextWindow: null,
        maxOutputTokens: null,
        enforcesJsonSchema: false,
        acceptsReferenceImages: true,
        inputModalities: ['text', 'image'],
        outputModalities: ['text', 'image'],
        pricing: {
          // 0.0000003 per token == 0.3 per million.
          inputPerMTokensUsd: '0.3',
          outputPerMTokensUsd: '2.5',
          imageOutputPerMTokensUsd: '30',
          approxPerImageUsd: '0.039',
          free: false,
        },
      },
    ];

    const drift = reconcile(live, seed).filter((entry) => entry.kind === 'price-changed');
    expect(drift).toEqual([]);
  });

  it('reports a price that has moved', () => {
    const live = new Map(payload.data.map((model) => [model.id, toCatalogueEntry(model)]));
    const seed: ModelDescriptor[] = [
      {
        provider: 'openrouter',
        id: 'google/gemini-2.5-flash-image',
        label: 'x',
        capabilities: ['image-generation'],
        contextWindow: null,
        maxOutputTokens: null,
        enforcesJsonSchema: false,
        acceptsReferenceImages: true,
        inputModalities: ['text', 'image'],
        outputModalities: ['text', 'image'],
        pricing: {
          inputPerMTokensUsd: '0.1',
          outputPerMTokensUsd: '2.5',
          imageOutputPerMTokensUsd: '30',
          approxPerImageUsd: '0.039',
          free: false,
        },
      },
    ];

    const drift = reconcile(live, seed);
    expect(drift).toContainEqual({
      kind: 'price-changed',
      modelId: 'google/gemini-2.5-flash-image',
      expected: 'input 0.1/1M',
      actual: 'input 0.3/1M',
    });
  });

  it('reports a modality that has changed', () => {
    const live = new Map([
      [
        'google/gemini-2.5-flash-image',
        toCatalogueEntry({
          id: 'google/gemini-2.5-flash-image',
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          pricing: { prompt: '0.0000003', completion: '0.0000025' },
        }),
      ],
    ]);

    const drift = reconcile(
      live,
      KNOWN_MODELS.filter((model) => model.id === 'google/gemini-2.5-flash-image'),
    );
    expect(drift.some((entry) => entry.kind === 'modality-changed')).toBe(true);
  });

  it('reports the free pool changing size away from the verified count', () => {
    const live = new Map(payload.data.map((model) => [model.id, toCatalogueEntry(model)]));
    const drift = reconcile(live, []);

    expect(drift).toContainEqual({
      kind: 'free-pool-size-changed',
      modelId: '*',
      expected: `${String(FREE_TIER_FACTS.openRouterFreeModelCount)} models with the :free suffix`,
      actual: '2',
    });
  });

  it('reports a `:free` model that starts emitting images', () => {
    // Research §2 measured zero of these. If one ever appears, it should be news, not
    // a silent routing change.
    const live = new Map([
      [
        'someone/free-image:free',
        toCatalogueEntry({
          id: 'someone/free-image:free',
          architecture: { input_modalities: ['text'], output_modalities: ['text', 'image'] },
          pricing: { prompt: '0', completion: '0' },
        }),
      ],
    ]);

    const drift = reconcile(live, []);
    expect(drift.some((entry) => entry.kind === 'free-model-emits-images')).toBe(true);
  });

  it('flags a rate that appeared where we recorded none', () => {
    const seed: ModelDescriptor[] = [
      {
        provider: 'openrouter',
        id: 'z-ai/glm-5.2:free',
        label: 'x',
        capabilities: ['text-generation'],
        contextWindow: null,
        maxOutputTokens: null,
        enforcesJsonSchema: false,
        acceptsReferenceImages: false,
        inputModalities: ['text'],
        outputModalities: ['text'],
        pricing: {
          inputPerMTokensUsd: null,
          outputPerMTokensUsd: null,
          imageOutputPerMTokensUsd: null,
          approxPerImageUsd: null,
          free: true,
        },
      },
    ];
    const live = new Map(payload.data.map((model) => [model.id, toCatalogueEntry(model)]));

    const drift = reconcile(live, seed).filter((entry) => entry.kind === 'price-changed');
    expect(drift).toHaveLength(2);
    expect(drift[0]?.expected).toContain('not published');
  });
});

describe('buildSnapshot', () => {
  it('carries the models, the free ids and the drift together', () => {
    const snapshot = buildSnapshot(payload, 1_000, agreeingCatalogue());
    expect(snapshot.fetchedAt).toBe(1_000);
    expect(snapshot.models.size).toBe(3);
    expect(snapshot.freeModelIds).toHaveLength(2);
    expect(snapshot.drift.length).toBeGreaterThan(0);
  });

  it('sorts the free ids so two snapshots are diffable', () => {
    const snapshot = buildSnapshot(payload, 0, []);
    expect([...snapshot.freeModelIds]).toEqual([...snapshot.freeModelIds].sort());
  });
});
