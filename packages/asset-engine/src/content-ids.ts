/**
 * Ids derived from content rather than from a clock.
 *
 * `Ids` in `@rv/contracts` mints prefixed ULIDs, and that is correct for anything with
 * an identity of its own - an asset, a version, a run. It is wrong for a **clip IR
 * fragment**, which the architecture stores by content hash precisely so that "two
 * assets that share a generated `idle` share it on disk" (`AnimationClip.irHash`). A
 * ULID inside the document would make every fragment unique by construction, the hash
 * would never collide, and the sharing would silently never happen.
 *
 * So a fragment's internal ids are a pure function of what the fragment *is*: the
 * archetype, the clip name and the motion parameters. No clock, no RNG - which is the
 * same determinism rule as everywhere else (CLAUDE.md #1), reached from the other side.
 *
 * The output is ULID-shaped because the id schemas in `@rv/contracts` validate the
 * shape, and a second id format would mean a second regex, a second column type and a
 * second thing for `Ids` to not know about.
 */

import { sha256 } from '@rv/shared-kernel';

/** Crockford base32, minus I/L/O/U - identical to the alphabet `ID_PREFIXES` validates. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY_LENGTH = 26;

/**
 * `<prefix>_<26 chars>` derived from `seed`.
 *
 * Collision resistance comes from sha256: 130 bits of the digest reach the output,
 * which is more than the 80 bits of randomness a real ULID carries.
 */
export function contentId<T extends string>(prefix: string, seed: string): T {
  const digest = sha256(seed);
  let body = '';
  for (let i = 0; i < BODY_LENGTH; i += 1) {
    // Two hex chars per output char: 8 bits folded into 5, which is uneven but
    // deterministic, and uniformity is not a property this needs.
    const byte = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16);
    // `charAt` rather than `[]`: it is typed as `string` where the index signature is
    // `string | undefined`, and the modulo already proved the index is in range.
    body += ALPHABET.charAt(byte % ALPHABET.length);
  }
  return `${prefix}_${body}` as T;
}
