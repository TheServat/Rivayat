/**
 * Higgs TTS 3, the expressive lane: 21 named emotions, and it speaks Persian.
 *
 * The only one of the three engines that can be *told* an emotion and also speak the
 * series language, which makes it the default for character dialogue. What it costs is
 * hardware: the weights are ~4B parameters and the model card benchmarks on an H100, so
 * the 6 GB Quadro in `docs/00-research §0` will not serve it. That is a deployment fact,
 * not an adapter one - this talks HTTP to whatever is serving `/v1/audio/speech`,
 * whether that is a bigger machine on the LAN or Boson's hosted API.
 *
 * ## Two dialects, because there really are two
 *
 * The self-hosted servers (`sgl-omni`, `vllm-omni`) and Boson's hosted API expose the
 * same endpoint path with different field names for the same ideas: `references:
 * [{audio_path, text}]` against `ref_audio` / `ref_text`. Both are documented, neither
 * is a superset, and guessing produces a 4xx at best. So the dialect is a constructor
 * option and each spelling is the one its own source states.
 *
 * The capabilities differ with it, and honestly: preset voices are documented for the
 * hosted API (`voice: "jake"`) and not for the self-hosted servers, so a self-hosted
 * adapter declares `selectsPresetVoice: false` and reports a preset id as dropped rather
 * than sending a field the server may reject.
 *
 * Verified 2026-08-24 against the model card shipped with `bosonai/higgs-tts-3-4b`
 * (README.md, PROMPTING.md) and `docs.boson.ai/models/higgs-tts`. Nothing here was
 * inferred from a plausible-looking example.
 */

import type {
  Capability,
  ProviderKind,
  SpeechCapabilities,
  SpeechModelDescriptor,
} from '@rv/contracts';
import { KNOWN_SPEECH_MODELS, findSpeechModel, modelRef } from '@rv/contracts';
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
  SpeechCostQuote,
  SpeechCostRequest,
  SpeechRequest,
  SpeechResult,
  SpeechSynthesisPort,
} from '../../ports/speech-synthesis';
import { speechRefusal } from '../../ports/speech-synthesis';
import { elapsedSince, toBase64 } from '../shared';
import { readWavFacts } from '../wav';
import { renderHiggsInput } from './tags';

/** What `sgl-omni serve` and `vllm-omni serve` bind by default in the model card's examples. */
export const HIGGS_DEFAULT_BASE_URL = 'http://127.0.0.1:8000';

/** The model id the catalogue prices and the ledger records. */
export const HIGGS_DEFAULT_MODEL = 'bosonai/higgs-tts-3-4b';

export const HIGGS_CAPABILITIES: readonly Capability[] = ['speech-synthesis'];

/**
 * Which wire spelling to use.
 *
 * Not a preference. The two servers name the same fields differently and a request in
 * the wrong dialect is a rejected request or, worse, a silently ignored voice reference
 * that produces an episode in the wrong voice.
 */
export type HiggsDialect = 'self-hosted' | 'boson-cloud';

export interface HiggsAdapterOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly dialect?: HiggsDialect;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly capabilities?: readonly Capability[];
  /** Overrides the catalogue's declaration - a different checkpoint speaks different languages. */
  readonly speech?: SpeechCapabilities;
  readonly catalogue?: readonly SpeechModelDescriptor[];
  /** Sampling temperature. The model card's voice-clone example uses 0.8. */
  readonly temperature?: number;
  /** Generation ceiling. The model card's voice-clone example uses 1024. */
  readonly maxNewTokens?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/** The declaration used when the catalogue has never heard of this checkpoint. */
const UNKNOWN_CHECKPOINT: SpeechCapabilities = {
  emotionControl: 'named-tags',
  clonesFromExemplar: true,
  selectsPresetVoice: false,
  acceptsSeed: false,
  returnsAlignment: false,
  // Empty means "not verified", which `speaksLanguage` reads as "do not refuse". An
  // unknown checkpoint is our ignorance, not the model's silence.
  languages: [],
  maxCharactersPerRequest: null,
  sampleRateHz: 24_000,
  watermarks: false,
};

export class HiggsAdapter implements ProviderAdapter, SpeechSynthesisPort {
  readonly kind: ProviderKind = 'higgs';
  readonly modelRef: string;
  readonly capabilities: readonly Capability[];
  readonly speech: SpeechCapabilities;

  readonly #http: JsonHttpClient;
  readonly #clock: Clock;
  readonly #model: string;
  readonly #dialect: HiggsDialect;
  readonly #temperature: number | undefined;
  readonly #maxNewTokens: number | undefined;
  readonly #timeoutMs: number;
  readonly #catalogue: readonly SpeechModelDescriptor[];

  constructor(options: HiggsAdapterOptions = {}) {
    this.#model = options.model ?? HIGGS_DEFAULT_MODEL;
    this.#dialect = options.dialect ?? 'self-hosted';
    this.modelRef = modelRef('higgs', this.#model);
    this.capabilities = options.capabilities ?? HIGGS_CAPABILITIES;
    this.#catalogue = options.catalogue ?? KNOWN_SPEECH_MODELS;
    this.#clock = options.clock ?? new SystemClock();
    this.#temperature = options.temperature;
    this.#maxNewTokens = options.maxNewTokens;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const declared =
      options.speech ??
      findSpeechModel('higgs', this.#model, this.#catalogue)?.capabilities ??
      UNKNOWN_CHECKPOINT;
    this.speech = {
      ...declared,
      // Preset speakers are documented for the hosted API only. Declaring them on a
      // self-hosted deployment would have the router send a `voice` the server ignores,
      // and every character would arrive in the same default voice.
      selectsPresetVoice: this.#dialect === 'boson-cloud' && declared.selectsPresetVoice,
    };

    this.#http = new JsonHttpClient({
      baseUrl: options.baseUrl ?? HIGGS_DEFAULT_BASE_URL,
      provider: 'higgs',
      clock: this.#clock,
      timeoutMs: this.#timeoutMs,
      ...(options.apiKey === undefined
        ? {}
        : { headers: { authorization: `Bearer ${options.apiKey}` } }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  /**
   * Free on a self-hosted server, and that is a measurement rather than a missing price.
   *
   * The GPU-hours are real; what is zero is the *metered* cost, which is the only thing
   * a dollar-denominated budget can act on. The hosted Boson API is a different matter -
   * its price was not published on the page checked on 2026-08-24, so the catalogue
   * leaves it unpriced and this returns the `unpriced` arm, which a strict budget policy
   * can refuse rather than silently approve.
   */
  quoteSpeech(request: SpeechCostRequest): SpeechCostQuote {
    const rendered = this.#render(request.text, request.direction);
    return quoteSpeechCall(
      this.modelRef,
      speechPricingFor('higgs', this.#model, this.#catalogue),
      rendered.length,
    );
  }

  async synthesizeSpeech(request: SpeechRequest): Promise<Result<SpeechResult, AppError>> {
    const refusal = speechRefusal('higgs', this.speech, request);
    if (refusal !== undefined) return err(refusal);

    const startedAt = this.#clock.now();
    const rendering = renderHiggsInput(request.text, request.direction, {
      pitchBias: request.voice.pitchBias,
      tempoBias: request.voice.tempoBias,
      expressiveness: request.voice.expressiveness,
    });

    const dropped = [...rendering.dropped];
    const body: Record<string, unknown> = { model: this.#model, input: rendering.text };
    if (this.#temperature !== undefined) body.temperature = this.#temperature;
    if (this.#maxNewTokens !== undefined) body.max_new_tokens = this.#maxNewTokens;

    // `/v1/audio/speech` documents no seed on either dialect. Reported rather than
    // ignored: a caller that asked for a repeatable take must learn it did not get one.
    if (request.seed !== undefined) {
      dropped.push({
        aspect: 'seed',
        requested: String(request.seed),
        substituted: null,
        reason: 'neither Higgs dialect documents a seed on /v1/audio/speech',
      });
    }

    const voiceGap = this.#applyVoice(body, request);
    if (voiceGap !== undefined) dropped.push(voiceGap);

    const response = await this.#http.postBytes('/v1/audio/speech', body, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (isErr(response)) return response;

    const bytes = response.value.bytes;
    if (bytes.length === 0) {
      return err(
        new ProviderError({
          message: 'Higgs returned an empty audio body',
          provider: 'higgs',
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
      // The model card documents no timing output. `null` rather than an alignment
      // derived from character counts, which would be a fabrication that lip-sync would
      // then trust.
      alignment: null,
      rendered: {
        text: rendering.text,
        applied: rendering.applied,
        approximated: rendering.approximated,
        dropped,
      },
      modelRef: this.modelRef,
      usage: {
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        images: { count: 0, resolution: null },
        latencyMs: elapsedSince(this.#clock, startedAt),
        speech: { characters: rendering.text.length, audioMs: facts?.durationMs ?? 0 },
      },
    });
  }

  // -- internals -------------------------------------------------------------

  /** The exact string that will be sent, so the quote counts what the bill counts. */
  #render(text: string, direction: SpeechCostRequest['direction']): string {
    if (direction === undefined) return text;
    return renderHiggsInput(text, direction, { pitchBias: 0, tempoBias: 0, expressiveness: 0.5 })
      .text;
  }

  /**
   * Attaches the voice, in this dialect's spelling, and reports what it could not use.
   *
   * The cloning path prefers the URI over the bytes on a self-hosted server because
   * `references[].audio_path` is a path the *server* opens - it never sees our buffer -
   * and prefers the bytes on the hosted API because `ref_audio` accepts a data URI and
   * a local path would mean nothing to a machine elsewhere.
   */
  #applyVoice(
    body: Record<string, unknown>,
    request: SpeechRequest,
  ): SpeechResult['rendered']['dropped'][number] | undefined {
    const binding = request.voice.binding;
    const transcript = binding.exemplar?.transcript ?? '';

    if (this.#dialect === 'boson-cloud') {
      if (request.exemplarAudio !== undefined) {
        body.ref_audio = `data:${request.exemplarAudio.mimeType};base64,${toBase64(request.exemplarAudio.data)}`;
        if (transcript.length > 0) body.ref_text = transcript;
        return undefined;
      }
      if (request.exemplarUri !== undefined) {
        body.ref_audio = request.exemplarUri;
        if (transcript.length > 0) body.ref_text = transcript;
        return undefined;
      }
      if (binding.presetId !== null) {
        body.voice = binding.presetId;
        return undefined;
      }
      return this.#unboundVoiceGap(request);
    }

    if (request.exemplarUri !== undefined) {
      body.references = [
        { audio_path: request.exemplarUri, ...(transcript.length > 0 ? { text: transcript } : {}) },
      ];
      return undefined;
    }
    if (binding.presetId !== null) {
      return {
        aspect: 'voice',
        requested: binding.presetId,
        substituted: null,
        reason:
          'preset speakers are documented for the hosted Boson API only; a self-hosted server needs a reference clip it can open, so this line used the default voice',
      };
    }
    return this.#unboundVoiceGap(request);
  }

  #unboundVoiceGap(request: SpeechRequest): SpeechResult['rendered']['dropped'][number] {
    return {
      aspect: 'voice',
      requested: request.voice.label,
      substituted: null,
      reason: 'no exemplar clip and no preset id reached the adapter; the default voice was used',
    };
  }
}
