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
  /**
   * Always **true**, and the ports are still request/response.
   *
   * Not a feature: a workaround for a deadline in the HTTP stack. Node's fetch caps the
   * wait for the first response *header* at 300 seconds, and Ollama with `stream: false`
   * sends nothing until generation is complete - so any call taking longer than five
   * minutes failed with `fetch failed`, which reads as a network fault and is not one.
   * Streaming puts the first byte at the start of generation instead of the end.
   *
   * The adapter reassembles the chunks and returns the same `OllamaChatResponse` it
   * always did, so nothing above this file knows the difference.
   */
  readonly stream: true;
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

/**
 * What a streamed `/api/chat` looks like while it is still arriving.
 *
 * Structurally the finished response with everything optional, because that is what the
 * intermediate chunks are: each carries a fragment of `message.content` (or
 * `message.thinking`), and the last one carries `done`, the token counts and the
 * durations. Typed loosely here and validated as `OllamaChatResponse` once complete, so
 * the strictness lands in exactly one place.
 */
export interface OllamaChatChunks {
  model?: string;
  message: { role?: string; content: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

/**
 * Folds one streamed chunk into the response being assembled.
 *
 * Content and thinking are **concatenated**; everything else is overwritten by whatever
 * the latest chunk states. That asymmetry is the whole of the protocol: the text arrives
 * in pieces, the metadata arrives once at the end, and a merge that concatenated the
 * counts would report a token total that is the sum of every partial report of it.
 *
 * `thinking` matters as much as `content` here: on a `format` call some models put the
 * entire schema-conforming answer in the reasoning channel and leave `content` empty,
 * and a merge that dropped it would turn a correct answer into "no content".
 */
export function mergeChatChunk(
  accumulated: OllamaChatChunks | undefined,
  chunk: unknown,
): OllamaChatChunks {
  const base: OllamaChatChunks = accumulated ?? { message: { content: '' } };
  if (typeof chunk !== 'object' || chunk === null) return base;

  const next = chunk as {
    model?: unknown;
    message?: { role?: unknown; content?: unknown; thinking?: unknown };
    done?: unknown;
    done_reason?: unknown;
    prompt_eval_count?: unknown;
    eval_count?: unknown;
    total_duration?: unknown;
  };

  const content = typeof next.message?.content === 'string' ? next.message.content : '';
  const thinking = typeof next.message?.thinking === 'string' ? next.message.thinking : '';
  const merged: OllamaChatChunks = {
    ...base,
    message: {
      ...base.message,
      ...(typeof next.message?.role === 'string' ? { role: next.message.role } : {}),
      content: base.message.content + content,
      ...(thinking.length > 0 ? { thinking: (base.message.thinking ?? '') + thinking } : {}),
    },
  };

  if (typeof next.model === 'string') merged.model = next.model;
  if (typeof next.done === 'boolean') merged.done = next.done;
  if (typeof next.done_reason === 'string') merged.done_reason = next.done_reason;
  if (typeof next.prompt_eval_count === 'number') merged.prompt_eval_count = next.prompt_eval_count;
  if (typeof next.eval_count === 'number') merged.eval_count = next.eval_count;
  if (typeof next.total_duration === 'number') merged.total_duration = next.total_duration;
  return merged;
}
