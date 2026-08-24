/**
 * ElevenLabs: the paid lane, the only one that returns timing, and the only one billed
 * per character.
 *
 * **Unverified against the live API.** Every field, range, limit and price below comes
 * from the vendor's documentation read on 2026-08-24; no request has ever been sent,
 * because no key exists on this machine. The tests are fixture-driven and prove the
 * translation and the failure mapping, not that the endpoint accepts what we send. The
 * first real call is a test in itself and should be treated as one.
 *
 * ## Two emotion channels, and only one of them is closed
 *
 * `voice_settings` is a documented object with documented ranges - `stability` 0-1,
 * `similarity_boost`, `style`, `speed` 0.7-1.2 - and it applies to every model. Audio
 * tags (`[whispers]`, `[sarcastic]`) are a **v3-only** feature, and the crucial
 * difference from Higgs is that the published tag list is *examples rather than a
 * closed vocabulary*. There is no documented catalogue to check a tag against.
 *
 * That is exactly the situation the brief warned about, so this adapter takes the
 * conservative side: it emits **only** tags that appear verbatim in the documentation,
 * and every other emotion is reported as dropped and expressed through `voice_settings`
 * alone. Inventing `[bitter]` because it looks like `[curious]` would probably work,
 * would occasionally be read aloud as the word "bitter", and would be indistinguishable
 * from a verified mapping to anyone reading this file later.
 *
 * ## Why the timestamps endpoint
 *
 * `/with-timestamps` returns the audio *and* character-level timing. The plain endpoint
 * returns audio only, and this project needs a measured duration for every cue - a
 * guessed one mistimes the narrator's script - and phoneme-adjacent timing for lip-sync.
 * Since the default output format is MP3, whose length cannot be read from a header, the
 * alignment is the only free way to know how long a line actually is.
 */

import type {
  Capability,
  ProviderKind,
  SpeechCapabilities,
  SpeechDirection,
  SpeechModelDescriptor,
  SpeechVolume,
} from '@rv/contracts';
import { KNOWN_SPEECH_MODELS, findSpeechModel, modelRef, primarySubtag } from '@rv/contracts';
import {
  type AppError,
  type Clock,
  ProviderError,
  type Result,
  SystemClock,
  err,
  isErr,
  ok,
} from '@rv/shared-kernel';

import { quoteSpeechCall, speechPricingFor } from '../../cost/speech-pricing';
import { type FetchLike, JsonHttpClient } from '../../http/json-http';
import { toAudioArtifact } from '../../ports/common';
import type { ProviderAdapter } from '../../ports/provider-adapter';
import type {
  DirectionGap,
  SpeechAlignment,
  SpeechCostQuote,
  SpeechCostRequest,
  SpeechRequest,
  SpeechResult,
  SpeechSynthesisPort,
} from '../../ports/speech-synthesis';
import { speechRefusal } from '../../ports/speech-synthesis';
import { elapsedSince, fromBase64 } from '../shared';
import { ElevenLabsSpeech } from './wire';

export const ELEVENLABS_DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_v3';
export const ELEVENLABS_CAPABILITIES: readonly Capability[] = ['speech-synthesis'];

/**
 * The models that accept audio tags.
 *
 * A set rather than a prefix test: `eleven_flash_v2_5` and `eleven_multilingual_v2` both
 * contain a version number and neither takes tags, so any rule cleverer than a list
 * would eventually let a tag through to a model that reads it aloud.
 */
const TAGGED_MODELS: ReadonlySet<string> = new Set(['eleven_v3', 'eleven_v3_conversational']);

/**
 * The only tags this adapter will emit, each one lifted verbatim from the docs.
 *
 * The documented list is longer - it also includes non-verbal reactions like `[laughs]`,
 * `[sighs]` and `[clears throat]`, and sound effects. Those are deliberately absent:
 * they *insert an event* into the line rather than colouring it, so mapping an emotion
 * onto one would put a laugh in a sentence no writer wrote. What is left are the five
 * documented tags that describe how the existing words are said.
 */
const EMOTION_TAG: Readonly<Partial<Record<SpeechDirection['emotion'], string>>> = {
  amusement: 'mischievously',
  joy: 'excited',
  enthusiasm: 'excited',
  confusion: 'curious',
  contemplation: 'curious',
};

/** The one documented tag that is about loudness. `[shouts]` is not in the list checked. */
const VOLUME_TAG: Readonly<Partial<Record<SpeechVolume, string>>> = { whisper: 'whispers' };

/** Documented bounds for `voice_settings.speed`. Values outside are rejected. */
const SPEED_MIN = 0.7;
const SPEED_MAX = 1.2;

const PACE_SPEED: Readonly<Record<SpeechDirection['pace'], number>> = {
  slow: 0.85,
  measured: 1,
  quick: 1.1,
  rushed: 1.2,
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface ElevenLabsAdapterOptions {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly capabilities?: readonly Capability[];
  readonly speech?: SpeechCapabilities;
  readonly catalogue?: readonly SpeechModelDescriptor[];
  /** Documented default is `mp3_44100_128`. Overridden per deployment, not per line. */
  readonly outputFormat?: string;
  /** How closely a cloned voice is matched. Documented default 0.75. */
  readonly similarityBoost?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

const UNKNOWN_MODEL: SpeechCapabilities = {
  emotionControl: 'voice-settings',
  clonesFromExemplar: false,
  selectsPresetVoice: true,
  acceptsSeed: true,
  returnsAlignment: true,
  languages: [],
  maxCharactersPerRequest: null,
  sampleRateHz: null,
  watermarks: false,
};

export class ElevenLabsAdapter implements ProviderAdapter, SpeechSynthesisPort {
  readonly kind: ProviderKind = 'elevenlabs';
  readonly modelRef: string;
  readonly capabilities: readonly Capability[];
  readonly speech: SpeechCapabilities;

  readonly #http: JsonHttpClient;
  readonly #clock: Clock;
  readonly #model: string;
  readonly #voiceId: string;
  readonly #outputFormat: string;
  readonly #similarityBoost: number;
  readonly #catalogue: readonly SpeechModelDescriptor[];

  constructor(options: ElevenLabsAdapterOptions) {
    this.#model = options.model ?? ELEVENLABS_DEFAULT_MODEL;
    this.#voiceId = options.voiceId;
    this.modelRef = modelRef('elevenlabs', this.#model);
    this.capabilities = options.capabilities ?? ELEVENLABS_CAPABILITIES;
    this.#catalogue = options.catalogue ?? KNOWN_SPEECH_MODELS;
    this.#clock = options.clock ?? new SystemClock();
    this.#outputFormat = options.outputFormat ?? 'mp3_44100_128';
    this.#similarityBoost = options.similarityBoost ?? 0.75;
    this.speech =
      options.speech ??
      findSpeechModel('elevenlabs', this.#model, this.#catalogue)?.capabilities ??
      UNKNOWN_MODEL;

    this.#http = new JsonHttpClient({
      baseUrl: options.baseUrl ?? ELEVENLABS_DEFAULT_BASE_URL,
      provider: 'elevenlabs',
      clock: this.#clock,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: { 'xi-api-key': options.apiKey },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  /**
   * The quote that has to be right, because this is the one that costs money.
   *
   * It renders the tagged text and counts *that*, not the raw line. A `[whispers]` prefix
   * is eleven billable characters, and a series whose every hushed line is under-quoted
   * by eleven characters is a budget guard that drifts in one direction only.
   */
  quoteSpeech(request: SpeechCostRequest): SpeechCostQuote {
    const text =
      request.direction === undefined
        ? request.text
        : this.#renderText(request.text, request.direction).text;
    return quoteSpeechCall(
      this.modelRef,
      speechPricingFor('elevenlabs', this.#model, this.#catalogue),
      text.length,
    );
  }

  async synthesizeSpeech(request: SpeechRequest): Promise<Result<SpeechResult, AppError>> {
    const rendered = this.#renderText(request.text, request.direction);

    // Checked against the *rendered* text: the ceiling is on what the vendor receives,
    // and the tags are part of that.
    const refusal = speechRefusal('elevenlabs', this.speech, {
      text: rendered.text,
      language: request.language,
    });
    if (refusal !== undefined) return err(refusal);

    const startedAt = this.#clock.now();
    const dropped = [...rendered.dropped];

    if (request.voice.binding.exemplar !== null) {
      dropped.push({
        aspect: 'voice',
        requested: 'exemplar clip',
        substituted: request.voice.binding.presetId ?? this.#voiceId,
        reason:
          'this endpoint selects a voice by id; cloning is a separate ElevenLabs product and is not reachable from here',
      });
    }

    const body: Record<string, unknown> = {
      text: rendered.text,
      model_id: this.#model,
      language_code: primarySubtag(request.language),
      voice_settings: this.#voiceSettings(request),
      output_format: this.#outputFormat,
    };
    if (request.seed !== undefined) body.seed = request.seed;

    const voiceId = request.voice.binding.presetId ?? this.#voiceId;
    const response = await this.#http.postJson(
      `/v1/text-to-speech/${voiceId}/with-timestamps`,
      body,
      { ...(request.signal === undefined ? {} : { signal: request.signal }) },
    );
    if (isErr(response)) return response;

    const parsed = ElevenLabsSpeech.safeParse(response.value);
    if (!parsed.success) {
      return err(
        new ProviderError({
          message: 'ElevenLabs returned a body without audio',
          provider: 'elevenlabs',
          // A 200 that does not match the documented shape is worth exactly one retry;
          // a truncated response is the common cause and it is transient.
          retryable: true,
          context: { model: this.#model, issues: parsed.error.issues.map((issue) => issue.path) },
        }),
      );
    }

    const bytes = fromBase64(parsed.data.audio_base64);
    const alignment = toAlignment(parsed.data.alignment ?? parsed.data.normalized_alignment);
    const durationMs = alignment === null ? null : lastEndMs(alignment);

    return ok({
      audio: toAudioArtifact(
        { mimeType: mimeForFormat(this.#outputFormat), data: bytes },
        { durationMs, sampleRateHz: this.speech.sampleRateHz },
      ),
      alignment,
      rendered: { text: rendered.text, applied: rendered.applied, approximated: [], dropped },
      modelRef: this.modelRef,
      usage: {
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: 0, resolution: null },
        latencyMs: elapsedSince(this.#clock, startedAt),
        speech: { characters: rendered.text.length, audioMs: durationMs ?? 0 },
      },
    });
  }

  // -- internals -------------------------------------------------------------

  /**
   * Builds the string that is sent, and the account of what could not be said in it.
   *
   * On a non-v3 model no tag is emitted at all, and *every* named emotion is reported as
   * dropped. That is not pessimism: `eleven_multilingual_v2` reads `[bitter]` as the word
   * "bitter", so a tag here would be an audible defect rather than a silent one.
   */
  #renderText(
    text: string,
    direction: SpeechDirection,
  ): { text: string; applied: readonly string[]; dropped: readonly DirectionGap[] } {
    const applied: string[] = [];
    const dropped: DirectionGap[] = [];
    const tagsAllowed = TAGGED_MODELS.has(this.#model);

    if (!tagsAllowed) {
      if (direction.emotion !== 'neutral') {
        dropped.push({
          aspect: 'emotion',
          requested: direction.emotion,
          substituted: null,
          reason: `${this.#model} does not support audio tags; only voice_settings reached the engine`,
        });
      }
      if (direction.volume !== 'normal') {
        dropped.push({
          aspect: 'volume',
          requested: direction.volume,
          substituted: null,
          reason: `${this.#model} has no loudness channel`,
        });
      }
      if (direction.stance === 'ironic') {
        dropped.push({
          aspect: 'stance',
          requested: 'ironic',
          substituted: null,
          reason: `${this.#model} does not support audio tags`,
        });
      }
      return { text, applied, dropped };
    }

    const tags: string[] = [];

    // Stance first: `[sarcastic]` is documented and is the only tag that is genuinely
    // about the gap between the words and the meaning, which is what irony is.
    if (direction.stance === 'ironic') {
      tags.push('sarcastic');
    }
    // `mistaken` deliberately adds nothing. The audience holds the irony; a voice that
    // signalled it would give the game away. See `SpeechStance`.

    const emotionTag = EMOTION_TAG[direction.emotion];
    if (emotionTag !== undefined) {
      tags.push(emotionTag);
    } else if (direction.emotion !== 'neutral') {
      dropped.push({
        aspect: 'emotion',
        requested: direction.emotion,
        substituted: null,
        reason:
          'the published v3 tag list has no documented tag for this emotion, and an invented tag risks being spoken aloud; expressed through voice_settings only',
      });
    }

    const volumeTag = VOLUME_TAG[direction.volume];
    if (volumeTag !== undefined) {
      tags.push(volumeTag);
    } else if (direction.volume !== 'normal') {
      dropped.push({
        aspect: 'volume',
        requested: direction.volume,
        substituted: null,
        reason: 'only [whispers] appears in the documented tag list',
      });
    }

    for (const tag of tags) applied.push(`[${tag}]`);
    const prefix = tags.map((tag) => `[${tag}]`).join(' ');
    return {
      text: prefix.length === 0 ? text : `${prefix} ${text}`,
      applied,
      dropped,
    };
  }

  /**
   * The continuous half of the translation.
   *
   * `stability` is inverted against expressiveness on purpose and this is the field most
   * likely to be got backwards: the documentation describes the low end as "more
   * emotional and expressive, but prone to hallucinations" and the high end as "highly
   * stable, but less responsive to directional prompts". So a pushed line wants *less*
   * stability, and a concealing one wants more.
   *
   * The three named presets (Creative / Natural / Robust) are documented by name only;
   * the numeric values circulating for them were not confirmed on the pages checked, so
   * this maps continuously across the documented 0-1 range rather than snapping to three
   * numbers we would be guessing at.
   */
  #voiceSettings(request: SpeechRequest): Record<string, unknown> {
    const direction = request.direction;
    const push = direction.intensity * 0.6 + request.voice.expressiveness * 0.4;
    const stability =
      direction.stance === 'concealing'
        ? clamp(0.5 + (1 - push) * 0.4, 0, 1)
        : clamp(1 - push * 0.7, 0, 1);

    return {
      stability: round2(stability),
      similarity_boost: this.#similarityBoost,
      style: round2(clamp(push, 0, 1)),
      use_speaker_boost: true,
      speed: round2(
        clamp(PACE_SPEED[direction.pace] + request.voice.tempoBias * 0.1, SPEED_MIN, SPEED_MAX),
      ),
    };
  }
}

/** Documented `output_format` prefixes to media types. Unknown prefixes stay honest. */
function mimeForFormat(outputFormat: string): string {
  if (outputFormat.startsWith('mp3')) return 'audio/mpeg';
  if (outputFormat.startsWith('opus')) return 'audio/opus';
  if (outputFormat.startsWith('pcm')) return 'audio/pcm';
  if (outputFormat.startsWith('ulaw') || outputFormat.startsWith('alaw')) return 'audio/basic';
  return 'application/octet-stream';
}

/**
 * The vendor's three parallel arrays, in milliseconds.
 *
 * Returns `null` unless all three are present and the same length. A partial alignment
 * is worse than none: lip-sync would index past the end of one array and silently place
 * a viseme at time zero.
 */
function toAlignment(
  raw:
    | {
        characters: readonly string[];
        character_start_times_seconds: readonly number[];
        character_end_times_seconds: readonly number[];
      }
    | undefined,
): SpeechAlignment | null {
  if (raw === undefined) return null;
  const { characters } = raw;
  const starts = raw.character_start_times_seconds;
  const ends = raw.character_end_times_seconds;
  if (characters.length === 0) return null;
  if (starts.length !== characters.length || ends.length !== characters.length) return null;

  return {
    characters,
    startMs: starts.map((seconds) => Math.round(seconds * 1000)),
    endMs: ends.map((seconds) => Math.round(seconds * 1000)),
  };
}

/** The end of the last character, which is the length of the line. */
function lastEndMs(alignment: SpeechAlignment): number {
  return alignment.endMs.reduce((highest, value) => Math.max(highest, value), 0);
}
