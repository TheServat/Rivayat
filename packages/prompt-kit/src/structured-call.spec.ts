import {
  FixedClock,
  MemoryLogger,
  ProviderError,
  instant,
  ok as okResult,
  err as errResult,
  type Result,
  type AppError,
} from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CompletionRequest, CompletionResponse, StructuredBackend } from './backend';
import { StructuredCall } from './structured-call';

const Character = z.object({
  name: z.string().min(1),
  age: z.number().int().min(0),
  traits: z.array(z.string()).min(1),
});

/**
 * A backend that replays a fixed script.
 *
 * Scripted rather than stubbed: the whole point of the wrapper is what it does across
 * a *sequence* of bad responses, so a test needs to control that sequence exactly.
 */
class ScriptedBackend implements StructuredBackend {
  readonly requests: CompletionRequest[] = [];
  #index = 0;

  constructor(
    readonly id: string,
    private readonly script: readonly (string | AppError)[],
    readonly enforcesSchema = false,
    readonly dialect: 'ollama' | 'gemini' | 'openai-strict' | 'plain' = 'ollama',
  ) {}

  complete(request: CompletionRequest): Promise<Result<CompletionResponse, AppError>> {
    this.requests.push(request);
    const entry = this.script[Math.min(this.#index, this.script.length - 1)];
    this.#index += 1;

    if (entry === undefined) {
      throw new Error('ScriptedBackend ran out of script');
    }
    if (typeof entry !== 'string') {
      return Promise.resolve(errResult(entry));
    }
    return Promise.resolve(
      okResult({
        text: entry,
        modelId: this.id,
        usage: { inputTokens: 100, outputTokens: 50 },
        costNanoUsd: 1_000,
      }),
    );
  }
}

const VALID = JSON.stringify({ name: 'Kael', age: 32, traits: ['stubborn'] });

function callWith(...backends: StructuredBackend[]): {
  call: StructuredCall;
  logger: MemoryLogger;
  clock: FixedClock;
  request: Parameters<StructuredCall['run']>[0];
} {
  const logger = new MemoryLogger();
  const clock = new FixedClock(instant(1_000));
  return {
    call: new StructuredCall({ clock, logger }),
    logger,
    clock,
    request: {
      schemaName: 'Character',
      schema: Character,
      backends,
      system: 'You write characters.',
      user: 'Write one.',
    },
  };
}

describe('happy path', () => {
  it('returns the parsed value on a clean first response', async () => {
    const backend = new ScriptedBackend('ollama:qwen3.5', [VALID]);
    const { call, request } = callWith(backend);

    const result = await call.run(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.value).toEqual({ name: 'Kael', age: 32, traits: ['stubborn'] });
    expect(result.value.trace).toMatchObject({
      resolution: 'clean',
      attempts: 1,
      repairTurns: 0,
      escalatedTo: null,
      modelId: 'ollama:qwen3.5',
    });
  });

  it('reports fence-stripped when the model wrapped valid JSON in markdown', async () => {
    // The exact symptom research §1 documents for qwen3.5 on Ollama.
    const backend = new ScriptedBackend('ollama:qwen3.5', ['```json\n' + VALID + '\n```']);
    const { call, request } = callWith(backend);

    const result = await call.run(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trace.resolution).toBe('fence-stripped');
    expect(result.value.trace.fenceStripped).toBe(true);
  });

  it('accumulates usage and cost across every attempt, including discarded ones', async () => {
    const backend = new ScriptedBackend('m', ['not json', VALID]);
    const { call, request } = callWith(backend);

    const result = await call.run(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both round-trips are billed, so both are counted.
    expect(result.value.trace.usage.inputTokens).toBe(200);
    expect(result.value.trace.costNanoUsd).toBe(2_000);
  });
});

describe('repair loop', () => {
  it('feeds the Zod error back and succeeds on the retry', async () => {
    const invalid = JSON.stringify({ name: 'Kael', age: -3, traits: [] });
    const backend = new ScriptedBackend('m', [invalid, VALID]);
    const { call, request } = callWith(backend);

    const result = await call.run(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trace).toMatchObject({
      resolution: 'repaired',
      attempts: 2,
      repairTurns: 1,
    });
  });

  it('names the offending fields in the repair turn', async () => {
    const invalid = JSON.stringify({ name: '', age: 1.5, traits: [] });
    const backend = new ScriptedBackend('m', [invalid, VALID]);
    const { call, request } = callWith(backend);

    await call.run(request);

    const repairTurn = backend.requests[1]?.messages.at(-1);
    expect(repairTurn?.role).toBe('user');
    expect(repairTurn?.content).toContain('$.name');
    expect(repairTurn?.content).toContain('$.age');
    expect(repairTurn?.content).toContain('$.traits');
  });

  it('keeps the rejected output in the conversation exactly once', async () => {
    const invalid = JSON.stringify({ name: 'Kael', age: -3, traits: ['x'] });
    const backend = new ScriptedBackend('m', [invalid, VALID]);
    const { call, request } = callWith(backend);

    await call.run(request);

    const second = backend.requests[1]?.messages ?? [];
    const assistantTurns = second.filter((message) => message.role === 'assistant');
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0]?.content).toBe(invalid);
  });

  it('sends a different repair message when the output was not JSON at all', async () => {
    const backend = new ScriptedBackend('m', ['I cannot do that.', VALID]);
    const { call, request } = callWith(backend);

    await call.run(request);

    const repairTurn = backend.requests[1]?.messages.at(-1);
    expect(repairTurn?.content).toMatch(/not valid JSON/);
  });

  it('honours the repair budget and stops asking', async () => {
    const invalid = JSON.stringify({ name: 'Kael', age: -1, traits: ['x'] });
    const backend = new ScriptedBackend('m', [invalid, invalid, invalid, invalid, invalid]);
    const { call, request } = callWith(backend);

    const result = await call.run({ ...request, maxRepairs: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Initial attempt plus two repairs.
    expect(result.error.trace.attempts).toBe(3);
    expect(result.error.trace.repairTurns).toBe(2);
  });

  it('allows the budget to be set to zero for a single-shot call', async () => {
    const invalid = JSON.stringify({ name: 'Kael', age: -1, traits: ['x'] });
    const backend = new ScriptedBackend('m', [invalid, VALID]);
    const { call, request } = callWith(backend);

    const result = await call.run({ ...request, maxRepairs: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.trace.attempts).toBe(1);
  });
});

describe('escalation', () => {
  it('moves to the next backend once the repair budget is spent', async () => {
    const invalid = JSON.stringify({ name: '', age: 1, traits: [] });
    const weak = new ScriptedBackend('ollama:qwen3.5', [invalid, invalid, invalid]);
    const strong = new ScriptedBackend('openrouter:z-ai/glm-5.2:free', [VALID]);
    const { call, request } = callWith(weak, strong);

    const result = await call.run({ ...request, maxRepairs: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.trace).toMatchObject({
      resolution: 'escalated',
      escalatedTo: 'openrouter:z-ai/glm-5.2:free',
      modelId: 'openrouter:z-ai/glm-5.2:free',
    });
    expect(weak.requests).toHaveLength(2);
    expect(strong.requests).toHaveLength(1);
  });

  it('starts the stronger model on a clean conversation, not the failed one', async () => {
    // Carrying the failures over teaches the better model to imitate them.
    const invalid = 'garbage';
    const weak = new ScriptedBackend('weak', [invalid, invalid]);
    const strong = new ScriptedBackend('strong', [VALID]);
    const { call, request } = callWith(weak, strong);

    await call.run({ ...request, maxRepairs: 1 });

    const strongTurns = strong.requests[0]?.messages ?? [];
    expect(strongTurns.some((message) => message.role === 'assistant')).toBe(false);
  });

  it('moves on immediately when a backend errors, leaving retry policy to the provider', async () => {
    const down = new ScriptedBackend('down', [
      new ProviderError({ message: 'connection refused', provider: 'ollama' }),
    ]);
    const up = new ScriptedBackend('up', [VALID]);
    const { call, request } = callWith(down, up);

    const result = await call.run(request);
    expect(result.ok).toBe(true);
    // One attempt only: the wrapper does not re-send into a failing backend.
    expect(down.requests).toHaveLength(1);
  });

  it('fails with the last error when every backend is exhausted', async () => {
    const a = new ScriptedBackend('a', ['nope']);
    const b = new ScriptedBackend('b', ['also nope']);
    const { call, request } = callWith(a, b);

    const result = await call.run({ ...request, maxRepairs: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.trace.resolution).toBe('failed');
    expect(result.error.trace.errorCode).toBe(result.error.error.code);
    expect(result.error.trace.attempts).toBe(2);
  });

  it('records the failing field paths so a bad model can be diagnosed', async () => {
    const invalid = JSON.stringify({ name: 'x', age: 'thirty', traits: ['a'] });
    const backend = new ScriptedBackend('m', [invalid]);
    const { call, request } = callWith(backend);

    const result = await call.run({ ...request, maxRepairs: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.trace.failedPaths).toContain('$.age');
  });
});

describe('what gets sent to the backend', () => {
  it('always attaches the schema, whether or not the backend enforces it', async () => {
    // Gating this on `enforcesSchema` threw away Ollama's partial GBNF constraint:
    // it reports `false` because it does not enforce *reliably*, not because `format`
    // does nothing. A backend that ignores the field loses nothing by receiving it.
    const enforcing = new ScriptedBackend('enforcing', [VALID], true);
    const loose = new ScriptedBackend('loose', [VALID], false);

    await callWith(enforcing).call.run(callWith(enforcing).request);
    await callWith(loose).call.run(callWith(loose).request);

    expect(enforcing.requests[0]?.jsonSchema).toBeDefined();
    expect(loose.requests[0]?.jsonSchema).toBeDefined();
  });

  it('restates the schema in the prompt when the backend cannot enforce it', async () => {
    const loose = new ScriptedBackend('loose', [VALID], false);
    const { call, request } = callWith(loose);
    await call.run(request);

    const system = loose.requests[0]?.messages[0];
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('You write characters.');
    expect(system?.content).toContain('JSON Schema');
  });

  it('does not waste tokens restating the schema when it is enforced natively', async () => {
    const enforcing = new ScriptedBackend('enforcing', [VALID], true);
    const { call, request } = callWith(enforcing);
    await call.run(request);

    expect(enforcing.requests[0]?.messages[0]?.content).toBe('You write characters.');
  });

  it('defaults temperature to 0 and disables reasoning', async () => {
    // Schema adherence collapses as temperature rises, and a <think> block is one more
    // thing the extractor has to strip.
    const backend = new ScriptedBackend('m', [VALID]);
    const { call, request } = callWith(backend);
    await call.run(request);

    expect(backend.requests[0]).toMatchObject({ temperature: 0, think: false });
  });

  it('honours an explicit temperature', async () => {
    const backend = new ScriptedBackend('m', [VALID]);
    const { call, request } = callWith(backend);
    await call.run({ ...request, temperature: 0.7 });
    expect(backend.requests[0]?.temperature).toBe(0.7);
  });

  it('omits optional fields entirely rather than sending undefined', async () => {
    // `exactOptionalPropertyTypes` is on, and some providers reject an explicit null
    // where they accept an absent key.
    const backend = new ScriptedBackend('m', [VALID]);
    const { call, request } = callWith(backend);
    await call.run(request);

    const sent = backend.requests[0] ?? {};
    expect('maxOutputTokens' in sent).toBe(false);
    expect('signal' in sent).toBe(false);
  });

  it('passes context turns through in order, before the user message', async () => {
    const backend = new ScriptedBackend('m', [VALID]);
    const { call, request } = callWith(backend);
    await call.run({
      ...request,
      context: [
        { role: 'user', content: 'example in' },
        { role: 'assistant', content: 'example out' },
      ],
    });

    const roles = backend.requests[0]?.messages.map((message) => message.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
  });
});

describe('guards and telemetry', () => {
  it('refuses to run with no backend, because that is a wiring bug', async () => {
    const { call, request } = callWith();
    await expect(call.run({ ...request, backends: [] })).rejects.toThrow(/at least one backend/);
  });

  it('measures elapsed time from the injected clock, never the wall clock', async () => {
    const backend = new ScriptedBackend('m', [VALID]);
    const logger = new MemoryLogger();
    const clock = new FixedClock(instant(5_000));
    const call = new StructuredCall({ clock, logger });

    const result = await call.run({
      schemaName: 'Character',
      schema: Character,
      backends: [backend],
      user: 'go',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The clock never advanced, so the measurement is exactly zero - deterministic.
    expect(result.value.trace.totalLatencyMs).toBe(0);
  });

  it('logs an error naming the schema when every backend is exhausted', async () => {
    const backend = new ScriptedBackend('m', ['nope']);
    const { call, logger, request } = callWith(backend);

    await call.run({ ...request, maxRepairs: 0 });

    const errors = logger.at('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields).toMatchObject({ schema: 'Character' });
  });

  it('works without an injected logger or clock', async () => {
    const backend = new ScriptedBackend('m', [VALID]);
    const result = await new StructuredCall().run({
      schemaName: 'Character',
      schema: Character,
      backends: [backend],
      user: 'go',
    });
    expect(result.ok).toBe(true);
  });
});
