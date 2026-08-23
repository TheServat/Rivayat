/**
 * The projects surface's shapes.
 *
 * `Project` (in `application/resources.ts`) is the *aggregate* - what a write produces
 * and what `GET /projects/:id` answers. `ProjectSummary` below is the **read model** the
 * list screen needs, and the two are deliberately different: a list wants a spend total
 * and an episode count, which the aggregate does not carry, and does not want the full
 * description, which it does.
 *
 * **This shape is mirrored, not invented.** It is `ProjectSummary` in
 * `apps/web/src/api/schemas/pending-contracts.ts`, field for field, and that file is the
 * definition. The studio may not import from `apps/api` - the dependency rule points
 * inward and `apps/web` ships no server code - and `@rv/contracts` genuinely has no
 * `Project` schema at all: it has a `ProjectId` that identifies nothing.
 *
 * **Report:** `Project` and `ProjectSummary` both belong in `@rv/contracts`, so this
 * mirror can be deleted. Until then, the two copies are kept identical by the pair of
 * `strictObject`s either side of the wire: the API parses what it sends and the studio
 * parses what it receives, so a drift fails loudly at the boundary rather than silently
 * in a component.
 */

import {
  IsoInstant,
  Label,
  Locale,
  NanoUsdAmount,
  NonEmptyString,
  ProjectId,
  StyleBibleId,
} from '@rv/contracts';
import { z } from 'zod';

import { Project } from '../../application/resources';

export const CreateProjectRequest = Project.pick({
  name: true,
  description: true,
  budgetNanoUsd: true,
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const UpdateProjectRequest = Project.pick({
  name: true,
  description: true,
  styleBibleId: true,
  budgetNanoUsd: true,
}).partial();
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

export const ProjectIdParam = ProjectId;

/** A project as the list screen needs it. */
export const ProjectSummary = z.strictObject({
  id: ProjectId,
  name: Label,
  /** Author's own one line. Optional: a project can exist before an idea does. */
  logline: NonEmptyString.max(400).optional(),
  locale: Locale.default('fa'),
  styleBibleId: StyleBibleId.nullable().default(null),
  /**
   * Whether the style is locked, not merely chosen.
   *
   * The distinction is load-bearing: generation is refused against an unlocked bible
   * (`assertUsableForGeneration`), so "has a style" and "can produce assets" are
   * different states and a list that showed only the first would mislead.
   */
  styleLocked: z.boolean().default(false),
  episodeCount: z.number().int().nonnegative().default(0),
  spentNanoUsd: NanoUsdAmount.default(0),
  updatedAt: IsoInstant,
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

/**
 * The list, in an envelope.
 *
 * An object rather than a bare array so the response has somewhere to grow a cursor or
 * a total without becoming a breaking change - and because a top-level JSON array is
 * the one response shape that cannot be extended at all.
 */
export const ProjectList = z.strictObject({
  projects: z.array(ProjectSummary).default([]),
});
export type ProjectList = z.infer<typeof ProjectList>;
