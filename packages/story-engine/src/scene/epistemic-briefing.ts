/**
 * Turning one character's `EpistemicView` into the only thing their actor is told.
 *
 * docs/02 §3 stores what is *true* and what each character *believes* as separate edges,
 * and says the epistemic layer is the point. This is where that pays off or does not: the
 * scene writer is handed the POV entity's view rather than the narrator's, which is the
 * mechanism that stops a character acting on information they do not have.
 *
 * Two rules, and the second one is the whole file:
 *
 *  1. `knows`, `believesFalsely` and `suspects` are rendered - and rendered *separately*,
 *    because a character who is certain of something false plays completely differently
 *    from one who suspects something true.
 *  2. **`blindSpots` is never rendered.** Its own field description says it: "never put
 *    these in the prompt as facts". They are the true edges the viewer does *not* hold -
 *    the dramatic irony available to the scene - and putting them in an actor's briefing
 *    hands the character the exact facts the scene was built on them not having. There is
 *    no code path in this module that reads that field, which is deliberate: a redaction
 *    implemented as "remember not to include it" is a redaction that eventually includes
 *    it.
 */

import type { EpistemicView, KnownFact } from '@rv/contracts';
import { composePrompt, section } from '@rv/prompt-kit';

import { bulletList } from '../support/format';

function renderFact(fact: KnownFact): string {
  const source =
    fact.learnedFrom === undefined
      ? `they ${fact.via.replace(/-/gu, ' ')} it`
      : `they ${fact.via.replace(/-/gu, ' ')} it from someone`;
  const when =
    fact.learnedAt === null ? 'as long as they can remember' : `at ${storyTimeLabel(fact)}`;
  const certainty =
    fact.confidence >= 0.9
      ? 'certain'
      : fact.confidence >= 0.5
        ? 'fairly sure'
        : 'only half believes it';
  return `${fact.fact} (${source}, ${when}; ${certainty})`;
}

function storyTimeLabel(fact: KnownFact): string {
  const at = fact.learnedAt;
  if (at === null) return 'always';
  return at.label ?? `story point ${String(at.ordinal)}`;
}

/**
 * The briefing text for one character.
 *
 * Framed as "this is everything" rather than as "here is some context", because a model
 * handed a short list of facts will otherwise treat it as an excerpt and reason its way to
 * the rest. Saying that the list is exhaustive is what converts a gap into something to
 * play instead of something to fill.
 */
export function renderEpistemicBriefing(view: EpistemicView, viewerName: string): string {
  return composePrompt(
    `This is the whole of what ${viewerName} knows at this moment. There is no more.`,
    section(
      'What they know to be true',
      bulletList(view.knows.map(renderFact), 'nothing relevant to this scene'),
    ),
    section(
      'What they are certain of, and are wrong about',
      bulletList(
        view.believesFalsely.map(renderFact),
        'nothing - they are not mistaken about anything here',
      ),
    ),
    section(
      'What they suspect but have not acted on',
      bulletList(view.suspects.map(renderFact), 'nothing'),
    ),
    view.truncated
      ? `Their memory of this is incomplete: ${String(view.factCount)} facts exist and not all of them fit here. Play the incompleteness; do not fill it in.`
      : undefined,
  );
}

/**
 * Every distinct proposition in a view, lower-cased.
 *
 * Exported for the guard test: given a view, this is exactly the set of statements that
 * may legitimately appear in that character's prompt, and anything outside it that shows
 * up is a leak. Keeping the enumeration here rather than in the spec means the test and
 * the renderer cannot disagree about what "in the view" means.
 */
export function factsInView(view: EpistemicView): readonly string[] {
  return [...view.knows, ...view.believesFalsely, ...view.suspects].map((fact) =>
    fact.fact.toLowerCase(),
  );
}
