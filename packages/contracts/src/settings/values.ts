/**
 * Value types that exist only because a setting needs them.
 *
 * Everything else the registry offers as a choice already has a schema somewhere in
 * this package - `QualityTier`, `RenderBackend`, `FormatProfileId`, `Locale`. These
 * three did not, and architecture 7b names all three, so they are declared here rather
 * than inlined at the declaration site: an inlined `z.enum([...])` is invisible to the
 * rest of the system, and the image lane in particular is read by the asset engine long
 * before anyone opens the settings screen.
 */

import { z } from 'zod';

/**
 * Where images are generated.
 *
 * Architecture 7b is emphatic that **Colab is one value, never a requirement**: the
 * system runs complete on `local-comfyui` alone or on `cloud-api` alone. Encoding that
 * as three peers rather than as a `useColab` flag is what keeps the "Colab is optional"
 * claim structurally true instead of aspirational.
 */
export const ImageLane = z.enum([
  /** ComfyUI on this machine. Free, unlimited drafts, bounded by local VRAM. */
  'local-comfyui',
  /** ComfyUI behind a Colab tunnel. Same HTTP API, bigger models, needs an auth token. */
  'colab',
  /** A paid hosted image model through the provider router. */
  'cloud-api',
]);
export type ImageLane = z.infer<typeof ImageLane>;

/**
 * Reading direction of the interface.
 *
 * Separate from `Locale` because the two genuinely come apart: the UI is Persian-first
 * and therefore RTL by default, but an English-locale user reviewing a Persian series
 * may still want the RTL layout the storyboard was composed in. `auto` derives it from
 * the locale, which is the right default and the wrong thing to hard-code.
 */
export const TextDirection = z.enum(['auto', 'rtl', 'ltr']);
export type TextDirection = z.infer<typeof TextDirection>;

/**
 * The primitive values a setting can hold in an option list or a dependency condition.
 *
 * Not every setting *value* is one of these - `delivery.formats` holds an array - but
 * every value a UI control offers as a discrete choice is, and every value a
 * `dependsOn` condition compares against is. Keeping the comparison surface primitive
 * is what lets the dependency check be `includes()` rather than a deep equality that
 * would have to decide whether `[a, b]` matches `[b, a]`.
 */
export const SettingPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type SettingPrimitive = z.infer<typeof SettingPrimitive>;
