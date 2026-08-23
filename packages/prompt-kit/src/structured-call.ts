/**
 * `StructuredCall` - the only sanctioned way to ask a model for JSON.
 *
 * The rule exists because of a measured defect, not a hypothetical one: Ollama accepts
 * a JSON Schema for `qwen3.5` and `gemma4` and then does not enforce it
 * (docs/00-research.md §1, ollama#15540). A caller that trusts `format:` gets a
 * markdown-fenced object, a schema-violating object, or prose - intermittently, which
 * is worse than always.
 *
 * So every structured request goes through one loop:
 *
 *     send → extract → validate → repair (bounded) → escalate → give up
 *
 * and every trip is recorded. The record is the point as much as the value is: after a
 * few hundred calls the ledger says which models are actually usable for extraction
 * on this machine, which is not something documentation can tell us.
 */

import {
  type AppError,
  type Clock,
  type Logger,
  NoopLogger,
  SystemClock,
  ValidationError,
  type Result,
  err,
  isErr,
  ok,
} from '@rv/shared-kernel';
import { toLlmJsonSchema } from '@rv/contracts';
import type { z } from 'zod';

import type {
  CompletionRequest,
  ImagePayload,
  PromptMessage,
  StructuredBackend,
  TokenUsage,
} from './backend';
import { extractJson, type ExtractionStep } from './json-extract';
import { buildRepairMessage, buildSchemaInstruction } from './repair';

/** Mirrors `StructuredCallResolution` in `@rv/contracts`. */
export type StructuredResolution = 'clean' | 'fence-stripped' | 'repaired' | 'escalated' | 'failed';

/**
 * What the wrapper observed, for the cost/quality ledger.
 *
 * Everything a `StructuredCallOutcome` needs except the fields only the caller knows
 * (`provider`, `task`, `at`) - the caller fills those in when it records the outcome.
 */
export interface StructuredTrace {
  readonly schemaName: string;
  readonly resolution: StructuredResolution;
  /** Model that produced the accepted value, or the last one tried on failure. */
  readonly modelId: string;
  readonly attempts: number;
  readonly repairTurns: number;
  readonly fenceStripped: boolean;
  readonly usedNativeSchemaEnforcement: boolean;
  readonly escalatedTo: string | null;
  readonly failedPaths: readonly string[];
  readonly errorCode: string | null;
  readonly totalLatencyMs: number;
  readonly costNanoUsd: number;
  readonly usage: TokenUsage;
  readonly extractionSteps: readonly ExtractionStep[];
}

export interface StructuredSuccess<T> {
  readonly value: T;
  readonly trace: StructuredTrace;
}

export interface StructuredFailure {
  readonly error: AppError;
  readonly trace: StructuredTrace;
}

export interface StructuredRequest<T> {
  /** Names the shape in logs and in the ledger, e.g. `CharacterSheet`. */
  readonly schemaName: string;
  readonly schema: z.ZodType<T>;
  /**
   * Ordered chain. The first entry is the primary; each subsequent one is tried after
   * the previous exhausts its repair budget. Put the cheap local model first.
   */
  readonly backends: readonly StructuredBackend[];
  readonly system?: string;
  readonly user: string;
  /**
   * Images the user turn should carry.
   *
   * Vision scoring and style derivation both look at pictures, and routing them
   * through `context` as a separate turn is a workaround, not a design - the model
   * reads them as prior conversation rather than as the thing being asked about.
   */
  readonly images?: readonly ImagePayload[];
  /** Extra turns placed before the user message - few-shot examples, prior context. */
  readonly context?: readonly PromptMessage[];
  /** Repair turns allowed per backend before escalating. Default 2. */
  readonly maxRepairs?: number;
  /** Default 0: schema adherence collapses as temperature rises. */
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface StructuredCallDeps {
  readonly clock?: Clock;
  readonly logger?: Logger;
}

const DEFAULT_MAX_REPAIRS = 2;

export class StructuredCall {
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(deps: StructuredCallDeps = {}) {
    this.#clock = deps.clock ?? new SystemClock();
    this.#logger = deps.logger ?? new NoopLogger();
  }

  async run<T>(
    request: StructuredRequest<T>,
  ): Promise<Result<StructuredSuccess<T>, StructuredFailure>> {
    if (request.backends.length === 0) {
      throw new ValidationError({ message: 'StructuredCall requires at least one backend' });
    }

    const startedAt = this.#clock.now();
    const maxRepairs = request.maxRepairs ?? DEFAULT_MAX_REPAIRS;

    const accumulator = new TraceAccumulator(request.schemaName);
    let lastError: AppError | undefined;

    for (const [backendIndex, backend] of request.backends.entries()) {
      const isEscalation = backendIndex > 0;
      if (isEscalation) accumulator.noteEscalation(backend.id);

      const jsonSchema = toLlmJsonSchema(request.schema, { dialect: backend.dialect });
      const messages = this.#openingMessages(request, backend, jsonSchema);

      for (let repair = 0; repair <= maxRepairs; repair += 1) {
        accumulator.noteAttempt(backend);

        const response = await backend.complete(
          this.#buildCompletionRequest(request, backend, jsonSchema, messages),
        );

        if (isErr(response)) {
          lastError = response.error;
          this.#logger.warn('structured call: backend failed', {
            schema: request.schemaName,
            model: backend.id,
            code: response.error.code,
          });
          break; // The provider owns retry policy; move to the next backend.
        }

        accumulator.noteUsage(response.value);

        const extraction = extractJson(response.value.text);
        if (isErr(extraction)) {
          lastError = extraction.error;
          if (repair === maxRepairs) break;
          accumulator.noteRepair();
          messages.push(
            { role: 'assistant', content: response.value.text },
            { role: 'user', content: NOT_JSON_REPAIR },
          );
          continue;
        }

        accumulator.noteExtraction(extraction.value.steps);

        const parsed = request.schema.safeParse(extraction.value.value);
        if (parsed.success) {
          const trace = accumulator.succeed(this.#elapsed(startedAt));
          this.#logger.debug('structured call: resolved', {
            schema: request.schemaName,
            model: trace.modelId,
            resolution: trace.resolution,
            attempts: trace.attempts,
          });
          return ok({ value: parsed.data, trace });
        }

        const repairMessage = buildRepairMessage(parsed.error);
        accumulator.noteFailedPaths(repairMessage.paths);
        lastError = new ValidationError({
          message: `${request.schemaName} did not validate: ${String(repairMessage.issueCount)} issue(s)`,
          context: { paths: repairMessage.paths, model: backend.id },
        });

        if (repair === maxRepairs) break;

        accumulator.noteRepair();
        messages.push(
          { role: 'assistant', content: extraction.value.json },
          { role: 'user', content: repairMessage.content },
        );
      }
    }

    const error =
      lastError ??
      new ValidationError({
        message: `${request.schemaName} could not be produced by any backend`,
      });
    const trace = accumulator.fail(this.#elapsed(startedAt), error.code);
    this.#logger.error('structured call: exhausted every backend', {
      schema: request.schemaName,
      attempts: trace.attempts,
      failedPaths: trace.failedPaths,
    });
    return err({ error, trace });
  }

  /**
   * Builds the opening turns.
   *
   * A backend that cannot constrain generation gets the schema restated in the prompt.
   * One that can does not - the tokens buy nothing and the schema is already attached.
   */
  #openingMessages<T>(
    request: StructuredRequest<T>,
    backend: StructuredBackend,
    jsonSchema: Record<string, unknown>,
  ): PromptMessage[] {
    const messages: PromptMessage[] = [];
    const systemParts: string[] = [];
    if (request.system !== undefined) systemParts.push(request.system);
    if (!backend.enforcesSchema) systemParts.push(buildSchemaInstruction(jsonSchema));
    if (systemParts.length > 0) {
      messages.push({ role: 'system', content: systemParts.join('\n\n') });
    }
    if (request.context !== undefined) messages.push(...request.context);
    messages.push(
      request.images === undefined
        ? { role: 'user', content: request.user }
        : { role: 'user', content: request.user, images: request.images },
    );
    return messages;
  }

  #buildCompletionRequest<T>(
    request: StructuredRequest<T>,
    backend: StructuredBackend,
    jsonSchema: Record<string, unknown>,
    messages: readonly PromptMessage[],
  ): CompletionRequest {
    // Built conditionally rather than with `undefined` values: `exactOptionalPropertyTypes`
    // treats a present-but-undefined key as different from an absent one, and some
    // providers reject an explicit null where they accept omission.
    const base: CompletionRequest = {
      messages: [...messages],
      temperature: request.temperature ?? 0,
      // Reasoning wastes tokens on extraction and, on Ollama, leaks a `<think>` block
      // into the response that the extractor then has to strip.
      think: false,
    };
    return {
      ...base,
      // Always sent. A backend that constrains generation uses it; one that does not
      // ignores it. Gating on `enforcesSchema` meant Ollama - which honestly reports
      // `false` because it does not enforce reliably - never received `format` at all,
      // throwing away the partial GBNF constraint it *does* apply.
      jsonSchema,
      ...(request.maxOutputTokens !== undefined
        ? { maxOutputTokens: request.maxOutputTokens }
        : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    };
  }

  #elapsed(startedAt: number): number {
    return Math.max(0, (this.#clock.now() as number) - startedAt);
  }
}

const NOT_JSON_REPAIR = [
  'Your previous response was not valid JSON.',
  'Return the JSON value only: no prose, no explanation, no markdown code fence, no reasoning.',
].join('\n');

/** Accumulates the trace across attempts and backends. Kept separate to keep `run` readable. */
class TraceAccumulator {
  readonly #schemaName: string;
  #attempts = 0;
  #repairTurns = 0;
  #fenceStripped = false;
  #extractionSteps = new Set<ExtractionStep>();
  #failedPaths: readonly string[] = [];
  #modelId = 'unknown';
  #nativeEnforcement = false;
  #escalatedTo: string | null = null;
  #costNanoUsd = 0;
  #usage: { input: number; output: number; cached: number; reasoning: number } = {
    input: 0,
    output: 0,
    cached: 0,
    reasoning: 0,
  };

  constructor(schemaName: string) {
    this.#schemaName = schemaName;
  }

  noteAttempt(backend: StructuredBackend): void {
    this.#attempts += 1;
    this.#modelId = backend.id;
    this.#nativeEnforcement = backend.enforcesSchema;
  }

  noteEscalation(modelId: string): void {
    this.#escalatedTo = modelId;
  }

  noteRepair(): void {
    this.#repairTurns += 1;
  }

  noteUsage(response: { usage?: TokenUsage; costNanoUsd?: number }): void {
    this.#costNanoUsd += response.costNanoUsd ?? 0;
    const usage = response.usage;
    if (usage === undefined) return;
    this.#usage.input += usage.inputTokens;
    this.#usage.output += usage.outputTokens;
    this.#usage.cached += usage.cachedInputTokens ?? 0;
    this.#usage.reasoning += usage.reasoningTokens ?? 0;
  }

  noteExtraction(steps: readonly ExtractionStep[]): void {
    for (const step of steps) {
      this.#extractionSteps.add(step);
      if (step === 'stripped-code-fence') this.#fenceStripped = true;
    }
  }

  noteFailedPaths(paths: readonly string[]): void {
    this.#failedPaths = paths;
  }

  succeed(totalLatencyMs: number): StructuredTrace {
    return this.#build(this.#resolveSuccess(), totalLatencyMs, null);
  }

  fail(totalLatencyMs: number, errorCode: string): StructuredTrace {
    return this.#build('failed', totalLatencyMs, errorCode);
  }

  /**
   * Resolution is reported at its *most serious* level, so the ledger never
   * under-reports how much work a model needed.
   */
  #resolveSuccess(): StructuredResolution {
    if (this.#escalatedTo !== null) return 'escalated';
    if (this.#repairTurns > 0) return 'repaired';
    if (this.#fenceStripped) return 'fence-stripped';
    return 'clean';
  }

  #build(
    resolution: StructuredResolution,
    totalLatencyMs: number,
    errorCode: string | null,
  ): StructuredTrace {
    return {
      schemaName: this.#schemaName,
      resolution,
      modelId: this.#modelId,
      attempts: this.#attempts,
      repairTurns: this.#repairTurns,
      fenceStripped: this.#fenceStripped,
      usedNativeSchemaEnforcement: this.#nativeEnforcement,
      escalatedTo: this.#escalatedTo,
      failedPaths: this.#failedPaths,
      errorCode,
      totalLatencyMs,
      costNanoUsd: this.#costNanoUsd,
      usage: {
        inputTokens: this.#usage.input,
        outputTokens: this.#usage.output,
        cachedInputTokens: this.#usage.cached,
        reasoningTokens: this.#usage.reasoning,
      },
      extractionSteps: [...this.#extractionSteps],
    };
  }
}
