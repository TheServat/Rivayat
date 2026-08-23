/**
 * Reuse before regrowth.
 *
 * The dedup key only catches an *exact* repeat. This catches the near ones: a writer
 * asking for "a gnarled old tree" should be shown `flora/oak-tree/mature` before
 * anybody decides to spend money on a second tree. It is the difference between a
 * library and a pile.
 *
 * Two behaviours are load-bearing:
 *
 * - **A floor, not a top-N.** Below `minSimilarity` the answer is an empty list, never
 *   the least-bad match. A confident wrong suggestion costs more than no suggestion,
 *   because someone will accept it.
 * - **Deterministic ranking.** Ties break on `assetId`, so the same query against the
 *   same index revision always produces the same order (RV-103). Float ordering that
 *   depends on map iteration would make the guarantee untestable.
 */

import { type Result, err, isErr, ok, InternalError } from '@rv/shared-kernel';
import type { AssetId, AssetKey, Label, SemanticKey } from '@rv/contracts';

import type { AssetRepository, EmbeddingPort } from '../ports/index';
import { assetEmbeddingText, cosineSimilarity } from '../semantic-text';

/** Below this, a match is noise. Tuned to be conservative: silence beats a bad hint. */
export const DEFAULT_MIN_SIMILARITY = 0.6;

export interface FindSimilarAssetsInput {
  readonly query: string;
  readonly limit?: number;
  readonly minSimilarity?: number;
}

export interface SimilarAsset {
  readonly assetId: AssetId;
  readonly key: AssetKey;
  readonly semanticKey: SemanticKey;
  readonly label: Label;
  readonly similarity: number;
}

export interface FindSimilarAssetsDeps {
  readonly repository: AssetRepository;
  readonly embeddings: EmbeddingPort;
  readonly minSimilarity?: number;
}

export class FindSimilarAssetsUseCase {
  readonly #repository: AssetRepository;
  readonly #embeddings: EmbeddingPort;
  readonly #minSimilarity: number;

  constructor(deps: FindSimilarAssetsDeps) {
    this.#repository = deps.repository;
    this.#embeddings = deps.embeddings;
    this.#minSimilarity = deps.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  }

  async execute(input: FindSimilarAssetsInput): Promise<Result<readonly SimilarAsset[]>> {
    const trimmed = input.query.trim();
    if (trimmed.length === 0) return ok([]);

    const embedded = await this.#embeddings.embed([trimmed]);
    if (isErr(embedded)) return embedded;

    const queryVector = embedded.value[0];
    if (queryVector === undefined) {
      return err(
        new InternalError({
          message: 'Embedding provider returned no vector for a single-text batch.',
          context: { model: this.#embeddings.model },
        }),
      );
    }

    const records = await this.#repository.listSearchRecords();
    if (isErr(records)) return records;

    const floor = input.minSimilarity ?? this.#minSimilarity;
    const scored: SimilarAsset[] = [];

    for (const record of records.value) {
      // Vectors from a different model share a number space but not a meaning, so
      // comparing across them yields confident nonsense. Skip rather than mislead.
      if (record.embedding === null || record.embeddingModel !== this.#embeddings.model) continue;

      const similarity = cosineSimilarity(queryVector, record.embedding);
      if (similarity < floor) continue;

      scored.push({
        assetId: record.assetId,
        key: record.key,
        semanticKey: record.semanticKey,
        label: record.label,
        similarity,
      });
    }

    scored.sort((left, right) =>
      right.similarity === left.similarity
        ? left.assetId.localeCompare(right.assetId)
        : right.similarity - left.similarity,
    );

    const limit = input.limit ?? scored.length;
    return ok(scored.slice(0, Math.max(0, limit)));
  }
}

/**
 * The text an asset must be indexed under for this use-case to find it.
 *
 * Re-exported here so an indexer cannot accidentally build the text a different way
 * and put the corpus and the queries in different corners of the vector space.
 */
export { assetEmbeddingText };
