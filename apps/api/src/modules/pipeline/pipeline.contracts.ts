/**
 * The run surface's request shapes.
 *
 * `seed` is required and has no default, for the reason `PipelineRun` in
 * `@rv/contracts` gives: non-negotiable #1 makes runs replayable, and a run that cannot
 * name the seed it fed `createRng` cannot be replayed. Defaulting it here would make
 * every API-started run unreproducible while looking convenient.
 *
 * `stages` must be in pipeline order with no repeats. Out of order is not a scheduling
 * preference - it is two mutually exclusive claims about what the pipeline is - and a
 * repeated stage silently doubles that stage's cost estimate.
 */

import {
  NanoUsdAmount,
  NonNegativeInt,
  PIPELINE_STAGE_CODES,
  PipelineStageKey,
  ProjectId,
  RunId,
  SeriesId,
} from '@rv/contracts';
import { z } from 'zod';

/** Execution order, derived from the published `S<n>` codes rather than retyped. */
const STAGE_ORDER: readonly PipelineStageKey[] = Object.keys(
  PIPELINE_STAGE_CODES,
) as PipelineStageKey[];

function stageIndex(stage: PipelineStageKey): number {
  return STAGE_ORDER.indexOf(stage);
}

export const StartRunBody = z
  .object({
    projectId: ProjectId,
    seriesId: SeriesId.nullable().default(null),
    stages: z
      .array(PipelineStageKey)
      .min(1)
      .max(STAGE_ORDER.length)
      .describe('The stages to execute, in pipeline order, no repeats.'),
    seed: NonNegativeInt.describe(
      'Seed for every deterministic decision in the run. Required: a run that cannot ' +
        'name its seed cannot be replayed (non-negotiable #1).',
    ),
    budgetNanoUsd: NanoUsdAmount.nullable()
      .default(null)
      .describe('Ceiling for this run. `null` inherits the project and machine layers.'),
    payload: z
      .record(z.string(), z.unknown())
      .default({})
      .describe('Whatever the first stage needs - a `brief` for S0, specs for S5.'),
  })
  .superRefine((body, ctx) => {
    const positions = body.stages.map(stageIndex);
    const misordered = positions.some(
      (position, index) => index > 0 && position <= (positions[index - 1] ?? -1),
    );
    if (misordered) {
      ctx.addIssue({
        code: 'custom',
        path: ['stages'],
        message: `stages must be in pipeline order with no repeats, got [${body.stages.join(', ')}]`,
      });
    }
  });
export type StartRunBody = z.infer<typeof StartRunBody>;

export const RunIdParam = RunId;
export const ProjectIdParam = ProjectId;

/**
 * The optional narrowing on `GET /api/projects/:projectId/cost`.
 *
 * A schema rather than a raw string for the same reason a path parameter gets one:
 * `SeriesId` is a branded `ser_<ULID>`, and a handler that accepted any string would
 * silently return the whole project's report for a typo.
 */
export const CostReportQuery = z.object({
  seriesId: SeriesId.optional(),
});
export type CostReportQuery = z.infer<typeof CostReportQuery>;
