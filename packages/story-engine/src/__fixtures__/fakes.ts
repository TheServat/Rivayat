/**
 * Fake backends. No socket is opened anywhere in this package's tests.
 *
 * The fake records every `CompletionRequest` it is handed, which is what makes the most
 * valuable test in the package possible: asserting on the *actual prompt text* an actor
 * was sent, rather than on a mock's call count. A test that checks "three actor calls were
 * made" would still pass if all three were handed the omniscient view.
 *
 * Scripting is a queue, so one fake can be told to return malformed output, then
 * schema-violating output, then something valid - which is exactly the sequence
 * `StructuredCall`'s repair loop exists for and the only way to prove it runs.
 */

import type { SchemaDialect } from '@rv/contracts';
import type { CompletionRequest, CompletionResponse, StructuredBackend } from '@rv/prompt-kit';
import { type AppError, ProviderError, type Result, err, ok } from '@rv/shared-kernel';

export type ScriptedResponse =
  | { readonly kind: 'json'; readonly value: unknown }
  /** Raw text, for the not-JSON and fenced-JSON paths. */
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'error'; readonly error: AppError };

/** Valid JSON of the right shape. */
export function respondJson(value: unknown): ScriptedResponse {
  return { kind: 'json', value };
}

/** Prose where JSON was asked for. Drives the "not JSON" repair turn. */
export function respondText(text: string): ScriptedResponse {
  return { kind: 'text', text };
}

/** Well-formed JSON that violates the schema. Drives the validation repair turn. */
export function respondInvalid(value: unknown): ScriptedResponse {
  return { kind: 'json', value };
}

export function respondError(message = 'the fake provider is down'): ScriptedResponse {
  return { kind: 'error', error: new ProviderError({ provider: 'fake', message }) };
}

export interface FakeBackendOptions {
  readonly id?: string;
  readonly enforcesSchema?: boolean;
  readonly dialect?: SchemaDialect;
  /** Consumed in order. When exhausted, `fallback` is used. */
  readonly script?: readonly ScriptedResponse[];
  /**
   * What to return once the script runs out.
   *
   * Defaults to an error, so a test that makes one more call than it scripted fails loudly
   * instead of quietly reusing the last answer.
   */
  readonly fallback?: ScriptedResponse;
}

export class FakeStructuredBackend implements StructuredBackend {
  readonly id: string;
  readonly enforcesSchema: boolean;
  readonly dialect: SchemaDialect;
  /** Every request, in order. The assertion surface. */
  readonly requests: CompletionRequest[] = [];

  readonly #script: ScriptedResponse[];
  readonly #fallback: ScriptedResponse;

  constructor(options: FakeBackendOptions = {}) {
    this.id = options.id ?? 'fake:primary';
    this.enforcesSchema = options.enforcesSchema ?? true;
    this.dialect = options.dialect ?? 'plain';
    this.#script = [...(options.script ?? [])];
    this.#fallback = options.fallback ?? respondError('the fake backend ran out of script');
  }

  complete(request: CompletionRequest): Promise<Result<CompletionResponse, AppError>> {
    this.requests.push(request);
    const scripted = this.#script.shift() ?? this.#fallback;

    if (scripted.kind === 'error') return Promise.resolve(err(scripted.error));

    const text = scripted.kind === 'json' ? JSON.stringify(scripted.value) : scripted.text;
    return Promise.resolve(
      ok({
        text,
        modelId: this.id,
        usage: { inputTokens: 100, outputTokens: 50 },
        costNanoUsd: 1_000,
      }),
    );
  }

  /** How many times this backend was called. */
  get callCount(): number {
    return this.requests.length;
  }

  /** Everything sent on call `index`, system and user turns joined. */
  promptAt(index: number): string {
    const request = this.requests[index];
    if (request === undefined) throw new Error(`no request at index ${String(index)}`);
    return request.messages.map((message) => message.content).join('\n\n');
  }

  /** Only the user turns of call `index`. */
  userPromptAt(index: number): string {
    const request = this.requests[index];
    if (request === undefined) throw new Error(`no request at index ${String(index)}`);
    return request.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n\n');
  }

  systemPromptAt(index: number): string {
    const request = this.requests[index];
    if (request === undefined) throw new Error(`no request at index ${String(index)}`);
    return request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
  }

  /** Every prompt this backend saw, for a sweep across all of them. */
  get allPrompts(): readonly string[] {
    return this.requests.map((_, index) => this.promptAt(index));
  }
}
