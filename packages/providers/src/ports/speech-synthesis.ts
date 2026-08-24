/**
 * Words to a voice, and what that will cost.
 *
 * ## Why this port is shaped differently from `ImageGenerationPort`
 *
 * The three voice engines the owner named are *less* interchangeable than three image
 * models are. Two of them run locally and are free, one is paid and bills by the
 * character. One takes named emotion tokens inside the text, one takes a settings object
 * beside it, and one has no way to name an emotion at all - it has a single scalar. One
 * clones a voice from a recording, one selects from a catalogue, one does both. One
 * returns character-level timing; two do not. And, decisively for this project, one of
 * them does not speak Persian on stock weights.
 *
 * A port that flattened those differences would have to pick a lowest common
 * denominator, and the lowest common denominator of these three is "text in, audio out"
 * - which throws away the entire reason the owner named three engines. So this port does
 * the opposite: it carries the **union** of what they can do, in engine-neutral terms,
 * and makes every adapter say out loud what it could not use.
 *
 * Two members carry that honesty, and they work at different scales:
 *
 *  - {@link SpeechSynthesisPort.speech} declares, once per adapter, what these weights
 *    can do at all. It is what the router reads to refuse a route *before* the call -
 *    including the Persian case, which is a `languages` list and not a special case.
 *  - {@link RenderedDirection} reports, once per call, which parts of the direction
 *    actually reached the engine. An adapter that quietly dropped `volume: 'raised'`
 *    and one that expressed it are indistinguishable in the audio to anyone who was not
 *    there; they are not indistinguishable in the provenance record.
 *
 * ## Why `quoteSpeech` is a required member
 *
 * The same argument `ImageGenerationPort` makes for `quoteImage`, and it lands harder
 * here because speech is billed per character of a text the *adapter* composes. An
 * adapter that adds `[whispers]` to a line has added nine characters to the bill, so a
 * quote computed by the caller from the raw line would be systematically low on exactly
 * the expressive lines a series has most of. The quote is therefore the adapter's job,
 * it renders the same text the call will send, and it reads the same `SpeechPricing`
 * record the invoice is priced from - so an estimate and an invoice cannot come from two
 * different tables.
 *
 * It is synchronous and pure: no clock, no network, no state. A guard that had to await
 * a round trip would be one more thing that can fail open.
 */

import type {
  LanguageTag,
  ModelRef,
  SpeechCapabilities,
  SpeechDirection,
  VoiceProfile,
} from '@rv/contracts';
import { speaksLanguage } from '@rv/contracts';
import {
  type AppError,
  type NanoUsd,
  type Result,
  UnsupportedCapabilityError,
  ValidationError,
} from '@rv/shared-kernel';

import type { AudioArtifact, AudioPayload, ProviderCallResult } from './common';

export interface SpeechRequest {
  /**
   * The words, and only the words.
   *
   * Never carries engine tags. Composing the tagged string is the adapter's job and the
   * adapter's alone - a caller that pre-tagged the text would be choosing an engine, and
   * would be double-counted by `quoteSpeech`.
   */
  readonly text: string;
  /**
   * The whole profile, not just its binding.
   *
   * An adapter needs `pitchBias`, `tempoBias` and `expressiveness` as much as it needs
   * the voice id: those three are what carry the *character sheet* into the performance,
   * and they are the reason two characters given the same line and the same direction do
   * not come back sounding the same. Passing only the binding would make every voice the
   * engine's default with a different timbre.
   */
  readonly voice: VoiceProfile;
  readonly direction: SpeechDirection;
  /**
   * The language of *this line*, which is usually but not always the voice's own.
   *
   * Separate from `voice.language` because a character saying one phrase in another
   * tongue is a real thing a series does, and it is the line that has to be routed to an
   * engine that can speak it.
   */
  readonly language: LanguageTag;
  /**
   * The exemplar clip's bytes, when the caller has resolved them from the store.
   *
   * `VoiceExemplar` carries a content hash, not bytes - it is a contract, and contracts
   * do not hold blobs. Resolving the hash is the composition root's job, and an engine
   * that clones needs one of this and {@link SpeechRequest.exemplarUri}.
   */
  readonly exemplarAudio?: AudioPayload;
  /**
   * A location the *engine* can read the exemplar from.
   *
   * A filesystem path for a server sharing this machine's disk, an https URL for a
   * hosted one. Distinct from `exemplarAudio` because a self-hosted Higgs takes a path
   * it opens itself and never sees our bytes at all.
   */
  readonly exemplarUri?: string;
  /**
   * Fixed seed, for engines that accept one.
   *
   * Not a determinism requirement: ADR-0008 §1 places synthesis outside the boundary and
   * the hashed artefact is what replays. It is the difference between "that take again"
   * costing nothing and being a fresh roll of the dice.
   */
  readonly seed?: number;
  readonly signal?: AbortSignal;
}

/**
 * Everything a quote depends on, and nothing else.
 *
 * `SpeechRequest` satisfies it structurally, so one method quotes a planned line and a
 * real one alike and there is no second place for the rule to drift to. The direction is
 * part of it because on a tag-driven engine the direction changes the number of
 * characters sent.
 */
export interface SpeechCostRequest {
  readonly text: string;
  readonly direction?: SpeechDirection;
}

/**
 * What one synthesis call is expected to cost, answered before it is made.
 *
 * Three arms, mirroring {@link import('./image-generation').ImageCostQuote} exactly, and
 * the third is again the point: collapsing `unpriced` into a zero makes every unpriced
 * voice look free to the budget guard, which is the most expensive way to be wrong.
 */
export type SpeechCostQuote =
  | {
      readonly kind: 'free';
      readonly modelRef: ModelRef;
      /** Always `ZERO_USD`. Present so callers can sum quotes without branching. */
      readonly nanoUsd: NanoUsd;
      /** Why it is free - "local inference", not an empty price list. */
      readonly reason: string;
      /** Characters that would be sent. Recorded even when free, so usage is comparable. */
      readonly characters: number;
    }
  | {
      readonly kind: 'estimated';
      readonly modelRef: ModelRef;
      readonly nanoUsd: NanoUsd;
      /** How the number was arrived at, for the ledger's audit trail. */
      readonly basis: string;
      readonly characters: number;
    }
  | {
      readonly kind: 'unpriced';
      readonly modelRef: ModelRef;
      readonly reason: string;
      readonly characters: number;
    };

/**
 * The number to give a budget guard, or `null` when there is none.
 *
 * `null` rather than `0`, and callers are expected to branch: a helper that quietly
 * returned zero would destroy the whole value of the `unpriced` arm.
 */
export function projectedSpeechNanoUsd(quote: SpeechCostQuote): NanoUsd | null {
  return quote.kind === 'unpriced' ? null : quote.nanoUsd;
}

/** The parts of a direction an engine may or may not be able to express. */
export type DirectionAspect =
  'emotion' | 'intensity' | 'pace' | 'volume' | 'stance' | 'seed' | 'voice';

/**
 * One thing the engine was asked for and could not do exactly.
 *
 * `substituted` distinguishes the two failures that matter. `null` means the aspect was
 * **dropped** - nothing about it reached the engine. A string means it was
 * **approximated** - Higgs has no `contempt`, so `disgust` went instead, and the take
 * will be in the wrong register rather than in no register. A reviewer listening back
 * needs to be able to tell those apart without listening.
 */
export interface DirectionGap {
  readonly aspect: DirectionAspect;
  readonly requested: string;
  readonly substituted: string | null;
  readonly reason: string;
}

/**
 * What the adapter actually did with the direction.
 *
 * Returned on every result, including the ones where nothing was lost, because "was
 * anything lost" is a question the provenance record has to be able to answer without
 * re-deriving the translation.
 */
export interface RenderedDirection {
  /** Exactly the string that was sent, tags and all. This is what the bill counts. */
  readonly text: string;
  /** Engine-native settings and tokens that were applied, for the log. */
  readonly applied: readonly string[];
  /** Aspects that reached the engine in some altered form. */
  readonly approximated: readonly DirectionGap[];
  /** Aspects that did not reach the engine at all. */
  readonly dropped: readonly DirectionGap[];
}

/**
 * Character-level timing, when the engine returns it.
 *
 * Three parallel arrays rather than an array of triples because that is the shape
 * ElevenLabs returns and re-shaping it here would mean re-shaping it back for anything
 * that consumes it in bulk. The invariant - all three the same length - is asserted by
 * the adapter that builds it, once.
 */
export interface SpeechAlignment {
  readonly characters: readonly string[];
  readonly startMs: readonly number[];
  readonly endMs: readonly number[];
}

export interface SpeechResult extends ProviderCallResult {
  readonly audio: AudioArtifact;
  /** `null` from an engine that does not return timing. Never a fabricated alignment. */
  readonly alignment: SpeechAlignment | null;
  readonly rendered: RenderedDirection;
}

export interface SpeechSynthesisPort {
  /**
   * What these weights can do. Read by the router before anything is spent.
   *
   * A property rather than a method because it is a fact about the configured adapter,
   * not a computation, and because the router needs it in a synchronous filter.
   */
  readonly speech: SpeechCapabilities;

  synthesizeSpeech(request: SpeechRequest): Promise<Result<SpeechResult, AppError>>;

  /** What `synthesizeSpeech` will cost on this model. Pure and synchronous. */
  quoteSpeech(request: SpeechCostRequest): SpeechCostQuote;
}

/**
 * The refusal an adapter owes before it opens a socket, or `undefined` when it can serve.
 *
 * Shared so the three adapters cannot disagree about *when* to refuse. Two checks, and
 * both exist because of something real:
 *
 *  - **Language.** Chatterbox's stock multilingual weights have no Persian. Sending
 *    Persian anyway does not fail - it produces confident, fluent, wrong sound, which is
 *    the worst possible failure mode because it passes every automated check we have. A
 *    typed refusal costs the router one failover.
 *  - **Length.** ElevenLabs rejects over its per-model ceiling with a 4xx that is charged
 *    for. Refusing locally is free and names the number.
 *
 * Returned rather than thrown: a request for something an adapter cannot do is expected
 * failure, and the router routes around it.
 */
export function speechRefusal(
  provider: string,
  capabilities: SpeechCapabilities,
  request: { readonly text: string; readonly language: LanguageTag },
): AppError | undefined {
  if (request.text.trim().length === 0) {
    return new ValidationError({
      message: 'a speech request needs something to say',
      context: { provider },
    });
  }

  if (!speaksLanguage(capabilities, request.language)) {
    return new UnsupportedCapabilityError(
      provider,
      `speech in "${request.language}" - these weights declare ${capabilities.languages.join(', ')}; route this language to an engine that speaks it rather than accepting fluent nonsense`,
    );
  }

  const ceiling = capabilities.maxCharactersPerRequest;
  if (ceiling !== null && request.text.length > ceiling) {
    return new ValidationError({
      message: `text is ${String(request.text.length)} characters; this model accepts ${String(ceiling)}`,
      context: { provider, characters: request.text.length, ceiling },
    });
  }

  return undefined;
}
