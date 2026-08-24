/**
 * What S1 needs on a run's payload.
 *
 * Two ways in, exactly one of which must be present: a preset off the shelf, or an id
 * naming a bible some earlier request already made (`POST /api/style/from-preset` or
 * `/derive`). There is no third door here on purpose - deriving from references inside a
 * pipeline run would need the reference bytes on the payload, and a run payload is
 * carried through the queue and the payload store on every stage.
 *
 * **Why the stage does not hand its id to the next stage.** A run's payload is fixed
 * when the run starts and passed to every stage unchanged (see `PipelineRunner`), so S1
 * cannot write `styleBibleId` where S5 will read it. That is a property of the runner
 * rather than of this stage, and the honest consequence is spelled out rather than
 * worked around: a run that wants `[style, resolve, produce]` puts the id on the payload
 * once, and S1 uses the bible that id names instead of minting a second one. A run given
 * only a preset gets a fresh bible and reports its id as an artifact, which is the right
 * answer for a run whose only job is to establish a style.
 */

import { Slug, StyleBibleId } from '@rv/contracts';
import { z } from 'zod';

import { StyleProbeLane } from '../modules/style/style.contracts';

export const StyleStageRequest = z
  .object({
    styleBibleId: StyleBibleId.optional().describe(
      'An existing bible. Present with `preset`, it is the id the preset is materialised ' +
        'under, which is how a multi-stage run names its style before it exists.',
    ),
    preset: Slug.optional().describe('A preset id from `GET /api/style/presets`.'),
    /**
     * Whether to draw the sheet, and on which lane.
     *
     * `false` is a real answer and not a shortcut: a replay of a run whose style was
     * already approved should not redraw four tiles, and on the paid lane it should
     * certainly not re-spend for them.
     */
    probe: z.union([z.literal(false), StyleProbeLane]).default('free'),
    /**
     * Whether to freeze the checksum at the end of the stage.
     *
     * Defaults to true because every stage after this one refuses an unlocked bible -
     * `assertUsableForGeneration` is the guard in front of every image generation - so a
     * run that produced assets would fail at S6 with a message about a lock nobody was
     * asked for. A run that only wants a candidate to look at sets it false.
     */
    lock: z.boolean().default(true),
  })
  .superRefine((request, ctx) => {
    if (request.styleBibleId === undefined && request.preset === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['preset'],
        message:
          'S1 needs either a `preset` to materialise or a `styleBibleId` to use; it has neither',
      });
    }
  });
export type StyleStageRequest = z.infer<typeof StyleStageRequest>;
