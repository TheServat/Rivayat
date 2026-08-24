/**
 * The narrator's script: a plain text file a person reads aloud.
 *
 * This is one of the two outputs of the audio layer and the one with the harder brief,
 * because its reader is a human under time pressure with a microphone open. The design
 * rule the owner gave is the acceptance criterion: **if they have to decode it while
 * reading, it has failed.** Everything below follows from that.
 *
 *  - **Breath groups are lines.** The text is broken where a breath goes and each group
 *    is printed on its own line. That is the *only* performance instruction that is not
 *    words - there is no `<break>`, no ellipsis code, no bracketed pause. The layout is
 *    the instruction.
 *  - **The delivery is a Persian phrase on its own line**, above the text and separated
 *    from it, so the eye takes it once and then never crosses it again. It is never
 *    inline, because an inline tag is read *inside* the sentence and there is no way to
 *    not read it.
 *  - **Timing appears once per passage**, as a window and a length. Per-breath timing
 *    would be more precise and unreadable; the passage is what the timeline actually
 *    guarantees.
 *  - **Silence is printed.** A rest between passages is a thing the reader has to do,
 *    so it appears as a line saying how long it is, rather than as blank space they have
 *    to infer from two timestamps.
 *  - **Persian digits throughout.** A reader glancing at `00:08` in the middle of
 *    Persian text has to switch scripts to read a number. `۰:۰۸` does not.
 *
 * The script is *derived from* {@link AudioTimeline} rather than written beside it, so
 * "the narrator's timing file has to agree with the timeline" is true by construction
 * and not by a check somebody has to run.
 */

import { z } from 'zod';

import { Label, Locale, Millis, NonNegativeInt, Prose } from '../primitives/common';
import { AudioCueId } from '../primitives/ids';
import {
  SPEECH_EMOTION_LABELS,
  SPEECH_PACE_LABELS,
  SPEECH_STANCE_LABELS,
  SPEECH_VOLUME_LABELS,
  SpeechDirection,
} from './emotion';
import { type AudioCue, type AudioTimeline, cuesOnTrack } from './timeline';

// -- breath grouping ---------------------------------------------------------

/**
 * Punctuation that ends a thought. A line always breaks here.
 *
 * Both the Persian and the Latin forms, because a Persian script written on a Latin
 * keyboard contains both and a reader should not be punished for the writer's keyboard.
 */
const SENTENCE_ENDS = new Set(['.', '!', '?', '؟', '…']);

/** Punctuation that separates clauses. A line breaks here only if it has to. */
const CLAUSE_ENDS = new Set([',', '،', ';', '؛', ':', '»']);

/**
 * How many characters fit on a line a person can take in at a glance.
 *
 * A working figure, not a measurement: it is roughly a comfortable spoken phrase in
 * Persian and it is exposed as an option so a reader who prefers longer lines can have
 * them. Too small and the page becomes a list of fragments, which is harder to perform
 * than a paragraph.
 */
export const DEFAULT_BREATH_CHARS = 46;

function splitAt(text: string, marks: ReadonlySet<string>, limit: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const character of text) {
    current += character;
    if (marks.has(character) && current.trim().length >= limit) {
      out.push(current.trim());
      current = '';
    }
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
}

/** Last resort: break on a space before the limit, or hand back an over-long group. */
function splitOnSpace(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const breakAt = text.lastIndexOf(' ', limit);
  if (breakAt <= 0) return [text];
  return [text.slice(0, breakAt).trim(), ...splitOnSpace(text.slice(breakAt + 1).trim(), limit)];
}

/**
 * Breaks a passage where a reader would breathe.
 *
 * Three passes, weakest break last: sentences first, then clauses only for the sentences
 * that are still too long, then a space only for what remains. The ordering is what
 * stops a short sentence being chopped at its comma for no reason - a break that is not
 * needed is a break that reads as a pause the writer never wrote.
 */
export function splitBreathGroups(text: string, maxChars = DEFAULT_BREATH_CHARS): string[] {
  const groups: string[] = [];
  for (const paragraph of text.split('\n')) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) continue;

    for (const sentence of splitAt(trimmed, SENTENCE_ENDS, 1)) {
      if (sentence.length <= maxChars) {
        groups.push(sentence);
        continue;
      }
      for (const clause of splitAt(sentence, CLAUSE_ENDS, Math.floor(maxChars / 3))) {
        groups.push(...splitOnSpace(clause, maxChars));
      }
    }
  }
  return groups.length > 0 ? groups : [text.trim()];
}

// -- the script --------------------------------------------------------------

/**
 * One passage the narrator reads, with the window it has to land in.
 *
 * `fitsWindow` is a warning and not a validation. A passage that does not fit is not a
 * malformed document - it is a note to the writer that the line is too long for the
 * shot, and it is far better delivered on the page in advance than discovered by the
 * owner halfway through a take.
 */
export const NarrationPassage = z.strictObject({
  cueRef: AudioCueId,
  index: NonNegativeInt.describe('Position in the read, from 1. Printed, so it can be called out.'),
  startMs: Millis,
  durationMs: Millis.describe('The window. For a human performance this is an allotment.'),
  /** Silence between the end of the previous passage and this one. `0` for the first. */
  restBeforeMs: Millis.default(0),
  /** The text, already broken where a breath goes. One entry per printed line. */
  breaths: z.array(Prose).min(1),
  direction: SpeechDirection,
  /** What is on screen while this is read, when the compiler knew. */
  onScreen: Prose.optional(),
  /** False when the words plainly will not fit the window at a normal reading rate. */
  fitsWindow: z.boolean().default(true),
});
export type NarrationPassage = z.infer<typeof NarrationPassage>;

export const NarrationScript = z.strictObject({
  title: Label,
  /** e.g. "قسمت ۱". Free text because a series numbers its episodes however it likes. */
  episodeLabel: Label,
  locale: Locale.default('fa'),
  /** The `AnimationIR.id` these times are measured against. Printed, so a stale page is obvious. */
  animationRef: Label,
  totalDurationMs: Millis,
  passages: z.array(NarrationPassage).max(2048).default([]),
});
export type NarrationScript = z.infer<typeof NarrationScript>;

/**
 * Roughly how fast Persian is read aloud, in characters per second.
 *
 * **This is a working figure, not a verified measurement.** Nothing in `docs/00-research`
 * covers Persian speech rate, and inventing a number and presenting it as research would
 * be worse than admitting the gap. It exists only to warn that a passage is *obviously*
 * too long for its window, so it is deliberately generous - it should never cry wolf.
 * Replace it with the real figure from the owner's first recorded read.
 */
export const ASSUMED_PERSIAN_CHARS_PER_SECOND = 14;

export interface NarrationScriptOptions {
  readonly title: string;
  readonly episodeLabel: string;
  readonly maxBreathChars?: number;
  readonly charsPerSecond?: number;
  /** What is on screen at each cue, keyed by cue id. The compiler supplies it if it knows. */
  readonly onScreen?: Readonly<Record<string, string>>;
}

/**
 * The narrator's script, derived from the timeline that scores the video.
 *
 * Derivation rather than authorship is the point: there is no second copy of the timings
 * to fall out of step, and a passage cannot exist on the page without existing on the
 * narration track. Only cues on that track are read, which is exactly the
 * narrator/character split expressed as a filter.
 */
export function toNarrationScript(
  timeline: AudioTimeline,
  options: NarrationScriptOptions,
): NarrationScript {
  const charsPerSecond = options.charsPerSecond ?? ASSUMED_PERSIAN_CHARS_PER_SECOND;
  const maxBreathChars = options.maxBreathChars ?? DEFAULT_BREATH_CHARS;
  const onScreen = options.onScreen ?? {};

  let previousEndMs = 0;
  const passages: NarrationPassage[] = [];

  for (const cue of cuesOnTrack(timeline, 'narration')) {
    const spoken = readableIn(cue);
    if (spoken === null) continue;

    const { durationMs } = spoken;
    const needMs = Math.round((spoken.text.length / charsPerSecond) * 1000);
    const note = onScreen[cue.id];

    passages.push({
      cueRef: cue.id,
      index: passages.length + 1,
      startMs: cue.startMs,
      durationMs,
      restBeforeMs: Math.max(0, cue.startMs - previousEndMs),
      breaths: splitBreathGroups(spoken.text, maxBreathChars),
      direction: spoken.direction,
      ...(note === undefined ? {} : { onScreen: note }),
      fitsWindow: needMs <= durationMs,
    });
    previousEndMs = cue.startMs + durationMs;
  }

  return {
    title: options.title,
    episodeLabel: options.episodeLabel,
    locale: 'fa',
    animationRef: timeline.animationRef,
    totalDurationMs: timeline.durationMs,
    passages,
  };
}

/**
 * A cue a *person* has to read inside a window, or `null` for anything else.
 *
 * Three conditions, and each excludes something that would otherwise reach the page:
 * an effect cue has no words, a synthetic narration cue belongs to the episode rather
 * than to the reader, and a cue with no window is a line the owner would be asked to
 * read to nothing. `AudioCue` already refuses the last of those, so this is belt and
 * braces - but it is the kind that costs one comparison and protects the page from a
 * future relaxation of the schema.
 */
function readableIn(
  cue: AudioCue,
): { text: string; direction: SpeechDirection; durationMs: number } | null {
  if (cue.source.kind !== 'speech') return null;
  if (cue.source.performer !== 'human') return null;
  if (cue.durationMs === null) return null;
  return { text: cue.source.text, direction: cue.source.direction, durationMs: cue.durationMs };
}

// -- rendering the page ------------------------------------------------------

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/**
 * Latin digits to Persian digits.
 *
 * Not cosmetic. The page is Persian and right-to-left; a Latin numeral in the middle of
 * it is a left-to-right island that a reader's eye has to stop and re-orient for. The
 * narrator glances at these between breaths.
 */
export function toPersianDigits(value: string): string {
  // `charAt` rather than an index: the regex already guarantees a digit, and an index
  // would need a `?? digit` fallback that can never run and can therefore never be tested.
  return value.replace(/[0-9]/gu, (digit) => PERSIAN_DIGITS.charAt(Number(digit)));
}

/** `m:ss`, in Persian digits. Hours are not used: an episode is minutes long. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return toPersianDigits(`${String(minutes)}:${String(seconds).padStart(2, '0')}`);
}

/** "۸ ثانیه" - a duration as a reader thinks of it, not as a timecode. */
export function formatSeconds(ms: number): string {
  return `${toPersianDigits(String(Math.round(ms / 1000)))} ثانیه`;
}

const RULE = '────────────────────────────────────────';

/**
 * How the delivery is printed: Persian words, no punctuation to parse.
 *
 * A neutral, measured, normal, plain line prints nothing at all. The absence *is* the
 * instruction, and a page that says "خنثی، سنجیده، معمولی" above every passage trains
 * the reader to skip the line that occasionally matters.
 */
function directionLine(direction: SpeechDirection): string | null {
  const words: string[] = [];
  if (direction.emotion !== 'neutral') words.push(SPEECH_EMOTION_LABELS[direction.emotion].fa);
  if (direction.pace !== 'measured') words.push(SPEECH_PACE_LABELS[direction.pace].fa);
  if (direction.volume !== 'normal') words.push(SPEECH_VOLUME_LABELS[direction.volume].fa);
  if (direction.stance !== 'plain') words.push(SPEECH_STANCE_LABELS[direction.stance].fa);
  return words.length === 0 ? null : words.join('، ');
}

/**
 * The file the owner opens and reads from.
 *
 * Plain UTF-8 text and nothing else. Not Markdown, not SSML, not a table: every one of
 * those puts characters on the page that exist for a machine, and the reader has to
 * skip them with their eyes while speaking with their mouth.
 */
export function renderNarrationSheet(script: NarrationScript): string {
  const lines: string[] = [
    script.title,
    `${script.episodeLabel} · ${formatClock(script.totalDurationMs)} · ${toPersianDigits(String(script.passages.length))} بند`,
    '',
  ];

  for (const passage of script.passages) {
    lines.push(RULE);

    if (passage.restBeforeMs >= 1000) {
      lines.push(`${formatSeconds(passage.restBeforeMs)} سکوت`, '');
    }

    const endMs = passage.startMs + passage.durationMs;
    lines.push(
      `${toPersianDigits(String(passage.index))} · ${formatClock(passage.startMs)} تا ${formatClock(endMs)} · ${formatSeconds(passage.durationMs)}`,
    );

    const direction = directionLine(passage.direction);
    if (direction !== null) lines.push(direction);
    if (!passage.fitsWindow) lines.push('این بند برای این زمان بلند است');

    lines.push('');
    for (const breath of passage.breaths) lines.push(`  ${breath}`);
    lines.push('');

    if (passage.onScreen !== undefined) lines.push(`روی تصویر: ${passage.onScreen}`, '');
    if (passage.direction.note !== undefined) lines.push(passage.direction.note, '');
  }

  lines.push(RULE);
  return `${lines.join('\n')}\n`;
}
