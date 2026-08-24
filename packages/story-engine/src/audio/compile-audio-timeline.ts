/**
 * Shots in, one scored timeline out.
 *
 * The same relationship `AnimationIR` has to `Shot[]`: the shot list holds *intent*, in
 * shot-relative time, per shot; this produces the compiled artefact, in episode-absolute
 * time, across the whole cut. `Shot.audio` and `Shot.dialogue` already existed and had no
 * consumer - this is the consumer.
 *
 * Three compilations happen here that are more than an offset addition, and each is a
 * decision worth reading:
 *
 *  - **The narrator gets a window.** A synthetic line's duration is measured after it is
 *    spoken; a human line's has to exist *before*, because the whole point of the
 *    narrator's script is to tell the owner how long they have. So a human line is
 *    allotted the time from where it starts to wherever the next thing that needs the
 *    channel begins, and that allotment is what the printed page says.
 *  - **Music is a state machine, not a list.** `MusicCue.action` describes what the score
 *    *does* at this shot - it may be already playing - so a bed is opened, extended and
 *    closed across shots rather than restarted at each one. Emitting a cue per shot would
 *    produce a score that retriggers every cut.
 *  - **A looping effect is ambience.** `SfxCue.loop` already means "a bed that runs to the
 *    end of the shot, e.g. rain", which is precisely §27's ambience track. Routing on the
 *    existing field is better than adding a second one that says the same thing.
 */

import type {
  AudioCue,
  AudioTimeline,
  AudioTrack,
  AudioCueId,
  DialogueLine,
  Ids,
  LanguageTag,
  MarkerId,
  Shot,
  SpeechDirection,
  SpeechStance,
  VoiceCasting,
  VoiceProfile,
} from '@rv/contracts';
import { toSpeechDirection, trackForRole, voiceFor } from '@rv/contracts';

/** A marker in the animation document, as much of one as this module needs. */
export interface CompileMarker {
  readonly id: MarkerId;
  readonly timeMs: number;
  readonly kind: string;
}

export interface CompileAudioInput {
  readonly ids: Ids;
  /** The `AnimationIR.id` these times are measured against. */
  readonly animationRef: string;
  readonly language: LanguageTag;
  /** In cut order. Their durations are what makes a shot-relative time absolute. */
  readonly shots: readonly Shot[];
  readonly casting: VoiceCasting;
  /**
   * The stance for a line the graph cannot infer, keyed by `shotId:lineIndex`.
   *
   * Only `ironic` really needs this - see `line-stance.ts` for why it is never guessed -
   * but the map is general so a director can override any line.
   */
  readonly stances?: Readonly<Record<string, SpeechStance>>;
  /**
   * The animation document's markers, when it exists yet.
   *
   * A cue is pinned to a marker at the same instant. Optional because audio can be
   * planned before the IR is choreographed, and an unpinned cue is legal.
   */
  readonly markers?: readonly CompileMarker[];
}

/** One thing the compiler could not do, reported rather than silently dropped. */
export interface CompileIssue {
  readonly shotId: string;
  readonly kind: 'uncast-speaker' | 'unresolved-emotion';
  readonly detail: string;
}

export interface CompiledAudio {
  readonly timeline: AudioTimeline;
  /**
   * Everything the compiler had to work around.
   *
   * Returned rather than logged, and non-fatal by design: an uncast speaker should not
   * stop a whole episode compiling, but it must not be invisible either - the audience
   * would notice as silence, and nobody else would notice at all.
   */
  readonly issues: readonly CompileIssue[];
}

/**
 * The window a human performer is given for a line.
 *
 * From where the line starts to whichever comes first: the next line in this shot, or the
 * end of the shot. Not to the end of the *scene*, because the shot is the unit the video
 * actually cuts on, and a narrator given a window that spans a cut will drift across it.
 */
function windowFor(shot: Shot, line: DialogueLine, next: DialogueLine | undefined): number {
  const endMs = next === undefined ? shot.durationMs : next.startMs;
  return Math.max(0, endMs - line.startMs);
}

export function compileAudioTimeline(input: CompileAudioInput): CompiledAudio {
  const totalMs = input.shots.reduce((sum, shot) => sum + shot.durationMs, 0);
  const markerAt = new Map<string, MarkerId>();
  for (const marker of input.markers ?? []) {
    markerAt.set(`${marker.kind}:${String(marker.timeMs)}`, marker.id);
  }

  const cues: AudioCue[] = [];
  const issues: CompileIssue[] = [];
  const music = new MusicBed();

  // A running cursor rather than a parallel offsets array: the array would need an
  // index-guard fallback that could never fire, and an unreachable fallback is a branch
  // nobody can test.
  let shotStart = 0;
  for (const shot of input.shots) {
    shot.dialogue.forEach((line, lineIndex) => {
      const profile = voiceFor(input.casting, line.speakerRef);
      if (profile === undefined) {
        issues.push({
          shotId: shot.id,
          kind: 'uncast-speaker',
          detail: `${line.speakerRef} speaks in this shot but has no voice; the line will be silent`,
        });
        return;
      }

      const stance = input.stances?.[`${shot.id}:${String(lineIndex)}`];
      const { direction, unresolvedEmotion } = toSpeechDirection(line.delivery, stance ?? 'plain');
      if (unresolvedEmotion !== null) {
        issues.push({
          shotId: shot.id,
          kind: 'unresolved-emotion',
          detail: `"${unresolvedEmotion}" is not in the emotion lexicon; this line will be performed flat`,
        });
      }

      const startMs = shotStart + line.startMs;
      const track = trackForRole(profile.role);
      cues.push(
        speechCue({
          id: input.ids.audioCue(),
          track,
          startMs,
          durationMs: durationFor(profile, line, shot, shot.dialogue[lineIndex + 1]),
          shotId: shot.id,
          markerRef: markerAt.get(`dialogue:${String(startMs)}`) ?? null,
          profile,
          text: line.text,
          subtext: line.subtext,
          language: input.language,
          direction,
        }),
      );
    });

    for (const effect of shot.audio.sfx) {
      const startMs = shotStart + effect.startMs;
      cues.push({
        id: input.ids.audioCue(),
        // `loop` already means "a bed that runs to the end of the shot, e.g. rain",
        // which is §27's ambience track under a different name.
        track: effect.loop ? 'ambience' : 'sfx',
        startMs,
        durationMs: effect.loop ? Math.max(0, shotStart + shot.durationMs - startMs) : null,
        gain: effect.gain,
        source: { kind: 'effect', key: effect.key, loop: effect.loop },
        shotRef: shot.id,
        markerRef: markerAt.get(`sfx:${String(startMs)}`) ?? null,
        blob: null,
        provenance: pendingProvenance(),
      });
    }

    music.apply(shot, shotStart, input.ids, markerAt);
    shotStart += shot.durationMs;
  }

  cues.push(...music.close(totalMs));
  cues.sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));

  return {
    timeline: {
      animationRef: input.animationRef,
      durationMs: totalMs,
      language: input.language,
      cues,
    },
    issues,
  };
}

/**
 * A cue that has not been produced yet.
 *
 * A function rather than a shared constant: `dropped` is a mutable array on the schema,
 * and one shared instance across every cue in an episode is an aliasing bug waiting for
 * the first adapter that pushes to it.
 */
function pendingProvenance(): AudioCue['provenance'] {
  return { modelRef: null, renderedText: null, dropped: [], costNanoUsd: null, seed: null };
}

/**
 * The two meanings of a duration, decided in one place.
 *
 * A synthetic line's is a measurement and stays `null` until it has been spoken. A human
 * line's is an allotment and must exist now, because the narrator's page is generated
 * from it - `AudioCue` refuses a human cue without one.
 */
function durationFor(
  profile: VoiceProfile,
  line: DialogueLine,
  shot: Shot,
  next: DialogueLine | undefined,
): number | null {
  if (line.durationMs !== undefined) return line.durationMs;
  return profile.performedBy === 'human' ? windowFor(shot, line, next) : null;
}

function speechCue(parts: {
  id: AudioCueId;
  track: AudioTrack;
  startMs: number;
  durationMs: number | null;
  shotId: Shot['id'];
  markerRef: MarkerId | null;
  profile: VoiceProfile;
  text: string;
  subtext: string;
  language: LanguageTag;
  direction: SpeechDirection;
}): AudioCue {
  return {
    id: parts.id,
    track: parts.track,
    startMs: parts.startMs,
    durationMs: parts.durationMs,
    gain: 1,
    source: {
      kind: 'speech',
      speakerRef: parts.profile.speakerRef,
      performer: parts.profile.performedBy,
      text: parts.text,
      language: parts.language,
      direction: parts.direction,
      subtext: parts.subtext,
    },
    shotRef: parts.shotId,
    markerRef: parts.markerRef,
    blob: null,
    provenance: pendingProvenance(),
  };
}

/**
 * The score, carried across cuts.
 *
 * `MusicCue.action` describes a transition rather than a clip: `continue` means the same
 * cue is still playing, `swell` means it changes intensity without restarting, `stop`
 * ends it. Emitting one cue per shot would restart the music at every edit, which is the
 * single most audible way to get a score wrong.
 */
class MusicBed {
  #open: { cue: AudioCue; key: string } | null = null;
  readonly #closed: AudioCue[] = [];

  apply(shot: Shot, shotStart: number, ids: Ids, markerAt: ReadonlyMap<string, MarkerId>): void {
    const cue = shot.audio.music;
    if (cue === null) {
      // Silence is a choice the shot made. Whatever was playing ends here.
      this.#end(shotStart);
      return;
    }

    if (cue.action === 'stop' || cue.action === 'fade') {
      this.#end(shotStart + (cue.action === 'fade' ? shot.durationMs : 0));
      return;
    }

    // `continue` on nothing is an authoring slip, not a crash: the writer meant the cue
    // to keep playing and it was never started, so start it here rather than lose it.
    const sameCue = this.#open !== null && this.#open.key === cue.key;
    if (cue.action === 'continue' && sameCue) return;
    if (cue.action === 'swell' && sameCue) return;

    this.#end(shotStart);
    this.#open = {
      key: cue.key,
      cue: {
        id: ids.audioCue(),
        track: 'music',
        startMs: shotStart,
        durationMs: null,
        gain: 1,
        source: {
          kind: 'bed',
          key: cue.key,
          mood: cue.mood,
          intensity: cue.intensity,
          fadeInMs: 0,
          fadeOutMs: 0,
        },
        shotRef: shot.id,
        markerRef: markerAt.get(`music:${String(shotStart)}`) ?? null,
        blob: null,
        provenance: pendingProvenance(),
      },
    };
  }

  /** Closes whatever is still playing at the end of the episode. */
  close(totalMs: number): readonly AudioCue[] {
    this.#end(totalMs);
    return this.#closed;
  }

  #end(atMs: number): void {
    const open = this.#open;
    if (open === null) return;
    this.#closed.push({ ...open.cue, durationMs: Math.max(0, atMs - open.cue.startMs) });
    this.#open = null;
  }
}
