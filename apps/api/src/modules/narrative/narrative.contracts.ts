/**
 * The narrative surface takes `@rv/contracts` schemas directly wherever it can.
 *
 * `Scene` and `MemoryRetrievalRequest` are already exactly what the port consumes, so
 * there is nothing to wrap. This file exists to make that a deliberate statement rather
 * than an omission - and to give the OpenAPI emitter one place to name the schemas from.
 */

import { MemoryRetrievalRequest, Slug } from '@rv/contracts';
import type { z } from 'zod';

export const RetrieveMemoryBody = MemoryRetrievalRequest;
export type RetrieveMemoryBody = z.infer<typeof RetrieveMemoryBody>;

/**
 * A variant key in the path, validated as the `Slug` it is.
 *
 * Not a bare string: the variant key is half of the asset dedup key
 * (`semanticKey + styleChecksum + variantKey + specHash`), so a path segment that is not
 * a legal slug names a cell that could never have been generated - and answering 404 for
 * it is a slower way of saying the same thing than refusing it here.
 */
export const VariantKeyParam = Slug;
export type VariantKeyParam = z.infer<typeof VariantKeyParam>;
