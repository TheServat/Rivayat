/**
 * Request bodies for S1.
 *
 * `Brief` and `Sha256Hex` come straight from `@rv/contracts`; the bodies are only the
 * envelopes that name which of them a route takes. Composing contract schemas is not
 * re-declaring them - what non-negotiable #5 forbids is a second definition of the same
 * shape, and there is none here.
 */

import { Brief, Sha256Hex, Slug } from '@rv/contracts';
import { z } from 'zod';

export const FromPresetBody = z.object({
  preset: Slug.describe('Preset name from `GET /api/style/presets`.'),
});
export type FromPresetBody = z.infer<typeof FromPresetBody>;

export const DeriveStyleBody = z.object({
  brief: Brief,
  referenceHashes: z
    .array(Sha256Hex)
    .min(1)
    .max(16)
    .describe(
      'Content hashes of reference images already in the blob store. Hashes rather ' +
        'than bytes: the images are uploaded once and referred to thereafter, which is ' +
        'what makes the derivation cacheable.',
    ),
});
export type DeriveStyleBody = z.infer<typeof DeriveStyleBody>;
