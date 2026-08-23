/**
 * "Do these two characters actually sound different?", as arithmetic.
 *
 * The most reliable tell of LLM-written serial fiction is that every character speaks in
 * the same competent middle register - `CharacterVoice` exists to make that checkable
 * rather than merely regrettable, and this is the check.
 *
 * RV-082 fixes the bar: two voices in the same cast must differ on at least two of
 * `register`, `verbosity`, `idiolect`, `sentenceRhythm` and `humourMode`. Two rather than
 * one because a single axis is satisfied by a coin flip - give one character "expansive"
 * and the next "measured" and nothing about how they talk has changed. Five axes rather
 * than the whole block because the rest are either continuous (`profanity` shades) or
 * prose (`silenceHabits`), and neither compares cleanly enough to fail a generation over.
 */

import type { CharacterVoice } from '@rv/contracts';

export const VOICE_DISCRIMINATORS = [
  'register',
  'verbosity',
  'idiolect',
  'sentenceRhythm',
  'humourMode',
] as const;

export type VoiceDiscriminator = (typeof VOICE_DISCRIMINATORS)[number];

/** RV-082's bar. Below this, the cast is a chorus. */
export const MIN_DISTINCT_AXES = 2;

export interface VoiceComparison {
  /** Who the new voice was compared against. */
  readonly against: string;
  readonly differingOn: readonly VoiceDiscriminator[];
  readonly distinct: boolean;
}

/**
 * Compares two idiolects as *sets*.
 *
 * Order is meaningless - a character whose idiolect is `["sailing terms", "old oaths"]` is
 * not distinct from one with `["old oaths", "sailing terms"]`, and comparing the arrays
 * positionally would say they are.
 */
function idiolectDiffers(left: readonly string[], right: readonly string[]): boolean {
  const normalise = (items: readonly string[]): Set<string> =>
    new Set(items.map((item) => item.trim().toLowerCase()));
  const a = normalise(left);
  const b = normalise(right);
  if (a.size !== b.size) return true;
  for (const item of a) if (!b.has(item)) return true;
  return false;
}

/** Which of the five axes two voices differ on. */
export function differingAxes(
  left: CharacterVoice,
  right: CharacterVoice,
): readonly VoiceDiscriminator[] {
  const axes: VoiceDiscriminator[] = [];
  if (left.register !== right.register) axes.push('register');
  if (left.verbosity !== right.verbosity) axes.push('verbosity');
  if (idiolectDiffers(left.idiolect, right.idiolect)) axes.push('idiolect');
  if (left.sentenceRhythm !== right.sentenceRhythm) axes.push('sentenceRhythm');
  if (left.humourMode !== right.humourMode) axes.push('humourMode');
  return axes;
}

export interface NamedVoice {
  readonly name: string;
  readonly voice: CharacterVoice;
}

/**
 * Compares one voice against every voice already in the cast.
 *
 * Returns every comparison rather than only the failures, because "distinct from four
 * others by exactly two axes each" and "wildly distinct from all four" are different
 * situations for a showrunner and the same boolean.
 */
export function compareAgainstCast(
  voice: CharacterVoice,
  cast: readonly NamedVoice[],
): readonly VoiceComparison[] {
  return cast.map((member) => {
    const differingOn = differingAxes(voice, member.voice);
    return { against: member.name, differingOn, distinct: differingOn.length >= MIN_DISTINCT_AXES };
  });
}

/** The members of the cast this voice is too close to. Empty means it is usable. */
export function collisions(comparisons: readonly VoiceComparison[]): readonly VoiceComparison[] {
  return comparisons.filter((comparison) => !comparison.distinct);
}
