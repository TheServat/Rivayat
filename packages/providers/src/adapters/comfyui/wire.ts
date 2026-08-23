/**
 * ComfyUI's HTTP shapes.
 *
 * Loose throughout: ComfyUI's history entry carries a large `prompt` echo and per-node
 * metadata we have no use for, and a strict schema would reject a perfectly good
 * response because a node type we do not care about grew a field.
 */

import { z } from 'zod';

export const ComfyPromptResponse = z.looseObject({
  prompt_id: z.string(),
  number: z.number().optional(),
  /** Present and non-empty when ComfyUI refused the graph. */
  node_errors: z.record(z.string(), z.unknown()).optional(),
});
export type ComfyPromptResponse = z.infer<typeof ComfyPromptResponse>;

export const ComfyImageRef = z.looseObject({
  filename: z.string(),
  subfolder: z.string().optional(),
  /** `output` | `temp` | `input`. Feeds the `/view` query. */
  type: z.string().optional(),
});
export type ComfyImageRef = z.infer<typeof ComfyImageRef>;

export const ComfyHistoryEntry = z.looseObject({
  status: z
    .looseObject({
      status_str: z.string().optional(),
      completed: z.boolean().optional(),
      messages: z.array(z.unknown()).optional(),
    })
    .optional(),
  /** Keyed by node id; only the nodes that saved something appear. */
  outputs: z
    .record(z.string(), z.looseObject({ images: z.array(ComfyImageRef).optional() }))
    .optional(),
});
export type ComfyHistoryEntry = z.infer<typeof ComfyHistoryEntry>;

/** `GET /history/{id}` is keyed by prompt id, not wrapped. */
export const ComfyHistory = z.record(z.string(), ComfyHistoryEntry);
export type ComfyHistory = z.infer<typeof ComfyHistory>;
