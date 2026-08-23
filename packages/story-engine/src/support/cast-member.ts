/**
 * A character as the story stages actually hold one.
 *
 * The narrative graph stores a character as an `Entity` with a `CharacterPayload`, and
 * that envelope carries a great deal the story stages have no use for - embeddings,
 * asset links, alias tables. Passing the whole entity around would make every use-case
 * here depend on the graph's storage shape, so the stages take this instead: the id to
 * refer back by, the name to put in a prompt, and the sheet.
 */

import type { CharacterPayload, EntityId, Label } from '@rv/contracts';

export interface CastMember {
  readonly entityId: EntityId;
  /** The canonical name. What the prompt calls them and what the audience hears. */
  readonly name: Label;
  readonly payload: CharacterPayload;
}
