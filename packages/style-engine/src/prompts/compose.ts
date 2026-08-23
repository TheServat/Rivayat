/**
 * Assembling one concrete image request out of the frozen fragments.
 *
 * The fragments are the *style*; a generation also needs a subject. Keeping the join
 * here rather than at each call site is what makes RV-047's guarantee checkable: every
 * path to `ImageGenerationPort` carries the positive clause, the subject clause and the
 * full negative list, because there is exactly one function that builds the pair.
 */

import type { PromptFragments, SubjectClass } from '@rv/contracts';

import { joinClauses } from './words';

export interface ComposeStylePromptInput {
  readonly fragments: PromptFragments;
  /** What is being drawn, in plain words - "a mature oak with three main boughs". */
  readonly subject: string;
  readonly subjectClass: SubjectClass;
  /**
   * `provider:model` of the model about to run.
   *
   * When the fragments carry an override for it, the override *replaces* the style
   * clause rather than being appended: the override exists because that model cannot
   * take the long form, so sending both would defeat the point.
   */
  readonly modelRef?: string;
  /** Anything the caller needs to add for this one call. Never style, only content. */
  readonly extra?: string;
}

export interface ComposedPrompt {
  readonly positive: string;
  readonly negative: string;
}

export function composeStylePrompt(input: ComposeStylePromptInput): ComposedPrompt {
  const override =
    input.modelRef === undefined ? undefined : input.fragments.byModel[input.modelRef];
  const styleClause = override ?? input.fragments.positive;

  return {
    // Subject first: every encoder in play weights early tokens more heavily, and the
    // one thing that must survive truncation is *what the picture is of*.
    positive: joinClauses([
      input.subject,
      styleClause,
      input.fragments.bySubject[input.subjectClass],
      input.extra,
    ]),
    negative: input.fragments.negative,
  };
}
