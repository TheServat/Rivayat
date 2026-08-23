import type { Locale, LocalisedText } from '@rv/contracts';

/**
 * Renders a `LocalisedText` from `@rv/contracts` in the active locale.
 *
 * `fa` is required by the schema and `en` is optional, which is the right asymmetry
 * for a Persian-first studio: a project that never writes an English label is complete,
 * not broken. So English falls back to Persian rather than to the key - a Persian
 * label an English reader cannot read is still information; a raw `model.stage.story`
 * is not.
 *
 * This is deliberately separate from `t()`. `t()` renders *interface* strings, which
 * live in the catalogues and are checked against each other at compile time.
 * `LocalisedText` is *data* - a setting label, a style preset name - authored by whoever
 * declared it, and no build step can require its English half.
 */
export function localised(text: LocalisedText, locale: Locale): string {
  if (locale === 'en') return text.en ?? text.fa;
  return text.fa;
}
