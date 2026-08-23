/**
 * `Project` - the workspace everything else hangs off, and the one resource that had no
 * shared shape.
 *
 * `ProjectId` has been in the id registry since the beginning and is referenced by
 * `PipelineRun`, `UsageRecord`, the settings scope and every storage port, so the whole
 * system could *name* a project and nothing could *describe* one. Two places filled the
 * hole independently - `apps/api/src/application/resources.ts` and
 * `apps/web/src/api/schemas/pending-contracts.ts` - and each header says the other is
 * the authority. That is the shape of drift that produced a `response-schema-mismatch`
 * on the projects screen, and it is why non-negotiable #5 exists.
 *
 * Two schemas live here, and the split is deliberate rather than incidental.
 *
 * | schema           | answers                    | who fills it                              |
 * |------------------|----------------------------|-------------------------------------------|
 * | {@link Project}  | `GET /projects/:id`        | the project row, whole                    |
 * | {@link ProjectSummary} | one row of `GET /projects` | four sources joined - see below     |
 *
 * A summary is **not** a subset of the aggregate. `episodeCount` comes from the
 * episodes of the project's series, `spentNanoUsd` from the run ledger, and
 * `styleLocked` from the style bible - none of which the project row holds, and none of
 * which may be denormalised onto it, because the first of those to go stale is the
 * spend and the spend is the number a user checks. Widening `Project` to cover the list
 * would mean three columns kept in step by hand; keeping them apart means the list is a
 * read model and says so.
 */

import { z } from 'zod';

import {
  IsoInstant,
  Label,
  Locale,
  NanoUsdAmount,
  NonEmptyString,
  Prose,
} from '../primitives/common';
import { ProjectId, StyleBibleId } from '../primitives/ids';

// ── the aggregate ───────────────────────────────────────────────────────────

/**
 * A project, whole. What a write produces and what the detail route answers.
 *
 * `locale` is a field rather than a studio-wide constant because the studio is
 * Persian-first and single-installation: one machine hosts a Persian series and an
 * English one, and until this existed every project row in the list claimed `fa`
 * regardless. It is the project's own interface language, not the operator's - the
 * operator's belongs in the settings registry under `interface.locale`, which is a
 * different question with a different answer.
 *
 * `styleBibleId` and `budgetNanoUsd` are nullable rather than optional because both
 * have a meaningful "not yet" that the UI has to render: no style until S1 locks one,
 * and no ceiling means the workspace policy applies. `exactOptionalPropertyTypes` makes
 * absent and `null` genuinely different, and only one of them is a state a project can
 * be in.
 */
/**
 * The fields, before the refinement.
 *
 * Module-private, and the same pattern `story-bible.ts` uses for `episodeBase`: zod 4
 * refuses `.pick()` on an object that carries a refinement, so the request DTOs below
 * are derived from *this* and the exported `Project` is this plus its guard. Deriving
 * them from the refined schema fails at module load with
 * `.pick() cannot be used on object schemas containing refinements` - a runtime error,
 * not a compile error, which is why the DTOs live here rather than being picked at the
 * far end by whoever imports `Project`.
 */
const projectBase = z.strictObject({
  id: ProjectId,
  name: Label,
  description: Prose.describe(
    'The brief in the author\u2019s own words. The list shows its head as a logline; this is the whole of it.',
  ),
  locale: Locale.default('fa').describe(
    'The interface language for this project. Persian by default, because the studio is Persian-first.',
  ),
  styleBibleId: StyleBibleId.nullable()
    .default(null)
    .describe('The style this project produces in. `null` until S1 locks one.'),
  budgetNanoUsd: NanoUsdAmount.nullable()
    .default(null)
    .describe(
      'Ceiling for the whole project, in nano-dollars. `null` means the machine or workspace policy applies - it does not mean zero.',
    ),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});

export const Project = projectBase.superRefine((project, ctx) => {
  // The same class of check as `checkBiTemporalOrder`'s retraction rule, and for the
  // same reason: an `updatedAt` before its `createdAt` is a clock or an ordering bug
  // in our own pipeline, and it silently breaks every "most recently touched" sort
  // the projects list is built around.
  if (Date.parse(project.updatedAt) < Date.parse(project.createdAt)) {
    ctx.addIssue({
      code: 'custom',
      path: ['updatedAt'],
      message: 'updatedAt must not precede createdAt',
    });
  }
});
export type Project = z.infer<typeof Project>;

// \u2500\u2500 what a client may write \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Creating a project: the two things only the author can supply, and two defaults.
 *
 * `id`, `createdAt` and `updatedAt` are absent by construction. A client that could
 * choose an id could collide with an existing project or forge a reference, and a
 * client that could choose `createdAt` could write a project into the past - which is
 * the sort order the list screen is built on.
 */
export const CreateProjectRequest = projectBase.pick({
  name: true,
  description: true,
  locale: true,
  budgetNanoUsd: true,
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/**
 * Editing one: every field an author owns, and **no defaults**.
 *
 * The obvious spelling is `projectBase.pick({…}).partial()`, and it is wrong in a way
 * that is invisible until it deletes something. `.partial()` makes a field optional; it
 * does not remove its `.default()`. So a patch body of `{}` parses to
 * `{ styleBibleId: null, budgetNanoUsd: null }` - two values the client never sent -
 * and a repository that spreads the patch over the row un-sets the project's style and
 * its budget. `PATCH /projects/:id` in `apps/api` has exactly that behaviour today;
 * dropping `undefined` before the spread does not help, because these are not
 * `undefined`.
 *
 * So the fields are re-stated without their defaults, and `project.spec.ts` asserts the
 * key set is exactly the aggregate's minus the three a client may not write. That test
 * is what a `.pick()` would have given for free, and it is the price of not shipping a
 * patch that blanks fields nobody mentioned.
 *
 * `id`, `createdAt` and `updatedAt` are the three: a client that could choose an id
 * could collide or forge a reference, and one that could choose a timestamp could
 * reorder the list screen.
 */
export const UpdateProjectRequest = z.strictObject({
  name: Label.optional(),
  description: Prose.optional(),
  locale: Locale.optional(),
  styleBibleId: StyleBibleId.nullable().optional(),
  budgetNanoUsd: NanoUsdAmount.nullable().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

// ── the list read model ─────────────────────────────────────────────────────

/**
 * A project as the list screen needs it.
 *
 * `styleLocked` is separate from `styleBibleId` because the distinction is
 * load-bearing: `assertUsableForGeneration` in `@rv/core-domain` refuses generation
 * against an unlocked bible, so "has a style" and "can produce assets" are different
 * states, and a list that showed only the first would tell the user a project is ready
 * when it is not.
 *
 * `logline` is optional because a project can exist before an idea does, and it is
 * capped where it is because a list cell is a cell: the whole `description` lives on
 * the aggregate and the detail screen shows it.
 */
export const ProjectSummary = z.strictObject({
  id: ProjectId,
  name: Label,
  logline: NonEmptyString.max(400)
    .optional()
    .describe('The head of the description, for one line of a card. Absent when there is none.'),
  locale: Locale.default('fa'),
  styleBibleId: StyleBibleId.nullable().default(null),
  styleLocked: z
    .boolean()
    .default(false)
    .describe('Locked, not merely chosen. Generation is refused against an unlocked bible.'),
  episodeCount: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Episodes across every series of this project. Counted, never stored.'),
  spentNanoUsd: NanoUsdAmount.default(0).describe(
    'Summed from the run ledger, never denormalised onto the project row - the ledger is what an invoice is checked against (non-negotiable #3).',
  ),
  updatedAt: IsoInstant,
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

/**
 * The list, in an envelope.
 *
 * An object rather than a bare array so the response has somewhere to grow a cursor or
 * a total without becoming a breaking change - a top-level JSON array is the one
 * response shape that cannot be extended at all.
 */
export const ProjectList = z.strictObject({
  projects: z.array(ProjectSummary).default([]),
});
export type ProjectList = z.infer<typeof ProjectList>;
