/**
 * The epistemic layer, applied to a voice.
 *
 * This is the part of the audio layer that is genuinely richer here than it would be in
 * a system without a belief graph. `docs/02` stores what is *true* and what each
 * character *believes* as separate edges, and `AudienceVisibility` records what the
 * viewer has been shown. So at any line we can ask two questions no ordinary TTS pipeline
 * can:
 *
 *  1. Is the speaker wrong about something, and does the audience already know they are?
 *  2. Is the speaker sitting on something the audience has not been shown?
 *
 * Those two answers produce {@link SpeechStance}, and the stance changes the take. The
 * one that reads backwards is the first: a character who sincerely believes something
 * false must be delivered **more** sincerely, not knowingly. The irony belongs to the
 * audience; a voice that winks at it destroys the effect the scene was built for. That
 * rule is stated in `SpeechStance` and enforced in every adapter.
 *
 * ## What is deliberately not derived
 *
 * `ironic` is not inferred, ever. Irony is a line meaning its opposite, and no edge in
 * the graph says that - it is an authorial decision that lives in `DialogueLine.subtext`,
 * which is prose. A heuristic over prose would be wrong often enough to make a character
 * sound sarcastic in a scene where they were sincere, which is a worse failure than
 * flatness. It is accepted from the caller and never guessed.
 */

import type { EpistemicView, RelationId, SpeechStance } from '@rv/contracts';

/**
 * What the graph can say about a speaker at one moment.
 *
 * Booleans rather than the raw view, because the derivation and the *decision* are worth
 * separating: {@link stanceFor} is a three-line rule table that a person can check by
 * reading, and {@link speakerPosition} is the part that walks a graph.
 */
export interface SpeakerPosition {
  /** The speaker holds a belief that is false, and the audience has been shown the truth. */
  readonly audienceKnowsBetter: boolean;
  /** The speaker knows something the audience has not been shown. */
  readonly withholding: boolean;
}

/**
 * Reads a speaker's position out of their view and what the audience has seen.
 *
 * `audienceKnows` is the set of relations the viewer has been shown - in practice, the
 * ids of facts whose `AudienceVisibility` is `public` by this point in the episode. It is
 * passed in rather than looked up because visibility is a property of the *episode's*
 * progress, and this module has no business knowing how far along the cut is.
 *
 * `blindSpots` is never read here, and that is deliberate rather than accidental: it is
 * the same field `epistemic-briefing.ts` refuses to render, for the same reason. What a
 * character does *not* know cannot change how they say something they *do*.
 */
export function speakerPosition(
  view: EpistemicView,
  audienceKnows: ReadonlySet<RelationId>,
): SpeakerPosition {
  const audienceKnowsBetter = view.believesFalsely.some((fact) =>
    audienceKnows.has(fact.relationId),
  );
  const withholding = view.knows.some((fact) => !audienceKnows.has(fact.relationId));
  return { audienceKnowsBetter, withholding };
}

/**
 * The stance a line is delivered in.
 *
 * The precedence is the interesting decision. A character can be both wrong about one
 * thing and hiding another, and the graph cannot tell us which of the two this particular
 * line is about - `DialogueLine` carries no fact reference. So `mistaken` wins, because
 * `mistaken` is the **null adjustment**: it instructs every adapter to change nothing.
 * Choosing `concealing` on a coin flip would flatten a line that may not want flattening,
 * and a flattened sincere line sounds wrong in a way a sincere sincere line never does.
 *
 * `ironic` is only ever what the caller asked for. See the file header.
 */
export function stanceFor(position: SpeakerPosition, authored?: SpeechStance): SpeechStance {
  if (authored !== undefined && authored !== 'plain') return authored;
  if (position.audienceKnowsBetter) return 'mistaken';
  if (position.withholding) return 'concealing';
  return 'plain';
}
