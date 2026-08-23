/**
 * Recorded provider response shapes.
 *
 * Every field here appears in the provider's own published API reference. Nothing is
 * invented: a fixture that carries a field the provider never sends makes the adapter
 * pass a test and fail in production, which is worse than having no test.
 *
 * Values (token counts, ids, base64 payloads) are synthetic; *shapes* are not.
 */

import { sha256 } from '@rv/shared-kernel';

/**
 * The smallest thing that is unmistakably a PNG.
 *
 * Only the 8-byte signature matters here - no test in this package decodes pixels
 * (`tools/scripts/comfy-smoke.mjs` is where real pixel assertions live). The trailing
 * bytes exist so two different fixtures hash differently.
 */
export function pngBytes(marker = 1): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker, 0x00, 0xff]);
}

export function pngBase64(marker = 1): string {
  return Buffer.from(pngBytes(marker)).toString('base64');
}

export function pngSha256(marker = 1): string {
  return sha256(pngBytes(marker));
}

// ── Ollama (native API) ─────────────────────────────────────────────────────

export const ollama = {
  /** `POST /api/chat`, `stream: false`. */
  chat(content: string): Record<string, unknown> {
    return {
      model: 'qwen3.5:latest',
      created_at: '2026-08-23T10:12:44.123456789Z',
      message: { role: 'assistant', content },
      done_reason: 'stop',
      done: true,
      total_duration: 1_830_000_000,
      load_duration: 1_200_000,
      prompt_eval_count: 26,
      prompt_eval_duration: 130_000_000,
      eval_count: 42,
      eval_duration: 1_690_000_000,
    };
  },

  /** `POST /api/embed`. Two 4-dimensional vectors; real ones are 768-4096. */
  embed: {
    model: 'qwen3:1.7b',
    embeddings: [
      [0.0102, -0.221, 0.0431, 0.918],
      [-0.0044, 0.317, -0.276, 0.612],
    ],
    total_duration: 14_143_917,
    load_duration: 1_019_500,
    prompt_eval_count: 8,
  } as Record<string, unknown>,

  /** What Ollama returns when the model name is not pulled. */
  modelNotFound: { error: 'model "nope" not found, try pulling it first' } as Record<
    string,
    unknown
  >,
} as const;

// ── Gemini (`generateContent`) ──────────────────────────────────────────────

export const gemini = {
  text(content: string): Record<string, unknown> {
    return {
      candidates: [
        {
          content: { parts: [{ text: content }], role: 'model' },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 31,
        totalTokenCount: 43,
      },
      modelVersion: 'gemini-2.5-flash',
      responseId: 'JmKtaKf7Ncq1qtsPr7Kg8QY',
    };
  },

  /**
   * An image response.
   *
   * `candidatesTokensDetails` carries the modality breakdown, which is where the real
   * image-output token count comes from - 1290 for a ~1K image (research §2).
   */
  image(marker = 1, imageTokens = 1290): Record<string, unknown> {
    return {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Here is the image.' },
              { inlineData: { mimeType: 'image/png', data: pngBase64(marker) } },
            ],
            role: 'model',
          },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 18,
        candidatesTokenCount: imageTokens + 6,
        totalTokenCount: imageTokens + 24,
        candidatesTokensDetails: [
          { modality: 'TEXT', tokenCount: 6 },
          { modality: 'IMAGE', tokenCount: imageTokens },
        ],
      },
      modelVersion: 'gemini-3.1-flash-lite-image',
      responseId: 'ZmKtaKf7Ncq1qtsPr7Kg8QZ',
    };
  },

  /** A refusal: a candidate with no parts at all. */
  refused: {
    candidates: [{ content: { role: 'model' }, finishReason: 'IMAGE_SAFETY', index: 0 }],
    usageMetadata: { promptTokenCount: 18, totalTokenCount: 18 },
    modelVersion: 'gemini-3.1-flash-lite-image',
  } as Record<string, unknown>,

  /** The Google API error envelope. */
  error(code: number, status: string, message: string): Record<string, unknown> {
    return { error: { code, message, status } };
  },
} as const;

// ── OpenRouter (OpenAI-compatible) ──────────────────────────────────────────

export const openrouter = {
  chat(content: string): Record<string, unknown> {
    return {
      id: 'gen-1756000000-AbCdEfGhIjKlMnOp',
      provider: 'Google',
      model: 'google/gemma-4-31b-it:free',
      object: 'chat.completion',
      created: 1_756_000_000,
      choices: [
        {
          logprobs: null,
          finish_reason: 'stop',
          native_finish_reason: 'stop',
          index: 0,
          message: { role: 'assistant', content, refusal: null, reasoning: null },
        },
      ],
      usage: { prompt_tokens: 14, completion_tokens: 27, total_tokens: 41 },
    };
  },

  image(marker = 1): Record<string, unknown> {
    return {
      id: 'gen-1756000001-QrStUvWxYzAbCdEf',
      provider: 'Google AI Studio',
      model: 'google/gemini-2.5-flash-image',
      object: 'chat.completion',
      created: 1_756_000_001,
      choices: [
        {
          finish_reason: 'stop',
          native_finish_reason: 'STOP',
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            images: [
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${pngBase64(marker)}` },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 21, completion_tokens: 1290, total_tokens: 1311 },
    };
  },

  /** OpenRouter reports some upstream failures inside a 200 body. */
  embeddedError: {
    id: 'gen-1756000002-ZzZzZzZz',
    choices: [],
    error: { code: 503, message: 'No instances available for this model' },
  } as Record<string, unknown>,

  /**
   * `GET /api/v1/models`.
   *
   * Three entries: two from the `:free` pool that research §1 names, and one paid
   * image model. Prices are per **token** here, which is the unit conversion the
   * reconciler has to get right.
   */
  models: {
    data: [
      {
        id: 'z-ai/glm-5.2:free',
        canonical_slug: 'z-ai/glm-5.2',
        hugging_face_id: '',
        name: 'GLM 5.2 (free)',
        created: 1_750_000_000,
        description: 'Free endpoint for GLM 5.2.',
        context_length: 256_000,
        architecture: {
          modality: 'text->text',
          input_modalities: ['text'],
          output_modalities: ['text'],
          tokenizer: 'Other',
          instruct_type: null,
        },
        pricing: {
          prompt: '0',
          completion: '0',
          request: '0',
          image: '0',
          web_search: '0',
          internal_reasoning: '0',
        },
        top_provider: { context_length: 256_000, max_completion_tokens: null, is_moderated: false },
        per_request_limits: null,
        supported_parameters: ['max_tokens', 'temperature', 'seed', 'response_format'],
      },
      {
        id: 'google/gemma-4-31b-it:free',
        canonical_slug: 'google/gemma-4-31b-it',
        hugging_face_id: 'google/gemma-4-31b-it',
        name: 'Google: Gemma 4 31B (free)',
        created: 1_752_000_000,
        description: 'Free vision-capable Gemma endpoint.',
        context_length: 131_072,
        architecture: {
          modality: 'text+image->text',
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
          tokenizer: 'Gemini',
          instruct_type: null,
        },
        pricing: {
          prompt: '0',
          completion: '0',
          request: '0',
          image: '0',
          web_search: '0',
          internal_reasoning: '0',
        },
        top_provider: { context_length: 131_072, max_completion_tokens: 8192, is_moderated: false },
        per_request_limits: null,
        supported_parameters: ['max_tokens', 'temperature', 'response_format'],
      },
      {
        id: 'google/gemini-2.5-flash-image',
        canonical_slug: 'google/gemini-2.5-flash-image',
        hugging_face_id: '',
        name: 'Google: Gemini 2.5 Flash Image',
        created: 1_753_000_000,
        description: 'Image generation and editing.',
        context_length: 32_768,
        architecture: {
          modality: 'text+image->text+image',
          input_modalities: ['text', 'image'],
          output_modalities: ['text', 'image'],
          tokenizer: 'Gemini',
          instruct_type: null,
        },
        pricing: {
          prompt: '0.0000003',
          completion: '0.0000025',
          request: '0',
          image: '0.001238',
          web_search: '0',
          internal_reasoning: '0',
        },
        top_provider: { context_length: 32_768, max_completion_tokens: 8192, is_moderated: false },
        per_request_limits: null,
        supported_parameters: ['max_tokens', 'temperature', 'seed'],
      },
    ],
  } as Record<string, unknown>,
} as const;

// ── ComfyUI ─────────────────────────────────────────────────────────────────

export const COMFY_PROMPT_ID = 'e6a1b3d4-7c22-4f0a-9c6e-2b1d5f8a0011';

export const comfy = {
  queued: { prompt_id: COMFY_PROMPT_ID, number: 1, node_errors: {} } as Record<string, unknown>,

  rejected: {
    error: {
      type: 'prompt_outputs_failed_validation',
      message: 'Prompt outputs failed validation',
    },
    node_errors: {
      '1': {
        errors: [
          { type: 'value_not_in_list', message: 'Value not in list', details: 'ckpt_name: nope' },
        ],
      },
    },
  } as Record<string, unknown>,

  /** Still executing: the entry exists but nothing has completed. */
  pending: {} as Record<string, unknown>,

  completed(filename = 'rivayat_00001_.png'): Record<string, unknown> {
    return {
      [COMFY_PROMPT_ID]: {
        prompt: [1, COMFY_PROMPT_ID, {}, { client_id: 'rivayat' }, ['9']],
        outputs: { '9': { images: [{ filename, subfolder: '', type: 'output' }] } },
        status: {
          status_str: 'success',
          completed: true,
          messages: [['execution_start', { prompt_id: COMFY_PROMPT_ID }]],
        },
        meta: {},
      },
    };
  },

  failed: {
    [COMFY_PROMPT_ID]: {
      status: {
        status_str: 'error',
        completed: false,
        messages: [
          [
            'execution_error',
            { prompt_id: COMFY_PROMPT_ID, node_type: 'KSampler', exception_message: 'OOM' },
          ],
        ],
      },
    },
  } as Record<string, unknown>,

  uploaded: { name: 'rivayat-base.png', subfolder: '', type: 'input' } as Record<string, unknown>,
} as const;
