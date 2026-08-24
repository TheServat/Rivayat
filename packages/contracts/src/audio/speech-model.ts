/**
 * What each voice engine can actually do, and what it charges.
 *
 * The sibling of `provider/capability.ts`, deliberately not folded into it. Speech is
 * billed in a unit nothing else in the system uses - **characters** - and the
 * invariants that make `Pricing` trustworthy have no speech analogue (a `:free` model
 * cannot emit an image; nothing similar is true of a voice). Folding a character rate
 * into `Pricing` would put a null in every one of the twenty-odd existing entries to
 * mean "not a voice model", and would put a `superRefine` arm in a file whose refinements
 * currently all defend a verified research finding. Two tables, one shape-language.
 *
 * ## The declaration is per checkpoint, not per engine
 *
 * The single most important thing this file encodes, and it is not obvious: **the same
 * engine speaks different languages depending on which weights are loaded.** Chatterbox's
 * multilingual checkpoint supports twenty-three languages and Persian is not one of them
 * (verified against `SUPPORTED_LANGUAGES` in `chatterbox/mtl_tts.py`, chatterbox-tts
 * 0.1.7) - yet community Persian fine-tunes of that same architecture exist. A per-engine
 * capability flag cannot express that; a per-model descriptor can, and an adapter
 * configured with different weights declares different languages. The router then routes
 * around an engine that cannot speak the series language instead of shipping an episode
 * of confident gibberish.
 *
 * ## Every number below was checked, and the date is recorded
 *
 * Verified 2026-08-24 against primary sources: the Higgs model card shipped with the
 * weights (`PROMPTING.md`, `README.md`), the installed `chatterbox-tts` 0.1.7 wheel, and
 * the ElevenLabs API reference and pricing pages. `docs/00-research.md` §9 records which
 * source said what. Where a source was silent the field is `null` and stays `null` -
 * inventing a plausible figure for an engine's tag syntax or price is the specific
 * failure this file exists to avoid.
 */

import { z } from 'zod';

import { Label, PositiveInt, Prose } from '../primitives/common';
import { PriceString, ProviderKind, ProviderModelId } from '../provider/capability';
import { LanguageTag, primarySubtag } from './voice';

// -- capabilities ------------------------------------------------------------

export const SPEECH_EMOTION_CONTROLS = ['named-tags', 'voice-settings', 'scalar', 'none'] as const;

/**
 * *How* an engine is told to feel something, which is the axis on which the three
 * engines are least interchangeable.
 *
 *  - `named-tags` - the emotion is a token inside the text (`<|emotion:bitterness|>`,
 *    `[sarcastic]`). The engine has a closed vocabulary and anything outside it is read
 *    aloud or degrades the output, so an adapter may only emit tags it has verified.
 *  - `voice-settings` - a separate object of continuous knobs sent beside the text.
 *  - `scalar` - one dial for the whole performance. There is no way to say *which*
 *    emotion, only how much; this is why `SPEECH_EMOTION_AXES` exists.
 *  - `none` - the words are all there is.
 *
 * An engine may of course have two of these. The member names the *primary* channel,
 * because that is what decides whether `SpeechDirection.emotion` survives translation
 * at all; the secondary knobs show up as fields on the adapter's own options.
 */
export const SpeechEmotionControl = z.enum(SPEECH_EMOTION_CONTROLS);
export type SpeechEmotionControl = z.infer<typeof SpeechEmotionControl>;

/**
 * What one loaded voice model can do.
 *
 * The same job `MotionCapabilities` does in `anim/motion.ts` and for the same reason:
 * the router must be able to refuse a route *before* the call, and an adapter that
 * cannot serve something says so rather than failing at the far end - or worse,
 * succeeding badly.
 */
export const SpeechCapabilities = z.strictObject({
  emotionControl: SpeechEmotionControl,
  /** Zero-shot cloning from a reference clip. */
  clonesFromExemplar: z.boolean(),
  /** A catalogue of named voices to pick from. */
  selectsPresetVoice: z.boolean(),
  /**
   * Whether a seed can be pinned.
   *
   * Not a determinism requirement - ADR-0008 §1 puts TTS outside the determinism
   * boundary and the artefact is what replays - but it is the difference between "give
   * me that take again" being free and being a re-roll.
   */
  acceptsSeed: z.boolean(),
  /**
   * Whether the engine returns character- or word-level timing with the audio.
   *
   * Worth a capability of its own because it is what lets a line be lip-synced and a
   * cue be measured without decoding the audio. Only ElevenLabs offers it today.
   */
  returnsAlignment: z.boolean(),
  /**
   * The languages **these weights** support, as the vendor documents them.
   *
   * Empty means the vendor documents no list, not that the model is mute; a caller must
   * treat an empty list as "unverified" rather than as a refusal. `speaksLanguage`
   * encodes that distinction so no call site has to remember it.
   */
  languages: z.array(LanguageTag).max(256).default([]),
  /** Vendor-documented request ceiling. `null` where none is published. */
  maxCharactersPerRequest: PositiveInt.nullable(),
  /** Output sample rate. `null` where the vendor does not state one. */
  sampleRateHz: PositiveInt.nullable(),
  /** True only where the vendor documents an audio watermark in the output. */
  watermarks: z.boolean(),
});
export type SpeechCapabilities = z.infer<typeof SpeechCapabilities>;

/**
 * Whether these weights can be asked to speak a language.
 *
 * An empty `languages` list answers `true`, and the asymmetry is deliberate: a documented
 * list is a promise we can route on, and its absence is ignorance rather than refusal.
 * Refusing on ignorance would make every model whose docs we have not read unroutable.
 */
export function speaksLanguage(capabilities: SpeechCapabilities, tag: LanguageTag): boolean {
  if (capabilities.languages.length === 0) return true;
  const wanted = primarySubtag(tag);
  return capabilities.languages.some((known) => primarySubtag(known) === wanted);
}

// -- pricing -----------------------------------------------------------------

/**
 * What a voice model costs, in the unit its vendor bills.
 *
 * Per **thousand** characters, because that is how ElevenLabs quotes it ("$0.10 per 1K
 * characters") and a table that no longer reads like its source is how a transcription
 * error survives review - the same argument `Pricing` makes for its per-million token
 * rates.
 */
export const SpeechPricing = z.strictObject({
  /** USD per 1,000 characters of input text. `null` when no rate is published. */
  perKCharactersUsd: PriceString.nullable(),
  /** True only when the call costs nothing: local inference, or a genuine free tier. */
  free: z.boolean(),
  note: Label.optional(),
});
export type SpeechPricing = z.infer<typeof SpeechPricing>;

/** A price list for a voice nobody has priced: charge nothing, and say so loudly. */
export const UNPRICED_SPEECH: SpeechPricing = {
  perKCharactersUsd: null,
  free: false,
  note: 'no published price',
};

/**
 * One-line price summary for a voice picker or a spend confirmation.
 *
 * "Free" and "not published" are different answers to someone about to approve a run,
 * and rendering both as `$0.00` is how a bill goes unnoticed - the point
 * `describePricing` makes for models, restated because it is just as easy to get wrong
 * for voices.
 */
export function describeSpeechPricing(pricing: SpeechPricing): string {
  if (pricing.free) return 'free';
  if (pricing.perKCharactersUsd === null) return pricing.note ?? 'price not published';
  const rate = `$${pricing.perKCharactersUsd}/1K characters`;
  return pricing.note === undefined ? rate : `${rate} - ${pricing.note}`;
}

/**
 * What one synthesis call consumed.
 *
 * The sibling of `TokenUsage` and `ImageUsage` in `provider/usage.ts`, and it has to be
 * a third type rather than a reuse of either: a voice call bills by characters of input
 * and produces seconds of output, and neither of those is a token or an image. Putting
 * a character count in `TokenUsage.input` would make every existing token report a lie
 * the moment a voice call was logged against it.
 *
 * `characters` is the count of what was actually **sent**, tags included, because that
 * is what a vendor meters. An adapter that adds `[whispers]` to a line has added six
 * characters to the bill, and a count taken before the tags were added would quietly
 * under-report every expressive line in the series.
 */
export const SpeechUsage = z.strictObject({
  characters: z
    .number()
    .int()
    .nonnegative()
    .describe('Characters sent to the engine, including any inline tags the adapter added.'),
  /** Length of the audio produced. `0` when the call failed or nothing was measured. */
  audioMs: z.number().int().nonnegative().default(0),
});
export type SpeechUsage = z.infer<typeof SpeechUsage>;

// -- descriptors -------------------------------------------------------------

export const SpeechModelDescriptor = z
  .strictObject({
    provider: ProviderKind,
    id: ProviderModelId,
    label: Label,
    capabilities: SpeechCapabilities,
    pricing: SpeechPricing,
    /** Where the facts above came from, and when they were checked. Never empty. */
    verifiedFrom: Prose,
    notes: Prose.optional(),
  })
  .superRefine((model, ctx) => {
    if (model.pricing.free && model.pricing.perKCharactersUsd !== null) {
      const rate = Number.parseFloat(model.pricing.perKCharactersUsd);
      if (rate !== 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['pricing'],
          message: 'a model priced as free cannot quote a nonzero rate',
        });
      }
    }
    // A named-tag engine whose tag list we never verified is the exact trap the brief
    // warned about: an adapter would have to guess a syntax, and a guessed tag is read
    // aloud to the audience. Sourcing is the price of claiming the capability.
    if (model.capabilities.emotionControl === 'named-tags' && model.verifiedFrom.length < 20) {
      ctx.addIssue({
        code: 'custom',
        path: ['verifiedFrom'],
        message: 'a named-tag engine must cite where its tag vocabulary was verified',
      });
    }
  });
export type SpeechModelDescriptor = z.infer<typeof SpeechModelDescriptor>;

/**
 * The 23 languages Chatterbox's multilingual checkpoint declares.
 *
 * Read out of `SUPPORTED_LANGUAGES` in `chatterbox/mtl_tts.py` (chatterbox-tts 0.1.7,
 * installed and inspected 2026-08-24), not from a blog post. **Persian is absent**, which
 * is the single fact in this file with the largest consequence: the series language is
 * Persian, so this engine cannot carry character dialogue for it on stock weights, and
 * the router has to be able to know that before a run starts.
 */
export const CHATTERBOX_MULTILINGUAL_LANGUAGES: readonly LanguageTag[] = [
  'ar',
  'da',
  'de',
  'el',
  'en',
  'es',
  'fi',
  'fr',
  'he',
  'hi',
  'it',
  'ja',
  'ko',
  'ms',
  'nl',
  'no',
  'pl',
  'pt',
  'ru',
  'sv',
  'sw',
  'tr',
  'zh',
];

/**
 * The engines we have adapters for, with what was verified about each.
 *
 * Seed data, exactly as `KNOWN_MODELS` is: the local lane's real capability depends on
 * which weights are on disk, and an adapter may be constructed with an override. What
 * this table guarantees is that the *defaults* are sourced.
 */
export const KNOWN_SPEECH_MODELS: readonly SpeechModelDescriptor[] = [
  {
    provider: 'higgs',
    id: 'bosonai/higgs-tts-3-4b',
    label: 'Higgs TTS 3 (4B, self-hosted)',
    capabilities: {
      emotionControl: 'named-tags',
      clonesFromExemplar: true,
      selectsPresetVoice: true,
      acceptsSeed: false,
      returnsAlignment: false,
      // 102 languages are documented; only the series language is listed here, because
      // transcribing a hundred tags from a flag-emoji table is how a wrong one gets in.
      // `fa` is in the model card's production-quality tier.
      languages: ['fa', 'en'],
      maxCharactersPerRequest: null,
      sampleRateHz: 24_000,
      watermarks: false,
    },
    pricing: {
      perKCharactersUsd: '0',
      free: true,
      note: 'local inference; the hosted Boson API is priced separately and was not verified',
    },
    verifiedFrom:
      'Model card shipped with the weights (bosonai/higgs-tts-3-4b): PROMPTING.md for the 43-tag catalogue, README.md for the 102-language list including Persian, the 24 kHz rate and the OpenAI-compatible /v1/audio/speech surface. Read from the local HuggingFace cache on 2026-08-24.',
    notes:
      'Released under the Boson Higgs TTS 3 Research and Non-Commercial License, with a Creator Use Grant permitting monetised content if Boson AI is credited. Production or hosted use needs a separate licence - a legal constraint, not a technical one, and the owner has to decide it before this engine ships an episode.',
  },
  {
    provider: 'chatterbox',
    id: 'ResembleAI/chatterbox-multilingual',
    label: 'Chatterbox multilingual (local)',
    capabilities: {
      emotionControl: 'scalar',
      clonesFromExemplar: true,
      selectsPresetVoice: true,
      acceptsSeed: true,
      returnsAlignment: false,
      languages: [...CHATTERBOX_MULTILINGUAL_LANGUAGES],
      maxCharactersPerRequest: null,
      sampleRateHz: 24_000,
      watermarks: true,
    },
    pricing: { perKCharactersUsd: '0', free: true, note: 'local inference' },
    verifiedFrom:
      'chatterbox-tts 0.1.7 (MIT), installed and read on 2026-08-24: SUPPORTED_LANGUAGES and the generate() signature in chatterbox/mtl_tts.py, S3GEN_SR = 24000 in chatterbox/models/s3gen/const.py, and the Perth watermark statement on the ResembleAI/chatterbox model card.',
    notes:
      'Every output carries a Resemble AI Perth neural watermark; there is no documented way to disable it. Emotion is one scalar (exaggeration, default 0.5) with cfg_weight (default 0.5) as its counterweight - there is no way to name an emotion, so SpeechDirection.emotion is always reported as approximated by this engine.',
  },
  {
    provider: 'elevenlabs',
    id: 'eleven_v3',
    label: 'ElevenLabs Eleven v3',
    capabilities: {
      emotionControl: 'named-tags',
      clonesFromExemplar: false,
      selectsPresetVoice: true,
      acceptsSeed: true,
      returnsAlignment: true,
      languages: ['fa', 'en'],
      maxCharactersPerRequest: 5000,
      sampleRateHz: null,
      watermarks: false,
    },
    pricing: { perKCharactersUsd: '0.10', free: false },
    verifiedFrom:
      'ElevenLabs API reference (POST /v1/text-to-speech/{voice_id} and /with-timestamps) and the models and API pricing pages, read 2026-08-24: voice_settings fields and ranges, the 5,000-character limit, 70+ languages including Persian, and $0.10 per 1K characters.',
    notes:
      'Audio tags ([whispers], [sarcastic], ...) are a v3 feature; the v2 and Flash models ignore them. The published tag list is examples rather than a closed vocabulary, so the adapter emits only tags that appear in the documentation and reports every other emotion as dropped.',
  },
  {
    provider: 'elevenlabs',
    id: 'eleven_multilingual_v2',
    label: 'ElevenLabs Multilingual v2',
    capabilities: {
      emotionControl: 'voice-settings',
      clonesFromExemplar: false,
      selectsPresetVoice: true,
      acceptsSeed: true,
      returnsAlignment: true,
      // Deliberately empty: the documentation's language table was ambiguous about
      // Persian for this model on the day it was read, and an empty list means
      // "unverified" rather than "refused". See `speaksLanguage`.
      languages: [],
      maxCharactersPerRequest: 10_000,
      sampleRateHz: null,
      watermarks: false,
    },
    pricing: { perKCharactersUsd: '0.10', free: false },
    verifiedFrom:
      'ElevenLabs models and API pricing pages, read 2026-08-24: 29 languages, a 10,000-character limit, and $0.10 per 1K characters.',
    notes:
      'No audio tags. Emotion reaches this model only through voice_settings, so every named emotion is reported as dropped and only its intensity survives.',
  },
  {
    provider: 'elevenlabs',
    id: 'eleven_flash_v2_5',
    label: 'ElevenLabs Flash v2.5',
    capabilities: {
      emotionControl: 'voice-settings',
      clonesFromExemplar: false,
      selectsPresetVoice: true,
      acceptsSeed: true,
      returnsAlignment: true,
      languages: [],
      maxCharactersPerRequest: 40_000,
      sampleRateHz: null,
      watermarks: false,
    },
    pricing: {
      perKCharactersUsd: '0.05',
      free: false,
      note: 'half the price per character of v3 and multilingual v2',
    },
    verifiedFrom:
      'ElevenLabs models and API pricing pages, read 2026-08-24: 32 languages, a 40,000-character limit, and $0.05 per 1K characters.',
  },
];

/** The catalogue entry for one voice model, or `undefined` when we have never seen it. */
export function findSpeechModel(
  provider: ProviderKind,
  id: string,
  catalogue: readonly SpeechModelDescriptor[] = KNOWN_SPEECH_MODELS,
): SpeechModelDescriptor | undefined {
  return catalogue.find((model) => model.provider === provider && model.id === id);
}

/** The catalogue's price list for a voice model, or `UNPRICED_SPEECH` when it is unknown. */
export function speechPricingFor(
  provider: ProviderKind,
  id: string,
  catalogue: readonly SpeechModelDescriptor[] = KNOWN_SPEECH_MODELS,
): SpeechPricing {
  return findSpeechModel(provider, id, catalogue)?.pricing ?? UNPRICED_SPEECH;
}
