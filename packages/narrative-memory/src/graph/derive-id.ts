/**
 * Content-derived ids, because a replay must mint the same id twice.
 *
 * Every id in the system is a prefixed ULID, and `IdGenerator` mints one from the wall
 * clock plus entropy. Neither is available here: CLAUDE.md non-negotiable #1 forbids
 * both in domain and application code, and a memory engine that minted a fresh
 * `RelationId` each time a scene was folded would make the same extraction produce a
 * different graph on every run - so nothing downstream could be diffed, cached or
 * replayed.
 *
 * So an id is a **function of what the thing says**. Folding the same delta twice
 * produces the same relation ids and therefore the same graph, which is the property
 * the fold and retrieval tests actually assert.
 *
 * The body is Crockford base32 (`0-9A-HJKMNP-TV-Z`, no I/L/O/U) so it satisfies the
 * same regex `@rv/contracts` validates a real ULID against. It is not time-ordered -
 * a derived id sorts by content, not by creation - which costs nothing here because
 * every ordering in this package is explicit.
 */

import { sha256 } from '@rv/shared-kernel';
import {
  ID_PREFIXES,
  type EntityId,
  type FactId,
  type IdKind,
  type IssueId,
  type OpenLoopId,
  type RelationId,
} from '@rv/contracts';

/** Crockford base32 - exactly the alphabet the ULID body regex admits. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_BODY_LENGTH = 26;

/**
 * A stable id for `kind`, derived from `seed`.
 *
 * Callers must include everything that distinguishes the thing in the seed - the
 * series, the scene, the subject, the assertion - because two things with the same
 * seed *are* the same thing as far as this function is concerned, and the second one
 * will silently overwrite the first.
 */
export function deriveId<T extends string>(kind: IdKind, seed: string): T {
  const digest = sha256(seed);
  let body = '';
  for (let index = 0; index < ULID_BODY_LENGTH; index += 1) {
    // Two hex chars per position, walked with wraparound: 26 positions need 52 hex
    // characters and sha256 gives 64, so there is no reuse in practice.
    const offset = (index * 2) % digest.length;
    const byte = Number.parseInt(digest.slice(offset, offset + 2), 16);
    body += CROCKFORD.charAt(byte % CROCKFORD.length);
  }
  return `${ID_PREFIXES[kind]}_${body}` as T;
}

export function deriveRelationId(seed: string): RelationId {
  return deriveId<RelationId>('relation', seed);
}

export function deriveFactId(seed: string): FactId {
  return deriveId<FactId>('fact', seed);
}

export function deriveIssueId(seed: string): IssueId {
  return deriveId<IssueId>('issue', seed);
}

export function deriveOpenLoopId(seed: string): OpenLoopId {
  return deriveId<OpenLoopId>('openLoop', seed);
}

export function deriveEntityId(seed: string): EntityId {
  return deriveId<EntityId>('entity', seed);
}

/**
 * Joins seed parts unambiguously.
 *
 * Length-prefixed rather than delimiter-joined: `['ab', 'c']` and `['a', 'bc']` must
 * not collide, and any delimiter can appear inside a fact sentence.
 */
export function seed(...parts: readonly string[]): string {
  return parts.map((part) => `${String(part.length)}:${part}`).join('|');
}
