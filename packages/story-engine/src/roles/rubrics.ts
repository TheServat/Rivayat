/**
 * The critique vocabulary, grounded in the evaluation literature rather than invented.
 *
 * Prior-art §B names `StoryER`, `ConStory-Bench` and `LitBench` as the basis for the
 * automated critique pass, and each contributes a different half of the question:
 *
 *  - **StoryER** scores a story on *reader-facing* axes - coherence, engagement, surprise.
 *    Those are the dimensions a draft can pass every structural check and still fail.
 *  - **ConStory-Bench** scores *consistency* across a long work - character, setting and
 *    plot holding still over many episodes. That is the axis a single-episode reader
 *    cannot see and a series lives or dies on.
 *  - **LitBench** is the reminder that the two above are proxies for a human preference,
 *    which is why every dimension here carries a `question` a person could answer, not a
 *    metric name.
 *
 * Dimensions are shared constants rather than per-role literals so that a score for
 * `scene-causality` means the same thing whether the screenwriter or the director asked
 * for it - otherwise the critique history is not comparable across stages and the whole
 * ledger is decoration.
 */

import type { RubricDimension } from './role';

/** The five dimensions `docs/03-backlog.md` RV-088 requires of the story critique. */
export const PREMISE_CLARITY: RubricDimension = {
  key: 'premise-clarity',
  label: 'Premise clarity',
  question:
    'Can a reader state, in one sentence and without guessing, who wants what and what ' +
    'stands in the way? Score 0 if the premise has to be inferred, 1 if it is unmissable.',
  failsBelow: 0.6,
};

export const STAKES: RubricDimension = {
  key: 'stakes',
  label: 'Stakes',
  question:
    'Is it clear what is lost if the protagonist fails, and does that loss cost them ' +
    'something they cannot replace? Score 0 for a failure with no consequence.',
  failsBelow: 0.6,
};

export const ARC_MOVEMENT: RubricDimension = {
  key: 'arc-movement',
  label: 'Arc movement',
  question:
    'Does the protagonist end somewhere they could not have started? Score 0 if the ' +
    'closing state is the opening state with different scenery.',
  failsBelow: 0.55,
};

export const SCENE_CAUSALITY: RubricDimension = {
  key: 'scene-causality',
  label: 'Scene causality',
  question:
    'Does each unit happen *because of* the one before it rather than merely after it? ' +
    'Score 0 for a sequence joined only by "and then".',
  failsBelow: 0.6,
};

export const STYLE_FIT: RubricDimension = {
  key: 'style-fit',
  label: 'Style fit',
  question:
    'Could this be shot in the locked style bible without fighting it - shapes, palette, ' +
    'motion vocabulary? Score 0 for something that needs a different art direction.',
  failsBelow: 0.6,
};

/** ConStory-Bench's contribution: the axes a single episode cannot show you. */
export const WORLD_CONSISTENCY: RubricDimension = {
  key: 'world-consistency',
  label: 'World consistency',
  question:
    'Does anything here contradict a stated rule of the world or an established fact? ' +
    'Score 1 only when every assertion is compatible with what is already canon.',
  failsBelow: 0.8,
};

export const CANON_RESPECT: RubricDimension = {
  key: 'canon-respect',
  label: 'Aired-canon respect',
  question:
    'Does this contradict - rather than extend or reveal - something an aired episode ' +
    'already showed? Score 0 for any contradiction, however small.',
  failsBelow: 0.95,
};

export const CHARACTER_DISTINCTNESS: RubricDimension = {
  key: 'character-distinctness',
  label: 'Character distinctness',
  question:
    'With the speaker labels removed, could a reader still tell who is talking? Score 0 ' +
    'if every character shares one competent middle register.',
  failsBelow: 0.6,
};

export const VOICE_FIDELITY: RubricDimension = {
  key: 'voice-fidelity',
  label: 'Voice fidelity',
  question:
    'Do these lines match the character sheet - register, verbosity, idiolect, tics, ' +
    'silence habits? Score 0 where the sheet is contradicted rather than merely unused.',
  failsBelow: 0.65,
};

/** StoryER's contribution: the reader is not reading a checklist. */
export const ENGAGEMENT: RubricDimension = {
  key: 'engagement',
  label: 'Engagement',
  question:
    'Is there a reason to keep watching past the first thirty seconds that is not ' +
    'curiosity about whether it improves? Score 0 for competent and inert.',
  failsBelow: 0.5,
};

/** The producer's axis: what this costs to actually make. */
export const SCOPE_FEASIBILITY: RubricDimension = {
  key: 'scope-feasibility',
  label: 'Scope feasibility',
  question:
    'Can this be made inside the declared episode count, runtime and asset budget without ' +
    'inventing a crowd scene per episode? Score 0 for a plan that only works at ten times ' +
    'the budget.',
  failsBelow: 0.5,
};

export const SILHOUETTE_READABILITY: RubricDimension = {
  key: 'silhouette-readability',
  label: 'Silhouette readability',
  question:
    'Filled solid black at thumbnail size, is this design still identifiable and still ' +
    'distinct from the rest of the cast? Score 0 for a shape only its palette separates.',
  failsBelow: 0.6,
};

/**
 * Every dimension, keyed. Exported so a critique result can be joined back to the
 * question that produced it without the caller keeping its own copy of the rubric.
 */
export const RUBRIC_DIMENSIONS: Readonly<Record<string, RubricDimension>> = Object.fromEntries(
  [
    PREMISE_CLARITY,
    STAKES,
    ARC_MOVEMENT,
    SCENE_CAUSALITY,
    STYLE_FIT,
    WORLD_CONSISTENCY,
    CANON_RESPECT,
    CHARACTER_DISTINCTNESS,
    VOICE_FIDELITY,
    ENGAGEMENT,
    SCOPE_FEASIBILITY,
    SILHOUETTE_READABILITY,
  ].map((dimension) => [dimension.key, dimension]),
);

/** Renders a rubric as the numbered list a critique prompt asks the model to fill. */
export function describeRubric(rubric: readonly RubricDimension[]): string {
  return rubric
    .map(
      (dimension, index) =>
        `${String(index + 1)}. \`${dimension.key}\` - ${dimension.label}. ${dimension.question}`,
    )
    .join('\n');
}
