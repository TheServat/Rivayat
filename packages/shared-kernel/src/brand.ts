/**
 * Nominal typing for primitives.
 *
 * TypeScript is structural, so `type EpisodeId = string` gives no protection at
 * all - an `AssetId` flows into an `EpisodeId` parameter silently. Branding costs
 * nothing at runtime and makes those mix-ups compile errors.
 *
 * @example
 * type UserId = Brand<string, 'UserId'>;
 * const id = 'u_1' as UserId;   // deliberate, explicit widening
 */

declare const brandSymbol: unique symbol;

export type Brand<TBase, TBrand extends string> = TBase & {
  readonly [brandSymbol]: TBrand;
};

/** Strip the brand back off, for serialisation boundaries. */
export type Unbrand<T> = T extends Brand<infer TBase, string> ? TBase : T;

/**
 * Builds a `{ make, is }` pair for a branded primitive with a runtime guard.
 *
 * The guard is what makes branding honest: `as` casts lie, `make` throws.
 */
export interface BrandedFactory<TBase, TBrand extends string> {
  readonly brand: TBrand;
  /** Validates then brands. Returns `undefined` when the value is not valid. */
  readonly parse: (value: TBase) => Brand<TBase, TBrand> | undefined;
  /** Brands without validating. Use only where the value provably came from `parse`. */
  readonly unsafe: (value: TBase) => Brand<TBase, TBrand>;
  readonly is: (value: unknown) => value is Brand<TBase, TBrand>;
}

export function defineBrand<TBase, TBrand extends string>(
  brand: TBrand,
  validate: (value: unknown) => value is TBase,
): BrandedFactory<TBase, TBrand> {
  const unsafe = (value: TBase): Brand<TBase, TBrand> => value as Brand<TBase, TBrand>;

  return {
    brand,
    unsafe,
    parse: (value: TBase): Brand<TBase, TBrand> | undefined =>
      validate(value) ? unsafe(value) : undefined,
    is: (value: unknown): value is Brand<TBase, TBrand> => validate(value),
  };
}
