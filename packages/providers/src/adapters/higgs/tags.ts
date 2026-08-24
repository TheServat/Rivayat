/**
 * Higgs's control-token dialect, and the translation into it.
 *
 * ## Where this vocabulary came from
 *
 * Every token below was read out of `PROMPTING.md` and `README.md` in the model card
 * shipped with `bosonai/higgs-tts-3-4b`, on 2026-08-24. Not from memory, not from a
 * blog: the model card's own words are *"Only the tags below are recognized - anything
 * else degrades output or gets read literally."* That sentence is why this file is a
 * closed table rather than a template. A tag we invented would either be read aloud to
 * the audience or would quietly wreck the take, and both failures arrive as a finished
 * episode rather than as an error.
 *
 * So: the adapter may emit a token only if it appears in {@link HIGGS_EMOTIONS},
 * {@link HIGGS_STYLES} or {@link HIGGS_PROSODY}, and `tags.spec.ts` asserts that every
 * token this module can produce is in one of them.
 *
 * ## The placement rules, which are not obvious and are load-bearing
 *
 * The model card distinguishes two placements and getting them wrong wastes the tag:
 *
 *  - **Sentence-level** - emotion, style, and the prosody `speed_*`, `pitch_*` and
 *    `expressive_*` tokens. They colour the whole utterance and go at the *start*.
 *  - **Inline** - `pause`, `long_pause` and every `sfx`. They fire where they are placed.
 *
 * This module emits only sentence-level tokens. Inline effects are a director's decision
 * about a specific moment inside a line, and nothing upstream currently expresses one;
 * inventing placements would be putting a laugh where no writer asked for it.
 */

import type { SpeechDirection, SpeechEmotion, SpeechPace, SpeechVolume } from '@rv/contracts';

import type { DirectionGap } from '../../ports/speech-synthesis';

/** The 21 emotion tokens, verbatim from the model card's catalogue of 43. */
export const HIGGS_EMOTIONS = [
  'elation',
  'amusement',
  'enthusiasm',
  'determination',
  'pride',
  'contentment',
  'affection',
  'relief',
  'contemplation',
  'confusion',
  'surprise',
  'awe',
  'longing',
  'arousal',
  'anger',
  'fear',
  'disgust',
  'bitterness',
  'sadness',
  'shame',
  'helplessness',
] as const;
export type HiggsEmotion = (typeof HIGGS_EMOTIONS)[number];

/** The three style tokens. */
export const HIGGS_STYLES = ['singing', 'shouting', 'whispering'] as const;
export type HiggsStyle = (typeof HIGGS_STYLES)[number];

/** The eight sentence-level prosody tokens. `pause` and `long_pause` are inline and absent. */
export const HIGGS_PROSODY = [
  'speed_very_slow',
  'speed_slow',
  'speed_fast',
  'speed_very_fast',
  'pitch_low',
  'pitch_high',
  'expressive_high',
  'expressive_low',
] as const;
export type HiggsProsody = (typeof HIGGS_PROSODY)[number];

/**
 * Our vocabulary to Higgs's, and where it is lossy.
 *
 * Twenty-six drama emotions into twenty-one engine tokens: five of them cannot be exact,
 * and those five are marked rather than hidden. `contempt` arriving as `disgust` is a
 * different performance - colder in a different direction - and a reviewer listening back
 * to a take that is not quite right deserves to find out from the provenance record
 * rather than from twenty minutes of A/B.
 *
 * `neutral` maps to `null`, meaning *no tag at all*. That is correct rather than a gap:
 * Higgs has no neutral token, and an unmarked utterance is exactly what neutral means.
 */
const EMOTION_TAG: Readonly<Record<SpeechEmotion, HiggsEmotion | null>> = {
  neutral: null,
  contemplation: 'contemplation',
  contentment: 'contentment',
  relief: 'relief',
  affection: 'affection',
  amusement: 'amusement',
  joy: 'elation',
  enthusiasm: 'enthusiasm',
  pride: 'pride',
  determination: 'determination',
  desire: 'arousal',
  awe: 'awe',
  surprise: 'surprise',
  confusion: 'confusion',
  longing: 'longing',
  anxiety: 'fear',
  fear: 'fear',
  anger: 'anger',
  contempt: 'disgust',
  disgust: 'disgust',
  bitterness: 'bitterness',
  shame: 'shame',
  sadness: 'sadness',
  grief: 'sadness',
  helplessness: 'helplessness',
  resignation: 'helplessness',
};

/** The emotions whose Higgs tag is a near neighbour rather than the same word. */
const APPROXIMATE: ReadonlySet<SpeechEmotion> = new Set<SpeechEmotion>([
  'anxiety',
  'contempt',
  'grief',
  'resignation',
]);

/**
 * Volume to style, for the two ends Higgs can express.
 *
 * `low` and `raised` have no token. They are dropped rather than approximated to
 * `whispering` and `shouting`, because those are not "a bit quieter" and "a bit louder" -
 * a whisper is unvoiced and a shout is projected, and substituting either for a
 * conversational level change would be a much larger error than doing nothing.
 */
const STYLE_TAG: Readonly<Record<SpeechVolume, HiggsStyle | null>> = {
  whisper: 'whispering',
  low: null,
  normal: null,
  raised: null,
  shout: 'shouting',
};

/** Pace as a position on Higgs's four-step speed scale, with `measured` as the unmarked centre. */
const SPEED_STEP: Readonly<Record<SpeechPace, number>> = {
  slow: -1,
  measured: 0,
  quick: 1,
  rushed: 2,
};

const SPEED_TAG: Readonly<Record<number, HiggsProsody | undefined>> = {
  [-2]: 'speed_very_slow',
  [-1]: 'speed_slow',
  [0]: undefined,
  [1]: 'speed_fast',
  [2]: 'speed_very_fast',
};

function clampStep(step: number): number {
  return Math.max(-2, Math.min(2, step));
}

/** The knobs that come off the voice profile rather than off the line. */
export interface HiggsVoiceBias {
  readonly pitchBias: number;
  readonly tempoBias: number;
  /** The voice's resting expressiveness, 0..1, blended with the line's intensity. */
  readonly expressiveness: number;
}

export interface HiggsRendering {
  /** The tagged string, ready to be sent as `input`. */
  readonly text: string;
  readonly applied: readonly string[];
  readonly approximated: readonly DirectionGap[];
  readonly dropped: readonly DirectionGap[];
}

/**
 * How far above or below neutral a line is pitched, on Higgs's two-value expressive axis.
 *
 * The stance rules from `SpeechStance` are enforced here, and one of them is
 * counter-intuitive enough to be worth restating: **`mistaken` adds nothing.** A
 * character who sincerely believes something false must sound sincere; the irony is the
 * audience's and a voice that leans into it destroys the scene. `concealing` is the
 * opposite - the effort of holding something back is audible, and `expressive_low` is
 * what that sounds like.
 */
function expressiveTag(direction: SpeechDirection, bias: HiggsVoiceBias): HiggsProsody | null {
  if (direction.stance === 'concealing') return 'expressive_low';

  // The line's intensity read against the voice's own resting level: a terse character
  // at 0.6 is being loud for them, and a theatrical one at 0.6 is holding back.
  const relative = direction.intensity * 0.65 + bias.expressiveness * 0.35;
  if (direction.stance === 'ironic' || relative >= 0.7) return 'expressive_high';
  if (relative <= 0.3) return 'expressive_low';
  return null;
}

function pitchTag(pitchBias: number): HiggsProsody | null {
  if (pitchBias >= 0.34) return 'pitch_high';
  if (pitchBias <= -0.34) return 'pitch_low';
  return null;
}

/**
 * Builds the `input` string Higgs is sent, and the account of what did not survive.
 *
 * Order matters and follows the model card: emotion, then style, then prosody, all
 * before the first word. The account is returned rather than logged because the
 * provenance record is what a reviewer reads when a take is wrong.
 */
export function renderHiggsInput(
  text: string,
  direction: SpeechDirection,
  bias: HiggsVoiceBias,
): HiggsRendering {
  const applied: string[] = [];
  const approximated: DirectionGap[] = [];
  const dropped: DirectionGap[] = [];
  const tokens: string[] = [];

  const emotion = EMOTION_TAG[direction.emotion];
  if (emotion !== null) {
    tokens.push(`<|emotion:${emotion}|>`);
    applied.push(`emotion:${emotion}`);
    if (APPROXIMATE.has(direction.emotion)) {
      approximated.push({
        aspect: 'emotion',
        requested: direction.emotion,
        substituted: emotion,
        reason: `Higgs has no "${direction.emotion}" token; "${emotion}" is its nearest of the 21`,
      });
    }
  }

  const style = STYLE_TAG[direction.volume];
  if (style !== null) {
    tokens.push(`<|style:${style}|>`);
    applied.push(`style:${style}`);
  } else if (direction.volume !== 'normal') {
    dropped.push({
      aspect: 'volume',
      requested: direction.volume,
      substituted: null,
      reason:
        'Higgs styles cover only whispering and shouting; a conversational level change has no token, and borrowing one would be a larger error than none',
    });
  }

  const speed = SPEED_TAG[clampStep(SPEED_STEP[direction.pace] + Math.round(bias.tempoBias))];
  if (speed !== undefined) {
    tokens.push(`<|prosody:${speed}|>`);
    applied.push(`prosody:${speed}`);
  }

  const pitch = pitchTag(bias.pitchBias);
  if (pitch !== null) {
    tokens.push(`<|prosody:${pitch}|>`);
    applied.push(`prosody:${pitch}`);
  }

  const expressive = expressiveTag(direction, bias);
  if (expressive !== null) {
    tokens.push(`<|prosody:${expressive}|>`);
    applied.push(`prosody:${expressive}`);
  }

  // Deliberate: `ironic` is reported as approximated, not applied. Higgs has no sarcasm
  // token, and `expressive_high` is a volume of feeling rather than a wink - the take
  // will be emphatic rather than knowing, and that is a real difference.
  if (direction.stance === 'ironic') {
    approximated.push({
      aspect: 'stance',
      requested: 'ironic',
      substituted: expressive ?? 'none',
      reason: 'Higgs has no irony or sarcasm token; the line is pushed rather than winked',
    });
  }

  return { text: `${tokens.join('')}${text}`, applied, approximated, dropped };
}
