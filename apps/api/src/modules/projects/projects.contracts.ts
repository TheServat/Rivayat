/**
 * The projects surface's shapes, all of which now live in `@rv/contracts`.
 *
 * This file used to hold four copies of them, mirrored by hand against
 * `apps/web/src/api/schemas/pending-contracts.ts` because `@rv/contracts` had a
 * `ProjectId` that identified nothing. The aggregate has since landed, and two defects
 * came with the writing of it that the copies had been carrying:
 *
 *  - `CreateProjectRequest`/`UpdateProjectRequest` were `Project.pick(...)`, and zod 4
 *    refuses `.pick()` on a schema carrying a refinement. `Project` now guards
 *    `updatedAt >= createdAt`, so the pick throws **at module load** - a boot failure,
 *    not a compile error.
 *  - `.partial()` makes a field optional without removing its `.default()`, so a patch
 *    body of `{}` parsed to `{ styleBibleId: null, budgetNanoUsd: null }` and renaming
 *    a project silently un-set its style and its budget.
 *
 * Both are fixed at the source. Re-exporting rather than importing at each call site
 * keeps the module's imports pointing at the module, and leaves one obvious place to
 * look for "what shapes does this surface use".
 */

import { ProjectId } from '@rv/contracts';

export {
  CreateProjectRequest,
  ProjectList,
  ProjectSummary,
  UpdateProjectRequest,
} from '@rv/contracts';

/** A project id out of the URL, branded rather than a bare string. */
export const ProjectIdParam = ProjectId;
