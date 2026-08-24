import { at } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CallParams,
  Capability,
  FREE_TIER_FACTS,
  FailoverPolicy,
  KNOWN_MODELS,
  ModelBinding,
  ModelDescriptor,
  ModelRef,
  Modality,
  PipelineStageKey,
  PriceString,
  Pricing,
  ProviderKind,
  QualityTier,
  RouterConfig,
  RoutingPolicy,
  RoutingRule,
  StageOverride,
  TaskKind,
  describePricing,
  modelRef,
} from './capability';

const PROJECT_ID = 'prj_0000000000000000000000000A';

/** A minimal descriptor the checks are happy with, so each test can break one thing. */
function textModel(overrides: Record<string, unknown> = {}): unknown {
  return {
    provider: 'ollama',
    id: 'qwen3.5:latest',
    label: 'Qwen 3.5',
    capabilities: ['text-generation'],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
    pricing: {
      inputPerMTokensUsd: '0',
      outputPerMTokensUsd: '0',
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: true,
    },
    ...overrides,
  };
}

describe('enums', () => {
  it('declares one capability per narrow port in architecture 5', () => {
    expect([...Capability.options].sort()).toEqual([
      'embedding',
      'image-edit',
      'image-generation',
      'speech-synthesis',
      'structured-generation',
      'text-generation',
      'vision-scoring',
    ]);
  });

  it('declares every provider that has an adapter', () => {
    expect(ProviderKind.options).toEqual([
      'ollama',
      'gemini',
      'openrouter',
      'comfyui',
      'pollinations',
      'openai-compatible',
      'higgs',
      'chatterbox',
      'elevenlabs',
    ]);
  });

  it('covers every LLM and image job the pipeline issues', () => {
    expect(TaskKind.options).toEqual([
      'story-outline',
      'scene-write',
      'character-sheet',
      'style-derive',
      'asset-spec',
      'prompt-compose',
      'continuity-check',
      'image-draft',
      'image-final',
      'image-edit',
      'vision-score',
      'embed',
      'speech-line',
    ]);
  });

  it('names the twelve pipeline stages of architecture 4 in order', () => {
    expect(PipelineStageKey.options).toEqual([
      'intake',
      'style',
      'story',
      'cast',
      'world',
      'resolve',
      'produce',
      'sequence',
      'choreograph',
      'preview',
      'render',
      'deliver',
    ]);
  });

  it('ladders quality and policy', () => {
    expect(QualityTier.options).toEqual(['draft', 'preview', 'final']);
    expect(RoutingPolicy.options).toEqual(['cheapest', 'balanced', 'best']);
    expect(Modality.options).toEqual(['text', 'image', 'audio']);
  });
});

describe('model references', () => {
  it('builds a provider-qualified reference', () => {
    expect(modelRef('openrouter', 'google/gemini-3-pro-image')).toBe(
      'openrouter:google/gemini-3-pro-image',
    );
    expect(ModelRef.parse(modelRef('ollama', 'qwen3.5:latest'))).toBe('ollama:qwen3.5:latest');
  });

  it('rejects a bare model id, which the ledger could not attribute', () => {
    expect(ModelRef.safeParse('gemini-3-pro-image').success).toBe(false);
    expect(ModelRef.safeParse('Openrouter:x').success).toBe(false);
  });

  it('accepts every reference built from a known model', () => {
    for (const model of KNOWN_MODELS) {
      expect(ModelRef.safeParse(modelRef(model.provider, model.id)).success).toBe(true);
    }
  });
});

describe('pricing', () => {
  it('accepts a decimal price string and rejects anything else', () => {
    expect(PriceString.parse('0')).toBe('0');
    expect(PriceString.parse('0.0000003')).toBe('0.0000003');
    expect(PriceString.safeParse('-1').success).toBe(false);
    expect(PriceString.safeParse('1e-7').success).toBe(false);
    expect(PriceString.safeParse('free').success).toBe(false);
    expect(PriceString.safeParse('').success).toBe(false);
  });

  it('keeps a rate that a float literal would blur', () => {
    const pricing = Pricing.parse({
      inputPerMTokensUsd: '0.250000000000001',
      outputPerMTokensUsd: null,
      imageOutputPerMTokensUsd: null,
      approxPerImageUsd: null,
      free: false,
    });
    expect(pricing.inputPerMTokensUsd).toBe('0.250000000000001');
  });

  it('describes a free model as free and says nothing about rates', () => {
    expect(
      describePricing({
        inputPerMTokensUsd: '0',
        outputPerMTokensUsd: '0',
        imageOutputPerMTokensUsd: null,
        approxPerImageUsd: null,
        free: true,
      }),
    ).toBe('free');
  });

  it('describes every rate a paid model publishes', () => {
    expect(
      describePricing({
        inputPerMTokensUsd: '0.3',
        outputPerMTokensUsd: '2.5',
        imageOutputPerMTokensUsd: '30',
        approxPerImageUsd: '0.0336',
        free: false,
        note: 'per 1024px image',
      }),
    ).toBe(
      '$0.3/1M in - $2.5/1M out - $30/1M image-output tokens - ~$0.0336/image - per 1024px image',
    );
  });

  it('distinguishes "no published price" from "free"', () => {
    expect(
      describePricing({
        inputPerMTokensUsd: null,
        outputPerMTokensUsd: null,
        imageOutputPerMTokensUsd: null,
        approxPerImageUsd: null,
        free: false,
      }),
    ).toBe('price not published');
  });
});

describe('ModelDescriptor invariants', () => {
  it('accepts a well-formed descriptor', () => {
    expect(ModelDescriptor.safeParse(textModel()).success).toBe(true);
  });

  it('requires an image capability to declare image output', () => {
    const result = ModelDescriptor.safeParse(
      textModel({
        capabilities: ['image-generation'],
        outputModalities: ['text'],
        pricing: {
          inputPerMTokensUsd: null,
          outputPerMTokensUsd: null,
          imageOutputPerMTokensUsd: '30',
          approxPerImageUsd: null,
          free: false,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('outputModalities');
  });

  it('requires an image model to carry an image price, so the budget guard can run first', () => {
    const result = ModelDescriptor.safeParse(
      textModel({
        capabilities: ['image-edit'],
        outputModalities: ['image'],
        pricing: {
          inputPerMTokensUsd: null,
          outputPerMTokensUsd: null,
          imageOutputPerMTokensUsd: null,
          approxPerImageUsd: null,
          free: false,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'pricing.imageOutputPerMTokensUsd',
    );
  });

  it('refuses a `:free` model that is not priced as free', () => {
    const result = ModelDescriptor.safeParse(
      textModel({
        provider: 'openrouter',
        id: 'z-ai/glm-5.2:free',
        pricing: {
          inputPerMTokensUsd: null,
          outputPerMTokensUsd: null,
          imageOutputPerMTokensUsd: null,
          approxPerImageUsd: null,
          free: false,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('pricing.free');
  });

  it('refuses a `:free` model that claims to emit images (research 2)', () => {
    const result = ModelDescriptor.safeParse(
      textModel({
        provider: 'openrouter',
        id: 'someone/imaginary-image:free',
        capabilities: ['image-generation'],
        outputModalities: ['image'],
        pricing: {
          inputPerMTokensUsd: null,
          outputPerMTokensUsd: null,
          imageOutputPerMTokensUsd: '0',
          approxPerImageUsd: null,
          free: true,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('capabilities');
  });

  it('refuses a free tier that quotes a nonzero rate', () => {
    const result = ModelDescriptor.safeParse(
      textModel({
        pricing: {
          inputPerMTokensUsd: '0',
          outputPerMTokensUsd: '2.5',
          imageOutputPerMTokensUsd: null,
          approxPerImageUsd: null,
          free: true,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('pricing');
  });

  it('rejects an unknown field rather than silently dropping it', () => {
    expect(ModelDescriptor.safeParse(textModel({ deprecated: true })).success).toBe(false);
  });

  it('requires at least one capability and one modality on each side', () => {
    expect(ModelDescriptor.safeParse(textModel({ capabilities: [] })).success).toBe(false);
    expect(ModelDescriptor.safeParse(textModel({ inputModalities: [] })).success).toBe(false);
    expect(ModelDescriptor.safeParse(textModel({ outputModalities: [] })).success).toBe(false);
  });
});

describe('KNOWN_MODELS', () => {
  it('every entry satisfies the schema', () => {
    for (const model of KNOWN_MODELS) {
      const result = ModelDescriptor.safeParse(model);
      expect(result.success, `${model.id}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it('has no duplicate model ids', () => {
    const ids = KNOWN_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every image-output model an image price', () => {
    const imageModels = KNOWN_MODELS.filter(
      (model) =>
        model.capabilities.includes('image-generation') ||
        model.capabilities.includes('image-edit'),
    );
    expect(imageModels.length).toBeGreaterThan(0);
    for (const model of imageModels) {
      expect(model.pricing.imageOutputPerMTokensUsd, model.id).not.toBeNull();
      expect(model.outputModalities, model.id).toContain('image');
    }
  });

  it('gives no `:free` model an image-output capability (research 2, live)', () => {
    const freeSuffixed = KNOWN_MODELS.filter((model) => model.id.endsWith(':free'));
    expect(freeSuffixed.length).toBe(4);
    for (const model of freeSuffixed) {
      expect(model.capabilities, model.id).not.toContain('image-generation');
      expect(model.capabilities, model.id).not.toContain('image-edit');
      expect(model.outputModalities, model.id).not.toContain('image');
      expect(model.pricing.free, model.id).toBe(true);
    }
  });

  it('has pricing strings that all parse to finite numbers', () => {
    for (const model of KNOWN_MODELS) {
      const rates = [
        model.pricing.inputPerMTokensUsd,
        model.pricing.outputPerMTokensUsd,
        model.pricing.imageOutputPerMTokensUsd,
        model.pricing.approxPerImageUsd,
      ];
      for (const rate of rates) {
        if (rate === null) continue;
        const parsed = Number.parseFloat(rate);
        expect(Number.isFinite(parsed), `${model.id}: ${rate}`).toBe(true);
        expect(parsed).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('records no free tier for any Gemini image model', () => {
    const geminiImages = KNOWN_MODELS.filter(
      (model) =>
        model.id.includes('gemini') &&
        (model.capabilities.includes('image-generation') ||
          model.capabilities.includes('image-edit')),
    );
    expect(geminiImages.length).toBe(4);
    for (const model of geminiImages) {
      expect(model.pricing.free, model.id).toBe(false);
    }
  });

  it('carries the exact verified image rates from research 2', () => {
    const rateOf = (id: string): string | null => {
      const model = KNOWN_MODELS.find((candidate) => candidate.id === id);
      expect(model, id).toBeDefined();
      return model?.pricing.imageOutputPerMTokensUsd ?? null;
    };

    expect(rateOf('google/gemini-3.1-flash-lite-image')).toBe('30');
    expect(rateOf('google/gemini-2.5-flash-image')).toBe('30');
    expect(rateOf('google/gemini-3.1-flash-image')).toBe('60');
    expect(rateOf('google/gemini-3-pro-image')).toBe('120');
    expect(rateOf('openai/gpt-5-image-mini')).toBe('8');
  });

  it('carries the per-image worked examples exactly where research 2 gives a single figure', () => {
    const lite = KNOWN_MODELS.find((model) => model.id === 'google/gemini-3.1-flash-lite-image');
    const flash25 = KNOWN_MODELS.find((model) => model.id === 'google/gemini-2.5-flash-image');
    expect(lite?.pricing.approxPerImageUsd).toBe('0.0336');
    expect(flash25?.pricing.approxPerImageUsd).toBe('0.039');
  });

  it('leaves the range-priced image models without a single per-image figure', () => {
    for (const id of [
      'google/gemini-3.1-flash-image',
      'google/gemini-3-pro-image',
      'openai/gpt-5-image-mini',
    ]) {
      const model = KNOWN_MODELS.find((candidate) => candidate.id === id);
      expect(model?.pricing.approxPerImageUsd, id).toBeNull();
      expect(model?.pricing.note, id).toBeDefined();
    }
  });

  it('includes the named free OpenRouter models with their researched context windows', () => {
    const glm = KNOWN_MODELS.find((model) => model.id === 'z-ai/glm-5.2:free');
    const nemotronUltra = KNOWN_MODELS.find(
      (model) => model.id === 'nvidia/nemotron-3-ultra-550b-a55b:free',
    );
    expect(glm?.contextWindow).toBe(256_000);
    expect(nemotronUltra?.contextWindow).toBe(1_000_000);

    for (const id of ['google/gemma-4-31b-it:free', 'nvidia/nemotron-nano-12b-v2-vl:free']) {
      const model = KNOWN_MODELS.find((candidate) => candidate.id === id);
      expect(model?.capabilities, id).toContain('vision-scoring');
      expect(model?.inputModalities, id).toContain('image');
    }
  });

  it('includes the free Gemini text tiers and the local Ollama models', () => {
    const geminiFree = KNOWN_MODELS.filter((model) => model.provider === 'gemini');
    expect(geminiFree.map((model) => model.id)).toEqual(['gemini-2.5-flash', 'gemini-3-flash']);
    for (const model of geminiFree) {
      expect(model.pricing.free, model.id).toBe(true);
      expect(model.outputModalities, model.id).not.toContain('image');
    }

    expect(
      KNOWN_MODELS.filter((model) => model.provider === 'ollama').map((model) => model.id),
    ).toEqual([
      'qwen3.5:latest',
      'gemma4:26b',
      'qwen2.5:7b',
      'qwen3:1.7b',
      'aya-expanse:8b',
      'llama3.2:latest',
    ]);
  });

  it('marks the models with the documented Ollama schema defect as unenforced', () => {
    for (const id of ['qwen3.5:latest', 'gemma4:26b']) {
      const model = KNOWN_MODELS.find((candidate) => candidate.id === id);
      expect(model?.enforcesJsonSchema, id).toBe(false);
    }
  });

  it('does not list Imagen 4, which was shut down 2026-08-17', () => {
    expect(KNOWN_MODELS.some((model) => model.id.includes('imagen'))).toBe(false);
  });

  it('only claims reference-image conditioning for models research 2 verified as text+image', () => {
    for (const model of KNOWN_MODELS) {
      if (!model.acceptsReferenceImages) continue;
      expect(model.inputModalities, model.id).toContain('image');
    }
  });

  it('pins the free-tier facts research 1-2 verified live', () => {
    expect(FREE_TIER_FACTS.openRouterFreeModelCount).toBe(18);
    expect(FREE_TIER_FACTS.openRouterFreeModelsProduceImages).toBe(false);
    expect(FREE_TIER_FACTS.geminiImageModelsHaveFreeTier).toBe(false);
  });
});

describe('routing', () => {
  const binding = {
    task: 'story-outline',
    tier: 'final',
    provider: 'openrouter',
    model: 'z-ai/glm-5.2:free',
  };

  it('defaults a binding to empty params rather than inventing provider defaults', () => {
    expect(ModelBinding.parse(binding).params).toEqual({});
  });

  it('keeps the params it is given', () => {
    const parsed = ModelBinding.parse({
      ...binding,
      params: { temperature: 0, think: false, seed: 42 },
    });
    expect(parsed.params).toEqual({ temperature: 0, think: false, seed: 42 });
  });

  it('rejects an out-of-range sampling parameter', () => {
    expect(CallParams.safeParse({ temperature: 2.5 }).success).toBe(false);
    expect(CallParams.safeParse({ topP: 1.5 }).success).toBe(false);
    expect(CallParams.safeParse({ seed: -1 }).success).toBe(false);
    expect(CallParams.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it('refuses an empty failover chain, which would be a routing hole', () => {
    const rule = {
      task: 'scene-write',
      tier: 'final',
      policy: 'best',
      chain: [] as unknown[],
    };
    expect(RoutingRule.safeParse(rule).success).toBe(false);
  });

  it('keeps the failover chain ordered', () => {
    const parsed = RoutingRule.parse({
      task: 'scene-write',
      tier: 'final',
      policy: 'best',
      chain: [
        { ...binding, task: 'scene-write' },
        { ...binding, task: 'scene-write', provider: 'gemini', model: 'gemini-3-flash' },
        { ...binding, task: 'scene-write', provider: 'ollama', model: 'qwen3.5:latest' },
      ],
    });
    expect(parsed.chain.map((link) => link.model)).toEqual([
      'z-ai/glm-5.2:free',
      'gemini-3-flash',
      'qwen3.5:latest',
    ]);
    expect(at(parsed.chain, 0).provider).toBe('openrouter');
    expect(parsed.maxCostPerCallNanoUsd).toBeNull();
  });

  it('backs off before failing over, with jitter so workers do not retry in lockstep', () => {
    const policy = FailoverPolicy.parse({});
    expect(policy).toEqual({
      maxAttemptsPerModel: 3,
      initialBackoffMs: 500,
      backoffMultiplier: 2,
      maxBackoffMs: 30_000,
      jitter: 0.2,
      failoverOn: ['rate-limit', 'timeout', 'provider', 'unsupported'],
    });
  });

  it('pins a stage absolutely by default, because a creative choice is not a preference', () => {
    const override = StageOverride.parse({
      stage: 'story',
      provider: 'openrouter',
      model: 'z-ai/glm-5.2:free',
    });
    expect(override.pinned).toBe(true);
  });

  it('represents a per-stage override for every stage the pipeline has', () => {
    const stageOverrides = Object.fromEntries(
      PipelineStageKey.options.map((stage) => [
        stage,
        { stage, provider: 'ollama', model: 'qwen3.5:latest' },
      ]),
    );
    const config = RouterConfig.parse({ projectId: PROJECT_ID, stageOverrides });
    expect(Object.keys(config.stageOverrides)).toHaveLength(PipelineStageKey.options.length);
    expect(config.stageOverrides.story?.model).toBe('qwen3.5:latest');
  });

  it('defaults to a balanced, empty, workspace-wide config', () => {
    const config = RouterConfig.parse({ projectId: null });
    expect(config.defaultPolicy).toBe('balanced');
    expect(config.rules).toEqual([]);
    expect(config.stageOverrides).toEqual({});
    expect(config.taskOverrides).toEqual({});
    expect(config.failover.maxAttemptsPerModel).toBe(3);
  });

  it('rejects an override for a stage that does not exist', () => {
    expect(
      RouterConfig.safeParse({
        projectId: null,
        stageOverrides: {
          storyboard: { stage: 'story', provider: 'ollama', model: 'qwen3.5:latest' },
        },
      }).success,
    ).toBe(false);
  });
});

describe('JSON Schema emission', () => {
  it('emits for the schemas an LLM or an API client has to fill', () => {
    for (const schema of [ModelDescriptor, ModelBinding, RoutingRule, RouterConfig, CallParams]) {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
    }
  });

  it('keeps the capability enum in the emitted schema', () => {
    const json = JSON.stringify(z.toJSONSchema(ModelDescriptor));
    expect(json).toContain('structured-generation');
    expect(json).toContain('vision-scoring');
  });
});
