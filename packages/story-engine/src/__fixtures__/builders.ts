/**
 * Deterministic test data.
 *
 * Every id, instant and random draw comes from here so a failing run is reproducible and a
 * diff of two runs is empty - the same discipline CLAUDE.md #1 holds the pipeline to. A
 * test suite that is not deterministic cannot be evidence that the code is.
 *
 * The domain objects are built through the contracts' own schemas wherever a default or a
 * refinement is involved, so a fixture cannot drift into a shape the real pipeline would
 * reject. A fixture that is invalid in production is a test of nothing.
 */

import {
  Brief,
  type CharacterPayload,
  type EntityId,
  type EpistemicView,
  Ids,
  type KnownFact,
  Scene,
  StyleBible,
} from '@rv/contracts';
import { StructuredCall } from '@rv/prompt-kit';
import { FixedClock, IdGenerator, type Instant, instant } from '@rv/shared-kernel';

import type { CastCandidate, NormalisedBriefDraft } from '../intake/normalised-brief';
import type { OutlineContext } from '../outline/context';
import { FixedStageBackends } from '../routing/stage-backends';
import type { CastMember } from '../support/cast-member';
import type { StoryEngineDeps } from '../support/stage-call';
import type { StyleBrief } from '../support/style-brief';
import type { FakeStructuredBackend } from './fakes';

export const TEST_EPOCH: Instant = instant(Date.parse('2026-08-23T12:00:00.000Z'));
export const TEST_ASOF = '2026-08-23T12:00:00.000Z';

/** A well-formed prefixed ULID that is the same on every run. */
export function fixtureId(prefix: string, n: number): string {
  return `${prefix}_01JQZX5K9T${String(n).padStart(16, '0')}`;
}

export const IDS = {
  series: fixtureId('ser', 1),
  mahtab: fixtureId('ent', 1),
  roya: fixtureId('ent', 2),
  lighthouse: fixtureId('ent', 3),
  relationOne: fixtureId('rel', 1),
  relationTwo: fixtureId('rel', 2),
} as const;

export function fixedClock(start: Instant = TEST_EPOCH): FixedClock {
  return new FixedClock(start);
}

/** Ids whose random half is a fixed byte pattern, so two runs mint the same ids. */
export function deterministicIds(clock = fixedClock()): Ids {
  return new Ids(new IdGenerator(clock, (size) => new Uint8Array(size).fill(7)));
}

/** Wires a use-case to fake backends and nothing else. */
export function testDeps(...backends: readonly FakeStructuredBackend[]): StoryEngineDeps {
  const clock = fixedClock();
  return {
    structured: new StructuredCall({ clock }),
    backends: new FixedStageBackends(backends),
    clock,
    ids: deterministicIds(clock),
  };
}

// ── style ───────────────────────────────────────────────────────────────────

export function styleBrief(overrides: Partial<StyleBrief> = {}): StyleBrief {
  return {
    name: 'Tideline gouache',
    medium: 'gouache',
    positiveFragment:
      'gouache on cold-pressed paper, limited salt-and-rust palette, flat cel shading',
    negativeFragment: 'photoreal skin, lens flare, visible brand logos',
    characterFragment: 'characters read in silhouette; hands simplified to three planes',
    paletteNames: ['salt white (primary)', 'rust (accent)', 'deep tide (shadow)'],
    silhouetteRule: 'recognisable as a solid black shape at 64px',
    shapeNote: 'roundness 0.30, exaggeration 0.45, 6.5 heads tall, detail density 0.35',
    ...overrides,
  };
}

// ── outline context ─────────────────────────────────────────────────────────

export function outlineContext(overrides: Partial<OutlineContext> = {}): OutlineContext {
  return {
    seriesTitle: 'The Keeper and the Tide',
    premise:
      'A lighthouse keeper who refuses to believe the sea can speak is answered by it, in ' +
      'her drowned daughter’s voice, every night the lamp goes out.',
    themes: ['inherited guilt', 'the price of being believed'],
    tone: ['melancholy', 'wry', 'salt-bitten'],
    genre: ['folk horror', 'mystery'],
    worldRules: [
      '[metaphysics, inviolable] The dead do not speak, and no living person has heard one.',
    ],
    canonPolicy: { freezeOnAir: true, retcon: 'reveal-only', strictness: 'strict' },
    episodeDurationMs: 420_000,
    ...overrides,
  };
}

// ── characters ──────────────────────────────────────────────────────────────

export function characterPayload(overrides: Partial<CharacterPayload> = {}): CharacterPayload {
  return {
    identity: {
      age: '54',
      ageYears: 54,
      gender: 'woman',
      species: 'human',
      occupation: 'lighthouse keeper',
      origin: 'the shoal villages',
    },
    psych: {
      want: 'To keep the lamp lit every night without fail.',
      need: 'To admit that she let her daughter go out in bad weather.',
      wound: 'Her daughter drowned on a boat she waved off.',
      lie: 'If the work is done perfectly, nothing else can be taken.',
      ghost: 'The night the Sahar went out and did not come back.',
      virtues: ['dogged', 'exact'],
      flaws: ['refuses help', 'answers grief with chores'],
      fears: ['being believed about the voice', 'the lamp failing'],
      values: ['duty', 'the truth as she saw it'],
      temperament: {
        warmth: -0.4,
        dominance: 0.3,
        volatility: -0.2,
        openness: -0.5,
        conscientiousness: 0.9,
      },
    },
    voice: {
      register: 'colloquial',
      verbosity: 'terse',
      idiolect: ['tide and weather terms'],
      verbalTics: ['aye then'],
      profanity: 'mild',
      sentenceRhythm: 'staccato',
      humourMode: 'dry',
      silenceHabits: 'Goes quiet mid-sentence when the subject turns to her daughter.',
    },
    arc: {
      startState: 'Works through every anniversary without naming it.',
      endState: 'Says the boat’s name out loud to another person.',
      turningPoints: [],
    },
    visual: {
      silhouetteNote: 'A squared-off oilskin cowl that never comes down, wider than her shoulders.',
      build: 'stocky',
      height: 'a head below most',
      palette: [{ name: 'rust', hex: '#8a3b1e', role: 'accent' }],
      distinguishingMarks: ['rope burn across the right palm'],
      wardrobe: [],
      expressionSet: [],
      poseSet: [],
      propAffinities: [],
    },
    motionSignature: {
      gaitStyle: 'trudge',
      posture: 'hunched',
      gestureFrequency: 0.2,
      energy: 0.4,
      idleBehaviour: 'Checks the wick with two fingers whether or not it needs it.',
      tellOnLying: 'Turns the lamp key a quarter-turn she does not need to turn.',
    },
    knowledgeScope: 'limited',
    ...overrides,
  };
}

export function castMember(
  name: string,
  entityId: EntityId,
  payload: Partial<CharacterPayload> = {},
): CastMember {
  return { entityId, name, payload: characterPayload(payload) };
}

/** A second cast member whose voice differs on four of the five discriminators. */
export function contrastingVoicePayload(): Partial<CharacterPayload> {
  const base = characterPayload();
  return {
    voice: {
      register: 'poetic',
      verbosity: 'rambling',
      idiolect: ['liturgical phrases'],
      verbalTics: ['as it happens'],
      profanity: 'none',
      sentenceRhythm: 'looping',
      humourMode: 'absurd',
      silenceHabits: 'Fills every pause rather than let one stand.',
    },
    psych: base.psych,
  };
}

// ── epistemic views ─────────────────────────────────────────────────────────

export function knownFact(fact: string, overrides: Partial<KnownFact> = {}): KnownFact {
  return {
    relationId: IDS.relationOne,
    fact,
    via: 'witnessed',
    learnedAt: null,
    confidence: 1,
    ...overrides,
  };
}

export function epistemicView(
  viewerId: EntityId,
  overrides: Partial<EpistemicView> = {},
): EpistemicView {
  return {
    seriesId: IDS.series,
    viewerId,
    at: { ordinal: 100, label: 'the first thaw' },
    asOf: TEST_ASOF,
    knows: [],
    believesFalsely: [],
    suspects: [],
    blindSpots: [],
    truncated: false,
    factCount: 0,
    ...overrides,
  };
}

// ── scenes ──────────────────────────────────────────────────────────────────

export function scene(): Scene {
  // Parsed rather than cast: `Scene` carries an ordinal-contiguity refinement, and a
  // fixture that quietly violates it would make every downstream assertion a test of the
  // refinement instead of the code under test.
  return Scene.parse({
    id: fixtureId('scn', 1),
    ordinal: 1,
    title: 'The keeper refuses the tide',
    summary:
      'Mahtab climbs to the lamp room and finds the tide already inside it, wearing her ' +
      'daughter’s shape. It says the name of the boat, which she has never told anyone.',
    plannedSummary:
      'Open on the keeper alone with the thing she has been refusing, and end with her ' +
      'certainty broken rather than with a threat.',
    locationRef: IDS.lighthouse,
    presentEntityRefs: [IDS.mahtab, IDS.roya],
    povEntityRef: IDS.mahtab,
    goal: 'Relight the lamp before the fleet reaches the shoal.',
    conflict: 'The thing on the stairs is standing between her and the wick.',
    outcome: 'She lights the lamp and leaves believing something she has denied for nine years.',
    storyInterval: { from: { ordinal: 100 }, until: { ordinal: 101 } },
    valueShift: { axis: 'certainty', from: 'positive', to: 'strong-negative' },
    beats: [
      {
        id: fixtureId('bet', 1),
        ordinal: 1,
        title: 'The climb',
        summary: 'Mahtab goes up with the spare wick and finds the door already open.',
        plannedSummary: 'Establish the ritual before anything breaks it.',
        function: 'setup',
        movesEntityRefs: [IDS.mahtab],
      },
      {
        id: fixtureId('bet', 2),
        ordinal: 2,
        title: 'The name',
        summary: 'The voice says the boat’s name.',
        plannedSummary: 'Break her certainty with one specific fact.',
        function: 'catalyst',
        movesEntityRefs: [IDS.mahtab, IDS.roya],
      },
    ],
  });
}

// ── briefs ──────────────────────────────────────────────────────────────────

const ENVELOPE = {
  workingTitle: 'The Keeper and the Tide',
  language: 'fa',
  targetAudience: 'Persian-speaking adults who grew up on 90s fantasy anime',
  toneWords: ['melancholy', 'wry'],
  targetEpisodeDurationMs: 420_000,
  episodes: { seasons: 1, episodesPerSeason: 6, openEnded: false },
  constraints: {
    mustNotAppear: ['visible blood'],
    ratingCeiling: 'teen' as const,
    notes: undefined,
  },
  references: [],
} as const;

/** A `Brief` of the requested kind, built through the schema so it is genuinely valid. */
export function brief(kind: Brief['kind'], overrides: Record<string, unknown> = {}): Brief {
  const bodies: Record<string, Record<string, unknown>> = {
    idea: { idea: 'یک روباه در شهر که فانوس دریایی را نگه می‌دارد' },
    logline: {
      logline:
        'A retired lighthouse keeper must out-argue the sea itself to keep her drowned ' +
        'daughter from being remembered wrongly.',
    },
    script: {
      script: 'INT. LAMP ROOM - NIGHT\n\nMAHTAB climbs the last stair.\n\nMAHTAB\nAye then.',
      scriptFormat: 'fountain',
    },
    prose: {
      prose:
        'The lamp had been out for an hour before she noticed, which was the first wrong thing.',
      excerptOf: 'The Shoal Villages',
    },
    'series-bible': { bible: seriesBibleFixture() },
  };

  return Brief.parse({
    kind,
    ...ENVELOPE,
    constraints: { mustNotAppear: ['visible blood'], ratingCeiling: 'teen' },
    ...bodies[kind],
    ...overrides,
  });
}

/** A minimal but complete series bible, for the `series-bible` front door. */
export function seriesBibleFixture(): unknown {
  return {
    id: IDS.series,
    title: 'The Keeper and the Tide',
    summary: 'Six episodes on a shoal coast where the sea has started answering back.',
    plannedSummary: null,
    premise:
      'A lighthouse keeper who refuses to believe the sea can speak is answered by it, in ' +
      'her drowned daughter’s voice, every night the lamp goes out.',
    themes: ['inherited guilt'],
    tone: ['melancholy'],
    genre: ['folk horror'],
    rulesOfTheWorld: [
      { scope: 'metaphysics', statement: 'The dead do not speak.', inviolable: true },
    ],
    targetFormat: {
      masterAspect: '16:9',
      deliverables: ['16:9', '9:16'],
      fps: 24,
      episodeDurationMs: 420_000,
    },
    canonPolicy: { freezeOnAir: true, retcon: 'reveal-only', strictness: 'strict' },
    seasons: [
      {
        id: fixtureId('sea', 1),
        ordinal: 1,
        title: 'Season one',
        summary: 'The keeper stops being able to explain the voice away.',
        plannedSummary: 'Take her from denial to admission across six episodes.',
        arc: 'From a woman who works through grief to a woman who names it.',
        episodes: [
          {
            id: fixtureId('ep', 1),
            ordinal: 1,
            title: 'The wick',
            summary: 'The lamp goes out and something answers.',
            plannedSummary: 'Establish the ritual and break it once.',
            status: 'draft',
            logline: 'Mahtab relights the lamp and hears a name she never told anyone.',
            opensLoops: [],
            closesLoops: [],
            acts: [
              {
                id: fixtureId('act', 1),
                ordinal: 1,
                title: 'Act one',
                summary: 'The climb.',
                plannedSummary: 'Get her to the lamp room alone.',
                turningPoint: 'She hears the name.',
                sequences: [
                  {
                    id: fixtureId('seq', 1),
                    ordinal: 1,
                    title: 'The climb',
                    summary: 'Up the stairs in the dark.',
                    plannedSummary: 'Make the ritual legible before it breaks.',
                    dramaticQuestion: 'Will she reach the lamp before the fleet reaches the shoal?',
                    scenes: [sceneRaw()],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function sceneRaw(): unknown {
  return {
    id: fixtureId('scn', 1),
    ordinal: 1,
    title: 'The keeper refuses the tide',
    summary: 'Mahtab climbs to the lamp room and finds the tide already inside it.',
    plannedSummary: 'Open on the keeper alone with the thing she has been refusing.',
    locationRef: IDS.lighthouse,
    presentEntityRefs: [IDS.mahtab],
    povEntityRef: IDS.mahtab,
    goal: 'Relight the lamp.',
    conflict: 'The thing on the stairs.',
    outcome: 'She lights it and leaves changed.',
    storyInterval: { from: { ordinal: 100 }, until: { ordinal: 101 } },
    valueShift: { axis: 'certainty', from: 'positive', to: 'negative' },
    beats: [
      {
        id: fixtureId('bet', 1),
        ordinal: 1,
        title: 'The climb',
        summary: 'She goes up with the spare wick.',
        plannedSummary: 'Establish the ritual.',
        function: 'setup',
        movesEntityRefs: [IDS.mahtab],
      },
    ],
  };
}

// ── model outputs ───────────────────────────────────────────────────────────

export function castCandidate(overrides: Partial<CastCandidate> = {}): CastCandidate {
  return {
    name: 'Mahtab',
    role: 'protagonist',
    importance: 'lead',
    premiseRole: 'Keeps the lamp, and refuses to hear what the sea is saying.',
    distinguishingTrait: 'Answers grief with chores.',
    ...overrides,
  };
}

/** A valid `NormalisedBriefDraft`, for a fake to return. */
export function normalisedDraft(
  overrides: Partial<NormalisedBriefDraft> = {},
): NormalisedBriefDraft {
  return {
    workingTitle: 'The Keeper and the Tide',
    premise: 'A keeper who cannot believe the sea speaks is answered by it every night.',
    logline: 'A lighthouse keeper must out-argue the sea to keep her daughter remembered rightly.',
    themes: ['inherited guilt'],
    tone: ['melancholy', 'wry'],
    genre: ['folk horror'],
    castCandidates: [castCandidate()],
    settingNotes: ['A shoal coast with one working lighthouse.'],
    openQuestions: ['The source does not say who else has heard the voice.'],
    scopeConcerns: [],
    ...overrides,
  };
}

/** A locked-looking style bible, for `styleBriefFrom`. Parsed, so it is genuinely valid. */
export function styleBibleFixture(): StyleBible {
  return StyleBible.parse({
    id: fixtureId('sty', 1),
    name: 'Tideline gouache',
    origin: 'preset',
    visual: {
      medium: 'gouache',
      palette: {
        colors: [
          { name: 'salt white', hex: '#f2efe6', role: 'primary' },
          { name: 'rust', hex: '#8a3b1e', role: 'accent' },
          { name: 'deep tide', hex: '#12303a', role: 'shadow' },
        ],
        harmony: 'analogous',
      },
      shape: { silhouetteRule: 'recognisable as a solid black shape at 64px' },
      negative: ['photoreal skin'],
    },
    motion: {
      fps: 24,
      // `camera.panEase` defaults to `ease-in-out`, and `MotionStyle` refuses a curve name
      // that resolves to nothing - so the list has to contain it.
      easings: [{ name: 'ease-in-out', p1: { x: 0.42, y: 0 }, p2: { x: 0.58, y: 1 } }],
      defaultEasing: 'ease-in-out',
      camera: { defaultShotMs: 3_000, cutRhythm: 'brisk' },
    },
    prompts: {
      positive: 'gouache on cold-pressed paper, limited salt-and-rust palette',
      negative: 'photoreal skin, lens flare',
      bySubject: { character: 'characters read in silhouette' },
    },
    seed: 7,
    checksum: 'a'.repeat(64),
    createdAt: TEST_ASOF,
  });
}
