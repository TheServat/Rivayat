/**
 * The audio timeline: §27's five tracks, as a document.
 *
 * ## Why this is not hung off `AnimationIR.markers`
 *
 * `Marker` already exists, already has the kinds `dialogue`, `sfx`, `music` and `beat`,
 * and the brief asked - correctly - whether audio should hang off it rather than
 * inventing a second concept. It should not, and the reason is not that markers are the
 * wrong shape. It is that they are on the wrong side of a cache boundary.
 *
 * A `Marker` is `{ id, timeMs, kind, label }`: a **point**, carrying no payload. It is
 * part of `AnimationIR`, and `AnimationIR` is content-hashed and *is* the render cache
 * key. Audio is a **span** carrying bytes, a voice, a cost and a provenance, and it is
 * produced after choreography and regenerated independently of it - a second take of one
 * line, a re-mixed music cue, a louder ambience bed. Widening `Marker` to hold that
 * payload would mean every retake of a single line changes the animation document's
 * hash and invalidates a render in which not one pixel moved. That is the whole argument.
 * Two supporting ones:
 *
 *  - `evaluate(ir, t)` never reads markers, and ADR-0008 §1 makes purity of the
 *    evaluator the determinism boundary. Audio is authored by providers, baked into
 *    artefacts, and replayed from them - the same status as a sprite sheet, which is
 *    also not in the IR.
 *  - `Shot.audio` (`story/shot.ts`) already holds *authoring intent* per shot: an
 *    `SfxCue` with a shot-relative `startMs`, a `MusicCue` that says what the score
 *    does here. This document is the **compiled** result across a whole episode, with
 *    absolute times and resolved artefacts - exactly the relationship `AnimationIR` has
 *    to `Shot[]`. So this is not a second concept for the same thing; it is the second
 *    half of a pipeline that already had a first half and no output.
 *
 * ## How the two are kept in agreement
 *
 * By reference, not by duplication. {@link AudioCue.markerRef} names the marker a cue
 * is synchronised to, and {@link checkAgainstMarkers} asserts that every referenced
 * marker exists and that the cue starts where the marker says. So the *cue point*
 * concept stays where it already lived and is not re-invented; only the sound is new.
 * A cue with no marker is legal and ordinary - an ambience bed is not synchronised to
 * anything.
 */

import { z } from 'zod';

import {
  Label,
  Millis,
  NonEmptyString,
  NonNegativeInt,
  Prose,
  SemanticKey,
  Sha256Hex,
  Unit01,
} from '../primitives/common';
import { AudioCueId, EntityId, MarkerId, ShotId } from '../primitives/ids';
import { SpeechDirection } from './emotion';
import { LanguageTag, Performer, type VoiceRole } from './voice';

/** The five tracks named in §27, in the order they are mixed. */
export const AUDIO_TRACKS = ['narration', 'dialogue', 'music', 'sfx', 'ambience'] as const;

export const AudioTrack = z.enum(AUDIO_TRACKS);
export type AudioTrack = z.infer<typeof AudioTrack>;

/**
 * A rendered piece of audio in the store, addressed by content.
 *
 * The determinism story for TTS in one type. A synthesiser is not deterministic and
 * ADR-0008 §1 says that is fine: **the provider authors, the artefact replays.** Once a
 * line has been spoken the bytes are hashed and cached like any other asset, and a
 * second run with the same text, voice and direction is a cache hit that costs nothing -
 * which is CLAUDE.md's second non-negotiable applied to sound.
 *
 * `durationMs` is nullable and that is not laziness. WAV carries its length in its
 * header and can be measured for free; MP3 cannot without decoding, and a guessed
 * duration silently mistimes everything after it on the track. `null` means "not yet
 * measured", and the compiler refuses to lay out a cue whose length is unknown.
 */
export const AudioBlob = z.strictObject({
  sha256: Sha256Hex,
  mimeType: NonEmptyString.max(80),
  bytes: NonNegativeInt,
  durationMs: Millis.nullable().default(null),
  sampleRateHz: NonNegativeInt.default(0).describe('0 when the decoder did not report one.'),
});
export type AudioBlob = z.infer<typeof AudioBlob>;

/**
 * Where a cue's sound came from, so a run can be audited and re-costed.
 *
 * `null` everywhere is the legitimate state of a freshly planned timeline: the cues
 * exist, the words are written, nothing has been spoken yet. That state is what the
 * cost estimate at S5 is computed over.
 */
export const AudioProvenance = z.strictObject({
  /** `provider:model`, e.g. `elevenlabs:eleven_v3`. `null` for a human performance. */
  modelRef: NonEmptyString.max(200).nullable().default(null),
  /** Exactly what was sent, tags and all. `null` when nothing was sent. */
  renderedText: Prose.nullable().default(null),
  /** Aspects of the direction the engine could not express. Empty is the happy case. */
  dropped: z.array(Label).max(16).default([]),
  /** Nano-dollars this cue cost. `0` for a local engine, `null` when it has not run. */
  costNanoUsd: NonNegativeInt.nullable().default(null),
  seed: NonNegativeInt.nullable().default(null),
});
export type AudioProvenance = z.infer<typeof AudioProvenance>;

/**
 * A spoken cue - a character line or a narrated paragraph.
 *
 * `performer` is the discriminator that matters operationally: `synthetic` cues are
 * provider calls with a cost, `human` cues are lines on the page the owner reads and
 * never touch a network. Both live on the same timeline because the mix does not care,
 * and because the narrator's timing has to be solved against the dialogue's.
 *
 * It is deliberately *not* the same question as which track the cue is on. The track is
 * the narrative function - is this the voice telling the story or a person inside it -
 * and the two axes come apart in both directions: a series with no human narrator has
 * synthetic narration, and a guest reading a character part is a human on the dialogue
 * track.
 */
export const SpeechCue = z.strictObject({
  kind: z.literal('speech'),
  speakerRef: EntityId,
  performer: Performer,
  text: Prose.describe('The words, verbatim, in the series language. Never carries engine tags.'),
  language: LanguageTag,
  direction: SpeechDirection,
  /** What the line is really doing, copied from `DialogueLine.subtext` for the reader. */
  subtext: Prose.optional(),
});
export type SpeechCue = z.infer<typeof SpeechCue>;

/** A library sound effect placed at a moment. Mirrors `Shot.audio.sfx`, resolved. */
export const EffectCue = z.strictObject({
  kind: z.literal('effect'),
  key: SemanticKey,
  loop: z.boolean().default(false),
});
export type EffectCue = z.infer<typeof EffectCue>;

/** A score or ambience bed. `mood` is kept so a music provider has something to read. */
export const BedCue = z.strictObject({
  kind: z.literal('bed'),
  key: SemanticKey,
  mood: Label,
  intensity: Unit01.default(0.5),
  /** Fade in and out, in milliseconds. A hard cut is `0`. */
  fadeInMs: Millis.default(0),
  fadeOutMs: Millis.default(0),
});
export type BedCue = z.infer<typeof BedCue>;

export const AudioSource = z.discriminatedUnion('kind', [SpeechCue, EffectCue, BedCue]);
export type AudioSource = z.infer<typeof AudioSource>;

/**
 * One entry on one track.
 *
 * `startMs` is absolute within the episode, unlike `SfxCue.startMs` which is relative to
 * its shot. That difference is the compilation: shot-relative intent in, episode-absolute
 * timeline out, and nothing downstream has to know which shot a sound came from - except
 * `shotRef`, which is kept so an edit to one shot can invalidate exactly its cues.
 */
export const AudioCue = z
  .strictObject({
    id: AudioCueId,
    track: AudioTrack,
    startMs: Millis,
    /**
     * How long the cue occupies the track.
     *
     * The field means two different things on the two kinds of speech cue, and the
     * difference is the whole reason the narrator's script can exist at all:
     *
     *  - For a **synthetic** cue it is a *measurement*, `null` until the line has been
     *    spoken. The same reason `DialogueLine.durationMs` says "do not guess it": a
     *    plan full of guessed lengths is a plan that will not match the video.
     *  - For a **human** cue it is an *allotment*, known before anything is recorded,
     *    because it is the window the compiler gave the owner to land the line in. It
     *    is therefore required, and the refinement below enforces that.
     */
    durationMs: Millis.nullable().default(null),
    /** Level before loudness normalisation. The mix, not the performance. */
    gain: Unit01.default(1),
    source: AudioSource,
    /** The shot this cue was compiled from, when it came from one. */
    shotRef: ShotId.nullable().default(null),
    /**
     * The `AnimationIR` marker this cue is synchronised to.
     *
     * A reference and not a copy: the marker owns the moment, the cue owns the sound.
     * `null` for anything not tied to a beat - an ambience bed, a music tail.
     */
    markerRef: MarkerId.nullable().default(null),
    blob: AudioBlob.nullable().default(null),
    provenance: AudioProvenance,
  })
  .superRefine((cue, ctx) => {
    // A cue with bytes but no measured length is the state that silently mistimes a
    // whole track: the mixer has something to play and no idea when the next thing
    // starts. Whoever produced the blob is the only party that can measure it.
    if (cue.blob !== null && cue.blob.durationMs === null && cue.durationMs === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['durationMs'],
        message: 'a cue that has audio must have a measured duration',
      });
    }
    // The narrator is a person. A human cue that acquired a model reference means a
    // machine read the owner's lines, and the only place that would otherwise surface
    // is the finished episode.
    if (
      cue.source.kind === 'speech' &&
      cue.source.performer === 'human' &&
      cue.provenance.modelRef !== null
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['provenance', 'modelRef'],
        message: 'a human-performed cue cannot name a synthesis model',
      });
    }
    if (cue.source.kind === 'speech' && !SPEECH_TRACKS.has(cue.track)) {
      ctx.addIssue({
        code: 'custom',
        path: ['track'],
        message: 'a speech cue belongs on the narration or dialogue track',
      });
    }
    if (cue.source.kind !== 'speech' && SPEECH_TRACKS.has(cue.track)) {
      ctx.addIssue({
        code: 'custom',
        path: ['track'],
        message: `the ${cue.track} track carries speech; an effect or a bed does not belong on it`,
      });
    }
    // A human line with no window is a line the owner is asked to read to nothing. The
    // narrator's script is generated from these numbers, so an absent one is not a gap
    // in a document, it is a page that cannot be performed.
    if (
      cue.source.kind === 'speech' &&
      cue.source.performer === 'human' &&
      cue.durationMs === null
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['durationMs'],
        message: 'a human-performed cue must be given the window it has to land in',
      });
    }
  });
export type AudioCue = z.infer<typeof AudioCue>;

/** The two tracks that carry words. Everything else on the timeline is sound. */
const SPEECH_TRACKS: ReadonlySet<AudioTrack> = new Set<AudioTrack>(['narration', 'dialogue']);

/**
 * Which of §27's speech tracks a voice belongs on.
 *
 * A lookup on the narrative role, so the two can never disagree and nobody has to
 * remember to move a cue when a voice is recast.
 */
export function trackForRole(role: VoiceRole): AudioTrack {
  return role === 'narrator' ? 'narration' : 'dialogue';
}

/**
 * Every cue in one episode, on five tracks.
 *
 * Flat rather than nested per track: a cue names its own track, the mixer wants them in
 * time order regardless, and a nested shape makes "what is playing at 4200 ms" a join
 * across five arrays.
 */
export const AudioTimeline = z
  .strictObject({
    /** The animation document these times are measured against. */
    animationRef: NonEmptyString.max(64).describe('The `AnimationIR.id` this timeline scores.'),
    /** Total programme length. Cues may not start after it. */
    durationMs: Millis,
    language: LanguageTag,
    cues: z.array(AudioCue).max(4096).default([]),
  })
  .superRefine((timeline, ctx) => {
    const seen = new Set<string>();
    timeline.cues.forEach((cue, index) => {
      if (seen.has(cue.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['cues', index, 'id'],
          message: `duplicate cue id ${cue.id}`,
        });
      }
      seen.add(cue.id);

      if (cue.startMs > timeline.durationMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['cues', index, 'startMs'],
          message: 'a cue cannot start after the programme ends',
        });
      }
    });
  });
export type AudioTimeline = z.infer<typeof AudioTimeline>;

/** The cues on one track, in time order. The mixer's view. */
export function cuesOnTrack(timeline: AudioTimeline, track: AudioTrack): readonly AudioCue[] {
  return timeline.cues
    .filter((cue) => cue.track === track)
    .slice()
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
}

/** Where a cue ends, or where it starts when nobody has measured it yet. */
export function cueEndMs(cue: AudioCue): number {
  return cue.startMs + (cue.durationMs ?? 0);
}

/** A cue that still has to be spoken: no bytes yet, and a machine will have to speak it. */
export function isPendingSynthesis(cue: AudioCue): boolean {
  return cue.blob === null && cue.source.kind === 'speech' && cue.source.performer === 'synthetic';
}

/** What a marker looks like from here. `AnimationIR.Marker` satisfies it structurally. */
export interface MarkerLike {
  readonly id: string;
  readonly timeMs: number;
}

/** One disagreement between the timeline and the markers it claims to be synchronised to. */
export const TimelineSyncIssue = z.strictObject({
  cueId: AudioCueId,
  markerRef: MarkerId,
  kind: z.enum(['missing-marker', 'time-mismatch']),
  /** The marker's time, or `null` when there is no such marker. */
  markerTimeMs: Millis.nullable(),
  cueStartMs: Millis,
});
export type TimelineSyncIssue = z.infer<typeof TimelineSyncIssue>;

/**
 * Proves the timeline and the animation document agree about when things happen.
 *
 * The one check that stops the two documents drifting. Returned as a list rather than
 * thrown, and rather than folded into `AudioTimeline`'s own refinement, because the
 * markers live in a different document that this module deliberately does not import -
 * `packages/contracts/src/anim/**` has its own owners, and a validation that reached
 * into it would couple the two schemas for the sake of one number.
 *
 * An empty result is the contract: **the narrator reads to a video that matches.**
 */
export function checkAgainstMarkers(
  timeline: AudioTimeline,
  markers: readonly MarkerLike[],
): readonly TimelineSyncIssue[] {
  const timeById = new Map(markers.map((marker) => [marker.id, marker.timeMs]));
  const issues: TimelineSyncIssue[] = [];

  for (const cue of timeline.cues) {
    const markerRef = cue.markerRef;
    if (markerRef === null) continue;

    const markerTimeMs = timeById.get(markerRef);
    if (markerTimeMs === undefined) {
      issues.push({
        cueId: cue.id,
        markerRef,
        kind: 'missing-marker',
        markerTimeMs: null,
        cueStartMs: cue.startMs,
      });
      continue;
    }
    if (markerTimeMs !== cue.startMs) {
      issues.push({
        cueId: cue.id,
        markerRef,
        kind: 'time-mismatch',
        markerTimeMs,
        cueStartMs: cue.startMs,
      });
    }
  }

  return issues;
}
