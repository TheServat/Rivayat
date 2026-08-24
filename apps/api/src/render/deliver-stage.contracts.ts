/**
 * What S11 Deliver takes.
 *
 * Almost nothing, and that is the point: everything a delivery needs was decided
 * earlier and recorded. The master comes from the render this run already did, the
 * shots come from the choreography record filed beside the composition, and the crops
 * are solved rather than authored. A payload that had to restate any of that would be a
 * second place for it to be wrong.
 *
 * `formats` defaults to all seven because seven deliverables from one composition *is*
 * the product (architecture §7). A caller that wants three says three; a caller that
 * says nothing gets the thing the pipeline exists to produce.
 */

import { FORMAT_PRESETS, FormatProfileId, NonEmptyString, Sha256Hex } from '@rv/contracts';
import { z } from 'zod';

/** Every profile this build can cut. Data from the contract, never a second list. */
export const DELIVERABLE_FORMATS: readonly FormatProfileId[] = Object.keys(
  FORMAT_PRESETS,
) as FormatProfileId[];

export const DeliverStageRequest = z.strictObject({
  formats: z
    .array(FormatProfileId)
    .min(1)
    .default([...DELIVERABLE_FORMATS])
    .describe('Delivery targets. Each is a transcode of one master through a solved crop.'),
  /**
   * The render to cut from. Defaults to the one this run produced.
   *
   * A content address rather than a run id, so a delivery can be re-run against a
   * master somebody else rendered - which is the same property that lets a killed
   * render resume in a different process.
   */
  renderKey: NonEmptyString.max(200).optional(),
  /**
   * The master, workspace-relative, when there is no manifest to read it from.
   *
   * An escape hatch rather than the normal path: S10 writes a manifest carrying the
   * *measured* size of what it produced, and the crop is expressed in fractions of that
   * frame. Naming the file by hand means naming a size by hand too, and a wrong one
   * crops the wrong rectangle.
   */
  masterPath: NonEmptyString.max(400).optional(),
  /** The composition, for locating the subject. Defaults to this run's own. */
  compositionId: Sha256Hex.optional(),
  /**
   * Where the files go, workspace-relative. Defaults to `deliveries/<renderKey>`.
   *
   * Under the render's own address by default, so the seven files sit beside the master
   * they were cut from and a second delivery of the same master lands in the same place.
   */
  outputDir: NonEmptyString.max(400).optional(),
  maxPanPerSecond: z
    .number()
    .positive()
    .max(2)
    .optional()
    .describe('Ceiling on crop travel, as a fraction of the composition per second.'),
  /**
   * Compare the measured bitrate against the profile's declared range.
   *
   * On by default here, unlike the validator's own default, because a delivery *is*
   * bitrate-targeted: `deliverySettings` aims at the middle of the platform's range, so
   * a file that lands outside it is a real observation. It is reported as a warning
   * either way - a static scene legitimately encodes below the floor - so it informs
   * without failing anything.
   */
  checkBitrate: z.boolean().default(true),
});
export type DeliverStageRequest = z.infer<typeof DeliverStageRequest>;
