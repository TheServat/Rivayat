import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { fixtureId, issuePaths } from './__fixtures__/support';
import {
  DELIVERY_ASPECTS,
  Act,
  DeliveryAspect,
  BEAT_FUNCTIONS,
  Beat,
  BeatFunction,
  CanonPolicy,
  DeliveryNote,
  DialogueLine,
  EPISODE_STATUSES,
  EPISODE_STATUS_TRANSITIONS,
  EmotionalValueShift,
  Episode,
  EpisodeStatus,
  OutlineEnvelope,
  PhonemeTiming,
  Scene,
  Season,
  Sequence,
  SeriesBible,
  TargetFormat,
  VALUE_CHARGES,
  ValueCharge,
  WorldRule,
} from './story-bible';

const mahtab = fixtureId('ent', 1);
const lighthouse = fixtureId('ent', 3);

const outline = {
  ordinal: 1,
  title: 'The climb',
  summary: 'She climbs the stair with the oil, counting the steps.',
  plannedSummary: 'Establish the ritual, then break it by one detail.',
};

const beat = {
  ...outline,
  id: fixtureId('bet', 1),
  function: 'setup',
  movesEntityRefs: [mahtab],
};

const scene = {
  ...outline,
  id: fixtureId('scn', 1),
  title: 'The keeper refuses the tide',
  locationRef: lighthouse,
  presentEntityRefs: [mahtab],
  povEntityRef: mahtab,
  goal: 'Relight the lamp before the fleet reaches the shoal.',
  conflict: 'The tide is standing between her and the lamp.',
  outcome: 'She lights it, and hears the name of the boat.',
  storyInterval: { from: { ordinal: 1000, label: 'Nine years after the wreck' }, until: null },
  valueShift: { axis: 'certainty', from: 'positive', to: 'strong-negative' },
  beats: [beat],
};

const sequence = {
  ...outline,
  id: fixtureId('seq', 1),
  title: 'Up the tower',
  dramaticQuestion: 'Will she get the lamp lit without looking?',
  scenes: [scene],
};

const act = {
  ...outline,
  id: fixtureId('act', 1),
  title: 'The ritual and the break',
  turningPoint: 'She looks at the tide.',
  sequences: [sequence],
};

const episode = {
  ...outline,
  id: fixtureId('ep', 1),
  title: 'The Shabnam',
  status: 'boarded',
  logline: 'A keeper who refused to grieve is answered.',
  acts: [act],
};

const season = {
  ...outline,
  id: fixtureId('sea', 1),
  title: 'Spring tide',
  arc: 'The season the coast stops being able to pretend.',
  episodes: [episode],
};

const seriesBible = {
  id: fixtureId('ser', 1),
  title: 'The Tide That Remembers',
  summary: 'A drowned coast and a keeper who will not grieve.',
  plannedSummary: null,
  premise: 'The sea has begun handing the drowned back, one voice at a time.',
  themes: ['inherited guilt'],
  tone: ['melancholy'],
  genre: ['folk horror'],
  targetFormat: { deliverables: ['16:9'], fps: 24, episodeDurationMs: 720_000 },
  canonPolicy: {},
  seasons: [season],
};

describe('TargetFormat', () => {
  it('defaults the master aspect to landscape', () => {
    expect(DeliveryAspect.options).toEqual([...DELIVERY_ASPECTS]);
    expect(TargetFormat.parse(seriesBible.targetFormat).masterAspect).toBe('16:9');
  });

  it('insists that at least one aspect actually ships', () => {
    expect(
      issuePaths(TargetFormat.safeParse({ ...seriesBible.targetFormat, deliverables: [] })),
    ).toEqual(['deliverables']);
  });

  it('rejects an aspect nothing can render', () => {
    expect(
      issuePaths(TargetFormat.safeParse({ ...seriesBible.targetFormat, deliverables: ['21:9'] })),
    ).toEqual(['deliverables.0']);
  });

  it('rejects a zero-length episode and an impossible frame rate', () => {
    const base = seriesBible.targetFormat;
    expect(issuePaths(TargetFormat.safeParse({ ...base, episodeDurationMs: 0 }))).toEqual([
      'episodeDurationMs',
    ]);
    expect(TargetFormat.safeParse({ ...base, episodeDurationMs: -1 }).success).toBe(false);
    expect(TargetFormat.safeParse({ ...base, fps: 0 }).success).toBe(false);
    expect(TargetFormat.safeParse({ ...base, fps: 121 }).success).toBe(false);
  });
});

describe('WorldRule', () => {
  it('treats a law as inviolable unless the author says otherwise', () => {
    const parsed = WorldRule.parse({
      scope: 'metaphysics',
      statement: 'The sea returns only voices, never bodies.',
    });
    expect(parsed.inviolable).toBe(true);
  });

  it('rejects a scope the continuity checker has no bucket for', () => {
    expect(issuePaths(WorldRule.safeParse({ scope: 'vibes', statement: 'x' }))).toEqual(['scope']);
  });

  it('rejects an empty statement, which cannot be violated or checked', () => {
    expect(issuePaths(WorldRule.safeParse({ scope: 'physics', statement: '' }))).toEqual([
      'statement',
    ]);
  });
});

describe('CanonPolicy', () => {
  it('defaults to the strict, freeze-on-air, reveal-only stance', () => {
    expect(CanonPolicy.parse({})).toEqual({
      freezeOnAir: true,
      retcon: 'reveal-only',
      strictness: 'strict',
    });
  });

  it('rejects a retcon policy that is not one of the three', () => {
    expect(issuePaths(CanonPolicy.safeParse({ retcon: 'sometimes' }))).toEqual(['retcon']);
  });
});

describe('EpisodeStatus', () => {
  it('lists the lifecycle in the order of docs/02 §1', () => {
    expect(EpisodeStatus.options).toEqual([
      'draft',
      'outlined',
      'scripted',
      'boarded',
      'asset-resolved',
      'choreographed',
      'rendered',
      'aired',
    ]);
  });

  it('rejects a status nobody defined', () => {
    expect(EpisodeStatus.safeParse('published').success).toBe(false);
  });
});

describe('EPISODE_STATUS_TRANSITIONS', () => {
  it('is total - every status has an entry', () => {
    expect(Object.keys(EPISODE_STATUS_TRANSITIONS).sort()).toEqual([...EPISODE_STATUSES].sort());
    for (const status of EPISODE_STATUSES) {
      expect(Array.isArray(EPISODE_STATUS_TRANSITIONS[status])).toBe(true);
    }
  });

  it('only ever points at a status that exists', () => {
    for (const status of EPISODE_STATUSES) {
      for (const next of EPISODE_STATUS_TRANSITIONS[status]) {
        expect(EPISODE_STATUSES).toContain(next);
      }
    }
  });

  it('never lets a status transition to itself', () => {
    for (const status of EPISODE_STATUSES) {
      expect(EPISODE_STATUS_TRANSITIONS[status]).not.toContain(status);
    }
  });

  it('moves exactly one step, forwards or backwards', () => {
    for (const status of EPISODE_STATUSES) {
      const here = EPISODE_STATUSES.indexOf(status);
      for (const next of EPISODE_STATUS_TRANSITIONS[status]) {
        expect(Math.abs(EPISODE_STATUSES.indexOf(next) - here)).toBe(1);
      }
    }
  });

  it('has exactly one terminal state, and it is aired', () => {
    const terminal = EPISODE_STATUSES.filter(
      (status) => EPISODE_STATUS_TRANSITIONS[status].length === 0,
    );
    expect(terminal).toEqual(['aired']);
  });

  it('lets an aired episode go nowhere at all - non-negotiable #7', () => {
    expect(EPISODE_STATUS_TRANSITIONS.aired).toEqual([]);
    for (const status of EPISODE_STATUSES) {
      expect(EPISODE_STATUS_TRANSITIONS.aired).not.toContain(status);
    }
  });

  it('only lets rendered reach aired, so nothing airs unrendered', () => {
    const canAir = EPISODE_STATUSES.filter((status) =>
      EPISODE_STATUS_TRANSITIONS[status].includes('aired'),
    );
    expect(canAir).toEqual(['rendered']);
  });

  it('reaches every status from draft, so nothing is stranded', () => {
    const seen = new Set<EpisodeStatus>(['draft']);
    const pending: EpisodeStatus[] = ['draft'];
    while (pending.length > 0) {
      const status = pending.pop();
      if (status === undefined) break;
      for (const next of EPISODE_STATUS_TRANSITIONS[status]) {
        if (!seen.has(next)) {
          seen.add(next);
          pending.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...EPISODE_STATUSES].sort());
  });
});

describe('PhonemeTiming', () => {
  it('takes a symbol and a span measured from the start of the line', () => {
    expect(PhonemeTiming.parse({ phoneme: 'DH', startMs: 0, durationMs: 90 }).startMs).toBe(0);
  });

  it('rejects a phoneme that occupies no time and one that starts before the line', () => {
    expect(
      issuePaths(PhonemeTiming.safeParse({ phoneme: 'DH', startMs: 0, durationMs: 0 })),
    ).toEqual(['durationMs']);
    expect(
      issuePaths(PhonemeTiming.safeParse({ phoneme: 'DH', startMs: -1, durationMs: 90 })),
    ).toEqual(['startMs']);
  });
});

describe('DeliveryNote', () => {
  const delivery = { emotion: 'braced', intensity: 0.55, pace: 'measured', volume: 'low' };

  it('parses the four fields the TTS adapter and the rig both read', () => {
    expect(DeliveryNote.parse(delivery).intensity).toBe(0.55);
  });

  it('bounds intensity to 0..1 because it scales gesture amplitude', () => {
    expect(issuePaths(DeliveryNote.safeParse({ ...delivery, intensity: 1.2 }))).toEqual([
      'intensity',
    ]);
    expect(DeliveryNote.safeParse({ ...delivery, intensity: -0.1 }).success).toBe(false);
  });

  it('rejects a pace or volume the synthesiser cannot map', () => {
    expect(issuePaths(DeliveryNote.safeParse({ ...delivery, pace: 'brisk' }))).toEqual(['pace']);
    expect(issuePaths(DeliveryNote.safeParse({ ...delivery, volume: 'medium' }))).toEqual([
      'volume',
    ]);
  });
});

describe('DialogueLine', () => {
  const line = {
    speakerRef: mahtab,
    text: 'I am not talking to you.',
    subtext: 'She is talking to it, and knows it.',
    delivery: { emotion: 'braced', intensity: 0.5, pace: 'measured', volume: 'low' },
  };

  it('defaults to the start of the shot with no alignment yet', () => {
    const parsed = DialogueLine.parse(line);
    expect(parsed.startMs).toBe(0);
    expect(parsed.phonemes).toEqual([]);
    expect(parsed.durationMs).toBeUndefined();
  });

  it('demands subtext, so no line can be only its surface', () => {
    const { subtext: _dropped, ...withoutSubtext } = line;
    expect(issuePaths(DialogueLine.safeParse(withoutSubtext))).toEqual(['subtext']);
  });

  it('rejects a speaker that is not an entity id', () => {
    expect(issuePaths(DialogueLine.safeParse({ ...line, speakerRef: 'mahtab' }))).toEqual([
      'speakerRef',
    ]);
  });

  it('reports the offending phoneme by index', () => {
    const result = DialogueLine.safeParse({
      ...line,
      phonemes: [
        { phoneme: 'DH', startMs: 0, durationMs: 90 },
        { phoneme: 'AH', startMs: 90, durationMs: -5 },
      ],
    });
    expect(issuePaths(result)).toEqual(['phonemes.1.durationMs']);
  });
});

describe('OutlineEnvelope - the DOC binding', () => {
  it('keeps the parent instruction beside the produced content', () => {
    const parsed = OutlineEnvelope.parse(outline);
    expect(parsed.plannedSummary).toBe(outline.plannedSummary);
    expect(parsed.summary).not.toBe(parsed.plannedSummary);
  });

  it('accepts an explicit null plan, and refuses an absent one', () => {
    expect(OutlineEnvelope.parse({ ...outline, plannedSummary: null }).plannedSummary).toBeNull();
    const { plannedSummary: _dropped, ...withoutPlan } = outline;
    expect(issuePaths(OutlineEnvelope.safeParse(withoutPlan))).toEqual(['plannedSummary']);
  });

  it('rejects ordinal zero and negatives - siblings are numbered from one', () => {
    expect(issuePaths(OutlineEnvelope.safeParse({ ...outline, ordinal: 0 }))).toEqual(['ordinal']);
    expect(OutlineEnvelope.safeParse({ ...outline, ordinal: -1 }).success).toBe(false);
    expect(OutlineEnvelope.safeParse({ ...outline, ordinal: 1.5 }).success).toBe(false);
  });

  it('rejects an empty summary', () => {
    expect(issuePaths(OutlineEnvelope.safeParse({ ...outline, summary: '   ' }))).toEqual([
      'summary',
    ]);
  });
});

describe('Beat', () => {
  it('parses a beat that moves someone', () => {
    expect(Beat.parse(beat).function).toBe('setup');
    expect(BeatFunction.options).toEqual([...BEAT_FUNCTIONS]);
  });

  it('refuses a beat that changes nothing for nobody', () => {
    expect(issuePaths(Beat.safeParse({ ...beat, movesEntityRefs: [] }))).toEqual([
      'movesEntityRefs',
    ]);
  });

  it('refuses a structural function nobody planned for', () => {
    expect(issuePaths(Beat.safeParse({ ...beat, function: 'vibes' }))).toEqual(['function']);
  });
});

describe('EmotionalValueShift', () => {
  it('takes one axis and two charges', () => {
    expect(ValueCharge.options).toEqual([...VALUE_CHARGES]);
    expect(EmotionalValueShift.parse(scene.valueShift).to).toBe('strong-negative');
  });

  it('allows a scene that does not turn, so the critique pass can flag it rather than the parser', () => {
    const flat = EmotionalValueShift.parse({ axis: 'trust', from: 'neutral', to: 'neutral' });
    expect(flat.from).toBe(flat.to);
  });

  it('rejects a charge off the scale', () => {
    expect(
      issuePaths(EmotionalValueShift.safeParse({ axis: 'trust', from: 'good', to: 'bad' })),
    ).toEqual(['from', 'to']);
  });
});

describe('Scene', () => {
  it('parses a fully specified scene', () => {
    const parsed = Scene.parse(scene);
    expect(parsed.beats).toHaveLength(1);
    expect(parsed.storyInterval.until).toBeNull();
  });

  it('accepts a null POV, which forfeits the dramatic-irony guard on purpose', () => {
    expect(Scene.parse({ ...scene, povEntityRef: null }).povEntityRef).toBeNull();
  });

  it('demands an explicit POV decision rather than an absent field', () => {
    const { povEntityRef: _dropped, ...withoutPov } = scene;
    expect(issuePaths(Scene.safeParse(withoutPov))).toEqual(['povEntityRef']);
  });

  it('defaults the present cast to empty for an empty location', () => {
    const { presentEntityRefs: _dropped, ...withoutCast } = scene;
    expect(Scene.parse(withoutCast).presentEntityRefs).toEqual([]);
  });

  it('refuses a scene with no beats', () => {
    expect(issuePaths(Scene.safeParse({ ...scene, beats: [] }))).toEqual(['beats']);
  });

  it('names the exact beat and field when a nested beat is wrong', () => {
    const result = Scene.safeParse({ ...scene, beats: [{ ...beat, function: 'vibes' }] });
    expect(issuePaths(result)).toEqual(['beats.0.function']);
  });

  it('rejects a location that is not an entity id', () => {
    expect(issuePaths(Scene.safeParse({ ...scene, locationRef: 'the lighthouse' }))).toEqual([
      'locationRef',
    ]);
  });

  it('rejects a story interval that is not two nullable story times', () => {
    expect(
      issuePaths(
        Scene.safeParse({ ...scene, storyInterval: { from: { ordinal: 1.5 }, until: null } }),
      ),
    ).toEqual(['storyInterval.from.ordinal']);
  });
});

describe('Sequence, Act, Episode, Season', () => {
  it('parses each level of the tree', () => {
    expect(Sequence.parse(sequence).scenes).toHaveLength(1);
    expect(Act.parse(act).sequences).toHaveLength(1);
    expect(Episode.parse(episode).status).toBe('boarded');
    expect(Season.parse(season).episodes).toHaveLength(1);
  });

  it('refuses an empty level anywhere in the tree', () => {
    expect(issuePaths(Sequence.safeParse({ ...sequence, scenes: [] }))).toEqual(['scenes']);
    expect(issuePaths(Act.safeParse({ ...act, sequences: [] }))).toEqual(['sequences']);
    expect(issuePaths(Episode.safeParse({ ...episode, acts: [] }))).toEqual(['acts']);
    expect(issuePaths(Season.safeParse({ ...season, episodes: [] }))).toEqual(['episodes']);
  });

  it('defaults an episode to owing and paying off nothing', () => {
    const parsed = Episode.parse(episode);
    expect(parsed.opensLoops).toEqual([]);
    expect(parsed.closesLoops).toEqual([]);
    expect(parsed.airedAt).toBeUndefined();
    expect(parsed.coldOpen).toBeUndefined();
  });

  it('records the air time in authoring time, with an offset', () => {
    const parsed = Episode.parse({ ...episode, status: 'aired', airedAt: '2026-08-23T21:00:00Z' });
    expect(parsed.airedAt).toBe('2026-08-23T21:00:00Z');
    expect(Episode.safeParse({ ...episode, airedAt: '2026-08-23' }).success).toBe(false);
  });

  it('tracks open loops by id, not by prose', () => {
    const loop = fixtureId('lop', 1);
    expect(Episode.parse({ ...episode, opensLoops: [loop] }).opensLoops).toEqual([loop]);
    expect(issuePaths(Episode.safeParse({ ...episode, opensLoops: ['the boat'] }))).toEqual([
      'opensLoops.0',
    ]);
  });

  it('lets a season fork the style without touching the series', () => {
    const style = fixtureId('sty', 2);
    expect(Season.parse({ ...season, styleBibleRef: style }).styleBibleRef).toBe(style);
  });

  it('reports the deepest wrong field through five levels of nesting', () => {
    const result = Season.safeParse({
      ...season,
      episodes: [
        {
          ...episode,
          acts: [
            {
              ...act,
              sequences: [
                { ...sequence, scenes: [{ ...scene, beats: [{ ...beat, ordinal: 0 }] }] },
              ],
            },
          ],
        },
      ],
    });
    expect(issuePaths(result)).toEqual(['episodes.0.acts.0.sequences.0.scenes.0.beats.0.ordinal']);
  });
});

describe('SeriesBible', () => {
  it('parses the root of the tree with its defaults applied', () => {
    const parsed = SeriesBible.parse(seriesBible);
    expect(parsed.rulesOfTheWorld).toEqual([]);
    expect(parsed.canonPolicy.freezeOnAir).toBe(true);
    expect(parsed.targetFormat.masterAspect).toBe('16:9');
    expect(parsed.styleBibleRef).toBeUndefined();
  });

  it('carries a null plan at the root, whose parent is the brief', () => {
    expect(SeriesBible.parse(seriesBible).plannedSummary).toBeNull();
  });

  it('refuses a series with no seasons - a standalone short is one season of one episode', () => {
    expect(issuePaths(SeriesBible.safeParse({ ...seriesBible, seasons: [] }))).toEqual(['seasons']);
  });

  it('insists on at least one theme, one tone word and one genre', () => {
    expect(issuePaths(SeriesBible.safeParse({ ...seriesBible, themes: [] }))).toEqual(['themes']);
    expect(issuePaths(SeriesBible.safeParse({ ...seriesBible, tone: [] }))).toEqual(['tone']);
    expect(issuePaths(SeriesBible.safeParse({ ...seriesBible, genre: [] }))).toEqual(['genre']);
  });

  it('caps the lists that stop meaning anything when they get long', () => {
    const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `x${String(i)}`);
    expect(SeriesBible.safeParse({ ...seriesBible, themes: many(9) }).success).toBe(false);
    expect(SeriesBible.safeParse({ ...seriesBible, tone: many(13) }).success).toBe(false);
    expect(SeriesBible.safeParse({ ...seriesBible, genre: many(5) }).success).toBe(false);
  });

  it('rejects an unknown key rather than absorbing a hallucinated field', () => {
    const result = SeriesBible.safeParse({ ...seriesBible, seasonCount: 1 });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toEqual(['']);
  });

  it('rejects an id minted for a different kind of thing', () => {
    expect(issuePaths(SeriesBible.safeParse({ ...seriesBible, id: fixtureId('ep', 1) }))).toEqual([
      'id',
    ]);
  });
});

describe('JSON Schema for the story model', () => {
  it('emits a closed object for every schema the model fills', () => {
    for (const schema of [
      TargetFormat,
      WorldRule,
      CanonPolicy,
      PhonemeTiming,
      DeliveryNote,
      DialogueLine,
      OutlineEnvelope,
      Beat,
      EmotionalValueShift,
      Scene,
      Sequence,
      Act,
      Episode,
      Season,
      SeriesBible,
    ]) {
      const json = z.toJSONSchema(schema) as { additionalProperties?: unknown };
      expect(json.additionalProperties).toBe(false);
    }
  });

  it('describes every field of a scene, because the model reads the descriptions', () => {
    const json = z.toJSONSchema(Scene) as {
      properties?: Record<string, { description?: string }>;
    };
    const properties = json.properties ?? {};
    expect(Object.keys(properties).length).toBeGreaterThan(0);
    for (const [key, property] of Object.entries(properties)) {
      if (key === 'id') continue; // minted by the pipeline, never by the model
      expect(property.description ?? '', `${key} has no instruction`).not.toBe('');
    }
  });

  it('exposes the lifecycle as an enum the model can only pick from', () => {
    const json = z.toJSONSchema(EpisodeStatus) as { enum?: string[] };
    expect(json.enum).toEqual([...EPISODE_STATUSES]);
  });
});

// ── the master aspect is one of the aspects that ship ───────────────────────

describe('TargetFormat is internally consistent', () => {
  const base = { deliverables: ['16:9'], fps: 24, episodeDurationMs: 720_000 };

  it('rejects a master aspect the series never ships', () => {
    expect(
      issuePaths(TargetFormat.safeParse({ ...base, masterAspect: '9:16', deliverables: ['16:9'] })),
    ).toEqual(['deliverables']);
  });

  it('accepts the default master aspect when it is in the list', () => {
    expect(TargetFormat.parse({ ...base, deliverables: ['16:9', '9:16'] }).masterAspect).toBe(
      '16:9',
    );
  });

  it('rejects a repeated deliverable, which would reframe the same crop twice', () => {
    expect(
      issuePaths(TargetFormat.safeParse({ ...base, deliverables: ['16:9', '9:16', '16:9'] })),
    ).toEqual(['deliverables']);
  });

  it('reports an empty deliverable list once, not also as a missing master', () => {
    expect(issuePaths(TargetFormat.safeParse({ ...base, deliverables: [] }))).toEqual([
      'deliverables',
    ]);
  });
});

// ── siblings are numbered 1..n, at every level ──────────────────────────────
//
// `ordinal` says "Contiguous - no gaps, no duplicates" in the description a model
// reads, and a description is advice. The list is the only thing that can check it.

describe('sibling ordinals are contiguous from one', () => {
  const secondBeat = { ...beat, id: fixtureId('bet', 2), ordinal: 2 };
  const secondScene = { ...scene, id: fixtureId('scn', 2), ordinal: 2 };
  const secondSequence = { ...sequence, id: fixtureId('seq', 2), ordinal: 2 };
  const secondAct = { ...act, id: fixtureId('act', 2), ordinal: 2 };
  const secondEpisode = { ...episode, id: fixtureId('ep', 2), ordinal: 2 };
  const secondSeason = { ...season, id: fixtureId('sea', 2), ordinal: 2 };

  it('accepts a well-numbered list at every level of the tree', () => {
    expect(Scene.safeParse({ ...scene, beats: [beat, secondBeat] }).success).toBe(true);
    expect(Sequence.safeParse({ ...sequence, scenes: [scene, secondScene] }).success).toBe(true);
    expect(Act.safeParse({ ...act, sequences: [sequence, secondSequence] }).success).toBe(true);
    expect(Episode.safeParse({ ...episode, acts: [act, secondAct] }).success).toBe(true);
    expect(Season.safeParse({ ...season, episodes: [episode, secondEpisode] }).success).toBe(true);
    expect(SeriesBible.safeParse({ ...seriesBible, seasons: [season, secondSeason] }).success).toBe(
      true,
    );
  });

  it('accepts a list numbered out of order, because order is the array, not the ordinal', () => {
    expect(Scene.safeParse({ ...scene, beats: [secondBeat, beat] }).success).toBe(true);
  });

  it('rejects a duplicate ordinal at every level of the tree', () => {
    expect(
      issuePaths(Scene.safeParse({ ...scene, beats: [beat, { ...secondBeat, ordinal: 1 }] })),
    ).toEqual(['beats']);
    expect(
      issuePaths(
        Sequence.safeParse({ ...sequence, scenes: [scene, { ...secondScene, ordinal: 1 }] }),
      ),
    ).toEqual(['scenes']);
    expect(
      issuePaths(
        Act.safeParse({ ...act, sequences: [sequence, { ...secondSequence, ordinal: 1 }] }),
      ),
    ).toEqual(['sequences']);
    expect(
      issuePaths(Episode.safeParse({ ...episode, acts: [act, { ...secondAct, ordinal: 1 }] })),
    ).toEqual(['acts']);
    expect(
      issuePaths(
        Season.safeParse({ ...season, episodes: [episode, { ...secondEpisode, ordinal: 1 }] }),
      ),
    ).toEqual(['episodes']);
    expect(
      issuePaths(
        SeriesBible.safeParse({
          ...seriesBible,
          seasons: [season, { ...secondSeason, ordinal: 1 }],
        }),
      ),
    ).toEqual(['seasons']);
  });

  it('rejects a gap, which is how a dropped expansion hides', () => {
    expect(
      issuePaths(Scene.safeParse({ ...scene, beats: [beat, { ...secondBeat, ordinal: 3 }] })),
    ).toEqual(['beats']);
  });

  it('rejects a list that starts at two', () => {
    expect(issuePaths(Scene.safeParse({ ...scene, beats: [secondBeat] }))).toEqual(['beats']);
  });

  it('reports an out-of-range ordinal once, at the field that is wrong', () => {
    expect(issuePaths(Scene.safeParse({ ...scene, beats: [{ ...beat, ordinal: 0 }] }))).toEqual([
      'beats.0.ordinal',
    ]);
  });
});

// ── aired canon: non-negotiable #7 ──────────────────────────────────────────

describe('airedAt is present exactly when the episode has aired', () => {
  const airedAt = '2026-08-23T21:00:00+03:30';

  it('accepts an aired episode that records when it aired', () => {
    const parsed = Episode.parse({ ...episode, status: 'aired', airedAt });
    expect(parsed.airedAt).toBe(airedAt);
  });

  it('rejects an aired episode with no air date, which cannot be replayed as-of airing', () => {
    expect(issuePaths(Episode.safeParse({ ...episode, status: 'aired' }))).toEqual(['airedAt']);
  });

  it('rejects an air date on an episode that has not aired', () => {
    for (const status of EPISODE_STATUSES.filter((each) => each !== 'aired')) {
      expect(issuePaths(Episode.safeParse({ ...episode, status, airedAt })), status).toEqual([
        'airedAt',
      ]);
    }
  });

  it('leaves an unaired episode with no air date alone', () => {
    expect(Episode.parse({ ...episode, status: 'rendered' }).airedAt).toBeUndefined();
  });
});
