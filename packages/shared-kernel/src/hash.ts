/**
 * Content hashing.
 *
 * This is load-bearing. The whole "never generate the same asset twice" guarantee
 * reduces to: two logically identical specs must hash identically, and two different
 * specs must not. `JSON.stringify` cannot be used for that - its key order follows
 * insertion order, so `{a:1,b:2}` and `{b:2,a:1}` would produce different hashes and
 * silently duplicate an expensive generation.
 */

import { createHash } from 'node:crypto';
import type { Brand } from './brand';
import { ValidationError } from './errors';

export type Sha256 = Brand<string, 'Sha256'>;

export function sha256(data: string | Uint8Array): Sha256 {
  return createHash('sha256').update(data).digest('hex') as Sha256;
}

/** First `length` hex chars - for directory shards and human-facing short refs. */
export function shortHash(hash: Sha256, length = 12): string {
  return hash.slice(0, length);
}

/** `<first two hex chars>/<full hash>` - the content-addressed store's layout. */
export function shardPath(hash: Sha256): string {
  return `${hash.slice(0, 2)}/${hash}`;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Canonical JSON: object keys sorted, `undefined` members dropped, no whitespace.
 *
 * Deliberately strict - it throws rather than silently coercing, because a value that
 * cannot be canonicalised cannot be part of a cache key without risking a collision.
 */
export function stableStringify(value: unknown): string {
  return write(value, new WeakSet<object>(), '$');
}

function write(value: unknown, seen: WeakSet<object>, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new ValidationError({
          message: `Cannot canonicalise non-finite number at ${path}: ${String(value)}`,
        });
      }
      // Normalise -0 to 0 so the two hash alike.
      return Object.is(value, -0) ? '0' : String(value);
    case 'bigint':
      return `"${value.toString()}n"`;
    case 'undefined':
      throw new ValidationError({ message: `Cannot canonicalise undefined at ${path}` });
    case 'function':
    case 'symbol':
      throw new ValidationError({
        message: `Cannot canonicalise ${typeof value} at ${path}`,
      });
    case 'object':
      break;
  }

  const objectValue: object = value;
  if (seen.has(objectValue)) {
    throw new ValidationError({ message: `Cannot canonicalise circular structure at ${path}` });
  }
  seen.add(objectValue);

  try {
    if (Array.isArray(objectValue)) {
      const parts = objectValue.map((item, index) =>
        item === undefined ? 'null' : write(item, seen, `${path}[${String(index)}]`),
      );
      return `[${parts.join(',')}]`;
    }

    if (objectValue instanceof Date) return JSON.stringify(objectValue.toISOString());
    if (objectValue instanceof Uint8Array) return JSON.stringify(bytesToHex(objectValue));

    // Sorted by code unit, which is stable across engines and locales.
    const record = objectValue as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const member = record[key];
      if (member === undefined) continue; // absent and explicitly-undefined must agree
      parts.push(`${JSON.stringify(key)}:${write(member, seen, `${path}.${key}`)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(objectValue);
  }
}

/** The dedup primitive: a stable hash of any canonicalisable value. */
export function contentHash(value: unknown): Sha256 {
  return sha256(stableStringify(value));
}

/**
 * Hash of several components, unambiguously delimited.
 *
 * Length-prefixing prevents the classic concatenation collision where
 * `["ab","c"]` and `["a","bc"]` would otherwise hash the same.
 */
export function compositeHash(...parts: readonly (string | Sha256)[]): Sha256 {
  return sha256(parts.map((part) => `${String(part.length)}:${part}`).join('|'));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
