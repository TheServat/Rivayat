/**
 * Per-stage model selection, end to end through the real router.
 *
 * The owner's requirement is that any LLM stage can be pinned to any model, so the test
 * that matters is not "the router has a stageOverrides field" - it is that two roles
 * running at two stages resolve to two different backends when, and only when, the config
 * says so.
 */

import { describe, expect, it } from 'vitest';
import type { Capability, ModelDescriptor, ProviderKind, RouterConfig } from '@rv/contracts';
import { RouterConfig as RouterConfigSchema } from '@rv/contracts';
import { CapabilityMatrix, ModelRouter } from '@rv/providers';
import { createRng, isErr } from '@rv/shared-kernel';

import { FakeStructuredBackend } from '../__fixtures__/fakes';
import { FixedStageBackends, RoutedStageBackends } from './stage-backends';

type TestAdapter = FakeStructuredBackend & {
  kind: ProviderKind;
  modelRef: string;
  capabilities: readonly Capability[];
  generateText?: () => never;
};

/**
 * An adapter that is also a `StructuredBackend`, which is what the real ones are.
 *
 * `generateText` is a real method because `CapabilityMatrix.register` checks that a
 * declared capability corresponds to a method that exists - which is the check that makes
 * `UnsupportedCapabilityError` an alarm rather than routine control flow.
 */
function adapter(
  kind: ProviderKind,
  model: string,
  capabilities: readonly Capability[] = ['text-generation', 'structured-generation'],
): TestAdapter {
  const backend = new FakeStructuredBackend({ id: `${kind}:${model}` });
  return Object.assign(backend, {
    kind,
    modelRef: `${kind}:${model}`,
    capabilities,
    generateText: (): never => {
      throw new Error('the story engine never calls a raw text port');
    },
  });
}

function descriptor(
  kind: ProviderKind,
  id: string,
  capabilities: readonly Capability[],
): ModelDescriptor {
  return {
    provider: kind,
    id,
    label: id,
    capabilities: [...capabilities],
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
  };
}

const LOCAL = adapter('ollama', 'qwen3.5:latest');
const CLOUD = adapter('openrouter', 'z-ai/glm-5.2:free');
/** Declares text generation only - no structured port. The resolver must skip it. */
const TEXT_ONLY = adapter('gemini', 'gemini-3-flash', ['text-generation']);

function matrixWith(...adapters: readonly TestAdapter[]): CapabilityMatrix {
  const matrix = new CapabilityMatrix();
  matrix.registerAll(adapters);
  return matrix;
}

function routerFor(config: Partial<RouterConfig>, matrix: CapabilityMatrix): ModelRouter {
  return new ModelRouter({
    config: RouterConfigSchema.parse({ projectId: null, ...config }),
    matrix,
    rng: createRng('story-engine-test'),
    catalogue: [
      descriptor('ollama', 'qwen3.5:latest', ['text-generation', 'structured-generation']),
      descriptor('openrouter', 'z-ai/glm-5.2:free', ['text-generation', 'structured-generation']),
      descriptor('gemini', 'gemini-3-flash', ['text-generation']),
    ],
  });
}

describe('RoutedStageBackends', () => {
  it('routes two stages to two different models when the config pins them apart', () => {
    const matrix = matrixWith(LOCAL, CLOUD);
    const router = routerFor(
      {
        stageOverrides: {
          intake: { stage: 'intake', provider: 'ollama', model: 'qwen3.5:latest', pinned: true },
          story: {
            stage: 'story',
            provider: 'openrouter',
            model: 'z-ai/glm-5.2:free',
            pinned: true,
          },
        },
      },
      matrix,
    );
    const backends = new RoutedStageBackends({ router, matrix });

    const intake = backends.resolve({ stage: 'intake', task: 'story-outline', tier: 'draft' });
    const story = backends.resolve({ stage: 'story', task: 'story-outline', tier: 'final' });

    expect(isErr(intake)).toBe(false);
    expect(isErr(story)).toBe(false);
    if (isErr(intake) || isErr(story)) return;

    expect(intake.value[0]?.id).toBe('ollama:qwen3.5:latest');
    expect(story.value[0]?.id).toBe('openrouter:z-ai/glm-5.2:free');
    expect(intake.value[0]?.id).not.toBe(story.value[0]?.id);
  });

  it('sends both stages to the same model when neither is pinned', () => {
    const matrix = matrixWith(LOCAL);
    const backends = new RoutedStageBackends({ router: routerFor({}, matrix), matrix });

    const intake = backends.resolve({ stage: 'intake', task: 'story-outline', tier: 'draft' });
    const story = backends.resolve({ stage: 'story', task: 'story-outline', tier: 'final' });
    if (isErr(intake) || isErr(story)) throw new Error('both stages should route');

    expect(intake.value[0]?.id).toBe(story.value[0]?.id);
  });

  it('skips a routed model that cannot return validated JSON', () => {
    // `scene-write` is declared `text-generation`, so the router happily offers a
    // text-only model. Everything here goes through StructuredCall, so it must be skipped.
    const matrix = matrixWith(TEXT_ONLY, LOCAL);
    const router = routerFor({}, matrix);
    const resolved = new RoutedStageBackends({ router, matrix }).resolve({
      stage: 'sequence',
      task: 'scene-write',
      tier: 'final',
    });
    if (isErr(resolved)) throw new Error('a structured-capable model was registered');

    expect(resolved.value.map((backend) => backend.id)).toEqual(['ollama:qwen3.5:latest']);
  });

  it('fails, naming the stage, when nothing on the route can return JSON', () => {
    const matrix = matrixWith(TEXT_ONLY);
    const router = routerFor({}, matrix);
    const resolved = new RoutedStageBackends({ router, matrix }).resolve({
      stage: 'sequence',
      task: 'scene-write',
      tier: 'final',
    });

    expect(isErr(resolved)).toBe(true);
    if (!isErr(resolved)) return;
    expect(resolved.error.kind).toBe('unsupported');
    expect(resolved.error.message).toContain('sequence');
  });

  it("propagates the router's own refusal when a pin cannot serve the task", () => {
    const matrix = matrixWith(TEXT_ONLY);
    const router = routerFor(
      {
        stageOverrides: {
          cast: { stage: 'cast', provider: 'gemini', model: 'gemini-3-flash', pinned: true },
        },
      },
      matrix,
    );
    const resolved = new RoutedStageBackends({ router, matrix }).resolve({
      stage: 'cast',
      task: 'character-sheet',
      tier: 'final',
    });

    expect(isErr(resolved)).toBe(true);
    if (!isErr(resolved)) return;
    expect(resolved.error.kind).toBe('unsupported');
  });
});

describe('FixedStageBackends', () => {
  it('returns the chain it was given, whatever the stage', () => {
    const one = new FakeStructuredBackend({ id: 'fake:one' });
    const resolved = new FixedStageBackends([one]).resolve({
      stage: 'story',
      task: 'story-outline',
      tier: 'final',
    });
    if (isErr(resolved)) throw new Error('a fixed chain always resolves');
    expect(resolved.value).toEqual([one]);
  });

  it('refuses an empty chain rather than letting StructuredCall throw', () => {
    const resolved = new FixedStageBackends([]).resolve({
      stage: 'story',
      task: 'story-outline',
      tier: 'final',
    });
    expect(isErr(resolved)).toBe(true);
  });
});
