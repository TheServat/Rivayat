/**
 * Getting JSON out of text a language model produced.
 *
 * This exists because models do not reliably return bare JSON, even when asked, even
 * with a schema attached. Ollama in particular does not enforce JSON Schema for
 * `qwen3.5` or `gemma4` (docs/00-research.md §1), so the raw text arrives wrapped in
 * some combination of:
 *
 *   - a ```json fenced block
 *   - a `<think>…</think>` reasoning preamble
 *   - conversational padding ("Sure! Here is the JSON you asked for:")
 *   - a trailing comma, because the model was trained on JavaScript
 *
 * Every recovery step is **recorded**, not silently applied. Knowing that a model
 * needed three repairs on every call is how we decide it is unusable for structured
 * work - and that signal is lost if the extractor quietly cleans up after it.
 */

import { ValidationError, type Result, err, ok } from '@rv/shared-kernel';

/** What had to be done to the raw text before it parsed. */
export type ExtractionStep =
  | 'none'
  | 'stripped-think-block'
  | 'stripped-code-fence'
  | 'extracted-balanced-span'
  | 'removed-trailing-commas';

export interface Extraction {
  readonly value: unknown;
  /** In the order applied. Empty means the model returned clean JSON. */
  readonly steps: readonly ExtractionStep[];
  /** The substring that finally parsed. Useful when diagnosing a bad model. */
  readonly json: string;
}

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
/** An unterminated think block: the model ran out of budget mid-reasoning. */
const UNTERMINATED_THINK = /<think>[\s\S]*$/i;
const CODE_FENCE = /```(?:json|jsonc|json5)?\s*\n?([\s\S]*?)```/i;

/**
 * Extracts the first complete JSON value from model output.
 *
 * Returns a `Result` rather than throwing: a model returning prose is an expected
 * outcome that the repair loop handles, not a programmer error.
 */
export function extractJson(raw: string): Result<Extraction, ValidationError> {
  const steps: ExtractionStep[] = [];
  let text = raw;

  if (THINK_BLOCK.test(text)) {
    THINK_BLOCK.lastIndex = 0;
    text = text.replace(THINK_BLOCK, '');
    steps.push('stripped-think-block');
  } else if (
    UNTERMINATED_THINK.test(text) &&
    text.trimStart().toLowerCase().startsWith('<think>')
  ) {
    // Everything after an unclosed `<think>` is reasoning, so there is no JSON here.
    return err(
      new ValidationError({
        message: 'Model output is an unterminated reasoning block with no JSON',
        context: { rawLength: raw.length },
      }),
    );
  }

  const fenced = CODE_FENCE.exec(text);
  if (fenced?.[1] !== undefined) {
    text = fenced[1];
    steps.push('stripped-code-fence');
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return err(new ValidationError({ message: 'Model returned no content' }));
  }

  // Fast path: the whole thing is already valid JSON.
  const direct = tryParse(trimmed);
  if (direct.parsed) {
    return ok({ value: direct.value, steps, json: trimmed });
  }

  const span = findBalancedSpan(trimmed);
  if (span === undefined) {
    return err(
      new ValidationError({
        message: 'No JSON object or array found in model output',
        context: { preview: preview(raw) },
      }),
    );
  }

  steps.push('extracted-balanced-span');
  const spanParsed = tryParse(span);
  if (spanParsed.parsed) {
    return ok({ value: spanParsed.value, steps, json: span });
  }

  const decommaed = removeTrailingCommas(span);
  if (decommaed !== span) {
    const retry = tryParse(decommaed);
    if (retry.parsed) {
      steps.push('removed-trailing-commas');
      return ok({ value: retry.value, steps, json: decommaed });
    }
  }

  return err(
    new ValidationError({
      message: `Model output is not parseable JSON: ${spanParsed.reason}`,
      context: { preview: preview(span) },
    }),
  );
}

function tryParse(
  text: string,
): { parsed: true; value: unknown } | { parsed: false; reason: string } {
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch (caught: unknown) {
    return { parsed: false, reason: caught instanceof Error ? caught.message : String(caught) };
  }
}

/**
 * Finds the first balanced `{…}` or `[…]`, honouring string literals and escapes.
 *
 * A naive `indexOf('{')` / `lastIndexOf('}')` breaks on a brace inside a string value,
 * which is common the moment a character description mentions one.
 */
function findBalancedSpan(text: string): string | undefined {
  const start = firstStructuralIndex(text);
  if (start === -1) return undefined;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return undefined;
}

function firstStructuralIndex(text: string): number {
  const brace = text.indexOf('{');
  const bracket = text.indexOf('[');
  if (brace === -1) return bracket;
  if (bracket === -1) return brace;
  return Math.min(brace, bracket);
}

/**
 * Removes commas that sit immediately before a closing brace or bracket.
 *
 * String-aware, so a literal `",}"` inside a value survives.
 */
export function removeTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';

    if (escaped) {
      escaped = false;
      out += char;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      out += char;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (!inString && char === ',') {
      const next = nextNonWhitespace(text, i + 1);
      if (next === '}' || next === ']') continue; // drop it
    }
    out += char;
  }

  return out;
}

function nextNonWhitespace(text: string, from: number): string | undefined {
  for (let i = from; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (!/\s/.test(char)) return char;
  }
  return undefined;
}

function preview(text: string, length = 240): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= length ? collapsed : `${collapsed.slice(0, length)}…`;
}
