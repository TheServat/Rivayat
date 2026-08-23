/**
 * The rubric pass a draft has to clear before anything downstream spends money on it.
 *
 * Two decisions distinguish this from "ask a model if the story is good".
 *
 * **The rubric is data, not prose.** Its dimensions come from the {@link AgentRole} that
 * is answerable for them, and they are grounded in the evaluation literature prior-art §B
 * names - StoryER's reader-facing axes, ConStory-Bench's consistency axes (`rubrics.ts`
 * says which is which). A critic that invents its own questions each run produces scores
 * that cannot be compared between drafts, which is the only thing scores are for.
 *
 * **The schema is built from the rubric.** The `key` field is an enum of exactly this
 * rubric's keys and every one of them is required, so a critique that skips the
 * uncomfortable dimension is a schema violation and gets repaired by `StructuredCall`
 * rather than silently returning four scores out of five. That is what stops the critic
 * being a rubber stamp by omission.
 *
 * What comes back is findings, not an opinion: per dimension a score, the evidence it
 * rests on, and a concrete revision note. Whether to revise, accept, or surface to the
 * user is the orchestrator's decision, and it needs structure to make it.
 */

import { z } from 'zod';
import { Prose, Unit01 } from '@rv/contracts';
import { PromptTemplate, type StructuredTrace } from '@rv/prompt-kit';
import { type AppError, type Result, ValidationError, err, isErr, ok } from '@rv/shared-kernel';

import type { AgentRole, RubricDimension } from '../roles/role';
import { describeRubric } from '../roles/rubrics';
import {
  ARC_MOVEMENT,
  PREMISE_CLARITY,
  SCENE_CAUSALITY,
  STAKES,
  STYLE_FIT,
} from '../roles/rubrics';
import { bulletList, orElse } from '../support/format';
import { type StoryEngineDeps, runRoleCall } from '../support/stage-call';

/** RV-088's five dimensions, in the order the acceptance criterion lists them. */
export const STORY_BIBLE_RUBRIC: readonly RubricDimension[] = [
  PREMISE_CLARITY,
  STAKES,
  ARC_MOVEMENT,
  SCENE_CAUSALITY,
  STYLE_FIT,
];

// ── the report shape ────────────────────────────────────────────────────────

export interface RubricScore {
  readonly key: string;
  readonly score: number;
  readonly verdict: string;
  readonly evidence: readonly string[];
  readonly revisionNote: string;
}

export interface CritiqueReport {
  readonly scores: readonly RubricScore[];
  readonly strongest: string;
  readonly weakest: string;
}

/**
 * Builds the schema for one specific rubric.
 *
 * Dynamic because the rubric is: a character design is scored on silhouette readability
 * and a story bible is not, and a shared schema listing every dimension in the package
 * would ask a critic about questions its role has no standing to answer.
 */
export function critiqueReportSchema(
  rubric: readonly RubricDimension[],
): z.ZodType<CritiqueReport> {
  const keys = rubric.map((dimension) => dimension.key);
  const [first, ...rest] = keys;
  if (first === undefined) {
    throw new ValidationError({
      message: 'A critique needs at least one rubric dimension to score',
      context: { reason: 'empty-rubric' },
    });
  }

  const score = z.strictObject({
    key: z.enum([first, ...rest]).describe('Which rubric dimension this scores.'),
    score: Unit01.describe(
      'The score, 0 to 1. Use the whole range: a draft that scores 0.8 on everything has ' +
        'not been read.',
    ),
    verdict: Prose.describe('One or two sentences saying what the score is for.'),
    evidence: z
      .array(Prose)
      .min(1)
      .max(6)
      .describe(
        'Quote or point at the specific places in the draft that produced this score. A ' +
          'score with no evidence is a vote.',
      ),
    revisionNote: Prose.describe(
      'The one change that would most raise this score, stated as an instruction someone ' +
        'could carry out. Write "no change needed" when there is none.',
    ),
  });

  return z
    .strictObject({
      scores: z
        .array(score)
        .min(rubric.length)
        .max(rubric.length)
        .describe('One entry per rubric dimension. All of them, including the awkward ones.'),
      strongest: Prose.describe('What this draft does best, in one sentence.'),
      weakest: Prose.describe('What most needs work, in one sentence.'),
    })
    .superRefine((report, ctx) => {
      const seen = new Set(report.scores.map((entry) => entry.key));
      const missing = keys.filter((key) => !seen.has(key));
      if (missing.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['scores'],
          message: `every rubric dimension must be scored; missing: ${missing.join(', ')}`,
        });
      }
      if (seen.size !== report.scores.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['scores'],
          message: 'a dimension may only be scored once',
        });
      }
    });
}

// ── prompt ──────────────────────────────────────────────────────────────────

const CRITIQUE_PROMPT = new PromptTemplate<{
  readonly subjectLabel: string;
  readonly rubric: string;
  readonly thresholds: string;
  readonly context: string;
  readonly draft: string;
}>(
  'critique.rubric',
  [
    'You are reviewing a {{subjectLabel}} before anyone spends money making it. Score it',
    'against the rubric below and nothing else - this is not the place for notes on things',
    'the rubric does not ask about.',
    '',
    '## The rubric',
    '{{rubric}}',
    '',
    '## What counts as failing',
    '{{thresholds}}',
    '',
    'Score honestly. A draft that scores above the threshold on every dimension is a draft',
    'that goes into production, so a generous score here is a bill later. If something is',
    'genuinely good, say so with evidence; if it is competent and inert, that is a low',
    'engagement score, not a high one.',
    '',
    '## Context',
    '{{context}}',
    '',
    '## The draft',
    '{{draft}}',
  ].join('\n'),
);

// ── the use-case ────────────────────────────────────────────────────────────

export interface CritiqueDraftInput {
  /**
   * The role answerable for these dimensions.
   *
   * It supplies the system prompt and - through `stage`, `task` and `tier` - the routing,
   * so the cost of critiquing a shot list lands on the sequence stage's ledger rather than
   * on a generic "critique" line nobody can attribute.
   */
  readonly role: AgentRole;
  /** Overrides `role.rubric`. For a pass that scores a subset, or adds a canon dimension. */
  readonly rubric?: readonly RubricDimension[];
  /** What is being reviewed, in words: "series bible", "shot list for scene 4". */
  readonly subjectLabel: string;
  /** The draft itself, rendered. Whatever a reader would need to judge it. */
  readonly draft: string;
  /** Anything the reviewer needs that is not in the draft - the brief, the style, canon. */
  readonly context?: string;
  /** Overrides every dimension's own `failsBelow`. Use sparingly. */
  readonly threshold?: number;
  readonly signal?: AbortSignal;
}

export interface CritiqueFinding {
  readonly dimension: RubricDimension;
  readonly score: number;
  readonly verdict: string;
  readonly evidence: readonly string[];
  readonly revisionNote: string;
  /** True when the score is below the threshold this dimension is held to. */
  readonly blocking: boolean;
}

export interface CritiqueResult {
  readonly subjectLabel: string;
  readonly findings: readonly CritiqueFinding[];
  /** The subset that failed. Empty means the draft may proceed. */
  readonly blocking: readonly CritiqueFinding[];
  /** Unweighted mean across the rubric. A summary, never the accept/reject decision. */
  readonly overall: number;
  readonly accepted: boolean;
  readonly strongest: string;
  readonly weakest: string;
  readonly trace: StructuredTrace;
}

export class CritiqueDraftUseCase {
  readonly #deps: StoryEngineDeps;

  constructor(deps: StoryEngineDeps) {
    this.#deps = deps;
  }

  async execute(input: CritiqueDraftInput): Promise<Result<CritiqueResult, AppError>> {
    const rubric = input.rubric ?? input.role.rubric;
    if (rubric.length === 0) {
      return err(
        new ValidationError({
          message: `Role "${input.role.id}" carries no rubric, so there is nothing to score`,
          context: { reason: 'empty-rubric', role: input.role.id },
        }),
      );
    }

    const outcome = await runRoleCall<CritiqueReport>(this.#deps, {
      role: input.role,
      schemaName: 'CritiqueReport',
      schema: critiqueReportSchema(rubric),
      user: CRITIQUE_PROMPT.render({
        subjectLabel: input.subjectLabel,
        rubric: describeRubric(rubric),
        thresholds: bulletList(
          rubric.map(
            (dimension) =>
              `\`${dimension.key}\` fails below ${(input.threshold ?? dimension.failsBelow).toFixed(2)}`,
          ),
        ),
        context: orElse(input.context, 'No additional context supplied.'),
        draft: input.draft,
      }).text,
      // Zero, unconditionally. A critic that samples is a critic whose verdict changes
      // between two runs over the same draft, and then the score history means nothing.
      temperature: 0,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (isErr(outcome)) return outcome;

    const findings = toFindings(outcome.value.value, rubric, input.threshold);
    const blocking = findings.filter((finding) => finding.blocking);
    const overall =
      findings.reduce((total, finding) => total + finding.score, 0) / Math.max(1, findings.length);

    return ok({
      subjectLabel: input.subjectLabel,
      findings,
      blocking,
      overall,
      accepted: blocking.length === 0,
      strongest: outcome.value.value.strongest,
      weakest: outcome.value.value.weakest,
      trace: outcome.value.trace,
    });
  }
}

/**
 * Joins the scores back to the questions that produced them.
 *
 * In rubric order, not in the order the model happened to answer, so two critiques of two
 * drafts line up row for row.
 */
export function toFindings(
  report: CritiqueReport,
  rubric: readonly RubricDimension[],
  threshold?: number,
): readonly CritiqueFinding[] {
  const byKey = new Map(report.scores.map((entry) => [entry.key, entry]));
  const findings: CritiqueFinding[] = [];

  for (const dimension of rubric) {
    const entry = byKey.get(dimension.key);
    // The schema requires every dimension, so an absent one only happens when a caller
    // passes a report built elsewhere. Skipped rather than defaulted: a missing score is
    // not a zero, and recording it as one would fabricate a blocking finding.
    if (entry === undefined) continue;
    findings.push({
      dimension,
      score: entry.score,
      verdict: entry.verdict,
      evidence: entry.evidence,
      revisionNote: entry.revisionNote,
      blocking: entry.score < (threshold ?? dimension.failsBelow),
    });
  }

  return findings;
}
