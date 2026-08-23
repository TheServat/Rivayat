/**
 * The dedup key. This file is the whole of non-negotiable #2.
 *
 * `key = hash(semanticKey ‖ styleChecksum ‖ variantKey ‖ specHash)`
 *
 * Two properties have to hold, and both are bought rather than hand-rolled:
 *
 * - **Order-insensitivity.** Two specs that differ only in the order their fields
 *   were written must produce the same key, or we pay twice for one oak tree.
 *   `stableStringify` sorts object keys, and {@link canonicalSpecBody} additionally
 *   sorts the spec's *set-like* arrays, because `['bark','moss']` and
 *   `['moss','bark']` describe the same asset and JSON array order does not know that.
 * - **Collision-resistance across the four components.** Naive concatenation makes
 *   `("ab","c")` and `("a","bc")` collide, which would serve one asset in place of
 *   another. `compositeHash` length-prefixes each component, so it cannot happen.
 *
 * The asymmetry that governs {@link computeSpecHash}: hashing a field twice is
 * harmless (it only ever costs a redundant byte), while *omitting* a field that
 * changes the output is silent corruption - the registry hands back an asset that
 * was made from a different request. So the exclusion list is exactly the spec
 * fields that are already key components in their own right, and nothing else.
 */

import { compositeHash, contentHash, stableStringify } from '@rv/shared-kernel';
import {
  AssetKey,
  type AssetKeyParts,
  type AssetSpec,
  type Sha256Hex,
  type Slug,
} from '@rv/contracts';

/** The variant key of an asset that is not a variant of anything. */
export const BASE_VARIANT_KEY = 'base';

/**
 * Spec fields that are key components on their own and are therefore left out of
 * `specHash`.
 *
 * Exported so the test can enumerate `AssetSpec`'s shape and prove that *every other*
 * field still moves the hash. Adding a field to `AssetSpec` without touching this list
 * is the safe default; adding one *to* this list without also making it a component of
 * {@link computeAssetKey} is the bug this constant exists to make visible.
 */
export const SPEC_FIELDS_ALREADY_IN_KEY = [
  'semanticKey',
] as const satisfies readonly (keyof AssetSpec)[];

/**
 * The spec reduced to the bytes that decide what the image model draws.
 *
 * Set-like arrays are sorted because their order carries no meaning: `tags` is a set,
 * `parts` are addressed by unique `name` and painted by explicit `zOrder`, `variants`
 * by unique `key`, and `references` are a weighted bag. Leaving any of them in author
 * order would fork the key on a cosmetic reordering and buy a duplicate generation.
 */
export function canonicalSpecBody(spec: AssetSpec): Record<string, unknown> {
  const { semanticKey: _alreadyKeyed, tags, parts, variants, references, ...rest } = spec;
  return {
    ...rest,
    tags: [...new Set(tags)].sort(),
    parts: sortCanonically(parts),
    variants: sortCanonically(variants),
    references: sortCanonically(references),
  };
}

/**
 * Content hash of everything in the spec that is not already a key component.
 *
 * Takes the *parsed* `AssetSpec` - the output type, with Zod's defaults applied.
 * Hashing an unparsed input would make `{}` and `{ quality: 'preview' }` two different
 * assets even though Zod resolves them to the same request.
 */
export function computeSpecHash(spec: AssetSpec): Sha256Hex {
  return contentHash(canonicalSpecBody(spec));
}

/** Combines the four components into the key itself. */
export function computeAssetKey(parts: AssetKeyParts): AssetKey {
  return AssetKey.parse(
    compositeHash(parts.semanticKey, parts.styleChecksum, parts.variantKey, parts.specHash),
  );
}

/** Everything outside the spec that the key depends on. */
export interface AssetKeyContext {
  /** The locked style bible's checksum. Changing it forks the whole library. */
  readonly styleChecksum: Sha256Hex;
  /** Which flavour. Defaults to {@link BASE_VARIANT_KEY}. */
  readonly variantKey?: Slug;
}

/** The four components, kept as data so an unexpected miss can be diffed. */
export function deriveAssetKeyParts(spec: AssetSpec, context: AssetKeyContext): AssetKeyParts {
  return {
    semanticKey: spec.semanticKey,
    styleChecksum: context.styleChecksum,
    variantKey: context.variantKey ?? BASE_VARIANT_KEY,
    specHash: computeSpecHash(spec),
  };
}

export interface DerivedAssetKey {
  readonly key: AssetKey;
  readonly keyParts: AssetKeyParts;
}

/** The one call every caller wants: spec plus context in, key plus its audit trail out. */
export function deriveAssetKey(spec: AssetSpec, context: AssetKeyContext): DerivedAssetKey {
  const keyParts = deriveAssetKeyParts(spec, context);
  return { key: computeAssetKey(keyParts), keyParts };
}

/**
 * Total order over any canonicalisable element.
 *
 * Sorting by the element's own canonical JSON needs no per-type comparator and cannot
 * be defeated by a field being added to the element later.
 */
function sortCanonically<T>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    const a = stableStringify(left);
    const b = stableStringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
