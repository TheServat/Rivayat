/**
 * Where a run's starting payload lives between the process that started it and the
 * process that resumes it.
 *
 * A separate port rather than two more methods on `RunRepository`, and the reason is
 * the shape of the data rather than tidiness. The payload is whatever the first stage
 * needs - for S10 that is a whole `AnimationIR`, megabytes of it - and `RunSummary` is
 * the document `GET /api/runs/:id` returns and the studio polls. Folding one into the
 * other would put the composition on the wire every time a progress bar moved.
 *
 * It has to be durable, which is the part that is easy to miss. The runner keeps the
 * payload in memory for the life of the run, and that is enough right up until the
 * process is killed - which is precisely the case resume exists for. A run whose
 * payload died with its worker cannot be resumed at all; it can only be started again
 * by a client that still has the request body.
 *
 * Today's adapter is a JSON file under the workspace, the same stopgap
 * `json-file.repositories.ts` documents. It moves to the checkpoint table the moment
 * `@rv/persistence` grows one, and nothing above this interface changes.
 */

import type { RunId } from '@rv/contracts';
import type { Result, Unit } from '@rv/shared-kernel';

export interface RunPayloadStore {
  save(runId: RunId, payload: Record<string, unknown>): Promise<Result<Unit>>;
  /** `null` for a run that was never saved, which a resume must report rather than guess. */
  load(runId: RunId): Promise<Result<Record<string, unknown> | null>>;
}
