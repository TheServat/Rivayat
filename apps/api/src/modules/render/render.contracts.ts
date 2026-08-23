/**
 * The render request body.
 *
 * `AnimationIR` travels whole rather than by reference because a render is the one
 * operation that must be reproducible from its input alone (ADR-0001): a request that
 * named an IR by id would render whatever that id points at *now*, which is not the
 * same guarantee.
 */

import { AnimationIR, FormatProfileId } from '@rv/contracts';
import { z } from 'zod';

export const RenderBody = z.object({
  ir: AnimationIR,
  formats: z
    .array(FormatProfileId)
    .min(1)
    .describe('Delivery targets. Each is reframed from the same composition (§7).'),
  outputDir: z
    .string()
    .min(1)
    .describe('Where the master and its reframes are written, under the workspace.'),
});
export type RenderBody = z.infer<typeof RenderBody>;
