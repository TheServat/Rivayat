/**
 * Counting the budget in.
 *
 * A budgeted retrieval needs a token count for every candidate *before* it decides
 * whether to include it, and it needs the same count on every machine and every run - a
 * context assembled with a real tokenizer on one host and an estimate on another is not
 * reproducible, and reproducibility is the point of the whole exercise.
 *
 * So the default is a deterministic estimate rather than a real tokenizer: no model
 * files, no async load, no version skew. It is calibrated to over-count slightly on
 * English and Persian prose, which is the safe direction - an estimate that runs low
 * silently overflows the context window it was supposed to protect.
 *
 * {@link TokenCounter} exists so a caller that has the real tokenizer for the model it
 * is about to call can supply it. The port is one method wide on purpose.
 */

export interface TokenCounter {
  count(text: string): number;
}

/** Overhead per included fact: the bullet, the newline, the separator in the prompt. */
export const PER_FACT_OVERHEAD_TOKENS = 4;

/**
 * Characters per token, by script.
 *
 * Latin text runs about four characters to a token on every BPE vocabulary in use.
 * Persian and Arabic script run closer to two, because the vocabularies are trained
 * mostly on English and fall back to short subwords - which is why a single ratio would
 * under-count a Persian series by roughly half.
 */
const LATIN_CHARS_PER_TOKEN = 4;
const NON_LATIN_CHARS_PER_TOKEN = 2;

const NON_LATIN = /[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{C}]/u;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let latin = 0;
  let other = 0;
  for (const character of text) {
    if (NON_LATIN.test(character)) other += 1;
    else latin += 1;
  }
  return Math.ceil(latin / LATIN_CHARS_PER_TOKEN) + Math.ceil(other / NON_LATIN_CHARS_PER_TOKEN);
}

/** The default counter: {@link estimateTokens} plus the per-fact rendering overhead. */
export const DEFAULT_TOKEN_COUNTER: TokenCounter = {
  count(text: string): number {
    return estimateTokens(text) + PER_FACT_OVERHEAD_TOKENS;
  },
};
