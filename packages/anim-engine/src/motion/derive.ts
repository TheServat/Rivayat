/**
 * Ids and seeds derived from what a request *is*, never from a clock or an RNG.
 *
 * A provider that minted a ULID would make authoring the same request twice produce two
 * documents that differ only in their identifiers - which defeats content addressing,
 * makes every diff enormous, and means the same motion is stored once per call. So the
 * identity of an authored record is a pure function of the request key, the target and
 * the record's position in it.
 *
 * The output is ULID-shaped because the id schemas in `@rv/contracts` validate the
 * shape. `@rv/asset-engine` needs the same function for the same reason and has its own
 * copy (`content-ids.ts`); the honest home for it is `@rv/shared-kernel`, and moving it
 * there is a change to a package this work does not own.
 */

import { hashSeed, sha256 } from '@rv/shared-kernel';

/** Crockford base32, minus I/L/O/U - the alphabet the id schemas validate. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY_LENGTH = 26;

/** `<prefix>_<26 chars>`, derived from `seed`. */
export function deriveId<T extends string>(prefix: string, seed: string): T {
  const digest = sha256(seed);
  let body = '';
  for (let index = 0; index < BODY_LENGTH; index += 1) {
    const byte = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
    body += ALPHABET.charAt(byte % ALPHABET.length);
  }
  return `${prefix}_${body}` as T;
}

/**
 * A behaviour seed derived from the request's root seed and the record's address.
 *
 * The IR's own docstring asks for exactly this - "derive it from the node id, never at
 * random" - and until now nothing enforced it. Threading the root seed through means two
 * trees in one request gust differently while the whole request replays identically.
 */
export function deriveSeed(parts: readonly (string | number)[]): number {
  return hashSeed(parts.map((part) => String(part)).join(':'));
}
