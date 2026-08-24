/**
 * Ollama's native wire shapes, as Zod schemas.
 *
 * The responses are validated rather than cast for a specific reason: research §1
 * records that `qwen3.5`/`gemma4` return schema-violating payloads, and an adapter
 * that casts would hand a `content: undefined` straight to `JSON.parse` and blame the
 * model for a `TypeError`. Validating here means the failure is a typed
 * `ProviderError` naming the field that was missing.
 *
 * Only the fields we actually read are declared; `loose` object shapes let Ollama add
 * anything else without breaking us.
 */

import { z } from 'zod';

export const OllamaChatResponse = z.looseObject({
  model: z.string().optional(),
  message: z.looseObject({
    role: z.string().optional(),
    content: z.string(),
    /**
     * The reasoning channel - and, on a `format` call, sometimes the *answer*.
     *
     * Measured on 2026-08-23 against Ollama 0.32.15 and `qwen3-vl:2b`: the same prompt
     * with no `format` returns the answer in `content` and the reasoning in `thinking`,
     * and with a `format` schema returns `content: ""` and the **complete, valid,
     * schema-conforming JSON** in `thinking` - with `think: false` on the request either
     * way. Reading only `content` therefore turns a correct answer into
     * "model returned no content", which is what took the quality gate down on every
     * small vision model. See `schemaConstrainedText`.
     */
    thinking: z.string().optional(),
  }),
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
  /** Input tokens. Absent when the whole prompt was served from Ollama's cache. */
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
  total_duration: z.number().optional(),
});
export type OllamaChatResponse = z.infer<typeof OllamaChatResponse>;

export const OllamaEmbedResponse = z.looseObject({
  model: z.string().optional(),
  embeddings: z.array(z.array(z.number())),
  prompt_eval_count: z.number().optional(),
  total_duration: z.number().optional(),
});
export type OllamaEmbedResponse = z.infer<typeof OllamaEmbedResponse>;

/** One turn on the way out. `images` is base64, and only present for a vision call. */
export interface OllamaChatMessage {
  readonly role: string;
  readonly content: string;
  readonly images?: readonly string[];
}

export interface OllamaChatRequest {
  readonly model: string;
  readonly messages: readonly OllamaChatMessage[];
  /** Always false: the ports are request/response, and streaming has no caller yet. */
  readonly stream: false;
  /**
   * The JSON Schema, passed to the **native** endpoint.
   *
   * This is mitigation #1 from research §1. Ollama compiles it to a GBNF grammar; the
   * OpenAI-compatible shim does not, which is the defect. It is still not trusted -
   * `enforcesSchema` is reported as `false` and `StructuredCall` validates regardless.
   */
  readonly format?: Record<string, unknown>;
  /** Mitigation #2: reasoning off for extraction, or `<think>` leaks into the JSON. */
  readonly think: boolean;
  readonly options: {
    readonly temperature: number;
    readonly num_predict?: number;
    readonly seed?: number;
    readonly stop?: readonly string[];
  };
}

export interface OllamaEmbedRequest {
  readonly model: string;
  readonly input: readonly string[];
}
