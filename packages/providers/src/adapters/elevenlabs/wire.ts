/**
 * The ElevenLabs response shape, validated rather than cast.
 *
 * The adapter has never spoken to the live API, so this schema is doing more work than
 * the equivalent for a provider we have exercised: it is the thing that will turn "the
 * documentation was wrong" into a typed `ProviderError` naming the field, instead of an
 * `undefined` propagating into a base64 decode. It is deliberately **loose about what it
 * does not need** - unknown keys pass - and strict about the three arrays whose lengths
 * have to agree, because a mismatched alignment silently mis-places every viseme.
 *
 * Shape from the documented 200 response of `POST
 * /v1/text-to-speech/{voice_id}/with-timestamps`, read 2026-08-24.
 */

import { z } from 'zod';

/** Character-level timing, in the vendor's three-parallel-array form and seconds. */
const Alignment = z.object({
  characters: z.array(z.string()),
  character_start_times_seconds: z.array(z.number()),
  character_end_times_seconds: z.array(z.number()),
});

export const ElevenLabsSpeech = z.object({
  audio_base64: z.string().min(1),
  /** Timing against the text as sent. */
  alignment: Alignment.optional(),
  /**
   * Timing against the text after the vendor's own normalisation.
   *
   * Kept as a fallback rather than preferred: the adapter needs offsets into the string
   * *it* sent, and normalisation can insert or expand characters ("۱۹۹۰" spoken out).
   * Using it when `alignment` is absent is better than having no duration at all, and
   * the difference is a few milliseconds at the ends.
   */
  normalized_alignment: Alignment.optional(),
});
export type ElevenLabsSpeech = z.infer<typeof ElevenLabsSpeech>;
