/**
 * The narrative surface takes `@rv/contracts` schemas directly.
 *
 * `Scene` and `MemoryRetrievalRequest` are already exactly what the port consumes, so
 * there is nothing to wrap. This file exists to make that a deliberate statement rather
 * than an omission - and to give the OpenAPI emitter one place to name the schemas from.
 */

import { MemoryRetrievalRequest } from '@rv/contracts';
import type { z } from 'zod';

export const RetrieveMemoryBody = MemoryRetrievalRequest;
export type RetrieveMemoryBody = z.infer<typeof RetrieveMemoryBody>;
