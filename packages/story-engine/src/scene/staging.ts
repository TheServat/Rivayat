/**
 * What an actor is allowed to see of the scene.
 *
 * A `Scene` from `@rv/contracts` is written by and for the narrator: `summary` says what
 * happens, `outcome` says how it ends, and `povEntityRef` names whose knowledge bounds it.
 * Handing that object to an actor call defeats the entire epistemic layer in one step -
 * the character now knows how the scene ends.
 *
 * So the actors get this instead: the observable surface of the room. It is a separate
 * type rather than a filtered `Scene` because filtering is a thing you can forget to do
 * and a type is a thing you cannot forget to construct. The one field that can still leak
 * is `observable`, and its documentation says so plainly.
 */

import type { Label } from '@rv/contracts';

export interface SceneStaging {
  readonly title: Label;
  readonly locationName: Label;
  /** Everyone in the room, by name. An actor may address anyone here and nobody else. */
  readonly presentNames: readonly Label[];
  /**
   * What a person standing in this room can see, hear and smell. Nothing more.
   *
   * The narrator's account of the scene does not go here. Neither does the outcome, the
   * subtext, or anything a character would have to be told. If you would have to explain
   * how someone knows it, it belongs in that character's `EpistemicView`, not here - and
   * putting it here gives it to *every* actor, including the ones the scene depends on not
   * knowing it.
   */
  readonly observable: string;
  /** When and where, as a person in the room would experience it. Optional. */
  readonly timeNote?: string;
  /**
   * A one-line tonal steer shared by every actor - "dry, unhurried, nobody raises their
   * voice".
   *
   * Deliberately the *only* series-level context an actor receives. The premise, the
   * themes and the world rules are not sent: they routinely contain the shape of the
   * thing the audience is not supposed to know yet.
   */
  readonly toneNote?: string;
}
