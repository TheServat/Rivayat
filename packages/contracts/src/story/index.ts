/**
 * Story contracts.
 *
 * Three files, in the order the pipeline meets them: `brief` is what the author hands
 * in (S0), `story-bible` is the tree the story stage grows from it (S2), and `shot` is
 * what the sequence stage cuts that tree into (S7).
 *
 * Re-exported flat rather than namespaced because these names are already unambiguous
 * across the package and a caller should not have to know which of the three files a
 * `Scene` lives in.
 */

export * from './brief';
export * from './shot';
export * from './story-bible';
export * from './cast-candidate';
