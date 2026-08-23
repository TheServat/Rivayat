/**
 * The text an asset is indexed and searched by.
 *
 * `semanticKey + description + tags`, per docs/01 §8, so that "a gnarled old tree"
 * retrieves `flora/oak-tree/mature` before anything decides to generate. The same
 * function must build the indexed text and the query text or the two live in
 * different corners of the vector space and the search quietly stops working.
 *
 * Tags are sorted: an asset re-indexed after its tags were reordered must produce the
 * same vector, otherwise the "same query, same index revision, same ranking"
 * guarantee (RV-103) is only true until someone edits a tag list.
 */

export interface SemanticTextInput {
  readonly semanticKey: string;
  readonly description: string;
  readonly tags: readonly string[];
}

export function assetEmbeddingText(input: SemanticTextInput): string {
  const tags = [...new Set(input.tags)].sort().join(', ');
  return [input.semanticKey, input.description, tags].filter((part) => part.length > 0).join('\n');
}

/**
 * Cosine similarity, clamped to `[-1, 1]`.
 *
 * Zero-length vectors score 0 rather than `NaN`: an unindexed or degenerate asset must
 * rank last, not poison the sort.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  const similarity = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  return Math.min(1, Math.max(-1, similarity));
}
