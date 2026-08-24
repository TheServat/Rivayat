/**
 * A character's TTS voice, derived from the sheet that already says how they speak.
 *
 * `CharacterVoice` exists because "the most reliable tell of LLM-written serial fiction
 * is that every character speaks in the same competent middle register" - that is its own
 * docstring in `narrative/entity.ts`. A separate set of TTS knobs, tuned by hand in a
 * settings panel, would reintroduce exactly that failure one layer down and would drift
 * from the sheet the first time either was edited. So the synthetic voice is *computed*
 * from the written one, and this is the only sanctioned way to obtain a `VoiceProfile`.
 *
 * ## What is derived, and what deliberately is not
 *
 * Two of the three biases come out of the sheet:
 *
 *  - **`expressiveness`** from verbosity, register, rhythm and humour. The one that reads
 *    backwards is humour: `dry` *lowers* it, because dry humour is deadpan, and a voice
 *    that leans into a dry joke has stopped telling one.
 *  - **`tempoBias`** from `sentenceRhythm`, which is the only field in the sheet that is
 *    actually about time.
 *
 * **`pitchBias` is always zero, and that is a decision rather than an omission.** No field
 * in `CharacterVoice` is about pitch. Deriving one from `register` - formal reads low,
 * colloquial reads high - would be inventing a stereotype and presenting it as a
 * derivation. Pitch belongs to the exemplar clip or the preset voice, which is a casting
 * decision a person makes, and the field stays available for a human to set.
 *
 * The `binding` is a parameter for the same reason: derivation decides *delivery*, casting
 * decides *identity*, and no amount of reading a character sheet tells you which recorded
 * human this character should sound like.
 */

import type {
  CharacterVoice,
  EntityId,
  HumourMode,
  LanguageTag,
  SentenceRhythm,
  Verbosity,
  VoiceBinding,
  VoiceProfile,
  VoiceRole,
  Performer,
  VoiceRegister,
} from '@rv/contracts';

import { inlineList } from '../support/format';

/**
 * How much a voice moves at rest, before any line is directed.
 *
 * Ordered by how much the character is willing to spend on saying a thing. These are
 * judgements, not measurements; they live in one table so they are one argument rather
 * than five scattered constants nobody would ever compare.
 */
const VERBOSITY_BASE: Readonly<Record<Verbosity, number>> = {
  terse: 0.2,
  clipped: 0.32,
  measured: 0.5,
  expansive: 0.68,
  rambling: 0.8,
};

/** Diction pulls expression up or down: a technical register flattens, a poetic one lifts. */
const REGISTER_SHIFT: Readonly<Record<VoiceRegister, number>> = {
  formal: -0.08,
  neutral: 0,
  colloquial: 0.04,
  vulgar: 0.1,
  archaic: -0.04,
  technical: -0.12,
  poetic: 0.1,
};

/**
 * Humour, and the entry that matters.
 *
 * `dry` and `gallows` *lower* expressiveness. Deadpan is the joke; a voice that performs
 * a dry line has stopped being dry. Getting this backwards is the single most likely
 * error in the table, which is why it is the one with a comment.
 */
const HUMOUR_SHIFT: Readonly<Record<HumourMode, number>> = {
  none: 0,
  dry: -0.08,
  sardonic: 0.02,
  absurd: 0.1,
  'self-deprecating': 0.02,
  slapstick: 0.15,
  gallows: -0.06,
  wordplay: 0.06,
};

/** Rhythm moves both how animated a voice is and how fast it goes. */
const RHYTHM_SHIFT: Readonly<Record<SentenceRhythm, { expressive: number; tempo: number }>> = {
  staccato: { expressive: 0.05, tempo: 0.3 },
  balanced: { expressive: 0, tempo: 0 },
  flowing: { expressive: 0.05, tempo: -0.1 },
  fragmented: { expressive: 0.08, tempo: 0.15 },
  looping: { expressive: -0.04, tempo: -0.2 },
};

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampSigned(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface DeriveVoiceOptions {
  readonly speakerRef: EntityId;
  readonly label: string;
  readonly voice: CharacterVoice;
  readonly language: LanguageTag;
  /**
   * Which engine voice this character is cast as.
   *
   * A parameter, because no reading of a character sheet tells you which recorded human
   * they should sound like. A human-performed voice passes an empty binding.
   */
  readonly binding: VoiceBinding;
  readonly role?: VoiceRole;
  readonly performedBy?: Performer;
}

/**
 * The synthetic voice this character's sheet implies.
 *
 * Pure: same sheet, same profile, every time. That matters more than it looks - the
 * profile participates in the cache key for every line this character ever speaks, so a
 * derivation that drifted would silently re-synthesise a whole series.
 */
export function deriveVoiceProfile(options: DeriveVoiceOptions): VoiceProfile {
  const { voice } = options;
  const rhythm = RHYTHM_SHIFT[voice.sentenceRhythm];

  const expressiveness = clampUnit(
    VERBOSITY_BASE[voice.verbosity] +
      REGISTER_SHIFT[voice.register] +
      HUMOUR_SHIFT[voice.humourMode] +
      rhythm.expressive,
  );

  return {
    role: options.role ?? 'character',
    performedBy: options.performedBy ?? 'synthetic',
    speakerRef: options.speakerRef,
    label: options.label,
    language: options.language,
    binding: options.binding,
    // See the file header: nothing in the sheet is about pitch, and inventing it from
    // register would be a stereotype dressed as a derivation.
    pitchBias: 0,
    tempoBias: round2(clampSigned(rhythm.tempo)),
    expressiveness: round2(expressiveness),
    rationale: rationaleFor(options.label, voice, expressiveness),
  };
}

/**
 * The sentence a reviewer checks the voice against.
 *
 * Required by `VoiceProfile` and generated rather than written, because a rationale that
 * a person has to remember to write is a rationale that is absent exactly when the voice
 * is wrong. It names the four fields the numbers came from, so "why does she sound like
 * that" is answerable without reading this file.
 */
function rationaleFor(label: string, voice: CharacterVoice, expressiveness: number): string {
  const level = expressiveness < 0.35 ? 'held in' : expressiveness > 0.65 ? 'open' : 'even';
  return (
    `${label} is ${voice.verbosity} in a ${voice.register} register, ${voice.sentenceRhythm} in rhythm, ` +
    `humour ${voice.humourMode} - so the voice is ${level}. ` +
    `Idiolect: ${inlineList([...voice.idiolect], 'nothing recorded')}. ` +
    `Silence: ${voice.silenceHabits}`
  );
}
