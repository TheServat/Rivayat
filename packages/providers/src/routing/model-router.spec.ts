import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  type Capability,
  type ModelDescriptor,
  type ProviderKind,
  RouterConfig,
  TaskKind,
} from '@rv/contracts';
import {
  type AppError,
  ProviderError,
  RateLimitError,
  type Result,
  ValidationError,
  err,
  isErr,
  isOk,
  ok,
} from '@rv/shared-kernel';

import { recordingSleep, testRng } from '../__fixtures__/support';
import { CAPABILITY_METHOD, CapabilityMatrix } from '../ports/capability-matrix';
import type { ProviderAdapter } from '../ports/provider-adapter';
import { ModelRouter } from './model-router';
import { TASK_CAPABILITY, capabilityForTask } from './task-capability';

function stubAdapter(
  kind: ProviderKind,
  model: string,
  capabilities: readonly Capability[],
): ProviderAdapter {
  const adapter: Record<string, unknown> = {
    kind,
    modelRef: `${kind}:${model}`,
    capabilities,
  };
  for (const capability of capabilities) {
    adapter[CAPABILITY_METHOD[capability]] = (): void => undefined;
  }
  return adapter as unknown as ProviderAdapter;
}

function descriptor(
  provider: ProviderKind,
  id: string,
  capabilities: readonly Capability[],
  pricing: { input?: string | null; imageOut?: string | null; free?: boolean } = {},
): ModelDescriptor {
  const emitsImages =
    capabilities.includes('image-generation') || capabilities.includes('image-edit');
  return {
    provider,
    id,
    label: id,
    capabilities: [...capabilities],
    contextWindow: null,
    maxOutputTokens: null,
    enforcesJsonSchema: false,
    acceptsReferenceImages: emitsImages,
    inputModalities: ['text'],
    outputModalities: emitsImages ? ['image'] : ['text'],
    pricing: {
      inputPerMTokensUsd: pricing.input ?? null,
      outputPerMTokensUsd: null,
      imageOutputPerMTokensUsd: pricing.imageOut ?? (emitsImages ? '0' : null),
      approxPerImageUsd: null,
      free: pricing.free ?? false,
    },
  };
}

function config(overrides: Record<string, unknown> = {}): ReturnType<typeof RouterConfig.parse> {
  return RouterConfig.parse({ projectId: null, ...overrides });
}

function routerWith(
  matrix: CapabilityMatrix,
  catalogue: readonly ModelDescriptor[],
  overrides: Record<string, unknown> = {},
): ModelRouter {
  return new ModelRouter({ config: config(overrides), matrix, catalogue, rng: testRng() });
}

describe('TASK_CAPABILITY', () => {
  it('covers every task kind, so a new one is a compile error and not a runtime surprise', () => {
    expect(Object.keys(TASK_CAPABILITY).sort()).toEqual([...TaskKind.options].sort());
  });

  it('routes prose to text and everything schema-shaped to structured', () => {
    expect(capabilityForTask('scene-write')).toBe('text-generation');
    expect(capabilityForTask('story-outline')).toBe('structured-generation');
    expect(capabilityForTask('image-edit')).toBe('image-edit');
  });
});

describe('ModelRouter.route: capability filtering', () => {
  it('refuses before any network call when nothing can serve the task', () => {
    // RV-020: the adapter that cannot edit images is never asked to.
    const matrix = new CapabilityMatrix();
    matrix.register(stubAdapter('comfyui', 'sd1.5-lcm', ['image-generation']));
    const router = routerWith(matrix, [descriptor('comfyui', 'sd1.5-lcm', ['image-generation'])]);

    const route = router.route({ task: 'image-edit', tier: 'draft' });

    expect(isErr(route)).toBe(true);
    if (isErr(route)) {
      expect(route.error.kind).toBe('unsupported');
      expect(route.error.retryable).toBe(false);
    }
  });

  it('routes a task the primary cannot do to a provider that can', () => {
    const matrix = new CapabilityMatrix();
    matrix.register(stubAdapter('comfyui', 'sd1.5-lcm', ['image-generation']));
    matrix.register(
      stubAdapter('gemini', 'gemini-3.1-flash-lite-image', ['image-generation', 'image-edit']),
    );

    const router = routerWith(matrix, [
      descriptor('comfyui', 'sd1.5-lcm', ['image-generation'], { free: true }),
      descriptor('gemini', 'gemini-3.1-flash-lite-image', ['image-generation', 'image-edit'], {
        imageOut: '30',
      }),
    ]);

    const route = router.route({ task: 'image-edit', tier: 'final', policy: 'cheapest' });

    expect(isOk(route)).toBe(true);
    if (isOk(route)) {
      expect(route.value.chain).toHaveLength(1);
      expect(route.value.chain[0]?.provider).toBe('gemini');
      expect(route.value.source).toBe('catalogue');
    }
  });

  it('drops a catalogue model that has no registered adapter', () => {
    // A price without an implementation is not a route.
    const matrix = new CapabilityMatrix();
    const router = routerWith(matrix, [descriptor('gemini', 'ghost', ['text-generation'])]);
    expect(isErr(router.route({ task: 'scene-write', tier: 'draft' }))).toBe(true);
  });
});

describe('ModelRouter.route: policy ordering', () => {
  const matrix = new CapabilityMatrix();
  matrix.register(stubAdapter('comfyui', 'free-lane', ['image-generation']));
  matrix.register(stubAdapter('gemini', 'cheap', ['image-generation']));
  matrix.register(stubAdapter('openrouter', 'dear', ['image-generation']));

  const catalogue = [
    descriptor('openrouter', 'dear', ['image-generation'], { imageOut: '120' }),
    descriptor('gemini', 'cheap', ['image-generation'], { imageOut: '30' }),
    descriptor('comfyui', 'free-lane', ['image-generation'], { free: true }),
  ];

  it('puts the lower estimated cost first under `cheapest`', () => {
    const route = routerWith(matrix, catalogue).route({
      task: 'image-final',
      tier: 'final',
      policy: 'cheapest',
    });
    if (isOk(route)) {
      expect(route.value.chain.map((binding) => binding.model)).toEqual([
        'free-lane',
        'cheap',
        'dear',
      ]);
    }
  });

  it('puts the most expensive first under `best`', () => {
    const route = routerWith(matrix, catalogue).route({
      task: 'image-final',
      tier: 'final',
      policy: 'best',
    });
    if (isOk(route)) expect(route.value.chain[0]?.model).toBe('dear');
  });

  it('puts the free lane first under `balanced`', () => {
    // Research §0: local is the free draft lane. That is the default preference, not
    // something that should need its own policy.
    const route = routerWith(matrix, catalogue).route({
      task: 'image-final',
      tier: 'final',
      policy: 'balanced',
    });
    if (isOk(route)) expect(route.value.chain[0]?.model).toBe('free-lane');
  });

  it('uses the config default policy when the caller names none', () => {
    const route = routerWith(matrix, catalogue, { defaultPolicy: 'best' }).route({
      task: 'image-final',
      tier: 'final',
    });
    if (isOk(route)) {
      expect(route.value.policy).toBe('best');
      expect(route.value.chain[0]?.model).toBe('dear');
    }
  });
});

describe('ModelRouter.route: rules and overrides', () => {
  const matrix = new CapabilityMatrix();
  matrix.register(stubAdapter('ollama', 'qwen3.5:latest', ['structured-generation']));
  matrix.register(stubAdapter('gemini', 'gemini-3-flash', ['structured-generation']));
  const catalogue = [
    descriptor('ollama', 'qwen3.5:latest', ['structured-generation'], { free: true }),
    descriptor('gemini', 'gemini-3-flash', ['structured-generation'], { input: '1' }),
  ];

  const rule = {
    task: 'story-outline',
    tier: 'final',
    policy: 'best',
    chain: [
      { task: 'story-outline', tier: 'final', provider: 'gemini', model: 'gemini-3-flash' },
      { task: 'story-outline', tier: 'final', provider: 'ollama', model: 'qwen3.5:latest' },
    ],
  };

  it('uses a matching rule’s chain in order', () => {
    const route = routerWith(matrix, catalogue, { rules: [rule] }).route({
      task: 'story-outline',
      tier: 'final',
      policy: 'best',
    });

    expect(isOk(route)).toBe(true);
    if (isOk(route)) {
      expect(route.value.source).toBe('rule');
      expect(route.value.chain.map((binding) => binding.model)).toEqual([
        'gemini-3-flash',
        'qwen3.5:latest',
      ]);
    }
  });

  it('lets a per-stage override win over the policy', () => {
    // The owner's requirement: any stage pinnable to any model.
    const route = routerWith(matrix, catalogue, {
      rules: [rule],
      stageOverrides: {
        story: { stage: 'story', provider: 'ollama', model: 'qwen3.5:latest', pinned: true },
      },
    }).route({ task: 'story-outline', tier: 'final', policy: 'best', stage: 'story' });

    expect(isOk(route)).toBe(true);
    if (isOk(route)) {
      expect(route.value.source).toBe('stage-override');
      expect(route.value.chain).toHaveLength(1);
      expect(route.value.chain[0]?.model).toBe('qwen3.5:latest');
    }
  });

  it('fails a pinned stage rather than silently running elsewhere', () => {
    // The point of pinning is that the author's choice is not quietly overridden.
    const route = routerWith(matrix, catalogue, {
      rules: [rule],
      stageOverrides: {
        produce: { stage: 'produce', provider: 'ollama', model: 'qwen3.5:latest', pinned: true },
      },
    }).route({ task: 'image-final', tier: 'final', stage: 'produce' });

    expect(isErr(route)).toBe(true);
    if (isErr(route)) expect(route.error.kind).toBe('unsupported');
  });

  it('lets an unpinned stage override head the chain and keep the fallbacks', () => {
    const route = routerWith(matrix, catalogue, {
      rules: [rule],
      stageOverrides: {
        story: { stage: 'story', provider: 'ollama', model: 'qwen3.5:latest', pinned: false },
      },
    }).route({ task: 'story-outline', tier: 'final', policy: 'best', stage: 'story' });

    if (isOk(route)) {
      expect(route.value.chain.map((binding) => binding.model)).toEqual([
        'qwen3.5:latest',
        'gemini-3-flash',
      ]);
    }
  });

  it('honours the stage override’s own tier', () => {
    const route = routerWith(matrix, catalogue, {
      stageOverrides: {
        story: {
          stage: 'story',
          provider: 'gemini',
          model: 'gemini-3-flash',
          tier: 'draft',
          pinned: true,
        },
      },
    }).route({ task: 'story-outline', tier: 'final', stage: 'story' });

    if (isOk(route)) expect(route.value.tier).toBe('draft');
  });

  it('applies a task override when there is no stage pin', () => {
    const route = routerWith(matrix, catalogue, {
      taskOverrides: {
        'story-outline': {
          task: 'story-outline',
          tier: 'final',
          provider: 'ollama',
          model: 'qwen3.5:latest',
        },
      },
    }).route({ task: 'story-outline', tier: 'final' });

    if (isOk(route)) {
      expect(route.value.source).toBe('task-override');
      expect(route.value.chain[0]?.model).toBe('qwen3.5:latest');
    }
  });

  it('drops a candidate whose estimate exceeds the rule’s per-call ceiling', () => {
    const route = routerWith(matrix, catalogue, {
      rules: [{ ...rule, maxCostPerCallNanoUsd: 1 }],
    }).route({ task: 'story-outline', tier: 'final', policy: 'best' });

    if (isOk(route)) {
      // Gemini's nominal 2000 input tokens at $1/1M is 2000 nano-dollars, over the cap.
      expect(route.value.chain.map((binding) => binding.model)).toEqual(['qwen3.5:latest']);
    }
  });

  it('deduplicates a model that appears in both the override and the rule', () => {
    const route = routerWith(matrix, catalogue, {
      rules: [rule],
      taskOverrides: {
        'story-outline': {
          task: 'story-outline',
          tier: 'final',
          provider: 'gemini',
          model: 'gemini-3-flash',
        },
      },
    }).route({ task: 'story-outline', tier: 'final', policy: 'best' });

    if (isOk(route)) {
      expect(
        route.value.chain.filter((binding) => binding.model === 'gemini-3-flash'),
      ).toHaveLength(1);
    }
  });
});

describe('ModelRouter.execute', () => {
  const matrix = new CapabilityMatrix();
  matrix.register(stubAdapter('ollama', 'local', ['text-generation']));
  matrix.register(stubAdapter('gemini', 'cloud', ['text-generation']));
  const catalogue = [
    descriptor('ollama', 'local', ['text-generation'], { free: true }),
    descriptor('gemini', 'cloud', ['text-generation'], { free: true }),
  ];
  const rule = {
    task: 'scene-write',
    tier: 'final',
    policy: 'balanced',
    chain: [
      { task: 'scene-write', tier: 'final', provider: 'ollama', model: 'local' },
      { task: 'scene-write', tier: 'final', provider: 'gemini', model: 'cloud' },
    ],
  };

  function routeFor(overrides: Record<string, unknown> = {}): {
    router: ModelRouter;
    route: ReturnType<ModelRouter['route']>;
  } {
    const router = routerWith(matrix, catalogue, { rules: [rule], ...overrides });
    return { router, route: router.route({ task: 'scene-write', tier: 'final' }) };
  }

  it('returns the first success without touching the fallback', async () => {
    const { router, route } = routeFor();
    expect(isOk(route)).toBe(true);
    if (!isOk(route)) return;

    const run = vi.fn(() => Promise.resolve(ok('written')));
    const outcome = await router.execute(route.value, run, { sleep: () => Promise.resolve() });

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.binding.model).toBe('local');
      expect(outcome.value.failedOver).toEqual([]);
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('fails over to the next model after a retryable failure exhausts its attempts', async () => {
    const { router, route } = routeFor();
    if (!isOk(route)) throw new Error('route failed');

    const seen: string[] = [];
    const outcome = await router.execute(
      route.value,
      (binding): Promise<Result<string, AppError>> => {
        seen.push(binding.model);
        return Promise.resolve(
          binding.model === 'local'
            ? err(new ProviderError({ message: 'down', provider: 'ollama', status: 503 }))
            : ok('written'),
        );
      },
      { sleep: () => Promise.resolve() },
    );

    expect(isOk(outcome)).toBe(true);
    if (isOk(outcome)) {
      expect(outcome.value.binding.model).toBe('cloud');
      expect(outcome.value.failedOver).toEqual([
        { modelRef: 'ollama:local', errorCode: 'PROVIDER_ERROR', retryable: true },
      ]);
    }
    // Three attempts on the primary (the default `maxAttemptsPerModel`), then one on
    // the fallback.
    expect(seen.filter((model) => model === 'local')).toHaveLength(3);
  });

  it('does not fail over on an error kind outside `failoverOn`', async () => {
    const { router, route } = routeFor();
    if (!isOk(route)) throw new Error('route failed');

    const seen: string[] = [];
    const outcome = await router.execute(
      route.value,
      (binding): Promise<Result<string, AppError>> => {
        seen.push(binding.model);
        return Promise.resolve(err(new ValidationError({ message: 'the prompt is malformed' })));
      },
      { sleep: () => Promise.resolve() },
    );

    expect(isErr(outcome)).toBe(true);
    // A validation failure will fail identically everywhere; trying the next provider
    // only spends money to learn the same thing.
    expect(seen).toEqual(['local']);
  });

  it('backs off by the provider’s retryAfterMs before retrying', async () => {
    const { sleep, waits } = recordingSleep();
    const { router, route } = routeFor();
    if (!isOk(route)) throw new Error('route failed');

    let attempts = 0;
    await router.execute(
      route.value,
      (): Promise<Result<string, AppError>> => {
        attempts += 1;
        return Promise.resolve(
          attempts <= 2 ? err(new RateLimitError('ollama', 2_500)) : ok('written'),
        );
      },
      { sleep },
    );

    expect(waits).toEqual([2_500, 2_500]);
  });

  it('records the whole failover chain when everything fails', async () => {
    const { router, route } = routeFor();
    if (!isOk(route)) throw new Error('route failed');

    const outcome = await router.execute(
      route.value,
      (binding): Promise<Result<string, AppError>> =>
        Promise.resolve(
          err(new ProviderError({ message: 'down', provider: binding.provider, status: 500 })),
        ),
      { sleep: () => Promise.resolve() },
    );

    expect(isErr(outcome)).toBe(true);
    if (isErr(outcome)) expect(outcome.error.kind).toBe('provider');
  });

  it('stops the chain when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { router, route } = routeFor();
    if (!isOk(route)) throw new Error('route failed');

    const run = vi.fn(() => Promise.resolve(ok('never')));
    const outcome = await router.execute(route.value, run, {
      signal: controller.signal,
      sleep: () => Promise.resolve(),
    });

    expect(run).not.toHaveBeenCalled();
    expect(isErr(outcome)).toBe(true);
  });
});

describe('the routing source', () => {
  it('contains no switch on a provider name', () => {
    // OCP: new providers are registered in a map, never added to a case list.
    const directory = fileURLToPath(new URL('./', import.meta.url));
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue;
      const source = readFileSync(join(directory, entry), 'utf8');
      expect(source).not.toMatch(/\bswitch\s*\(/);
    }
  });
});
