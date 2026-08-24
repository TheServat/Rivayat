/**
 * Chatterbox, the free local lane - and the engine that cannot name an emotion.
 *
 * Resemble AI's open model (MIT), 0.5B parameters, 24 kHz out, and small enough to run
 * on the 6 GB card in `docs/00-research §0`. It is the cheapest voice in the system and
 * it has two properties that shape this adapter completely:
 *
 *  1. **There is no emotion vocabulary.** The whole expressive surface is one scalar,
 *     `exaggeration`, with `cfg_weight` as its counterweight. `bitterness` and `awe`
 *     are the same request to this engine. So every named emotion is reported as
 *     *approximated* - its arousal reached the engine as a number, its identity did not.
 *     This is exactly the case `SPEECH_EMOTION_AXES` exists for.
 *  2. **The stock multilingual weights do not speak Persian.** Twenty-three languages,
 *     read out of `SUPPORTED_LANGUAGES` in the installed package, and `fa` is not among
 *     them. Sending Persian anyway produces fluent confident sound in the wrong language,
 *     which passes every automated check we have. `speechRefusal` stops it before the
 *     socket opens, and the router failovers to an engine that can.
 *
 *     The declaration is per checkpoint, not per engine: Persian fine-tunes of this
 *     architecture exist, and an adapter constructed with `speech.languages` including
 *     `fa` is telling the truth about different weights. That is why the override exists.
 *
 * ## Transport
 *
 * `POST /tts` on `devnen/Chatterbox-TTS-Server`, which is the documented HTTP surface
 * that exposes `exaggeration` and `cfg_weight`. The OpenAI-compatible `/v1/audio/speech`
 * on the same server is deliberately *not* used: it accepts only `input`, `voice`,
 * `response_format`, `speed` and `seed`, so routing through it would silently discard
 * the one expressive control this engine has.
 *
 * Verified 2026-08-24 against the installed `chatterbox-tts` 0.1.7 wheel (the `generate`
 * signatures and `SUPPORTED_LANGUAGES`) and the Chatterbox-TTS-Server documentation for
 * the request body.
 */

import type {
  Capability,
  ProviderKind,
  SpeechCapabilities,
  SpeechDirection,
  SpeechModelDescriptor,
  SpeechPace,
} from '@rv/contracts';
import {
  KNOWN_SPEECH_MODELS,
  expressiveness,
  findSpeechModel,
  modelRef,
  primarySubtag,
} from '@rv/contracts';
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
  SpeechCostQuote,
  SpeechCostRequest,
  SpeechRequest,
  SpeechResult,
  SpeechSynthesisPort,
} from '../../ports/speech-synthesis';
import { speechRefusal } from '../../ports/speech-synthesis';
import { elapsedSince } from '../shared';
import { readWavFacts } from '../wav';

export const CHATTERBOX_DEFAULT_BASE_URL = 'http://127.0.0.1:8004';

/** The checkpoint the catalogue describes. A fine-tune is a different id and a different row. */
export const CHATTERBOX_DEFAULT_MODEL = 'ResembleAI/chatterbox-multilingual';

export const CHATTERBOX_CAPABILITIES: readonly Capability[] = ['speech-synthesis'];

/**
 * The two anchors the vendor actually published, and the line between them.
 *
 * The README states the neutral pair (`exaggeration 0.5`, `cfg 0.5`) and the dramatic
 * one ("try lower cfg values, e.g. ~0.3, and increase exaggeration to around 0.7"), plus
 * the reason they move together: *"higher exaggeration tends to speed up speech;
 * reducing cfg helps compensate with slower, more deliberate pacing."*
 *
 * Two points and a straight line between them, clamped outside. Deliberately not a
 * cleverer curve - there is no third published point to fit one to, and an invented
 * curve would look like tuning and be guessing.
 */
export const CHATTERBOX_NEUTRAL = { exaggeration: 0.5, cfgWeight: 0.5 } as const;
export const CHATTERBOX_DRAMATIC = { exaggeration: 0.7, cfgWeight: 0.3 } as const;

/** `cfg_weight` for a given exaggeration, along the vendor's own line. */
export function cfgWeightFor(exaggerationValue: number): number {
  const slope =
    (CHATTERBOX_DRAMATIC.cfgWeight - CHATTERBOX_NEUTRAL.cfgWeight) /
    (CHATTERBOX_DRAMATIC.exaggeration - CHATTERBOX_NEUTRAL.exaggeration);
  const raw =
    CHATTERBOX_NEUTRAL.cfgWeight + (exaggerationValue - CHATTERBOX_NEUTRAL.exaggeration) * slope;
  return round2(
    Math.min(CHATTERBOX_NEUTRAL.cfgWeight, Math.max(CHATTERBOX_DRAMATIC.cfgWeight, raw)),
  );
}

/**
 * Pace as a speed multiplier.
 *
 * The `/tts` endpoint documents `speed_factor` without a range; the OpenAI-compatible
 * endpoint on the same server documents `speed` as 0.5-2.0, so that is the bound used.
 * The four values are a reading of the four words and are not claimed to be vendor data.
 */
const SPEED_FACTOR: Readonly<Record<SpeechPace, number>> = {
  slow: 0.85,
  measured: 1,
  quick: 1.15,
  rushed: 1.3,
};

const SPEED_MIN = 0.5;
const SPEED_MAX = 2;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface ChatterboxAdapterOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly capabilities?: readonly Capability[];
  /**
   * Overrides the catalogue's declaration.
   *
   * The field that makes a Persian fine-tune usable: point the server at different
   * weights, declare `languages: ['fa']`, and the refusal above stops refusing. Changing
   * this without changing the weights is how an episode ships in the wrong language.
   */
  readonly speech?: SpeechCapabilities;
  readonly catalogue?: readonly SpeechModelDescriptor[];
  /** Sampling temperature. The package default is 0.8. */
  readonly temperature?: number;
  /** Server-side chunking for long passages. The server's own default is on. */
  readonly splitText?: boolean;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

const UNKNOWN_CHECKPOINT: SpeechCapabilities = {
  emotionControl: 'scalar',
  clonesFromExemplar: true,
  selectsPresetVoice: true,
  acceptsSeed: true,
  returnsAlignment: false,
  languages: [],
  maxCharactersPerRequest: null,
  sampleRateHz: 24_000,
  watermarks: true,
};

export class ChatterboxAdapter implements ProviderAdapter, SpeechSynthesisPort {
  readonly kind: ProviderKind = 'chatterbox';
  readonly modelRef: string;
  readonly capabilities: readonly Capability[];
  readonly speech: SpeechCapabilities;

  readonly #http: JsonHttpClient;
  readonly #clock: Clock;
  readonly #model: string;
  readonly #temperature: number | undefined;
  readonly #splitText: boolean | undefined;
  readonly #catalogue: readonly SpeechModelDescriptor[];

  constructor(options: ChatterboxAdapterOptions = {}) {
    this.#model = options.model ?? CHATTERBOX_DEFAULT_MODEL;
    this.modelRef = modelRef('chatterbox', this.#model);
    this.capabilities = options.capabilities ?? CHATTERBOX_CAPABILITIES;
    this.#catalogue = options.catalogue ?? KNOWN_SPEECH_MODELS;
    this.#clock = options.clock ?? new SystemClock();
    this.#temperature = options.temperature;
    this.#splitText = options.splitText;
    this.speech =
      options.speech ??
      findSpeechModel('chatterbox', this.#model, this.#catalogue)?.capabilities ??
      UNKNOWN_CHECKPOINT;

    this.#http = new JsonHttpClient({
      baseUrl: options.baseUrl ?? CHATTERBOX_DEFAULT_BASE_URL,
      provider: 'chatterbox',
      clock: this.#clock,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  /**
   * Free, and it is a measurement.
   *
   * The characters are still counted. A free lane that reported no usage would make the
   * ledger unable to answer "how much of this series was voiced locally", which is the
   * question the free lane exists to make answerable.
   */
  quoteSpeech(request: SpeechCostRequest): SpeechCostQuote {
    // The text is sent verbatim: this dialect carries expression in fields, not in the
    // string, so the quote and the invoice count exactly the same characters.
    return quoteSpeechCall(
      this.modelRef,
      speechPricingFor('chatterbox', this.#model, this.#catalogue),
      request.text.length,
    );
  }

  async synthesizeSpeech(request: SpeechRequest): Promise<Result<SpeechResult, AppError>> {
    const refusal = speechRefusal('chatterbox', this.speech, request);
    if (refusal !== undefined) return err(refusal);

    const startedAt = this.#clock.now();
    const { applied, approximated, dropped, body } = this.#translate(request);

    const response = await this.#http.postBytes('/tts', body, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (isErr(response)) return response;

    const bytes = response.value.bytes;
    if (bytes.length === 0) {
      return err(
        new ProviderError({
          message: 'Chatterbox returned an empty audio body',
          provider: 'chatterbox',
          retryable: true,
          context: { model: this.#model },
        }),
      );
    }

    const facts = readWavFacts(bytes);
    const audio = toAudioArtifact(
      { mimeType: response.value.contentType, data: bytes },
      {
        durationMs: facts?.durationMs ?? null,
        sampleRateHz: facts?.sampleRateHz ?? this.speech.sampleRateHz,
      },
    );

    return ok({
      audio,
      alignment: null,
      rendered: { text: request.text, applied, approximated, dropped },
      modelRef: this.modelRef,
      usage: {
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: 0, resolution: null },
        latencyMs: elapsedSince(this.#clock, startedAt),
        speech: { characters: request.text.length, audioMs: facts?.durationMs ?? 0 },
      },
    });
  }

  // -- internals -------------------------------------------------------------

  #translate(request: SpeechRequest): {
    applied: string[];
    approximated: DirectionGap[];
    dropped: DirectionGap[];
    body: Record<string, unknown>;
  } {
    const direction = request.direction;
    const exaggerationValue = this.#exaggeration(direction, request.voice.expressiveness);
    const cfgWeight = cfgWeightFor(exaggerationValue);
    const speedFactor = this.#speedFactor(direction, request.voice.tempoBias);

    const applied = [
      `exaggeration=${String(exaggerationValue)}`,
      `cfg_weight=${String(cfgWeight)}`,
      `speed_factor=${String(speedFactor)}`,
    ];

    const approximated: DirectionGap[] = [];
    const dropped: DirectionGap[] = [];

    // Not "dropped": the emotion's *arousal* really did reach the engine, as a number.
    // What did not reach it is which emotion it was, and calling that a drop would
    // under-report what the take will sound like.
    if (direction.emotion !== 'neutral') {
      approximated.push({
        aspect: 'emotion',
        requested: direction.emotion,
        substituted: `exaggeration=${String(exaggerationValue)}`,
        reason:
          'Chatterbox has no emotion vocabulary; only the arousal of the emotion survives, as a scalar',
      });
    }

    if (direction.volume !== 'normal') {
      dropped.push({
        aspect: 'volume',
        requested: direction.volume,
        substituted: null,
        reason: 'the /tts endpoint has no loudness or whisper control',
      });
    }

    if (direction.stance === 'ironic') {
      dropped.push({
        aspect: 'stance',
        requested: 'ironic',
        substituted: null,
        reason: 'there is no channel for irony; the words have to carry it alone',
      });
    }

    if (request.voice.pitchBias !== 0) {
      dropped.push({
        aspect: 'voice',
        requested: `pitchBias=${String(request.voice.pitchBias)}`,
        substituted: null,
        reason: 'pitch is a property of the cloned or predefined voice, not a request parameter',
      });
    }

    const body: Record<string, unknown> = {
      text: request.text,
      output_format: 'wav',
      exaggeration: exaggerationValue,
      cfg_weight: cfgWeight,
      speed_factor: speedFactor,
      language: primarySubtag(request.language),
    };
    if (this.#temperature !== undefined) body.temperature = this.#temperature;
    if (this.#splitText !== undefined) body.split_text = this.#splitText;
    if (request.seed !== undefined) {
      body.seed = request.seed;
      applied.push(`seed=${String(request.seed)}`);
    }

    const voiceGap = this.#applyVoice(body, request);
    if (voiceGap !== undefined) dropped.push(voiceGap);

    return { applied, approximated, dropped, body };
  }

  /**
   * The one number that carries the whole performance.
   *
   * `expressiveness(direction)` folds arousal, intensity, volume and the concealing
   * stance into 0..1 in `@rv/contracts`, which is where that judgement belongs - three
   * adapters must not each invent their own. What is added here is the *voice's* resting
   * level, so a terse character and a theatrical one given the same line do not arrive
   * at the same number.
   */
  #exaggeration(direction: SpeechDirection, voiceExpressiveness: number): number {
    const line = expressiveness(direction);
    return round2(Math.min(1, Math.max(0, line * 0.7 + voiceExpressiveness * 0.3)));
  }

  #speedFactor(direction: SpeechDirection, tempoBias: number): number {
    const base = SPEED_FACTOR[direction.pace];
    return round2(Math.min(SPEED_MAX, Math.max(SPEED_MIN, base + tempoBias * 0.15)));
  }

  /**
   * Chooses the voice, in the server's two modes.
   *
   * `exemplarUri` is used as the *filename* the server knows the clip by, not as a path:
   * `reference_audio_filename` is resolved inside the server's own sandbox and a path
   * that escapes it is rejected with a 400. Uploading the clip is a deployment step, not
   * something an adapter should do on every line.
   */
  #applyVoice(body: Record<string, unknown>, request: SpeechRequest): DirectionGap | undefined {
    if (request.exemplarUri !== undefined) {
      body.voice_mode = 'clone';
      body.reference_audio_filename = request.exemplarUri;
      return undefined;
    }
    const presetId = request.voice.binding.presetId;
    if (presetId !== null) {
      body.voice_mode = 'predefined';
      body.predefined_voice_id = presetId;
      return undefined;
    }
    return {
      aspect: 'voice',
      requested: request.voice.label,
      substituted: null,
      reason:
        'no reference clip filename and no predefined voice id; the server default voice was used',
    };
  }
}
