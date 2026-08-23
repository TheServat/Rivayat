/**
 * S2 Story: expand one node into its immediate children. Once. Never further.
 *
 * This is the whole of DOC (prior-art §B) in one use-case, and the two guards are the
 * reason it exists rather than a prompt asking nicely:
 *
 *  - **Before the call**, `checkSingleLevelDescent` refuses a target level that is not
 *    exactly one below the parent. "Generate the scenes of this season" is a legal thing
 *    to want and an illegal thing to do; the caller has to walk the tree.
 *  - **After the call**, the expansion has to quote its parent's instruction back
 *    unchanged. An expansion that cannot is not bound to its parent, whatever it says.
 *
 * The prompt carries the parent node, the parent's *siblings'* summaries, and the series
 * context - and nothing else. Not the grandparent, not the cousins, not the rest of the
 * tree. That bounded window is what keeps the call affordable at scene level, where there
 * are hundreds of them, and it is asserted in the spec rather than trusted.
 */

import { PromptTemplate } from '@rv/prompt-kit';
import type { StructuredTrace } from '@rv/prompt-kit';
import { type AppError, type Result, ValidationError, err, isErr, ok } from '@rv/shared-kernel';

import { SCREENWRITER } from '../roles/index';
import { bulletList, normaliseForComparison, orElse } from '../support/format';
import { type StoryEngineDeps, runRoleCall } from '../support/stage-call';
import { type OutlineContext, renderOutlineContext } from './context';
import { type OutlineChildDraft, OutlineExpansion } from './expansion';
import { type OutlineLevel, checkSingleLevelDescent, childLevelOf } from './levels';

/** The node being expanded, in the three fields an expansion actually reads. */
export interface OutlineNodeRef {
  readonly level: OutlineLevel;
  readonly title: string;
  readonly summary: string;
  /**
   * What this node's own parent asked of it. `null` only at the series root, whose parent
   * is the brief.
   *
   * This is the string the expansion is bound to: it is what gets sent, and it is what
   * has to come back in `parentPlanEcho`.
   */
  readonly plannedSummary: string | null;
}

export interface ChildCountBounds {
  readonly min: number;
  readonly max: number;
}

export interface ExpandOutlineLevelInput {
  readonly context: OutlineContext;
  readonly parent: OutlineNodeRef;
  /** Must be exactly one level below `parent.level`. */
  readonly targetLevel: OutlineLevel;
  /**
   * Summaries of the *parent's* siblings, in order.
   *
   * Lateral context, deliberately shallow: episode 4 needs to know what episodes 3 and 5
   * are for, and does not need their beats. Empty for an only child.
   */
  readonly parentSiblingSummaries?: readonly string[];
  readonly childCount?: ChildCountBounds;
  /** Anything the caller wants this one expansion to honour - an author's note, an edit. */
  readonly directive?: string;
  readonly signal?: AbortSignal;
}

export interface OutlineExpansionResult {
  readonly parentLevel: OutlineLevel;
  readonly level: OutlineLevel;
  /** The instruction this expansion was bound to, as sent. */
  readonly boundTo: string;
  readonly children: readonly OutlineChildDraft[];
  readonly trace: StructuredTrace;
}

const EXPAND_PROMPT = new PromptTemplate<{
  readonly seriesContext: string;
  readonly parentLevel: string;
  readonly targetLevel: string;
  readonly parentTitle: string;
  readonly parentSummary: string;
  readonly parentPlan: string;
  readonly siblingSummaries: string;
  readonly countInstruction: string;
  readonly directive: string;
}>(
  'outline.expand',
  [
    '{{seriesContext}}',
    '',
    '## The node you are expanding',
    'Level: {{parentLevel}}',
    'Title: {{parentTitle}}',
    '',
    '### What it was asked to be',
    '{{parentPlan}}',
    '',
    '### What it currently contains',
    '{{parentSummary}}',
    '',
    '## What sits either side of it',
    '{{siblingSummaries}}',
    '',
    '## Your task',
    'Expand this {{parentLevel}} into its {{targetLevel}} children, in playing order.',
    '{{countInstruction}}',
    '',
    'Produce {{targetLevel}} nodes and nothing below them. Do not sketch what each child',
    'will later contain - the next pass does that, and a sketch written now becomes an',
    'instruction nobody agreed to.',
    '',
    'Copy the instruction above into parentPlanEcho word for word before you write anything',
    'else. It is checked.',
    '',
    '{{directive}}',
  ].join('\n'),
);

export class ExpandOutlineLevelUseCase {
  readonly #deps: StoryEngineDeps;

  constructor(deps: StoryEngineDeps) {
    this.#deps = deps;
  }

  async execute(input: ExpandOutlineLevelInput): Promise<Result<OutlineExpansionResult, AppError>> {
    const skip = checkSingleLevelDescent(input.parent.level, input.targetLevel);
    if (skip !== undefined) return err(skip);

    const bounds = input.childCount;
    if (bounds !== undefined && (bounds.min < 1 || bounds.max < bounds.min)) {
      return err(
        new ValidationError({
          message: `Child count bounds are impossible: min ${String(bounds.min)}, max ${String(bounds.max)}`,
          context: { reason: 'bad-child-bounds', min: bounds.min, max: bounds.max },
        }),
      );
    }

    // The root has no parent instruction, so it is bound to its own summary instead -
    // which is what the brief said the series is. Binding to nothing would make the echo
    // check vacuous exactly where the tree is widest.
    const boundTo = orElse(input.parent.plannedSummary, input.parent.summary);

    const outcome = await runRoleCall<OutlineExpansion>(this.#deps, {
      role: SCREENWRITER,
      schemaName: 'OutlineExpansion',
      schema: OutlineExpansion,
      user: EXPAND_PROMPT.render({
        seriesContext: renderOutlineContext(input.context),
        parentLevel: input.parent.level,
        targetLevel: input.targetLevel,
        parentTitle: input.parent.title,
        parentSummary: input.parent.summary,
        parentPlan: boundTo,
        siblingSummaries: bulletList(
          [...(input.parentSiblingSummaries ?? [])],
          `no siblings - this ${input.parent.level} stands alone`,
        ),
        countInstruction:
          bounds === undefined
            ? 'Use as many children as the material needs and no more.'
            : `Produce between ${String(bounds.min)} and ${String(bounds.max)} children.`,
        directive: orElse(input.directive, 'No additional directive for this expansion.'),
      }).text,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (isErr(outcome)) return outcome;

    const checked = validateExpansion(outcome.value.value, boundTo, bounds);
    if (isErr(checked)) return checked;

    return ok({
      parentLevel: input.parent.level,
      level: input.targetLevel,
      boundTo,
      children: checked.value,
      trace: outcome.value.trace,
    });
  }
}

/**
 * The post-call half of the DOC binding.
 *
 * Separate and pure so it can be exercised directly: these are the checks that decide
 * whether an expansion is *about the node it was asked about*, and a check that can only
 * be reached through a model call is a check nobody tests properly.
 *
 * Comparison is whitespace- and case-insensitive. A model that re-wraps the instruction
 * has still quoted it; failing on line wrapping would be a false alarm that trains callers
 * to disable the check.
 */
export function validateExpansion(
  expansion: OutlineExpansion,
  boundTo: string,
  bounds?: ChildCountBounds,
): Result<readonly OutlineChildDraft[], ValidationError> {
  if (normaliseForComparison(expansion.parentPlanEcho) !== normaliseForComparison(boundTo)) {
    return err(
      new ValidationError({
        message:
          'The expansion did not quote back the instruction it was given, so it is not ' +
          'bound to its parent',
        context: {
          reason: 'expansion-not-bound-to-parent',
          expected: boundTo,
          received: expansion.parentPlanEcho,
        },
      }),
    );
  }

  if (bounds !== undefined) {
    const count = expansion.children.length;
    if (count < bounds.min || count > bounds.max) {
      return err(
        new ValidationError({
          message: `Expansion returned ${String(count)} children; ${String(bounds.min)}..${String(bounds.max)} were asked for`,
          context: { reason: 'child-count-out-of-bounds', count, min: bounds.min, max: bounds.max },
        }),
      );
    }
  }

  return ok(expansion.children);
}

/**
 * Whether a node can be expanded at all, and into what.
 *
 * Exported for the UI, which has to grey out "expand" on a beat rather than let a user
 * discover the leaf by hitting an error.
 */
export function expandableInto(level: OutlineLevel): OutlineLevel | undefined {
  return childLevelOf(level);
}
