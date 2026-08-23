/**
 * Turning a validation failure into a message the model can act on.
 *
 * The naive repair prompt - "that was invalid, try again" - mostly produces the same
 * output a second time. What works is being specific: name the field, say what was
 * wrong with it, and restate only the constraint that was broken.
 *
 * Issues are also **capped and grouped**. Handing a model forty issues at once makes it
 * rewrite the whole document and introduce new errors; handing it the first few makes
 * it patch them.
 */

import type { z } from 'zod';

const MAX_ISSUES_SHOWN = 8;

export interface RepairMessage {
  readonly content: string;
  readonly issueCount: number;
  /** The paths named in the message, for logging which fields a model struggles with. */
  readonly paths: readonly string[];
}

/**
 * Builds the user turn that follows a rejected response.
 *
 * `previousOutput` is deliberately *not* included: it is already in the conversation as
 * the assistant turn, and repeating it doubles the token cost of every repair.
 */
export function buildRepairMessage(error: z.ZodError): RepairMessage {
  const issues = error.issues;
  const shown = issues.slice(0, MAX_ISSUES_SHOWN);
  const paths = shown.map((issue) => formatPath(issue.path));

  const lines = shown.map((issue) => `- \`${formatPath(issue.path)}\`: ${describe(issue)}`);

  const overflow =
    issues.length > MAX_ISSUES_SHOWN
      ? `\n\n(${String(issues.length - MAX_ISSUES_SHOWN)} further problems were omitted; fix these first.)`
      : '';

  const content = [
    'Your previous response did not satisfy the required schema. Fix exactly these problems:',
    '',
    ...lines,
    overflow,
    '',
    'Return the corrected JSON only. No explanation, no code fence, no commentary.',
    'Keep every field that was already correct unchanged.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { content, issueCount: issues.length, paths };
}

/**
 * A human-readable description of one issue.
 *
 * Zod's own message is usually good; this adds the *expected* shape where Zod only says
 * something is wrong, because "expected one of: a, b, c" repairs far more reliably than
 * "invalid value".
 */
function describe(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `expected ${issue.expected}, received ${describeReceived(issue)}`;
    case 'invalid_value': {
      const values = issue.values.map((value) => JSON.stringify(value)).join(', ');
      return `must be one of: ${values}`;
    }
    case 'too_small':
      return `too small: minimum is ${String(issue.minimum)}${issue.inclusive === false ? ' (exclusive)' : ''}`;
    case 'too_big':
      return `too large: maximum is ${String(issue.maximum)}${issue.inclusive === false ? ' (exclusive)' : ''}`;
    case 'unrecognized_keys':
      return `remove these unexpected keys: ${issue.keys.join(', ')}`;
    case 'invalid_union':
      return 'does not match any allowed variant; check the discriminator field';
    case 'invalid_format':
      return `wrong format: expected ${issue.format}`;
    default:
      return issue.message;
  }
}

function describeReceived(issue: z.core.$ZodIssueInvalidType): string {
  const received = (issue as { received?: string }).received;
  return received ?? 'something else';
}

/** `$.characters[2].voice.register` - the form a model can locate in its own output. */
export function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '$';
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${String(segment)}]`;
    return `${acc}.${String(segment)}`;
  }, '$');
}

/**
 * The instruction appended when a backend cannot constrain generation itself.
 *
 * Kept separate from the schema so it can be tuned without touching schema emission,
 * and so its cost is visible: every non-enforcing backend pays for these tokens on
 * every call.
 */
export function buildSchemaInstruction(jsonSchema: Record<string, unknown>): string {
  return [
    'Respond with a single JSON value that validates against this JSON Schema.',
    'Output the JSON only: no prose before or after, no markdown code fence.',
    '',
    JSON.stringify(jsonSchema),
  ].join('\n');
}
