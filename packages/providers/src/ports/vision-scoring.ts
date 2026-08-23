/**
 * Scoring a generated image against a rubric derived from the StyleBible.
 *
 * This is the quality gate of architecture §5: style match, alpha cleanliness,
 * silhouette readability, identity match against the anchors, part completeness.
 *
 * ## Why this port parses its own JSON, and why that is flagged rather than hidden
 *
 * CLAUDE.md #6 says JSON only ever comes out of a model through `StructuredCall`.
 * `StructuredCall` drives a `StructuredBackend`, whose `CompletionRequest` carries
 * `PromptMessage[]` - and a `PromptMessage` is `{ role, content: string }`. There is
 * no image channel, so a scoring call physically cannot travel through it today.
 *
 * The compromise: this port makes **one** attempt and reuses `extractJson` from
 * `@rv/prompt-kit` - the same fence/think-block stripper the sanctioned path uses, so
 * the research §1 symptom is handled identically - then validates with Zod and returns
 * a typed `ValidationError` on failure. It deliberately does **not** re-implement the
 * repair/escalate loop; duplicating it here is how the two copies drift apart.
 *
 * The real fix belongs upstream: add `images?: readonly ImagePayload[]` to
 * `PromptMessage`, and this port collapses into an ordinary `StructuredCall`.
 */

import { z } from 'zod';
import { type AppError, type Result, ValidationError, err, isErr, ok } from '@rv/shared-kernel';
import { extractJson } from '@rv/prompt-kit';

import type { ImagePayload, ProviderCallResult } from './common';

/** One question the scorer must answer, with the weight it carries in the overall. */
export interface VisionRubricCriterion {
  /** Machine key, e.g. `style-match`. Becomes a property name in the score sheet. */
  readonly key: string;
  /** What "good" means, in the words the StyleBible used. */
  readonly question: string;
  /** Relative weight. Defaults to 1 when omitted. */
  readonly weight?: number;
}

export interface VisionScoringRequest {
  readonly image: ImagePayload;
  readonly rubric: readonly VisionRubricCriterion[];
  /** Style anchors or a character turnaround to compare the image against. */
  readonly references?: readonly ImagePayload[];
  readonly signal?: AbortSignal;
}

export interface VisionScore {
  readonly key: string;
  /** 0..1. Normalised so a rubric can gain a criterion without moving the threshold. */
  readonly score: number;
  readonly reason: string;
}

export interface VisionScoringResult extends ProviderCallResult {
  readonly scores: readonly VisionScore[];
  /** Weighted mean of `scores`. This is the number the gate compares to a threshold. */
  readonly overall: number;
}

export interface VisionScoringPort {
  score(request: VisionScoringRequest): Promise<Result<VisionScoringResult, AppError>>;
}

/**
 * The shape the scoring model is asked for.
 *
 * Kept here rather than in `@rv/contracts` because it is not a domain shape - it is
 * the wire format of one prompt, and the domain only ever sees `VisionScoringResult`.
 */
export const VisionScoreSheet = z.object({
  scores: z
    .array(
      z.object({
        key: z.string().min(1),
        score: z.number().min(0).max(1),
        reason: z.string().min(1).max(600),
      }),
    )
    .min(1),
});
export type VisionScoreSheet = z.infer<typeof VisionScoreSheet>;

/**
 * Renders the rubric as an instruction.
 *
 * Shared by every vision-capable adapter so that a score from Ollama and a score from
 * Gemini answer the same question - otherwise the quality gate's threshold means a
 * different thing depending on which lane produced the image.
 */
export function buildRubricPrompt(rubric: readonly VisionRubricCriterion[]): string {
  const lines = rubric.map((criterion) => `- "${criterion.key}": ${criterion.question}`);
  return [
    'Score the attached image against each criterion below.',
    '',
    ...lines,
    '',
    'Reply with JSON only, no prose and no markdown fence:',
    '{"scores":[{"key":"<criterion key>","score":<0..1>,"reason":"<one short sentence>"}]}',
    'Include every criterion exactly once. `score` is a number between 0 and 1.',
  ].join('\n');
}

/**
 * Turns raw model text into scores, or a typed failure.
 *
 * Missing criteria are an error rather than a zero: a gate that silently scores an
 * unanswered criterion as 0 fails good assets, and one that scores it as 1 passes bad
 * ones. Both are worse than saying the model did not answer.
 */
export function parseScoreSheet(
  raw: string,
  rubric: readonly VisionRubricCriterion[],
): Result<{ scores: readonly VisionScore[]; overall: number }, AppError> {
  const extraction = extractJson(raw);
  if (isErr(extraction)) return err(extraction.error);

  const parsed = VisionScoreSheet.safeParse(extraction.value.value);
  if (!parsed.success) {
    return err(
      new ValidationError({
        message: 'vision score sheet did not validate',
        context: { paths: parsed.error.issues.map((issue) => issue.path.join('.')) },
      }),
    );
  }

  const byKey = new Map(parsed.data.scores.map((entry) => [entry.key, entry]));
  const scores: VisionScore[] = [];
  const missing: string[] = [];
  let weighted = 0;
  let totalWeight = 0;

  for (const criterion of rubric) {
    const entry = byKey.get(criterion.key);
    if (entry === undefined) {
      missing.push(criterion.key);
      continue;
    }
    const weight = criterion.weight ?? 1;
    scores.push({ key: entry.key, score: entry.score, reason: entry.reason });
    weighted += entry.score * weight;
    totalWeight += weight;
  }

  if (missing.length > 0) {
    return err(
      new ValidationError({
        message: 'vision score sheet omitted rubric criteria',
        context: { missing },
      }),
    );
  }

  return ok({ scores, overall: totalWeight === 0 ? 0 : weighted / totalWeight });
}
