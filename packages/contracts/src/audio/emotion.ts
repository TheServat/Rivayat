/**
 * The emotion vocabulary, expressed once, in the layer that has no idea which voice
 * engine is installed.
 *
 * The alternative - letting each adapter own its own words - fails in a specific way:
 * `@rv/story-engine` would have to know that Higgs spells warmth `affection`, that
 * ElevenLabs spells it with a bracketed tag, and that Chatterbox has no word for it at
 * all. The story layer would then be picking the TTS engine, which is backwards. So the
 * vocabulary is declared here and every adapter translates it into its own dialect.
 *
 * ## Why each member carries two numbers
 *
 * The three engines do not merely spell emotion differently - one of them cannot name
 * it. Chatterbox exposes a single scalar (`exaggeration`) and nothing else; there is no
 * "bitterness" to send it. An enum of bare words would leave that adapter guessing, and
 * a guess inside an adapter is a lie the ledger cannot see.
 *
 * {@link SPEECH_EMOTION_AXES} therefore gives every member a **valence** and an
 * **arousal**, which is the minimum an engine without names can act on: arousal drives
 * the intensity knob, valence separates two states that sit at the same arousal (fear
 * and enthusiasm are both loud). A new engine that names nothing becomes a registration
 * rather than a redesign, and an engine that names everything ignores the numbers.
 *
 * The list is drama-facing, not vendor-facing. It is deliberately *not* Higgs's 21 tags
 * copied across: adopting one vendor's list would make that vendor's dialect the
 * interlingua, which is the thing this file exists to prevent. It is a superset, and
 * each adapter states its own - sometimes lossy - mapping and reports when it had to
 * approximate.
 */

import { z } from 'zod';

import { NonEmptyString, Prose, SignedUnit, Unit01 } from '../primitives/common';

/**
 * The emotions a line can be delivered in.
 *
 * Ordered from the settled through the warm to the hostile and the beaten, so a
 * reviewer scanning the list reads a range rather than an alphabet.
 */
export const SPEECH_EMOTIONS = [
  'neutral',
  'contemplation',
  'contentment',
  'relief',
  'affection',
  'amusement',
  'joy',
  'enthusiasm',
  'pride',
  'determination',
  'desire',
  'awe',
  'surprise',
  'confusion',
  'longing',
  'anxiety',
  'fear',
  'anger',
  'contempt',
  'disgust',
  'bitterness',
  'shame',
  'sadness',
  'grief',
  'helplessness',
  'resignation',
] as const;

export const SpeechEmotion = z
  .enum(SPEECH_EMOTIONS)
  .describe('The single dominant emotion a line is delivered in.');
export type SpeechEmotion = z.infer<typeof SpeechEmotion>;

/**
 * Where an emotion sits, for an engine that cannot be told its name.
 *
 * `valence` runs -1 (hostile, painful) to +1 (warm, pleasurable); `arousal` runs 0
 * (still) to 1 (at the top of the voice). Both are judgements, not measurements, and
 * they are here so the judgement is made **once**, in the open, rather than three times
 * inside three adapters where nobody would ever compare them.
 */
export const EmotionAxes = z.strictObject({
  valence: SignedUnit,
  arousal: Unit01,
});
export type EmotionAxes = z.infer<typeof EmotionAxes>;

export const SPEECH_EMOTION_AXES: Readonly<Record<SpeechEmotion, EmotionAxes>> = {
  neutral: { valence: 0, arousal: 0.3 },
  contemplation: { valence: 0, arousal: 0.25 },
  contentment: { valence: 0.6, arousal: 0.25 },
  relief: { valence: 0.5, arousal: 0.3 },
  affection: { valence: 0.8, arousal: 0.4 },
  amusement: { valence: 0.7, arousal: 0.55 },
  joy: { valence: 0.9, arousal: 0.75 },
  enthusiasm: { valence: 0.8, arousal: 0.85 },
  pride: { valence: 0.6, arousal: 0.6 },
  determination: { valence: 0.3, arousal: 0.7 },
  desire: { valence: 0.3, arousal: 0.8 },
  awe: { valence: 0.4, arousal: 0.6 },
  surprise: { valence: 0.1, arousal: 0.8 },
  confusion: { valence: -0.2, arousal: 0.45 },
  longing: { valence: -0.2, arousal: 0.4 },
  anxiety: { valence: -0.6, arousal: 0.7 },
  fear: { valence: -0.8, arousal: 0.85 },
  anger: { valence: -0.8, arousal: 0.9 },
  contempt: { valence: -0.6, arousal: 0.5 },
  disgust: { valence: -0.7, arousal: 0.6 },
  bitterness: { valence: -0.6, arousal: 0.45 },
  shame: { valence: -0.6, arousal: 0.4 },
  sadness: { valence: -0.7, arousal: 0.3 },
  grief: { valence: -0.9, arousal: 0.5 },
  helplessness: { valence: -0.7, arousal: 0.35 },
  resignation: { valence: -0.4, arousal: 0.2 },
};

/**
 * `LocalisedText` with the English side required.
 *
 * `LocalisedText.en` (in `primitives/common.ts`) is optional because a Persian-only
 * project should not be forced to write filler translations. Every label in this file has
 * both, and saying so in the type removes a `?? text.fa` fallback that could never run -
 * an unreachable fallback is a branch nobody can test and therefore a claim nobody can
 * check. It stays assignable to `LocalisedText`, so a consumer wanting the looser shape
 * still gets it.
 */
interface BilingualLabel {
  readonly fa: string;
  readonly en: string;
}

/**
 * Persian and English names, for the page the narrator reads.
 *
 * The narrator's script is Persian and is read by a human, so an emotion has to arrive
 * as a Persian word rather than as an enum member. Keeping the pair here rather than in
 * the studio's message catalogue means the script generator and the UI cannot disagree
 * about what `bitterness` is called.
 */
export const SPEECH_EMOTION_LABELS: Readonly<Record<SpeechEmotion, BilingualLabel>> = {
  neutral: { fa: 'خنثی', en: 'neutral' },
  contemplation: { fa: 'تأمل', en: 'contemplation' },
  contentment: { fa: 'رضایت', en: 'contentment' },
  relief: { fa: 'آسودگی', en: 'relief' },
  affection: { fa: 'مهر', en: 'affection' },
  amusement: { fa: 'سرخوشی', en: 'amusement' },
  joy: { fa: 'شادی', en: 'joy' },
  enthusiasm: { fa: 'شور', en: 'enthusiasm' },
  pride: { fa: 'غرور', en: 'pride' },
  determination: { fa: 'عزم', en: 'determination' },
  desire: { fa: 'اشتیاق', en: 'desire' },
  awe: { fa: 'شگفتی', en: 'awe' },
  surprise: { fa: 'تعجب', en: 'surprise' },
  confusion: { fa: 'سردرگمی', en: 'confusion' },
  longing: { fa: 'دلتنگی', en: 'longing' },
  anxiety: { fa: 'اضطراب', en: 'anxiety' },
  fear: { fa: 'ترس', en: 'fear' },
  anger: { fa: 'خشم', en: 'anger' },
  contempt: { fa: 'تحقیر', en: 'contempt' },
  disgust: { fa: 'انزجار', en: 'disgust' },
  bitterness: { fa: 'تلخی', en: 'bitterness' },
  shame: { fa: 'شرم', en: 'shame' },
  sadness: { fa: 'اندوه', en: 'sadness' },
  grief: { fa: 'سوگ', en: 'grief' },
  helplessness: { fa: 'درماندگی', en: 'helplessness' },
  resignation: { fa: 'تسلیم', en: 'resignation' },
};

// -- pace and volume ---------------------------------------------------------

/**
 * The same four words `DeliveryNote.pace` uses, named so an adapter can import them.
 *
 * `story-bible.ts` spells its enum inline because what it describes is the writer's
 * note; this is the machine-facing twin, and `emotion.spec.ts` asserts the two option
 * lists stay identical. A silent divergence would be a pace a writer can choose and no
 * engine can hear.
 */
export const SPEECH_PACES = ['slow', 'measured', 'quick', 'rushed'] as const;
export const SpeechPace = z.enum(SPEECH_PACES).describe('Speaking rate for this line.');
export type SpeechPace = z.infer<typeof SpeechPace>;

export const SPEECH_VOLUMES = ['whisper', 'low', 'normal', 'raised', 'shout'] as const;
export const SpeechVolume = z.enum(SPEECH_VOLUMES).describe('Loudness for this line.');
export type SpeechVolume = z.infer<typeof SpeechVolume>;

/** Persian and English names for the pace, for the narrator's page. */
export const SPEECH_PACE_LABELS: Readonly<Record<SpeechPace, BilingualLabel>> = {
  slow: { fa: 'آهسته', en: 'slow' },
  measured: { fa: 'سنجیده', en: 'measured' },
  quick: { fa: 'تند', en: 'quick' },
  rushed: { fa: 'شتاب‌زده', en: 'rushed' },
};

/** Persian and English names for the volume, for the narrator's page. */
export const SPEECH_VOLUME_LABELS: Readonly<Record<SpeechVolume, BilingualLabel>> = {
  whisper: { fa: 'نجوا', en: 'whisper' },
  low: { fa: 'آرام', en: 'low' },
  normal: { fa: 'معمولی', en: 'normal' },
  raised: { fa: 'بلند', en: 'raised' },
  shout: { fa: 'فریاد', en: 'shout' },
};

// -- stance: what the epistemic layer buys the voice --------------------------

export const SPEECH_STANCES = ['plain', 'mistaken', 'concealing', 'ironic'] as const;

/**
 * The gap between what the speaker knows and what the audience knows, as the *voice*
 * has to play it.
 *
 * This is the one thing in the audio layer that the epistemic graph makes genuinely
 * possible. `docs/02` stores what is true and what each character believes as separate
 * edges, so at any line we can ask whether the speaker is wrong and whether the audience
 * has been shown that they are wrong - and those two answers change the delivery.
 *
 * The counter-intuitive member is `mistaken`, and it is why this is an enum and not a
 * boolean. A character who sincerely believes something false must sound **more**
 * sincere, not knowing: the irony belongs to the audience, and a voice that winks at it
 * destroys the effect the scene was built for. Adapters add no knowing colour for
 * `mistaken`; `concealing` is the opposite case and flattens.
 */
export const SpeechStance = z
  .enum(SPEECH_STANCES)
  .describe(
    'How the speaker stands to what they are saying: plainly, sincerely wrong, hiding what they know, or winking at it.',
  );
export type SpeechStance = z.infer<typeof SpeechStance>;

/** What each stance obliges an adapter to do. Total over the union, and asserted in tests. */
export const SPEECH_STANCE_DIRECTION: Readonly<Record<SpeechStance, string>> = {
  plain: 'no adjustment - the words carry it',
  mistaken:
    'play it straight, if anything more sincerely; the audience holds the irony and the voice must not',
  concealing: 'flatter and more controlled - the effort of holding something back is audible',
  ironic: 'let the wink through; the line means its opposite and expects to be caught',
};

/** Persian and English names for the stance, for the narrator's page. */
export const SPEECH_STANCE_LABELS: Readonly<Record<SpeechStance, BilingualLabel>> = {
  plain: { fa: 'ساده', en: 'plain' },
  mistaken: { fa: 'صادقانه اما در اشتباه', en: 'sincerely mistaken' },
  concealing: { fa: 'پنهان‌کار', en: 'concealing' },
  ironic: { fa: 'کنایه‌آمیز', en: 'ironic' },
};

// -- the direction itself -----------------------------------------------------

/**
 * How one line is to be said, in engine-neutral terms.
 *
 * The machine-facing twin of `DeliveryNote`. `DeliveryNote` is what a writer wrote, and
 * its `emotion` is free text because a writer who has to pick from a list writes worse
 * lines. This is what a synthesiser is handed, and it is closed, because an adapter
 * cannot translate a word it has never seen. {@link toSpeechDirection} is the single
 * crossing between the two.
 */
export const SpeechDirection = z.strictObject({
  emotion: SpeechEmotion,
  intensity: Unit01.describe(
    'How far the emotion is pushed, 0 barely detectable to 1 as far as this character ever goes.',
  ),
  pace: SpeechPace,
  volume: SpeechVolume,
  stance: SpeechStance.default('plain'),
  note: Prose.optional().describe(
    'Anything the five fields cannot carry. Printed for the narrator verbatim; never sent to an engine.',
  ),
});
export type SpeechDirection = z.infer<typeof SpeechDirection>;

/**
 * The neutral direction: someone saying something, normally.
 *
 * Exported because "no direction" is a real answer several call sites need, and three
 * of them spelling it out by hand is three chances to spell it differently.
 */
export const PLAIN_DIRECTION: SpeechDirection = {
  emotion: 'neutral',
  intensity: 0.3,
  pace: 'measured',
  volume: 'normal',
  stance: 'plain',
};

// -- the lexicon --------------------------------------------------------------

/**
 * Free-form emotion words a writer actually uses, resolved to the closed vocabulary.
 *
 * Every entry points one way - many words to one emotion - so the table cannot express
 * an ambiguity it has no way to resolve. The three words in `DeliveryNote`'s own field
 * description ("bitter", "pleading", "flat") are here by name, because a schema that
 * offers an example and then cannot understand it is a trap.
 */
export const EMOTION_LEXICON: Readonly<Record<string, SpeechEmotion>> = {
  // The members themselves, so a caller may pass the canonical word straight back in.
  ...Object.fromEntries(SPEECH_EMOTIONS.map((emotion) => [emotion, emotion])),

  flat: 'neutral',
  even: 'neutral',
  plain: 'neutral',
  quiet: 'contemplation',
  thoughtful: 'contemplation',
  reflective: 'contemplation',
  curious: 'contemplation',
  calm: 'contentment',
  settled: 'contentment',
  content: 'contentment',
  relieved: 'relief',
  tender: 'affection',
  warm: 'affection',
  gentle: 'affection',
  fond: 'affection',
  amused: 'amusement',
  playful: 'amusement',
  wry: 'amusement',
  happy: 'joy',
  joyful: 'joy',
  delighted: 'joy',
  eager: 'enthusiasm',
  excited: 'enthusiasm',
  proud: 'pride',
  defiant: 'determination',
  resolute: 'determination',
  determined: 'determination',
  urgent: 'determination',
  hungry: 'desire',
  awed: 'awe',
  reverent: 'awe',
  surprised: 'surprise',
  startled: 'surprise',
  confused: 'confusion',
  lost: 'confusion',
  wistful: 'longing',
  homesick: 'longing',
  anxious: 'anxiety',
  nervous: 'anxiety',
  uneasy: 'anxiety',
  afraid: 'fear',
  scared: 'fear',
  terrified: 'fear',
  angry: 'anger',
  furious: 'anger',
  sharp: 'anger',
  cold: 'contempt',
  scornful: 'contempt',
  mocking: 'contempt',
  sarcastic: 'contempt',
  disgusted: 'disgust',
  revolted: 'disgust',
  bitter: 'bitterness',
  sour: 'bitterness',
  ashamed: 'shame',
  guilty: 'shame',
  sad: 'sadness',
  bleak: 'sadness',
  hollow: 'sadness',
  grieving: 'grief',
  bereft: 'grief',
  pleading: 'helplessness',
  desperate: 'helplessness',
  helpless: 'helplessness',
  weary: 'resignation',
  tired: 'resignation',
  numb: 'resignation',
  resigned: 'resignation',
};

/**
 * Resolves a writer's word, or admits it does not know it.
 *
 * `null` rather than a quiet fall back to `neutral`. A silent fallback means an
 * unrecognised word - a typo, or a real emotion nobody added - is performed flat and
 * nothing anywhere records that it happened. The caller decides: the story engine
 * substitutes `neutral` *and says so*, which is a fact a reviewer can act on.
 */
export function toSpeechEmotion(word: string): SpeechEmotion | null {
  return EMOTION_LEXICON[word.trim().toLowerCase()] ?? null;
}

/**
 * `DeliveryNote`'s shape, structurally.
 *
 * The story module is not imported here: that would tie audio to story for one field's
 * worth of shape, and the caller already holds the note. A `DeliveryNote` satisfies this
 * without a conversion.
 */
export interface DeliveryNoteLike {
  readonly emotion: string;
  readonly intensity: number;
  readonly pace: SpeechPace;
  readonly volume: SpeechVolume;
  readonly note?: string | undefined;
}

/** What {@link toSpeechDirection} did, including the part a reviewer needs to see. */
export const DirectionFromNote = z.strictObject({
  direction: SpeechDirection,
  /**
   * The writer's word, when the lexicon did not know it.
   *
   * Non-null means the emotion was substituted rather than translated and the line will
   * be performed flat. Returned rather than logged because "which words is the lexicon
   * missing" is the question that keeps the table honest.
   */
  unresolvedEmotion: NonEmptyString.nullable(),
});
export type DirectionFromNote = z.infer<typeof DirectionFromNote>;

/** The one crossing from what a writer wrote to what an engine is told. */
export function toSpeechDirection(
  note: DeliveryNoteLike,
  stance: SpeechStance = 'plain',
): DirectionFromNote {
  const resolved = toSpeechEmotion(note.emotion);
  const direction: SpeechDirection = {
    emotion: resolved ?? 'neutral',
    intensity: note.intensity,
    pace: note.pace,
    volume: note.volume,
    stance,
    ...(note.note === undefined ? {} : { note: note.note }),
  };
  return { direction, unresolvedEmotion: resolved === null ? note.emotion : null };
}

/**
 * One number for an engine that has one knob.
 *
 * Arousal, scaled by how far the line is pushed, floored so a fully damped delivery is
 * still speech rather than a mumble, damped again when the speaker is concealing, and
 * lifted for a raised or shouted line because volume is arousal by another name.
 * Chatterbox is the caller this exists for; any future engine with a single
 * expressiveness dial gets it without asking.
 */
export function expressiveness(direction: SpeechDirection): number {
  const axes = SPEECH_EMOTION_AXES[direction.emotion];
  const volumeLift = VOLUME_AROUSAL_LIFT[direction.volume];
  const damped = direction.stance === 'concealing' ? 0.6 : 1;
  const raw = (0.25 + axes.arousal * 0.75) * (0.35 + direction.intensity * 0.65) * damped;
  return Math.min(1, Math.max(EXPRESSIVENESS_FLOOR, raw + volumeLift));
}

/**
 * The quietest this function will report, and it is not zero.
 *
 * Three damping factors compose - a low-arousal emotion, an intensity of zero, a
 * whispered concealing line - and their product goes negative once the whisper's lift is
 * subtracted. Clamping that to `0` would make every sufficiently damped combination
 * report the same number, which destroys the one thing this function is for: giving an
 * engine with a single dial an *ordering* it can act on. It is also not what a damped
 * line sounds like. Someone whispering a thing they would rather not say is still
 * speaking.
 */
const EXPRESSIVENESS_FLOOR = 0.05;

/** How much each volume adds to perceived arousal. Total, so `expressiveness` has no default arm. */
const VOLUME_AROUSAL_LIFT: Readonly<Record<SpeechVolume, number>> = {
  whisper: -0.1,
  low: -0.05,
  normal: 0,
  raised: 0.1,
  shout: 0.2,
};

/** A short human-readable summary of a direction. For a log or the studio, never for an engine. */
export function describeDirection(direction: SpeechDirection, locale: 'fa' | 'en' = 'en'): string {
  const pick = (text: BilingualLabel): string => (locale === 'fa' ? text.fa : text.en);
  const parts = [
    pick(SPEECH_EMOTION_LABELS[direction.emotion]),
    pick(SPEECH_PACE_LABELS[direction.pace]),
    pick(SPEECH_VOLUME_LABELS[direction.volume]),
  ];
  if (direction.stance !== 'plain') parts.push(pick(SPEECH_STANCE_LABELS[direction.stance]));
  return parts.join(locale === 'fa' ? '، ' : ', ');
}
