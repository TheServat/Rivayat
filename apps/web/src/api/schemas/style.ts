/**
 * The Style Lab's wire shapes, composed from `@rv/contracts` rather than restated.
 *
 * Everything structural here - `VisualStyle`, `MotionStyle`, `Palette`, `StyleBible` -
 * is imported from the contracts package and assembled into the envelopes the screen
 * needs. Nothing below re-declares a field that already exists upstream, which is the
 * distinction non-negotiable #5 draws: composing contract schemas is allowed, writing a
 * second definition of one is not.
 *
 * ## What the API owes this screen
 *
 * Read this before assuming the screen is over-specified. Every shape here is written
 * against an endpoint that exists in `apps/api/src/modules/style/`, and three of the
 * four are wider than what that endpoint returns today:
 *
 * | endpoint                        | today                                   | what Style Lab needs                                     |
 * | ------------------------------- | --------------------------------------- | -------------------------------------------------------- |
 * | `GET /api/style/presets`        | `Slug[]`, and a 501 from the stub engine | {@link StylePresetCard}[] - a gallery of names cannot show a palette or a motion profile |
 * | `POST /api/style/from-preset`   | `StyleBible`, 501                        | unchanged - this one is right                            |
 * | `POST /api/style/:id/lock`      | `StyleBible`, 501                        | unchanged                                                |
 * | `POST /api/style/:id/probe`     | **does not exist**                       | {@link StyleProbeSheet}                                  |
 *
 * The preset card is the load-bearing one. `@rv/style-engine` already holds all of it -
 * `STYLE_PRESETS` carries a `LocalisedText` name, a description, the medium and a fully
 * parsed `StyleBibleDraft` per preset - so exposing it is a projection of data that
 * exists, not new work. A list of eleven slugs forces the client either to guess what
 * each style looks like or to `POST /from-preset` eleven times to find out, and the
 * second one mints eleven style bibles to render a gallery.
 *
 * `apps/web` may not import `@rv/style-engine` (`app.spec.ts` fails the build on it), so
 * there is no shortcut around this.
 */

import {
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

/**
 * One preset as the gallery renders it.
 *
 * A `StyleBibleDraft` with an identity on the front, which is exactly the shape
 * `@rv/style-engine` already builds internally (`StylePreset`: an id, a `LocalisedText`
 * name and description, and a parsed draft). Composing the contract's own draft rather
 * than listing the fields the gallery happens to read means the card cannot fall behind
 * the bible: a style with a new motion field gains it here for free, and
 * `POST /from-preset` is `draft` plus an id, a checksum and a clock reading.
 *
 * The draft is carried whole and not summarised because the summary is the thing this
 * screen must not invent. The card *plays* the motion profile, so it needs the easing
 * control points, the step mode, the boil rate and the ambient frequencies - not three
 * adjectives derived from them somewhere the user cannot see.
 *
 * `name` and `description` are `LocalisedText` while `draft.name` is a plain `Label`,
 * and that asymmetry is deliberate upstream: a bible is a machine document with one
 * name, a preset is a thing a person picks off a shelf in their own language.
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

/** Which image lane a probe runs on. Mirrors `StyleProbeLane` in `@rv/style-engine`. */
export const StyleProbeLane = z.enum(['free', 'paid']);
export type StyleProbeLane = z.infer<typeof StyleProbeLane>;

/**
 * One tile of the probe sheet.
 *
 * `priced: false` means the zero beside it is "the catalogue had no price", not "it was
 * free" - a distinction that matters a great deal on a sheet somebody is about to
 * approve, and one the engine already draws.
 */
export const StyleProbeTile = z.strictObject({
  subject: Slug,
  label: LocalisedText,
  /** Where the generated image can be fetched. Relative to the API origin. */
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

/**
 * How many images one probe sheet costs.
 *
 * Four, fixed forever, one per subject in `@rv/style-engine`'s `PROBE_SUBJECTS`: a
 * character, a tree, a prop and a sky. The number is restated here rather than imported
 * because the studio may not depend on the engine, and it is a *layout* fact as well as
 * a cost one - the sheet is a 2x2 grid and its skeleton has to be the right shape before
 * any tile arrives.
 */
export const PROBE_TILE_COUNT = 4;
