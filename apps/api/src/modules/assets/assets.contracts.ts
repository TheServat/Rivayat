/**
 * Request bodies for the asset registry surface.
 *
 * `ResolveAssetsBody` mirrors `ResolveAssetDemandInput` field for field, because that
 * use-case's input *is* the API's input - there is no translation to do, and inventing
 * one would be a second place for the dedup key's components to drift.
 */

import { AssetId, AssetSpec, NanoUsdAmount, Sha256Hex, Slug, StyleBibleId } from '@rv/contracts';
import { z } from 'zod';

export const ResolveAssetsBody = z.object({
  specs: z.array(AssetSpec).min(1).max(512),
  styleBibleId: StyleBibleId,
  styleChecksum: Sha256Hex.describe(
    'The locked style checksum. Change it and every spec in the list misses - which is ' +
      'the point: a restyle forks the library rather than silently mismatching.',
  ),
  variantKey: Slug.optional(),
  budgetNanoUsd: NanoUsdAmount.optional(),
  confirmationThresholdNanoUsd: NanoUsdAmount.optional(),
});
export type ResolveAssetsBody = z.infer<typeof ResolveAssetsBody>;

export const SearchAssetsBody = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
  minSimilarity: z.number().min(0).max(1).optional(),
});
export type SearchAssetsBody = z.infer<typeof SearchAssetsBody>;

export const AssetIdParam = AssetId;
