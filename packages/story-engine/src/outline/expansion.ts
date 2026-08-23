/**
 * What one DOC expansion returns, and what makes it acceptable.
 *
 * The schema is as important for what it *lacks* as for what it declares: an
 * `OutlineChildDraft` has no `children` field. A model asked to expand a season into
 * episodes therefore cannot emit acts, however much it wants to - not because it was told
 * not to, but because there is nowhere to put them. That is the structural half of "never
 * jump a level"; `checkSingleLevelDescent` in `levels.ts` is the other half.
 *
 * `parentPlanEcho` is the binding. Every expansion has to quote back the instruction it
 * was working from, and the use-case refuses an expansion whose echo does not match what
 * was actually sent. It is a cheap check and it catches the expensive failure: a response
 * that is coherent, well-formed, and about a different node.
 */

import { z } from 'zod';
import { Label, PositiveInt, Prose } from '@rv/contracts';

/**
 * One child node, as the parent's expansion describes it.
 *
 * `plannedSummary` and `summary` are both required and both mean something different.
 * The first is the job this child is being given; the second is what it actually
 * contains at this level of detail. Writers collapse them into one field the moment
 * they are allowed to, and then nothing downstream can measure drift.
 */
export const OutlineChildDraft = z.strictObject({
  ordinal: PositiveInt.describe(
    'Position among siblings, starting at 1. Contiguous - no gaps, no duplicates.',
  ),
  title: Label.describe('A short working name. Not shown to the audience below episode level.'),
  plannedSummary: Prose.describe(
    'The instruction you are giving this child: what it must accomplish for its parent. ' +
      'Write it as a brief to someone who will expand it later and cannot see this ' +
      'conversation.',
  ),
  summary: Prose.describe(
    'What this node contains, at this level of detail. Describe what happens, not what it ' +
      'is about. It may differ from plannedSummary; do not edit one to match the other.',
  ),
  servesParentPlanBy: Prose.describe(
    "One sentence naming which part of the parent's instruction this child discharges. If " +
      'you cannot name one, this child does not belong in the expansion.',
  ),
  movesEntityNames: z
    .array(Label)
    .max(24)
    .default([])
    .describe(
      'Who or what this node changes the situation of, by name. Used to check that the ' +
        'expansion is about somebody.',
    ),
});
export type OutlineChildDraft = z.infer<typeof OutlineChildDraft>;

/**
 * One level of expansion.
 *
 * The ordinal contiguity check lives in the schema rather than in the use-case on purpose:
 * `StructuredCall`'s repair loop can fix a list numbered 1, 2, 2 if it is told about it,
 * and a check the schema owns is a check the model gets a second chance at for free.
 */
export const OutlineExpansion = z
  .strictObject({
    parentPlanEcho: Prose.describe(
      'The instruction you were given for the node you are expanding, copied back word for ' +
        'word. Do not summarise it, improve it, or translate it.',
    ),
    children: z
      .array(OutlineChildDraft)
      .min(1)
      .max(32)
      .describe('The immediate children of this node, in playing order. Nothing deeper.'),
  })
  .superRefine((expansion, ctx) => {
    const ordinals = expansion.children.map((child) => child.ordinal);
    const sorted = [...ordinals].sort((a, b) => a - b);
    const expected = ordinals.map((_, index) => index + 1);
    if (sorted.some((value, index) => value !== expected[index])) {
      ctx.addIssue({
        code: 'custom',
        path: ['children'],
        message: `children must be numbered 1..${String(ordinals.length)} with no gaps or duplicates, got [${ordinals.join(', ')}]`,
      });
    }
  });
export type OutlineExpansion = z.infer<typeof OutlineExpansion>;
