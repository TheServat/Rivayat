/**
 * Turning domain values into prompt text, in one place.
 *
 * Every one of these exists because the naive version has a silent failure mode. An
 * empty array interpolated into a prompt renders as nothing, and "Verbal tics:" followed
 * by a blank line reads to a model as an instruction to have none - which is a different
 * statement from "this character has no recorded tics" and produces different output.
 * Likewise a bare `join(', ')` over prose fragments produces a wall the model skims;
 * a bulleted list it follows.
 */

/** Joins short labels for an inline slot, naming the empty case rather than vanishing. */
export function inlineList(items: readonly string[], empty = 'none recorded'): string {
  const kept = items.map((item) => item.trim()).filter((item) => item !== '');
  return kept.length === 0 ? empty : kept.join(', ');
}

/** One bullet per item, for anything longer than a few words. */
export function bulletList(items: readonly string[], empty = 'none recorded'): string {
  const kept = items.map((item) => item.trim()).filter((item) => item !== '');
  return kept.length === 0 ? empty : kept.map((item) => `- ${item}`).join('\n');
}

/** A numbered list, for anything whose order is load-bearing. */
export function orderedList(items: readonly string[], empty = 'none'): string {
  const kept = items.map((item) => item.trim()).filter((item) => item !== '');
  return kept.length === 0
    ? empty
    : kept.map((item, index) => `${String(index + 1)}. ${item}`).join('\n');
}

/** Substitutes a stated placeholder for an absent value, never the empty string. */
export function orElse(value: string | null | undefined, fallback: string): string {
  return value === null || value === undefined || value.trim() === '' ? fallback : value.trim();
}

/**
 * Collapses whitespace for comparison, not for display.
 *
 * Used where two strings have to be compared for *sameness of content* across a round
 * trip through a model - a re-emitted instruction that differs only in line wrapping is
 * the same instruction, and failing an expansion over it would be a false alarm.
 */
export function normaliseForComparison(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

/**
 * A lowercase, hyphenated key derived from a human label.
 *
 * Deterministic and total: anything that cannot contribute a character becomes a
 * position-stable fallback rather than an empty slug, because an empty slug is not a
 * legal `Slug` and would fail validation far from where the label was written.
 */
export function slugify(label: string, fallback = 'unnamed'): string {
  const slug = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug === '' ? fallback : slug;
}
