/**
 * The health report, as a schema.
 *
 * A schema rather than an interface because the OpenAPI document is emitted from these
 * (non-negotiable #5) and `/api/health` is the endpoint a deployment checks first - a
 * response shape that drifted from its documentation would be found by a monitoring
 * system at three in the morning.
 */

import { z } from 'zod';

export const HealthReport = z.object({
  status: z.enum(['ok', 'degraded']),
  env: z.enum(['development', 'test', 'production']),
  database: z.object({
    location: z.string().describe('Resolved on-disk path, or ":memory:".'),
    reachable: z.boolean(),
    error: z.string().optional(),
  }),
  queue: z.object({
    driver: z.enum(['bullmq', 'in-process']),
    concurrency: z.number().int(),
    /** Highest simultaneous job count observed. The ceiling, checked against itself. */
    peakConcurrency: z.number().int(),
  }),
  providers: z.object({
    registered: z.array(z.string()).describe('`provider:model` for every wired adapter.'),
    skipped: z.array(z.object({ provider: z.string(), reason: z.string() })),
  }),
  pipeline: z.object({
    implementedStages: z
      .array(z.string())
      .describe('Stages this build can execute. The rest return 501.'),
  }),
});
export type HealthReport = z.infer<typeof HealthReport>;
