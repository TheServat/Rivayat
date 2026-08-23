/**
 * What the model writes, and what it is not allowed to touch.
 *
 * Compaction is lossy by design, and the design is: **the model compacts prose, the
 * engine carries the bookkeeping.** A summary schema handed whole to an LLM comes back
 * with a plausible list of entity ids, a plausible story span and a plausible set of
 * open loops, every one of them wrong in a way nothing downstream can detect.
 *
 * So each draft here is the *prose half* of a rung on the ladder. The ids, the spans,
 * the relation lists and the loop ledgers are computed from the deltas that produced the
 * episodes, where they are exact and free.
 *
 * | preserved, mechanically              | preserved, in prose        | dropped        |
 * |--------------------------------------|----------------------------|----------------|
 * | entities introduced, relations changed, open loops planted and paid, story span, canon-frozen flag, arc endpoints | logline, synopsis, beats, throughline, tone | scene text, dialogue, blocking, everything about how it was written |
 */

import { z } from 'zod';
import { Label, Prose } from '@rv/contracts';

export const EpisodeSummaryDraft = z.strictObject({
  title: Label.describe('The episode title. Short; it goes in a list.'),
  logline: Prose.describe('One sentence: what the episode is *about*, not what happens in it.'),
  synopsis: Prose.describe('One paragraph: what happens in it.'),
  beats: z
    .array(Prose)
    .max(64)
    .default([])
    .describe(
      'The beats in story order, one line each. This is the rung the planner actually reads, so write each one as a state change, not as a scene description.',
    ),
});
export type EpisodeSummaryDraft = z.infer<typeof EpisodeSummaryDraft>;

export const ArcMovementDraft = z.strictObject({
  character: Label.describe('By name, as the series calls them. Never an identifier.'),
  from: Prose.describe('Where they stood at the start of the span.'),
  to: Prose.describe('Where they stand at the end of it.'),
  moved: z
    .boolean()
    .default(true)
    .describe(
      'False when the arc did not actually move. Say so rather than omitting them - a lead who stood still for a season is exactly what the planner needs told.',
    ),
});
export type ArcMovementDraft = z.infer<typeof ArcMovementDraft>;

export const SeasonSummaryDraft = z.strictObject({
  title: Label,
  throughline: Prose.describe('The one question the season asks and answers.'),
  synopsis: Prose,
  arcs: z.array(ArcMovementDraft).max(64).default([]),
});
export type SeasonSummaryDraft = z.infer<typeof SeasonSummaryDraft>;

export const SeriesSummaryDraft = z.strictObject({
  premise: Prose.describe(
    'The series in one paragraph. This ships in every single generation call, so every word is paid for repeatedly.',
  ),
  synopsis: Prose.describe('Everything that has happened so far, compacted.'),
  themes: z.array(Label).max(12).default([]),
  toneNote: Prose.describe(
    'How it should feel. The continuity pass reads this as the drift baseline.',
  ),
  rulesOfTheWorld: z
    .array(Prose)
    .max(32)
    .default([])
    .describe('Hard constraints on what can happen. Always included, never negotiable.'),
});
export type SeriesSummaryDraft = z.infer<typeof SeriesSummaryDraft>;

export const COMPACTION_SYSTEM_PROMPT = [
  'You compact a serialised story so a later planner can read it without re-reading the',
  'scripts.',
  '',
  '- State outcomes, not events. "The bridge is gone and the valley is cut off" beats',
  '  "they fought on the bridge and it collapsed".',
  '- Keep every consequence that constrains a later episode. Drop atmosphere, dialogue,',
  '  camera and anything about how a scene was written.',
  '- Never invent an identifier of any kind. Refer to people and places by name.',
  '- Never invent a fact that is not in the material you were given.',
].join('\n');
