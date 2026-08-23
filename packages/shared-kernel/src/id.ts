/**
 * Identifiers: prefixed, lexicographically sortable ULIDs.
 *
 * Format: `<prefix>_<26 chars Crockford base32>` e.g. `chr_01J8ZQ4E7K9M2N4P6R8T0V2W4X`
 *
 * Three properties we actually need:
 *  - **sortable** - the first 10 chars encode the millisecond timestamp, so ordering
 *    by id orders by creation. Useful for episode/scene/shot sequences and for
 *    database index locality.
 *  - **prefixed** - an id tells you what it identifies when it shows up in a log or a
 *    prompt. Combined with branded types this catches mix-ups at both ends.
 *  - **monotonic within a millisecond** - ids minted in a tight loop still sort in
 *    creation order, which matters when a whole shot list is created at once.
 */

import { getRandomValues } from 'node:crypto';
import type { Brand } from './brand';
import type { Clock, Instant } from './clock';
import { SystemClock } from './clock';
import { ValidationError } from './errors';

/** Crockford base32: no I, L, O or U, so ids survive being read aloud or retyped. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LENGTH = 32;
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10; // 80 bits

export type Ulid = Brand<string, 'Ulid'>;
export type PrefixedId<TPrefix extends string> = Brand<string, `Id:${TPrefix}`>;

const ID_PATTERN = /^[a-z][a-z0-9]{1,9}_[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(value: number): string {
  let remaining = value;
  let out = '';
  for (let i = 0; i < TIME_CHARS; i += 1) {
    const mod = remaining % ENCODING_LENGTH;
    out = ALPHABET[mod] + out;
    remaining = (remaining - mod) / ENCODING_LENGTH;
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 10 bytes -> 16 base32 chars, consumed 5 bits at a time.
  let bits = 0;
  let bitCount = 0;
  let out = '';
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      out += ALPHABET[(bits >>> bitCount) & 31];
    }
  }
  if (bitCount > 0) out += ALPHABET[(bits << (5 - bitCount)) & 31];
  return out.slice(0, RANDOM_CHARS);
}

/**
 * Mints ids. Stateful, because monotonicity within a millisecond requires memory.
 *
 * Inject one rather than reaching for a module-level singleton: tests need a
 * deterministic generator, and a replayed pipeline run must reproduce its ids.
 */
export class IdGenerator {
  readonly #clock: Clock;
  readonly #randomBytes: (size: number) => Uint8Array;
  #lastTime = -1;
  #lastRandom: Uint8Array = new Uint8Array(RANDOM_BYTES);

  constructor(
    clock: Clock = new SystemClock(),
    randomBytes: (size: number) => Uint8Array = defaultRandomBytes,
  ) {
    this.#clock = clock;
    this.#randomBytes = randomBytes;
  }

  ulid(): Ulid {
    const now = this.#clock.now() as number;
    if (now === this.#lastTime) {
      this.#lastRandom = incrementBytes(this.#lastRandom);
    } else {
      this.#lastTime = now;
      this.#lastRandom = this.#randomBytes(RANDOM_BYTES);
    }
    return (encodeTime(now) + encodeRandom(this.#lastRandom)) as Ulid;
  }

  /** `next('chr')` -> `chr_01J8ZQ...`. The prefix must be lowercase alphanumeric. */
  next<TPrefix extends string>(prefix: TPrefix): PrefixedId<TPrefix> {
    if (!/^[a-z][a-z0-9]{1,9}$/.test(prefix)) {
      throw new ValidationError({
        message: `Invalid id prefix "${prefix}": expected 2-10 lowercase alphanumerics starting with a letter`,
      });
    }
    return `${prefix}_${this.ulid()}` as PrefixedId<TPrefix>;
  }
}

function defaultRandomBytes(size: number): Uint8Array {
  return getRandomValues(new Uint8Array(size));
}

/** Big-endian increment with carry, so monotonic ids keep sorting correctly. */
function incrementBytes(bytes: Uint8Array): Uint8Array {
  const next = Uint8Array.from(bytes);
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const value = next[i] ?? 0;
    if (value < 0xff) {
      next[i] = value + 1;
      return next;
    }
    next[i] = 0;
  }
  // Overflowed 80 bits within one millisecond. Not reachable in practice.
  return defaultRandomBytes(RANDOM_BYTES);
}

// ── parsing ─────────────────────────────────────────────────────────────────

export function isPrefixedId(value: unknown): value is PrefixedId<string> {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function prefixOf(id: PrefixedId<string>): string {
  return id.slice(0, id.indexOf('_'));
}

/** Recovers the creation instant encoded in the id. */
export function timestampOf(id: PrefixedId<string> | Ulid): Instant {
  const ulid = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
  let time = 0;
  for (let i = 0; i < TIME_CHARS; i += 1) {
    const index = ALPHABET.indexOf(ulid[i] ?? '');
    if (index < 0) {
      throw new ValidationError({ message: `Malformed id, bad time component: ${String(id)}` });
    }
    time = time * ENCODING_LENGTH + index;
  }
  return time as Instant;
}
