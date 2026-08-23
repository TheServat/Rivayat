/**
 * The `{{placeholder}}` substitution contract for ComfyUI API-format graphs.
 *
 * `tools/comfy-workflows/README.md` §4 specifies it and `tools/scripts/comfy-smoke.mjs`
 * is the reference implementation this file must match. Four rules, each of which
 * caused a real failure before it was written down:
 *
 *  1. **Typed whole-value substitution.** A string that is *exactly* `"{{seed}}"` for a
 *     numeric placeholder becomes a JSON **number**. ComfyUI type-checks INT/FLOAT node
 *     inputs and rejects `"steps": "4"`.
 *  2. **Textual interpolation everywhere else**, so a prompt scaffold can embed a
 *     placeholder mid-sentence.
 *  3. **No leftovers.** A surviving `{{...}}` fails loudly instead of being POSTed.
 *  4. **`_meta` is stripped.** Its `title` keys are documentation; ComfyUI ignores them.
 */

import { type Result, ValidationError, err, ok } from '@rv/shared-kernel';

/**
 * Placeholders whose value must arrive as a JSON number.
 *
 * Copied verbatim from `comfy-smoke.mjs`; a test asserts the two lists still agree,
 * because a silent divergence here produces a graph ComfyUI rejects with a message
 * that names the node rather than the cause.
 */
export const NUMERIC_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'seed',
  'steps',
  'cfg',
  'width',
  'height',
  'lora_strength',
  'batch_size',
  'denoise',
  'grid_cols',
  'grid_rows',
]);

export type PlaceholderValues = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/;

function substitute(node: unknown, values: PlaceholderValues, seen: Set<string>): unknown {
  if (typeof node === 'string') {
    const whole = WHOLE_PLACEHOLDER.exec(node);
    if (whole !== null) {
      const name = whole[1];
      if (name === undefined) return node;
      seen.add(name);
      const value = values[name];
      // Left as-is when unknown, so the leftover check below reports it by name.
      if (value === undefined) return node;
      return NUMERIC_PLACEHOLDERS.has(name) ? Number(value) : String(value);
    }
    return node.replace(PLACEHOLDER, (match, name: string) => {
      seen.add(name);
      const value = values[name];
      return value === undefined ? match : String(value);
    });
  }
  if (Array.isArray(node)) return node.map((item) => substitute(item, values, seen));
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = substitute(value, values, seen);
    }
    return out;
  }
  return node;
}

export interface BuiltGraph {
  /** The `prompt` object to POST, `_meta` removed. */
  readonly prompt: Record<string, unknown>;
  /** Every placeholder name the template referenced, sorted. For diagnostics. */
  readonly placeholders: readonly string[];
}

/**
 * Fills a workflow template.
 *
 * Returns a `Result` rather than throwing because a missing placeholder is a caller
 * mistake the pipeline should surface as a failed asset, not a crashed worker.
 */
export function buildGraph(
  workflow: unknown,
  values: PlaceholderValues,
): Result<BuiltGraph, ValidationError> {
  const seen = new Set<string>();
  const filled = substitute(workflow, values, seen);

  const leftovers = [...new Set(JSON.stringify(filled).match(PLACEHOLDER) ?? [])];
  if (leftovers.length > 0) {
    return err(
      new ValidationError({
        message: `ComfyUI workflow still contains unsubstituted placeholders: ${leftovers.join(', ')}`,
        context: { leftovers },
      }),
    );
  }

  if (filled === null || typeof filled !== 'object' || Array.isArray(filled)) {
    return err(
      new ValidationError({ message: 'ComfyUI workflow must be an object keyed by node id' }),
    );
  }

  const graph: Record<string, unknown> = filled as Record<string, unknown>;
  const prompt: Record<string, unknown> = {};
  for (const [nodeId, node] of Object.entries(graph)) {
    if (node === null || typeof node !== 'object') {
      prompt[nodeId] = node;
      continue;
    }
    const stripped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '_meta') continue;
      stripped[key] = value;
    }
    prompt[nodeId] = stripped;
  }

  return ok({ prompt, placeholders: [...seen].sort() });
}
