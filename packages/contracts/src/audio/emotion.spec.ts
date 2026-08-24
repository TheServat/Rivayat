/**
 * The emotion vocabulary, and the three properties that make it usable by three engines
 * that share nothing.
 *
 * The tests here are total over the enum rather than sampled. That is not thoroughness
 * for its own sake: the whole promise of this module is that an adapter can look up
 * *any* member and find a number and a Persian word, and a table with one hole produces
 * an `undefined` inside a provider adapter at the worst possible moment.
 */

import { describe, expect, it } from 'vitest';

import { DeliveryNote } from '../story/story-bible';
import {
  EMOTION_LEXICON,
  PLAIN_DIRECTION,
  SPEECH_EMOTION_AXES,
  SPEECH_EMOTION_LABELS,
  SPEECH_EMOTIONS,
  SPEECH_PACE_LABELS,
  SPEECH_PACES,
  SPEECH_STANCE_DIRECTION,
  SPEECH_STANCE_LABELS,
  SPEECH_STANCES,
  SPEECH_VOLUME_LABELS,
  SPEECH_VOLUMES,
  SpeechDirection,
  type SpeechEmotion,
  SpeechEmotion as SpeechEmotionSchema,
  describeDirection,
  expressiveness,
  toSpeechDirection,
  toSpeechEmotion,
} from './emotion';

describe('the vocabulary is total', () => {
  it('gives every emotion a valence and an arousal', () => {
    for (const emotion of SPEECH_EMOTIONS) {
      const axes = SPEECH_EMOTION_AXES[emotion];
      expect(axes, emotion).toBeDefined();
      expect(axes.valence).toBeGreaterThanOrEqual(-1);
      expect(axes.valence).toBeLessThanOrEqual(1);
      expect(axes.arousal).toBeGreaterThanOrEqual(0);
      expect(axes.arousal).toBeLessThanOrEqual(1);
    }
    expect(Object.keys(SPEECH_EMOTION_AXES).sort()).toEqual([...SPEECH_EMOTIONS].sort());
  });

  it('gives every emotion, pace, volume and stance a Persian word', () => {
    for (const emotion of SPEECH_EMOTIONS)
      expect(SPEECH_EMOTION_LABELS[emotion].fa.length).toBeGreaterThan(0);
    for (const pace of SPEECH_PACES) expect(SPEECH_PACE_LABELS[pace].fa.length).toBeGreaterThan(0);
    for (const volume of SPEECH_VOLUMES)
      expect(SPEECH_VOLUME_LABELS[volume].fa.length).toBeGreaterThan(0);
    for (const stance of SPEECH_STANCES)
      expect(SPEECH_STANCE_LABELS[stance].fa.length).toBeGreaterThan(0);
  });

  it('says in one sentence what each stance obliges an adapter to do', () => {
    expect(Object.keys(SPEECH_STANCE_DIRECTION).sort()).toEqual([...SPEECH_STANCES].sort());
    // The `mistaken` rule is the one a reasonable person implements backwards, so it is
    // written down where an adapter author will read it.
    expect(SPEECH_STANCE_DIRECTION.mistaken).toContain('straight');
  });

  it('uses distinct Persian words, so the narrator can tell two directions apart', () => {
    const words = SPEECH_EMOTIONS.map((emotion) => SPEECH_EMOTION_LABELS[emotion].fa);
    expect(new Set(words).size).toBe(words.length);
  });
});

describe('the machine-facing enums stay in step with the writer-facing ones', () => {
  it('lists exactly the paces a writer can choose', () => {
    // A pace a writer can pick and no engine can hear is a silent defect, and the only
    // thing that would surface it is this assertion.
    expect(DeliveryNote.shape.pace.options).toEqual([...SPEECH_PACES]);
  });

  it('lists exactly the volumes a writer can choose', () => {
    expect(DeliveryNote.shape.volume.options).toEqual([...SPEECH_VOLUMES]);
  });
});

describe('toSpeechEmotion', () => {
  it('resolves every canonical word to itself', () => {
    for (const emotion of SPEECH_EMOTIONS) expect(toSpeechEmotion(emotion)).toBe(emotion);
  });

  it('resolves the three words DeliveryNote itself offers as examples', () => {
    // A schema that suggests an example and then cannot understand it is a trap.
    expect(toSpeechEmotion('bitter')).toBe('bitterness');
    expect(toSpeechEmotion('pleading')).toBe('helplessness');
    expect(toSpeechEmotion('flat')).toBe('neutral');
  });

  it('ignores case and surrounding space, because a writer will not be careful', () => {
    expect(toSpeechEmotion('  Furious ')).toBe('anger');
  });

  it('returns null for a word it does not know, rather than quietly flattening the line', () => {
    expect(toSpeechEmotion('splenetic')).toBeNull();
    expect(toSpeechEmotion('')).toBeNull();
  });

  it('maps every lexicon entry to a member of the closed vocabulary', () => {
    const members = new Set<string>(SPEECH_EMOTIONS);
    for (const [word, emotion] of Object.entries(EMOTION_LEXICON)) {
      expect(members.has(emotion), `${word} -> ${emotion}`).toBe(true);
    }
  });
});

describe('toSpeechDirection', () => {
  const note = {
    emotion: 'bitter',
    intensity: 0.7,
    pace: 'slow',
    volume: 'low',
  } as const;

  it('translates a writer note into a closed direction', () => {
    const { direction, unresolvedEmotion } = toSpeechDirection(note);
    expect(direction.emotion).toBe('bitterness');
    expect(direction.intensity).toBe(0.7);
    expect(direction.pace).toBe('slow');
    expect(direction.volume).toBe('low');
    expect(direction.stance).toBe('plain');
    expect(unresolvedEmotion).toBeNull();
  });

  it('reports the word it could not resolve instead of hiding the substitution', () => {
    const { direction, unresolvedEmotion } = toSpeechDirection({ ...note, emotion: 'splenetic' });
    expect(direction.emotion).toBe('neutral');
    expect(unresolvedEmotion).toBe('splenetic');
  });

  it('carries the writer note through, and omits the field when there is none', () => {
    expect(toSpeechDirection({ ...note, note: 'trails off' }).direction.note).toBe('trails off');
    expect(toSpeechDirection(note).direction).not.toHaveProperty('note');
  });

  it('takes a stance from the caller, because the scene knows and the note does not', () => {
    expect(toSpeechDirection(note, 'concealing').direction.stance).toBe('concealing');
  });

  it('produces something the schema accepts', () => {
    expect(SpeechDirection.safeParse(toSpeechDirection(note).direction).success).toBe(true);
  });

  it('accepts a real DeliveryNote without a conversion step', () => {
    const parsed = DeliveryNote.parse({
      emotion: 'weary',
      intensity: 0.3,
      pace: 'measured',
      volume: 'low',
    });
    expect(toSpeechDirection(parsed).direction.emotion).toBe('resignation');
  });
});

describe('expressiveness gives an engine with one knob something true to turn', () => {
  const base = SpeechDirection.parse({
    emotion: 'neutral',
    intensity: 0.5,
    pace: 'measured',
    volume: 'normal',
  });

  it('stays inside 0 and 1 across the whole cross product', () => {
    for (const emotion of SPEECH_EMOTIONS) {
      for (const volume of SPEECH_VOLUMES) {
        for (const stance of SPEECH_STANCES) {
          for (const intensity of [0, 0.25, 0.5, 0.75, 1]) {
            const value = expressiveness({ ...base, emotion, volume, stance, intensity });
            expect(
              value,
              `${emotion}/${volume}/${stance}/${String(intensity)}`,
            ).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('rises with intensity', () => {
    expect(expressiveness({ ...base, intensity: 0.9 })).toBeGreaterThan(
      expressiveness({ ...base, intensity: 0.1 }),
    );
  });

  it('separates two emotions of the same intensity by their arousal', () => {
    expect(expressiveness({ ...base, emotion: 'anger' })).toBeGreaterThan(
      expressiveness({ ...base, emotion: 'resignation' }),
    );
  });

  it('lifts a shout and lowers a whisper', () => {
    expect(expressiveness({ ...base, volume: 'shout' })).toBeGreaterThan(
      expressiveness({ ...base, volume: 'normal' }),
    );
    expect(expressiveness({ ...base, volume: 'whisper' })).toBeLessThan(
      expressiveness({ ...base, volume: 'normal' }),
    );
    expect(expressiveness({ ...base, volume: 'raised' })).toBeGreaterThan(
      expressiveness({ ...base, volume: 'low' }),
    );
  });

  it('damps a concealing line and leaves a mistaken one alone', () => {
    const open = expressiveness({ ...base, emotion: 'fear', intensity: 0.9 });
    expect(
      expressiveness({ ...base, emotion: 'fear', intensity: 0.9, stance: 'concealing' }),
    ).toBeLessThan(open);
    // The load-bearing one: a sincerely mistaken line is delivered exactly as a plain
    // one. The audience holds the irony; the voice must not.
    expect(expressiveness({ ...base, emotion: 'fear', intensity: 0.9, stance: 'mistaken' })).toBe(
      open,
    );
    expect(expressiveness({ ...base, emotion: 'fear', intensity: 0.9, stance: 'ironic' })).toBe(
      open,
    );
  });

  it('never reports a fully damped line as silence', () => {
    const floor = expressiveness({
      ...base,
      emotion: 'resignation',
      intensity: 0,
      volume: 'whisper',
      stance: 'concealing',
    });
    expect(floor).toBeGreaterThan(0);
  });
});

describe('describeDirection', () => {
  const bitter = SpeechDirection.parse({
    emotion: 'bitterness',
    intensity: 0.6,
    pace: 'slow',
    volume: 'low',
    stance: 'concealing',
  });

  it('reads in Persian for the narrator page', () => {
    const text = describeDirection(bitter, 'fa');
    expect(text).toContain(SPEECH_EMOTION_LABELS.bitterness.fa);
    expect(text).toContain(SPEECH_STANCE_LABELS.concealing.fa);
  });

  it('reads in English for a log', () => {
    expect(describeDirection(bitter)).toBe('bitterness, slow, low, concealing');
  });

  it('leaves a plain stance unsaid, because it is the absence of an instruction', () => {
    expect(describeDirection(PLAIN_DIRECTION)).toBe('neutral, measured, normal');
  });
});

describe('the schemas', () => {
  it('defaults a direction to a plain stance', () => {
    const parsed = SpeechDirection.parse({
      emotion: 'joy',
      intensity: 0.5,
      pace: 'quick',
      volume: 'normal',
    });
    expect(parsed.stance).toBe('plain');
  });

  it('refuses an emotion outside the vocabulary, so an adapter never meets one', () => {
    expect(SpeechEmotionSchema.safeParse('splenetic').success).toBe(false);
  });

  it('refuses an intensity outside 0..1', () => {
    const bad = SpeechDirection.safeParse({
      emotion: 'joy',
      intensity: 1.5,
      pace: 'quick',
      volume: 'normal',
    });
    expect(bad.success).toBe(false);
  });

  it('ships a plain direction that is itself valid', () => {
    expect(SpeechDirection.safeParse(PLAIN_DIRECTION).success).toBe(true);
  });

  it('names an emotion for every member of the enum', () => {
    const options: readonly SpeechEmotion[] = SpeechEmotionSchema.options;
    expect(options).toEqual([...SPEECH_EMOTIONS]);
  });
});
