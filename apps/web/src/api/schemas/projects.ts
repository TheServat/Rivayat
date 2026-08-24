/**
 * The projects surface, composed from `@rv/contracts`.
 *
 * `Project`, `ProjectSummary` and `ProjectList` all live upstream now, so nothing here
 * describes a project. What is left is the one shape the contracts package does not
 * carry: the body of `POST /projects`.
 *
 * It is composed rather than derived. `Project.pick({...})` is the obvious move and Zod
 * refuses it - the aggregate carries an object-level invariant (`updatedAt` may not
 * precede `createdAt`) and a refined schema has no `.pick()`. Building the body out of
 * the same primitives the aggregate is built from gives the identical bounds without a
 * second definition of the resource: `Label` is 1-120 trimmed characters here because
 * it is 1-120 trimmed characters there.
 */

import { Label, NanoUsdAmount, Prose } from '@rv/contracts';
import { z } from 'zod';

/**
 * What a person types to start a project.
 *
 * Validated on the client with this schema *and* on the server with its own, on
 * purpose. The client copy exists so a name that is 400 characters long is refused
 * beside the field that holds it rather than after a round trip; the server copy is the
 * one that decides. A client-only check would be a security hole and a server-only
 * check would be a form that loses a paragraph to a 400.
 */
export const NewProjectDraft = z.strictObject({
  name: Label,
  /**
   * The brief in the author's own words.
   *
   * The API calls this `description` and the list screen shows its first 400 characters
   * as a logline. The interface asks for "the idea", because that is what a person has
   * when they open this screen - `description` is the schema's word, not theirs.
   */
  description: Prose,
  /** `null` means the machine or workspace ceiling applies. It does not mean zero. */
  budgetNanoUsd: NanoUsdAmount.nullable().default(null),
});
export type NewProjectDraft = z.infer<typeof NewProjectDraft>;
