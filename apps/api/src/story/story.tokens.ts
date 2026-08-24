/**
 * Tokens for the story surface, kept out of `tokens.ts` on purpose.
 *
 * `tokens.ts` is the *port* registry and `app.spec.ts` counts it, so a service that is
 * merely injected - a store, a use-case wrapper, a factory - must not appear in that
 * list or the count stops meaning "every declared port is bound". These are the same
 * category as `modules/module-tokens.ts`, and they live beside the code they name rather
 * than in it because three workstreams are editing that file at once and a token added
 * here cannot collide with one added there.
 *
 * Strings rather than symbols, for the reason `tokens.ts` gives: an unresolved symbol
 * token prints as `Symbol(...)` in Nest's dependency error and an unresolved string
 * token prints its own name.
 */

/** `StoryStore` - the outline tree, per series. */
export const STORY_STORE = 'STORY_STORE';
/** `OutlineService` - one level of the tree, grown, edited or regrown. */
export const OUTLINE_SERVICE = 'OUTLINE_SERVICE';
/** `StoryEngineFactory` - `StructuredCall` plus the routed backend chain. */
export const STORY_ENGINE_FACTORY = 'STORY_ENGINE_FACTORY';
/** `CharacterStateStore` - the editable prompt grid, per character. */
export const CHARACTER_STATE_STORE = 'CHARACTER_STATE_STORE';
/** `CastService` - one character sheet and its state grid. */
export const CAST_SERVICE = 'CAST_SERVICE';
