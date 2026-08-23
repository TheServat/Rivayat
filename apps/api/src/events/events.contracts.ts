/**
 * The schemas the events endpoints validate and publish.
 *
 * Path parameters get a schema for the same reason bodies do: `RunId` is a branded
 * `run_<ULID>` in `@rv/contracts`, and a handler that accepts the raw string has
 * widened the type at exactly the boundary the brand exists to guard.
 */

import { RunId } from '@rv/contracts';

/** A run id out of the URL. */
export const RunIdParam = RunId;
