/**
 * Animation documents as the timeline screen consumes them.
 *
 * `AnimationIR` is imported from `@rv/contracts` and used verbatim - it is the render
 * document, the thing `evaluate(ir, t)` takes, and the studio must not hold a second
 * opinion about its shape. The only shape added here is the *index*: a list of
 * animations with the four counts the picker needs, which no upstream schema describes
 * because nothing but a UI has ever needed to list them.
 *
 * ## Endpoints that do not exist yet
 *
 * **None of these routes are implemented in `apps/api`.** There is no animation
 * controller at all: `apps/api/src/modules/` has assets, episodes, health, narrative,
 * pipeline, projects, render, series, settings and style, and an IR is reachable from
 * none of them. They are declared here with the paths a controller should use so that
 * the screen is written against the real shape now and re-points with one import later.
 *
 * | route                        | status | story          |
 * |------------------------------|--------|----------------|
 * | `GET   /animations`          | absent | RV-211         |
 * | `GET   /animations/:id`      | absent | RV-211, RV-212 |
 * | `PATCH /animations/:id/ops`  | absent | RV-146, RV-211 |
 *
 * The third one is blocked twice over: the typed op set it would carry is RV-146, which
 * is also unbuilt, so `features/timeline/ir-ops.ts` applies the same ops in the browser
 * against the loaded IR. That is the right half to build first regardless - a preview
 * that cannot show an edit until the server answers is not a preview - but it means an
 * edit made on this screen is not yet persisted, and the screen says so.
 */

import {
  AnimationId,
  AnimationIR,
  Fps,
  IsoInstant,
  Label,
  NonNegativeInt,
  PositiveInt,
  Size,
} from '@rv/contracts';
import { z } from 'zod';

/**
 * One animation, as the picker lists it.
 *
 * The counts are here rather than derived because deriving them means fetching every
 * IR to draw a menu, and an IR is the largest document in the system.
 */
export const AnimationSummary = z.strictObject({
  id: AnimationId,
  name: Label,
  fps: Fps,
  durationMs: PositiveInt,
  sceneSpace: Size,
  nodeCount: NonNegativeInt,
  trackCount: NonNegativeInt,
  behaviourCount: NonNegativeInt,
  markerCount: NonNegativeInt,
  updatedAt: IsoInstant,
});
export type AnimationSummary = z.infer<typeof AnimationSummary>;

export const AnimationIndex = z.strictObject({
  animations: z.array(AnimationSummary).default([]),
});
export type AnimationIndex = z.infer<typeof AnimationIndex>;

/**
 * Re-exported rather than aliased.
 *
 * `GET /animations/:id` returns the IR itself, and the studio parses it with the
 * contract schema - the same object the API validates with, the same one
 * `evaluate` is typed against. There is no studio-side animation type.
 */
export { AnimationIR };
