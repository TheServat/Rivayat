/**
 * Request and response shapes for S1.
 *
 * `Brief`, `Sha256Hex` and `StyleBibleDraft` come straight from `@rv/contracts`; every
 * shape below is an envelope naming which of them a route carries. Composing contract
 * schemas is not re-declaring them - what non-negotiable #5 forbids is a second
 * definition of the same shape, and there is none here.
 *
 * The three response shapes - {@link StylePresetList}, {@link StyleProbeSheet} and the
 * tile inside it - are declared here rather than in `@rv/contracts` only because this
 * agent may not write to that package. They are field-for-field the shapes
 * `apps/web/src/api/schemas/style.ts` validates, and both copies should collapse into
 * one in `@rv/contracts` - see the report accompanying this change.
 */

import {
  Brief,
  IsoInstant,
  LocalisedText,
  NanoUsdAmount,
  ProviderKind,
  Sha256Hex,
  Slug,
  StyleBibleDraft,
  StyleBibleId,
} from '@rv/contracts';
import { z } from 'zod';

export const FromPresetBody = z.object({
  preset: Slug.describe('Preset name from `GET /api/style/presets`.'),
});
export type FromPresetBody = z.infer<typeof FromPresetBody>;

export const DeriveStyleBody = z.object({
  brief: Brief,
  referenceHashes: z
    .array(Sha256Hex)
    .min(1)
    .max(16)
    .describe(
      'Content hashes of reference images already in the blob store. Hashes rather ' +
        'than bytes: the images are uploaded once and referred to thereafter, which is ' +
        'what makes the derivation cacheable.',
    ),
});
export type DeriveStyleBody = z.infer<typeof DeriveStyleBody>;

// ── the shelf, as a gallery can render it ───────────────────────────────────

/**
 * One preset with enough of itself to be chosen without being materialised.
 *
 * `GET /api/style/presets` used to answer `Slug[]`, and a gallery of eleven names can
 * show neither a palette nor a motion profile - so a client had two options, guess or
 * `POST /from-preset` eleven times, and the second mints eleven style bibles to draw a
 * grid. `STYLE_PRESETS` in `@rv/style-engine` already holds all of this; exposing it is
 * a projection of data that exists.
 *
 * The draft is carried **whole** rather than summarised. The card plays the motion
 * profile, so it needs the easing control points, the step mode and the boil rate - not
 * three adjectives derived from them somewhere the user cannot see. Composing
 * `StyleBibleDraft` also means a style that gains a field gains it here for free.
 *
 * `medium` is deliberately absent: it is `draft.visual.medium`, and a second copy is a
 * second thing to keep in step.
 */
export const StylePresetCard = z.strictObject({
  id: Slug,
  name: LocalisedText,
  description: LocalisedText,
  draft: StyleBibleDraft,
});
export type StylePresetCard = z.infer<typeof StylePresetCard>;

export const StylePresetList = z.strictObject({
  presets: z.array(StylePresetCard).default([]),
});
export type StylePresetList = z.infer<typeof StylePresetList>;

// ── the probe sheet ─────────────────────────────────────────────────────────

/** Which image lane a probe runs on. Mirrors `StyleProbeLane` in `@rv/style-engine`. */
export const StyleProbeLane = z.enum(['free', 'paid']);
export type StyleProbeLane = z.infer<typeof StyleProbeLane>;

export const ProbeStyleBody = z.object({
  lane: StyleProbeLane.default('free').describe(
    'The local ComfyUI lane by default: four 512px tiles at $0.00, so rejecting six ' +
      'candidate styles costs nothing.',
  ),
});
export type ProbeStyleBody = z.infer<typeof ProbeStyleBody>;

/**
 * One tile, with its bytes behind a content address rather than inline.
 *
 * A sheet is four PNGs; inlining them as base64 makes a JSON body a few megabytes that
 * no client can cache. The bytes go into the blob store on the way out and the tile
 * carries the URL, which is immutable by construction and therefore cacheable forever.
 *
 * `priced: false` means the zero beside it is "the catalogue had no price", not "it was
 * free" - a distinction that matters on a sheet somebody is about to approve.
 */
export const StyleProbeTile = z.strictObject({
  subject: Slug,
  label: LocalisedText,
  imageUrl: z.string().min(1),
  provider: ProviderKind,
  model: z.string().min(1),
  seed: z.number().int().nonnegative(),
  costNanoUsd: NanoUsdAmount.default(0),
  priced: z.boolean().default(true),
});
export type StyleProbeTile = z.infer<typeof StyleProbeTile>;

export const StyleProbeSheet = z.strictObject({
  styleBibleId: StyleBibleId,
  styleChecksum: Sha256Hex,
  lane: StyleProbeLane,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  tiles: z.array(StyleProbeTile).default([]),
  totalCostNanoUsd: NanoUsdAmount.default(0),
  /** False when any tile's model was missing from the price catalogue. */
  costIsComplete: z.boolean().default(true),
  generatedAt: IsoInstant,
});
export type StyleProbeSheet = z.infer<typeof StyleProbeSheet>;
