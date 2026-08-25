/**
 * Starting a pipeline run from the studio.
 *
 * Until now the studio could see the result of every stage and start none of them. The
 * cast existed only because a seeder wrote it; a character with no state grid said "no
 * states have been defined yet" and offered no way to define any, because the only thing
 * that could was a curl command.
 *
 * `seed` is required by the server and deliberately has no default here either. A run
 * that cannot name its seed cannot be replayed, and replayability is the first
 * non-negotiable - so the caller states it, and the studio shows it, rather than a
 * hidden default deciding what a run meant.
 */

import {
  NanoUsdAmount,
  NonNegativeInt,
  PipelineStageKey,
  ProjectId,
  SeriesId,
} from '@rv/contracts';
import { z } from 'zod';

import { RunSummary } from '../../features/render/render-wire';

export const StartRunBody = z.strictObject({
  projectId: ProjectId,
  seriesId: SeriesId.nullable().default(null),
  /** In pipeline order, no repeats. The server refuses anything else. */
  stages: z.array(PipelineStageKey).min(1),
  seed: NonNegativeInt,
  /** `null` inherits the project and machine layers rather than meaning "unlimited". */
  budgetNanoUsd: NanoUsdAmount.nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type StartRunBody = z.infer<typeof StartRunBody>;

export { RunSummary };
