/**
 * Prompt templates with typed variables and a stable rendering.
 *
 * Two reasons this is a module rather than template literals at the call site:
 *
 *  1. **Cache keys.** The response cache is keyed on a hash of the rendered prompt, so
 *     rendering has to be deterministic and canonical. Interpolating an object with
 *     `${}` gives `[object Object]`; interpolating one with `JSON.stringify` gives a
 *     different string depending on key order, which silently halves the hit rate.
 *  2. **Missing variables must fail loudly.** A `${undefined}` in a prompt becomes the
 *     literal text "undefined", the model does its best with it, and the result is a
 *     subtly wrong asset nobody traces back to a typo.
 */

import { ValidationError, stableStringify, contentHash, type Sha256 } from '@rv/shared-kernel';

/** Values a template variable may hold. Anything else must be formatted by the caller. */
export type TemplateValue = string | number | boolean | readonly TemplateValue[] | object;

export type TemplateVars = Readonly<Record<string, TemplateValue>>;

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export interface RenderedPrompt {
  readonly text: string;
  /** Hash of the rendered text. The cache key, and the provenance record. */
  readonly hash: Sha256;
}

/**
 * A named, reusable prompt.
 *
 * `TVars` is the shape the template requires; supplying anything else is a compile
 * error, and supplying a subset is a runtime one.
 */
export class PromptTemplate<TVars extends TemplateVars = TemplateVars> {
  readonly name: string;
  readonly source: string;
  readonly #required: readonly string[];

  constructor(name: string, source: string) {
    this.name = name;
    this.source = source;
    this.#required = [...new Set([...source.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''))];
  }

  /** The variable names this template consumes, in first-appearance order. */
  get variables(): readonly string[] {
    return this.#required;
  }

  render(vars: TVars): RenderedPrompt {
    const missing = this.#required.filter((name) => !(name in vars));
    if (missing.length > 0) {
      throw new ValidationError({
        message: `Prompt template "${this.name}" is missing: ${missing.join(', ')}`,
        context: { template: this.name, missing },
      });
    }

    const text = this.source.replace(PLACEHOLDER, (_match, rawName: string) =>
      formatValue((vars as TemplateVars)[rawName]),
    );

    return { text, hash: contentHash(text) };
  }
}

/**
 * Canonical rendering of a value inside a prompt.
 *
 * Arrays become bullet lists because models follow a list far better than a
 * comma-joined blob, and objects go through `stableStringify` so key order cannot
 * change the hash.
 */
function formatValue(value: TemplateValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => `- ${formatValue(item as TemplateValue)}`).join('\n');
  }
  return stableStringify(value);
}

/**
 * Composes several fragments into one prompt body.
 *
 * Empty and whitespace-only fragments are dropped rather than emitted as blank
 * sections - a prompt with three empty headings reads to the model as an instruction
 * to leave those things out.
 */
export function composePrompt(...fragments: readonly (string | undefined | null)[]): string {
  return fragments
    .filter(
      (fragment): fragment is string => typeof fragment === 'string' && fragment.trim() !== '',
    )
    .map((fragment) => fragment.trim())
    .join('\n\n');
}

/** A titled block, skipped entirely when the body is empty. */
export function section(title: string, body: string | undefined | null): string | undefined {
  if (typeof body !== 'string' || body.trim() === '') return undefined;
  return `## ${title}\n${body.trim()}`;
}
