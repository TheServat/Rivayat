/**
 * Shared test scaffolding for the story contracts.
 *
 * Kept out of the spec files so that all four of them agree on what a well-formed id
 * looks like: a fixture that quietly uses a malformed id turns every downstream
 * assertion into a test of the id regex instead of a test of the thing under test.
 */

/**
 * A deterministic, well-formed prefixed ULID.
 *
 * The timestamp half is frozen and the random half is a zero-padded counter, so the
 * same call always produces the same id and two different `n` never collide. Every
 * character stays inside Crockford base32.
 */
export function fixtureId(prefix: string, n: number): string {
  return `${prefix}_01JQZX5K9T${String(n).padStart(16, '0')}`;
}

interface SafeParseLike {
  readonly success: boolean;
  readonly error?: { readonly issues: readonly { readonly path: readonly PropertyKey[] }[] };
}

/**
 * The dotted paths of every issue in a failed parse.
 *
 * Asserting on paths rather than on messages is the point: the message wording belongs
 * to Zod and will change, while the path is the contract's own answer to "which field
 * did the model get wrong", which is what the repair loop actually reads.
 */
export function issuePaths(result: SafeParseLike): readonly string[] {
  return (result.error?.issues ?? []).map((issue) => issue.path.map(String).join('.'));
}
