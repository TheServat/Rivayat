/**
 * The audio side of the story engine.
 *
 * Three things are under test and they are the three the brief actually asked for: that
 * a character's voice comes out of the sheet rather than out of a settings panel, that
 * the epistemic layer changes the delivery, and that a shot list compiles into a timeline
 * the narrator's page can be generated from.
 */

import { describe, expect, it } from 'vitest';
import type { CharacterVoice, Shot, VoiceCasting } from '@rv/contracts';
import {
  AudioTimeline,
  Shot as ShotSchema,
  VoiceCasting as VoiceCastingSchema,
  toNarrationScript,
  renderNarrationSheet,
} from '@rv/contracts';

import {
  IDS,
  characterPayload,
  deterministicIds,
  epistemicView,
  knownFact,
} from '../__fixtures__/builders';
import { compileAudioTimeline } from './compile-audio-timeline';
import { speakerPosition, stanceFor } from './line-stance';
import { deriveVoiceProfile } from './voice-casting';

const NARRATOR = IDS.lighthouse;

function voiceOf(overrides: Partial<CharacterVoice> = {}): CharacterVoice {
  return { ...characterPayload().voice, ...overrides };
}

describe('deriveVoiceProfile', () => {
  const base = {
    speakerRef: IDS.mahtab,
    label: 'مهتاب',
    language: 'fa',
    binding: { presetId: 'mahtab-v1', exemplar: null },
  } as const;

  it('is pure: the same sheet gives the same voice, which the cache key depends on', () => {
    const first = deriveVoiceProfile({ ...base, voice: voiceOf() });
    const second = deriveVoiceProfile({ ...base, voice: voiceOf() });
    expect(first).toEqual(second);
  });

  it('makes a terse character quieter than a rambling one', () => {
    const terse = deriveVoiceProfile({ ...base, voice: voiceOf({ verbosity: 'terse' }) });
    const rambling = deriveVoiceProfile({ ...base, voice: voiceOf({ verbosity: 'rambling' }) });
    expect(terse.expressiveness).toBeLessThan(rambling.expressiveness);
  });

  it('flattens a dry voice, because deadpan is the joke', () => {
    // The entry in the table most likely to be written backwards.
    const dry = deriveVoiceProfile({ ...base, voice: voiceOf({ humourMode: 'dry' }) });
    const slapstick = deriveVoiceProfile({ ...base, voice: voiceOf({ humourMode: 'slapstick' }) });
    const plain = deriveVoiceProfile({ ...base, voice: voiceOf({ humourMode: 'none' }) });
    expect(dry.expressiveness).toBeLessThan(plain.expressiveness);
    expect(slapstick.expressiveness).toBeGreaterThan(plain.expressiveness);
  });

  it('flattens a technical register and lifts a poetic one', () => {
    expect(
      deriveVoiceProfile({ ...base, voice: voiceOf({ register: 'technical' }) }).expressiveness,
    ).toBeLessThan(
      deriveVoiceProfile({ ...base, voice: voiceOf({ register: 'poetic' }) }).expressiveness,
    );
  });

  it('takes tempo from rhythm, which is the only field about time', () => {
    expect(
      deriveVoiceProfile({ ...base, voice: voiceOf({ sentenceRhythm: 'staccato' }) }).tempoBias,
    ).toBeGreaterThan(0);
    expect(
      deriveVoiceProfile({ ...base, voice: voiceOf({ sentenceRhythm: 'looping' }) }).tempoBias,
    ).toBeLessThan(0);
    expect(
      deriveVoiceProfile({ ...base, voice: voiceOf({ sentenceRhythm: 'balanced' }) }).tempoBias,
    ).toBe(0);
  });

  it('refuses to invent a pitch, because no field in the sheet is about pitch', () => {
    for (const register of ['formal', 'poetic', 'vulgar'] as const) {
      expect(deriveVoiceProfile({ ...base, voice: voiceOf({ register }) }).pitchBias).toBe(0);
    }
  });

  it('keeps expressiveness inside 0..1 at both extremes of the sheet', () => {
    const loudest = deriveVoiceProfile({
      ...base,
      voice: voiceOf({
        verbosity: 'rambling',
        register: 'vulgar',
        humourMode: 'slapstick',
        sentenceRhythm: 'fragmented',
      }),
    });
    const quietest = deriveVoiceProfile({
      ...base,
      voice: voiceOf({
        verbosity: 'terse',
        register: 'technical',
        humourMode: 'dry',
        sentenceRhythm: 'looping',
      }),
    });
    expect(loudest.expressiveness).toBeLessThanOrEqual(1);
    expect(quietest.expressiveness).toBeGreaterThanOrEqual(0);
    expect(loudest.expressiveness).toBeGreaterThan(quietest.expressiveness);
  });

  it('writes a rationale that names the fields it came from', () => {
    const profile = deriveVoiceProfile({ ...base, voice: voiceOf() });
    expect(profile.rationale).toContain(voiceOf().verbosity);
    expect(profile.rationale).toContain(voiceOf().register);
    expect(profile.rationale).toContain('Silence:');
  });

  it('casts a human narrator with no binding, and the schema accepts it', () => {
    const narrator = deriveVoiceProfile({
      speakerRef: NARRATOR,
      label: 'راوی',
      language: 'fa',
      binding: { presetId: null, exemplar: null },
      role: 'narrator',
      performedBy: 'human',
      voice: voiceOf(),
    });
    const casting = VoiceCastingSchema.parse({
      narratorRef: NARRATOR,
      language: 'fa',
      profiles: [narrator, deriveVoiceProfile({ ...base, voice: voiceOf() })],
    });
    expect(casting.profiles).toHaveLength(2);
  });
});

describe('the epistemic layer changes the delivery', () => {
  const shown = new Set([IDS.relationOne]);

  it('calls a speaker mistaken when the audience has been shown they are wrong', () => {
    const view = epistemicView(IDS.mahtab, {
      believesFalsely: [knownFact('Roya is alive.', { relationId: IDS.relationOne })],
    });
    const position = speakerPosition(view, shown);
    expect(position.audienceKnowsBetter).toBe(true);
    expect(stanceFor(position)).toBe('mistaken');
  });

  it('does not call them mistaken when the audience is equally in the dark', () => {
    const view = epistemicView(IDS.mahtab, {
      believesFalsely: [knownFact('Roya is alive.', { relationId: IDS.relationTwo })],
    });
    // Without the audience knowing better there is no irony to hold, so there is nothing
    // for the voice to do differently.
    expect(stanceFor(speakerPosition(view, shown))).toBe('plain');
  });

  it('calls a speaker concealing when they know something the audience has not seen', () => {
    const view = epistemicView(IDS.mahtab, {
      knows: [knownFact('The Shabnam went down in the shoal.', { relationId: IDS.relationTwo })],
    });
    expect(stanceFor(speakerPosition(view, shown))).toBe('concealing');
  });

  it('prefers mistaken over concealing, because mistaken changes nothing', () => {
    // A character can be both wrong about one thing and sitting on another, and no edge
    // says which this line is about. The safe answer is the null adjustment.
    const view = epistemicView(IDS.mahtab, {
      believesFalsely: [knownFact('Roya is alive.', { relationId: IDS.relationOne })],
      knows: [knownFact('The lamp failed once.', { relationId: IDS.relationTwo })],
    });
    expect(stanceFor(speakerPosition(view, shown))).toBe('mistaken');
  });

  it('never infers irony, and always accepts it from the author', () => {
    const view = epistemicView(IDS.mahtab, {
      believesFalsely: [knownFact('Roya is alive.', { relationId: IDS.relationOne })],
    });
    const position = speakerPosition(view, shown);
    expect(stanceFor(position)).not.toBe('ironic');
    expect(stanceFor(position, 'ironic')).toBe('ironic');
  });

  it('lets an author state a plain line without it overriding the graph', () => {
    const view = epistemicView(IDS.mahtab, {
      knows: [knownFact('x', { relationId: IDS.relationTwo })],
    });
    expect(stanceFor(speakerPosition(view, shown), 'plain')).toBe('concealing');
  });

  it('reads a speaker with nothing to hide as plain', () => {
    expect(stanceFor(speakerPosition(epistemicView(IDS.mahtab), shown))).toBe('plain');
  });
});

// -- the compiler -------------------------------------------------------------

interface ShotOverrides {
  readonly id?: string;
  readonly index?: number;
  readonly durationMs?: number;
  readonly dialogue?: readonly Record<string, unknown>[];
  readonly audio?: Record<string, unknown>;
}

const FOCUS = {
  instance: 'mahtab',
  region: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
  priority: 'must-keep',
} as const;

function shot(overrides: ShotOverrides): Shot {
  return ShotSchema.parse({
    id: overrides.id ?? 'sht_01JQZX5K9T0000000000000001',
    index: overrides.index ?? 0,
    durationMs: overrides.durationMs ?? 8000,
    beatRef: 'bet_01JQZX5K9T0000000000000001',
    sceneSpace: {
      size: { width: 2160, height: 2160 },
      masterAspect: '16:9',
      reframeTargets: ['16:9', '9:16'],
    },
    camera: {
      framing: 'medium',
      move: 'static',
      focusTarget: FOCUS,
    },
    layout: [
      {
        z: 0,
        instances: [
          {
            instance: 'mahtab',
            assetId: 'ast_01JQZX5K9T0000000000000001',
            assetVersionId: 'asv_01JQZX5K9T0000000000000001',
            transform: { position: { x: 1080, y: 1080 } },
            depth: 0.5,
          },
        ],
      },
    ],
    dialogue: overrides.dialogue ?? [],
    audio: overrides.audio ?? { sfx: [], music: null },
    safeArea: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    focusTarget: FOCUS,
  });
}

function line(
  speakerRef: string,
  text: string,
  startMs: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    speakerRef,
    text,
    subtext: 'She is testing whether he flinches.',
    delivery: { emotion: 'bitter', intensity: 0.6, pace: 'measured', volume: 'normal' },
    startMs,
    ...overrides,
  };
}

function casting(): VoiceCasting {
  return VoiceCastingSchema.parse({
    narratorRef: NARRATOR,
    language: 'fa',
    profiles: [
      deriveVoiceProfile({
        speakerRef: NARRATOR,
        label: 'راوی',
        language: 'fa',
        binding: { presetId: null, exemplar: null },
        role: 'narrator',
        performedBy: 'human',
        voice: voiceOf(),
      }),
      deriveVoiceProfile({
        speakerRef: IDS.mahtab,
        label: 'مهتاب',
        language: 'fa',
        binding: { presetId: 'mahtab-v1', exemplar: null },
        voice: voiceOf(),
      }),
    ],
  });
}

describe('compileAudioTimeline', () => {
  function compile(
    shots: readonly Shot[],
    extra: Record<string, unknown> = {},
  ): ReturnType<typeof compileAudioTimeline> {
    return compileAudioTimeline({
      ids: deterministicIds(),
      animationRef: 'anm_lighthouse_01',
      language: 'fa',
      shots,
      casting: casting(),
      ...extra,
    });
  }

  it('produces a timeline the schema accepts', () => {
    const { timeline } = compile([
      shot({ dialogue: [line(NARRATOR, 'شب که می‌شود.', 0), line(IDS.mahtab, 'کسی نیست.', 4000)] }),
    ]);
    expect(AudioTimeline.safeParse(timeline).success).toBe(true);
  });

  it('turns shot-relative times into episode-absolute ones', () => {
    const { timeline } = compile([
      shot({ id: 'sht_01JQZX5K9T0000000000000001', index: 0, durationMs: 6000 }),
      shot({
        id: 'sht_01JQZX5K9T0000000000000002',
        index: 1,
        durationMs: 5000,
        dialogue: [line(IDS.mahtab, 'کسی نیست.', 1500)],
      }),
    ]);
    expect(timeline.durationMs).toBe(11_000);
    expect(timeline.cues[0]?.startMs).toBe(7500);
  });

  it('sends the narrator to the narration track and the cast to dialogue', () => {
    const { timeline } = compile([
      shot({ dialogue: [line(NARRATOR, 'شب که می‌شود.', 0), line(IDS.mahtab, 'کسی نیست.', 4000)] }),
    ]);
    const tracks = timeline.cues.map((cue) => cue.track);
    expect(tracks).toEqual(['narration', 'dialogue']);
  });

  it('gives a human line a window and leaves a synthetic one to be measured', () => {
    const { timeline } = compile([
      shot({
        durationMs: 9000,
        dialogue: [line(NARRATOR, 'شب که می‌شود.', 0), line(IDS.mahtab, 'کسی نیست.', 4000)],
      }),
    ]);
    // The narrator has from 0 to where the next line starts.
    expect(timeline.cues[0]?.durationMs).toBe(4000);
    // The character's length is not known until it has been spoken.
    expect(timeline.cues[1]?.durationMs).toBeNull();
  });

  it('gives the last human line the rest of its shot', () => {
    const { timeline } = compile([
      shot({ durationMs: 9000, dialogue: [line(NARRATOR, 'شب که می‌شود.', 1000)] }),
    ]);
    expect(timeline.cues[0]?.durationMs).toBe(8000);
  });

  it('prefers a measured duration over an allotted one once it exists', () => {
    const { timeline } = compile([
      shot({ durationMs: 9000, dialogue: [line(NARRATOR, 'شب.', 0, { durationMs: 2200 })] }),
    ]);
    expect(timeline.cues[0]?.durationMs).toBe(2200);
  });

  it('carries the delivery through, translated', () => {
    const { timeline } = compile([shot({ dialogue: [line(IDS.mahtab, 'کسی نیست.', 0)] })]);
    const source = timeline.cues[0]?.source;
    expect(source?.kind).toBe('speech');
    if (source?.kind === 'speech') {
      expect(source.direction.emotion).toBe('bitterness');
      expect(source.subtext).toContain('flinches');
    }
  });

  it('applies a stated stance to the line it names', () => {
    const { timeline } = compile([shot({ dialogue: [line(IDS.mahtab, 'عالی بود.', 0)] })], {
      stances: { 'sht_01JQZX5K9T0000000000000001:0': 'ironic' },
    });
    const source = timeline.cues[0]?.source;
    if (source?.kind === 'speech') expect(source.direction.stance).toBe('ironic');
  });

  it('reports an uncast speaker rather than emitting a silent line nobody notices', () => {
    const { timeline, issues } = compile([
      shot({ dialogue: [line(IDS.roya, 'من اینجا هستم.', 0)] }),
    ]);
    expect(timeline.cues).toHaveLength(0);
    expect(issues).toEqual([expect.objectContaining({ kind: 'uncast-speaker' })]);
  });

  it('reports an emotion the lexicon does not know', () => {
    const { issues } = compile([
      shot({
        dialogue: [
          line(IDS.mahtab, 'x', 0, {
            delivery: { emotion: 'splenetic', intensity: 0.5, pace: 'quick', volume: 'normal' },
          }),
        ],
      }),
    ]);
    expect(issues[0]?.kind).toBe('unresolved-emotion');
  });

  it('routes a looping effect to ambience and a one-shot to sfx', () => {
    const { timeline } = compile([
      shot({
        durationMs: 8000,
        audio: {
          sfx: [
            { key: 'weather/rain/heavy', startMs: 0, gain: 0.4, loop: true },
            { key: 'sfx/door-creak/slow', startMs: 3000, gain: 1, loop: false },
          ],
          music: null,
        },
      }),
    ]);
    const byTrack = Object.fromEntries(timeline.cues.map((cue) => [cue.track, cue]));
    expect(byTrack.ambience?.durationMs).toBe(8000);
    expect(byTrack.sfx?.durationMs).toBeNull();
    expect(byTrack.sfx?.startMs).toBe(3000);
  });

  it('carries one music bed across a cut rather than restarting it', () => {
    const { timeline } = compile([
      shot({
        id: 'sht_01JQZX5K9T0000000000000001',
        index: 0,
        durationMs: 5000,
        audio: {
          sfx: [],
          music: { key: 'music/tide/low', action: 'start', mood: 'unresolved', intensity: 0.4 },
        },
      }),
      shot({
        id: 'sht_01JQZX5K9T0000000000000002',
        index: 1,
        durationMs: 4000,
        audio: {
          sfx: [],
          music: { key: 'music/tide/low', action: 'continue', mood: 'unresolved', intensity: 0.4 },
        },
      }),
    ]);
    const musicCues = timeline.cues.filter((cue) => cue.track === 'music');
    // One bed, nine seconds long - not two beds retriggering at the edit.
    expect(musicCues).toHaveLength(1);
    expect(musicCues[0]?.startMs).toBe(0);
    expect(musicCues[0]?.durationMs).toBe(9000);
  });

  it('starts a new bed when the cue changes, and closes the old one at the cut', () => {
    const { timeline } = compile([
      shot({
        id: 'sht_01JQZX5K9T0000000000000001',
        index: 0,
        durationMs: 5000,
        audio: {
          sfx: [],
          music: { key: 'music/tide/low', action: 'start', mood: 'a', intensity: 0.4 },
        },
      }),
      shot({
        id: 'sht_01JQZX5K9T0000000000000002',
        index: 1,
        durationMs: 4000,
        audio: {
          sfx: [],
          music: { key: 'music/theme/roya', action: 'start', mood: 'b', intensity: 0.8 },
        },
      }),
    ]);
    const musicCues = timeline.cues.filter((cue) => cue.track === 'music');
    expect(musicCues.map((cue) => [cue.startMs, cue.durationMs])).toEqual([
      [0, 5000],
      [5000, 4000],
    ]);
  });

  it('ends the bed where the score says to stop, and where a shot chooses silence', () => {
    const { timeline } = compile([
      shot({
        id: 'sht_01JQZX5K9T0000000000000001',
        index: 0,
        durationMs: 5000,
        audio: {
          sfx: [],
          music: { key: 'music/tide/low', action: 'start', mood: 'a', intensity: 0.4 },
        },
      }),
      shot({
        id: 'sht_01JQZX5K9T0000000000000002',
        index: 1,
        durationMs: 4000,
        audio: {
          sfx: [],
          music: { key: 'music/tide/low', action: 'stop', mood: 'a', intensity: 0 },
        },
      }),
      shot({ id: 'sht_01JQZX5K9T0000000000000003', index: 2, durationMs: 3000 }),
    ]);
    const musicCues = timeline.cues.filter((cue) => cue.track === 'music');
    expect(musicCues).toHaveLength(1);
    expect(musicCues[0]?.durationMs).toBe(5000);
  });

  it('lets a fade run to the end of its shot rather than cutting at its start', () => {
    const { timeline } = compile([
      shot({
        id: 'sht_01JQZX5K9T0000000000000001',
        index: 0,
        durationMs: 5000,
        audio: {
          sfx: [],
          music: { key: 'music/tide/low', action: 'start', mood: 'a', intensity: 0.4 },
        },
      }),
      shot({
        id: 'sht_01JQZX5K9T0000000000000002',
        index: 1,
        durationMs: 4000,
        audio: {
          sfx: [],
          music: { key: 'music/tide/low', action: 'fade', mood: 'a', intensity: 0.1 },
        },
      }),
    ]);
    const musicCues = timeline.cues.filter((cue) => cue.track === 'music');
    expect(musicCues[0]?.durationMs).toBe(9000);
  });

  it('starts a bed that was only ever asked to continue, rather than losing it', () => {
    const { timeline } = compile([
      shot({
        durationMs: 5000,
        audio: {
          sfx: [],
          music: { key: 'music/tide/low', action: 'continue', mood: 'a', intensity: 0.4 },
        },
      }),
    ]);
    expect(timeline.cues.filter((cue) => cue.track === 'music')).toHaveLength(1);
  });

  it('keeps a swell on the same bed instead of retriggering it', () => {
    const { timeline } = compile([
      shot({
        id: 'sht_01JQZX5K9T0000000000000001',
        index: 0,
        durationMs: 5000,
        audio: {
          sfx: [],
          music: { key: 'music/tide/low', action: 'start', mood: 'a', intensity: 0.3 },
        },
      }),
      shot({
        id: 'sht_01JQZX5K9T0000000000000002',
        index: 1,
        durationMs: 4000,
        audio: {
          sfx: [],
          music: { key: 'music/tide/low', action: 'swell', mood: 'a', intensity: 0.9 },
        },
      }),
    ]);
    expect(timeline.cues.filter((cue) => cue.track === 'music')).toHaveLength(1);
  });

  it('pins a cue to the marker at the same instant, and leaves the rest unpinned', () => {
    const marker = 'mrk_01JQZX5K9T0000000000000001' as never;
    const { timeline } = compile([shot({ dialogue: [line(IDS.mahtab, 'کسی نیست.', 2000)] })], {
      markers: [{ id: marker, timeMs: 2000, kind: 'dialogue' }],
    });
    expect(timeline.cues[0]?.markerRef).toBe(marker);
  });

  it('leaves a cue unpinned when the animation document does not exist yet', () => {
    const { timeline } = compile([shot({ dialogue: [line(IDS.mahtab, 'کسی نیست.', 2000)] })]);
    expect(timeline.cues[0]?.markerRef).toBeNull();
  });

  it('returns the cues in time order, whatever order the shots put them in', () => {
    const { timeline } = compile([
      shot({
        durationMs: 9000,
        dialogue: [line(IDS.mahtab, 'دوم', 5000), line(IDS.mahtab, 'اول', 1000)],
        audio: {
          sfx: [{ key: 'sfx/door-creak/slow', startMs: 3000, gain: 1, loop: false }],
          music: null,
        },
      }),
    ]);
    const starts = timeline.cues.map((cue) => cue.startMs);
    expect(starts).toEqual([...starts].sort((left, right) => left - right));
  });

  it('orders two cues at the same instant stably, so a recompile is byte-identical', () => {
    const shots = [
      shot({
        durationMs: 9000,
        dialogue: [line(IDS.mahtab, 'همزمان', 2000)],
        audio: {
          sfx: [{ key: 'sfx/door-creak/slow', startMs: 2000, gain: 1, loop: false }],
          music: null,
        },
      }),
    ];
    const first = compile(shots).timeline.cues.map((cue) => cue.track);
    const second = compile(shots).timeline.cues.map((cue) => cue.track);
    expect(first).toEqual(second);
  });

  it('produces a narrator page whose timings are the timeline, by construction', () => {
    // The end-to-end claim the whole layer is for: the owner reads to a video that
    // matches, because the page is a projection of the same document the video is scored
    // from rather than a second copy of the numbers.
    const { timeline } = compile([
      shot({
        durationMs: 9000,
        dialogue: [
          line(NARRATOR, 'شب که می‌شود، فانوس را روشن می‌کند.', 0),
          line(IDS.mahtab, 'کسی نیست.', 4000),
        ],
      }),
    ]);
    const script = toNarrationScript(timeline, { title: 'فانوس', episodeLabel: 'قسمت ۱' });

    expect(script.passages).toHaveLength(1);
    const narrationCue = timeline.cues.find((cue) => cue.track === 'narration');
    expect(script.passages[0]?.startMs).toBe(narrationCue?.startMs);
    expect(script.passages[0]?.durationMs).toBe(narrationCue?.durationMs);

    const sheet = renderNarrationSheet(script);
    expect(sheet).toContain('۰:۰۰ تا ۰:۰۴');
    expect(sheet).not.toMatch(/[0-9<>[\]]/u);
  });
});
