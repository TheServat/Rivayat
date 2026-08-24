/**
 * Starting a delivery, in the vocabulary the screen actually has.
 *
 * A delivery *is* a run - `POST /api/runs` with `stages: ['deliver']` and a `deliver`
 * payload says the same thing - and this route exists because that sentence requires
 * knowing two things the Render screen does not: the shape of a stage payload, and the
 * render key. What the screen has is a run that finished, and a button.
 *
 * So `runId` is the normal path and `renderKey` is the escape hatch. The key is
 * resolved from the run's own artefacts, which is the same lookup
 * `GET /api/runs/:id/delivery` does, so the two routes cannot disagree about which
 * master a run produced.
 *
 * `seed` is present, defaulted, and does nothing - deliberately. A run record cannot
 * exist without one (non-negotiable #1: a run that cannot name its seed cannot be
 * replayed), and a delivery has nothing to seed: no provider, no generation, no RNG,
 * seven transcodes of a file that already exists. Recording 0 says that; inventing a
 * random one would imply a randomness that is not there.
 */

import {
  FormatProfileId,
  NanoUsdAmount,
  NonEmptyString,
  NonNegativeInt,
  ProjectId,
  RunId,
  SeriesId,
} from '@rv/contracts';
import { z } from 'zod';

import { DELIVERABLE_FORMATS } from '../../render/deliver-stage.contracts';

export const StartDeliveryBody = z
  .strictObject({
    projectId: ProjectId,
    seriesId: SeriesId.nullable().default(null),
    /** The run whose master is being delivered. Its render key is looked up. */
    runId: RunId.optional(),
    /** The master's content address, for delivering something this API did not run. */
    renderKey: NonEmptyString.max(200).optional(),
    formats: z
      .array(FormatProfileId)
      .min(1)
      .default([...DELIVERABLE_FORMATS])
      .describe('Delivery targets. Defaults to all seven, which is the product.'),
    outputDir: NonEmptyString.max(400).optional(),
    maxPanPerSecond: z.number().positive().max(2).optional(),
    checkBitrate: z.boolean().default(true),
    /** Nothing in a delivery is random. See the file header for why it is here at all. */
    seed: NonNegativeInt.default(0),
    budgetNanoUsd: NanoUsdAmount.nullable().default(null),
  })
  .superRefine((body, ctx) => {
    // Exactly one, for the same reason a render names its composition once: two sources
    // for one fact means the resolution order silently decides which master shipped.
    const named = (body.runId === undefined ? 0 : 1) + (body.renderKey === undefined ? 0 : 1);
    if (named !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['runId'],
        message: 'name the master either by `runId` or by `renderKey`, and not both',
      });
    }
  });
export type StartDeliveryBody = z.infer<typeof StartDeliveryBody>;
