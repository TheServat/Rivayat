/**
 * Answers to a complete draft, with **no model call at all**.
 *
 * RV-043 asks for composition without an LLM where the answers are sliders, and for the
 * LLM to write the prompt fragments. It turns out the second half is unnecessary: the
 * fragments are compiled from the structured fields anyway, so the whole wizard is a
 * pure function. That is strictly better than the acceptance criterion - it costs
 * nothing, it cannot fail, and the same answers produce byte-identical output forever.
 *
 * Completeness comes from starting at a preset rather than at an empty object. Every
 * leaf of the tree therefore yields a bible with no field left at a placeholder, which
 * is the property `wizard.spec.ts` asserts over the whole tree rather than over a
 * sample.
 */

import { MotionStyle, type StyleBibleDraft, VisualStyle } from '@rv/contracts';
import { type Result, ValidationError, err, isErr, ok } from '@rv/shared-kernel';

import { findPreset } from '../presets/index';
import { compilePromptFragments } from '../prompts/compile';
import { checkStyleCoherence } from './coherence';
import { type StyleFieldPatch, applyMotionPatch, applyVisualPatch } from './patch';
import {
  BASE_QUESTION_ID,
  type WizardAnswers,
  type WizardQuestion,
  visibleQuestions,
} from './questions';

export interface ComposeWizardStyleInput {
  readonly answers: WizardAnswers;
  readonly name: string;
  /** Base seed. Injected rather than generated - determinism (CLAUDE.md §1). */
  readonly seed: number;
  /**
   * Direct field overrides applied after every answer.
   *
   * The escape hatch for the advanced panel: the wizard covers the questions a
   * newcomer can answer, and this covers the twenty fields it deliberately never asks
   * about. It is also the only route by which an incoherent combination can arrive,
   * which is why the coherence check runs after it and not before.
   */
  readonly overrides?: StyleFieldPatch;
}

function optionFor(question: WizardQuestion, answers: WizardAnswers) {
  const answer = answers[question.id];
  if (answer === undefined) return undefined;
  return question.options.find((option) => option.id === answer);
}

/**
 * Composes the draft, or explains what is missing.
 *
 * An unknown option id is a `ValidationError` rather than a silent skip: a UI that
 * posts a stale option id would otherwise get back a style quietly missing the answer
 * the user gave.
 */
export function composeStyleDraft(
  input: ComposeWizardStyleInput,
): Result<StyleBibleDraft, ValidationError> {
  const baseAnswer = input.answers[BASE_QUESTION_ID];
  if (baseAnswer === undefined) {
    return err(
      new ValidationError({
        message: `The wizard needs an answer to "${BASE_QUESTION_ID}" before it can compose anything.`,
        context: { missing: [BASE_QUESTION_ID] },
      }),
    );
  }

  const preset = findPreset(baseAnswer);
  if (isErr(preset)) {
    return err(
      new ValidationError({
        message: `"${baseAnswer}" is not a style preset.`,
        context: { question: BASE_QUESTION_ID, answer: baseAnswer },
      }),
    );
  }

  const questions = visibleQuestions(input.answers);
  const missing = questions
    .filter((question) => input.answers[question.id] === undefined)
    .map((question) => question.id);
  if (missing.length > 0) {
    return err(
      new ValidationError({
        message: `The wizard is not finished: ${missing.join(', ')} unanswered.`,
        context: { missing },
      }),
    );
  }

  let visual = preset.value.draft.visual;
  let motion = preset.value.draft.motion;

  for (const question of questions) {
    if (question.id === BASE_QUESTION_ID) continue;
    const option = optionFor(question, input.answers);
    if (option === undefined) {
      return err(
        new ValidationError({
          message: `"${String(input.answers[question.id])}" is not an option of "${question.id}".`,
          context: { question: question.id, answer: input.answers[question.id] },
        }),
      );
    }
    visual = applyVisualPatch(visual, option.patch);
    motion = applyMotionPatch(motion, option.patch);
  }

  if (input.overrides !== undefined) {
    visual = applyVisualPatch(visual, input.overrides);
    motion = applyMotionPatch(motion, input.overrides);
  }

  const coherence = checkStyleCoherence(visual, motion);
  if (isErr(coherence)) return coherence;

  // Re-parsed rather than trusted: the patches are typed, but a patch that pushed a
  // unit field out of range would otherwise reach the checksum, and a bible is the one
  // document in this system that must never be wrong.
  const parsedVisual = VisualStyle.parse(visual);
  const parsedMotion = MotionStyle.parse(motion);

  return ok({
    name: input.name,
    origin: 'wizard',
    visual: parsedVisual,
    motion: parsedMotion,
    render: preset.value.draft.render,
    prompts: compilePromptFragments({ visual: parsedVisual }),
    anchors: [],
    seed: input.seed,
    notes: `Composed by the guided wizard from the "${preset.value.id}" preset.`,
  });
}
