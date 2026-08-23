/**
 * A realistic end-to-end fixture: two episodes, one fully specified scene, three shots.
 *
 * Written as raw data rather than as typed objects on purpose. The path that matters in
 * production is *untrusted JSON arriving from a model and being parsed*, so the fixture
 * has to travel that path too - a fixture built through the inferred type would only
 * ever prove that TypeScript agrees with itself.
 *
 * Episode 1 is carried all the way down to beats and shots; episode 2 is a legal
 * outline stub, which is exactly the state DOME leaves an unwritten episode in while
 * the planner keeps the right to re-plan it.
 */

import { fixtureId } from './support';

// ── ids ─────────────────────────────────────────────────────────────────────

export const FIXTURE_IDS = {
  series: fixtureId('ser', 1),
  season: fixtureId('sea', 1),
  styleBible: fixtureId('sty', 1),

  episodeOne: fixtureId('ep', 1),
  episodeTwo: fixtureId('ep', 2),
  actOne: fixtureId('act', 1),
  actTwo: fixtureId('act', 2),
  sequenceOne: fixtureId('seq', 1),
  sequenceTwo: fixtureId('seq', 2),
  sceneOne: fixtureId('scn', 1),
  sceneTwo: fixtureId('scn', 2),

  beatSetup: fixtureId('bet', 1),
  beatCatalyst: fixtureId('bet', 2),
  beatTurn: fixtureId('bet', 3),
  beatStub: fixtureId('bet', 4),

  mahtab: fixtureId('ent', 1),
  roya: fixtureId('ent', 2),
  lighthouse: fixtureId('ent', 3),
  theTide: fixtureId('ent', 4),

  loopWhoDrowned: fixtureId('lop', 1),

  shotOne: fixtureId('sht', 1),
  shotTwo: fixtureId('sht', 2),
  shotThree: fixtureId('sht', 3),

  assetLighthouse: fixtureId('ast', 1),
  assetMahtab: fixtureId('ast', 2),
  assetTideLine: fixtureId('ast', 3),
  versionLighthouse: fixtureId('asv', 1),
  versionMahtab: fixtureId('asv', 2),
  versionTideLine: fixtureId('asv', 3),
  variantMahtabStorm: fixtureId('vnt', 1),
} as const;

// ── the bible ───────────────────────────────────────────────────────────────

const sceneOne = {
  id: FIXTURE_IDS.sceneOne,
  ordinal: 1,
  title: 'The keeper refuses the tide',
  summary:
    'Mahtab climbs to the lamp room to relight it and finds the tide has come inside ' +
    'the tower, standing in her daughter’s shape. She refuses to speak to it, and it ' +
    'answers anyway, in Roya’s voice, with something only Roya could know.',
  plannedSummary:
    'Open the series on the keeper alone with the thing she has been refusing, and end ' +
    'the scene with her certainty broken rather than with a threat.',
  locationRef: FIXTURE_IDS.lighthouse,
  presentEntityRefs: [FIXTURE_IDS.mahtab, FIXTURE_IDS.theTide],
  povEntityRef: FIXTURE_IDS.mahtab,
  goal: 'Relight the lamp before the fishing fleet reaches the shoal, and get back down.',
  conflict:
    'The tide is standing between her and the lamp, wearing her drowned daughter’s ' +
    'face, and every second she spends refusing to look at it is a second the fleet ' +
    'runs blind.',
  outcome:
    'She lights the lamp. She also hears the voice say the name of the boat Roya died ' +
    'on, which she has never told anyone, so she leaves the tower believing something ' +
    'she spent nine years refusing to believe.',
  storyInterval: {
    from: { ordinal: 1000, label: 'Nine years after the wreck, first night of the spring tide' },
    until: { ordinal: 1010 },
  },
  valueShift: { axis: 'certainty', from: 'positive', to: 'strong-negative' },
  beats: [
    {
      id: FIXTURE_IDS.beatSetup,
      ordinal: 1,
      title: 'The climb',
      summary:
        'Mahtab climbs the stair with the oil, counting the steps aloud the way she has ' +
        'every night since the wreck. The count is one step short.',
      plannedSummary: 'Establish the ritual, then break it by exactly one detail.',
      function: 'setup',
      movesEntityRefs: [FIXTURE_IDS.mahtab],
    },
    {
      id: FIXTURE_IDS.beatCatalyst,
      ordinal: 2,
      title: 'Something is already in the lamp room',
      summary:
        'The water on the lamp-room floor does not run downhill. Mahtab lights the lamp ' +
        'without looking at it.',
      plannedSummary: 'Put the impossible thing in the room and let her refuse to see it.',
      function: 'catalyst',
      movesEntityRefs: [FIXTURE_IDS.mahtab, FIXTURE_IDS.theTide],
    },
    {
      id: FIXTURE_IDS.beatTurn,
      ordinal: 3,
      title: 'It says the name of the boat',
      summary:
        'The tide speaks in Roya’s voice and names the Shabnam - a name Mahtab has never ' +
        'said out loud to anyone. She looks.',
      plannedSummary:
        'End on her looking. The refusal has to break from the inside, not be overpowered.',
      function: 'turn',
      movesEntityRefs: [FIXTURE_IDS.mahtab, FIXTURE_IDS.theTide, FIXTURE_IDS.roya],
    },
  ],
};

const episodeOne = {
  id: FIXTURE_IDS.episodeOne,
  ordinal: 1,
  title: 'The Shabnam',
  summary:
    'Nine years after the wreck that took her daughter, the keeper of the Bandar light ' +
    'is visited by something that knows what only the drowned know.',
  plannedSummary:
    'Episode one: establish the keeper, the light, the refusal, and end on the first ' +
    'crack in it. Do not explain what the tide is.',
  status: 'boarded',
  logline:
    'A lighthouse keeper who has refused to grieve must decide whether to answer a voice ' +
    'that knows her daughter’s last night.',
  coldOpen:
    'The wreck of the Shabnam, seen from underwater, in the four seconds before the lamp ' +
    'above it goes out.',
  cliffhanger: 'Mahtab looks at the thing in the lamp room, and the episode ends on her face.',
  opensLoops: [FIXTURE_IDS.loopWhoDrowned],
  closesLoops: [],
  acts: [
    {
      id: FIXTURE_IDS.actOne,
      ordinal: 1,
      title: 'The ritual and the break',
      summary:
        'The keeper’s nightly routine, established in full, and then broken by one step ' +
        'and one voice.',
      plannedSummary: 'One act. Get her up the tower and get her certainty taken away.',
      turningPoint: 'Mahtab looks at the tide. After this she cannot un-hear the name.',
      sequences: [
        {
          id: FIXTURE_IDS.sequenceOne,
          ordinal: 1,
          title: 'Up the tower',
          summary: 'The climb, the lamp room, the voice.',
          plannedSummary:
            'A single continuous ascent so the audience is trapped in the tower with her.',
          dramaticQuestion: 'Will she get the lamp lit without looking at what is in the room?',
          scenes: [sceneOne],
        },
      ],
    },
  ],
};

const episodeTwo = {
  id: FIXTURE_IDS.episodeTwo,
  ordinal: 2,
  title: 'What the fleet saw',
  summary:
    'Outlined only. The fleet comes in with a story about the light, and Mahtab has to ' +
    'decide who she lies to.',
  plannedSummary:
    'Episode two: move the problem out of the tower and into the village, and keep the ' +
    'tide off screen entirely.',
  status: 'outlined',
  logline: 'The keeper has to decide whether to tell the village what spoke to her.',
  opensLoops: [],
  closesLoops: [],
  acts: [
    {
      id: FIXTURE_IDS.actTwo,
      ordinal: 1,
      title: 'The harbour',
      summary: 'Outlined only.',
      plannedSummary: 'Get her among people who need the light to mean nothing.',
      turningPoint: 'She lies to the harbourmaster, and the lie is the first thing she owes.',
      sequences: [
        {
          id: FIXTURE_IDS.sequenceTwo,
          ordinal: 1,
          title: 'The fleet comes in',
          summary: 'Outlined only.',
          plannedSummary: 'One sequence, dawn, on the quay.',
          dramaticQuestion: 'Will she tell them what she heard?',
          scenes: [
            {
              id: FIXTURE_IDS.sceneTwo,
              ordinal: 1,
              title: 'On the quay',
              summary: 'Outlined only - not yet expanded to beats worth shooting.',
              plannedSummary: 'The harbourmaster thanks her for the light. She says nothing true.',
              locationRef: FIXTURE_IDS.lighthouse,
              presentEntityRefs: [FIXTURE_IDS.mahtab],
              povEntityRef: FIXTURE_IDS.mahtab,
              goal: 'Get through the morning without being asked why the lamp was late.',
              conflict: 'She is thanked, publicly, for the one night she cannot account for.',
              outcome: 'She accepts the thanks. The lie starts here.',
              storyInterval: { from: { ordinal: 1100 }, until: null },
              valueShift: { axis: 'honesty', from: 'neutral', to: 'negative' },
              beats: [
                {
                  id: FIXTURE_IDS.beatStub,
                  ordinal: 1,
                  title: 'The thanks',
                  summary: 'The harbourmaster thanks her in front of the fleet.',
                  plannedSummary: 'One beat placeholder until this episode is scripted.',
                  function: 'setup',
                  movesEntityRefs: [FIXTURE_IDS.mahtab],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** A two-episode series bible, as raw data awaiting `SeriesBible.parse`. */
export const twoEpisodeSeriesBible = {
  id: FIXTURE_IDS.series,
  title: 'The Tide That Remembers',
  summary:
    'A drowned coast, a keeper who will not grieve, and a sea that has started returning ' +
    'the dead one voice at a time.',
  plannedSummary: null,
  premise:
    'Nine years ago the Shabnam went down within sight of the Bandar light and Mahtab ' +
    'has kept the lamp lit every night since without once saying her daughter’s name. ' +
    'The tide has begun handing the drowned back - not their bodies, their voices - and ' +
    'it starts with her. It does not resolve in one episode because every voice the sea ' +
    'returns costs the village something it agreed, silently, to forget.',
  themes: ['inherited guilt', 'the price of being believed', 'what a coast agrees to forget'],
  tone: ['melancholy', 'salt-bitten', 'quiet', 'unforgiving'],
  genre: ['folk horror', 'mystery'],
  rulesOfTheWorld: [
    {
      scope: 'metaphysics',
      statement:
        'The sea returns only voices, never bodies, and only to someone who refused to ' +
        'say the drowned one’s name aloud.',
      inviolable: true,
    },
    {
      scope: 'physics',
      statement: 'The lamp cannot be lit from outside the tower, by anyone, ever.',
      inviolable: true,
      consequenceIfBroken:
        'If a scene ever needs the lamp lit remotely, the tower stops being a trap and ' +
        'the series loses its only reliable pressure.',
    },
  ],
  targetFormat: {
    masterAspect: '16:9',
    deliverables: ['16:9', '9:16', '1:1'],
    fps: 24,
    episodeDurationMs: 720_000,
  },
  canonPolicy: {
    freezeOnAir: true,
    retcon: 'reveal-only',
    strictness: 'strict',
  },
  styleBibleRef: FIXTURE_IDS.styleBible,
  seasons: [
    {
      id: FIXTURE_IDS.season,
      ordinal: 1,
      title: 'Spring tide',
      summary:
        'The season the coast stops being able to pretend, told across two episodes of ' +
        'the keeper losing her deniability.',
      plannedSummary:
        'Season one: one keeper, one light, and the first two voices the sea returns.',
      arc:
        'Opens with a coast that has agreed to forget the Shabnam and closes with the ' +
        'keeper unable to pretend she has, in front of witnesses.',
      episodes: [episodeOne, episodeTwo],
    },
  ],
};

// ── the shot list for the fully specified scene ─────────────────────────────

const sceneSpace = {
  size: { width: 2400, height: 2400 },
  masterAspect: '16:9',
  reframeTargets: ['16:9', '9:16', '1:1'],
};

/** Three shots covering the three beats of the fully specified scene. */
export const sceneOneShots = [
  {
    id: FIXTURE_IDS.shotOne,
    index: 0,
    durationMs: 4200,
    beatRef: FIXTURE_IDS.beatSetup,
    sceneSpace,
    camera: {
      framing: 'establishing',
      move: 'tilt-up',
      focusTarget: {
        instance: 'lighthouse',
        region: { x: 0.38, y: 0.1, width: 0.24, height: 0.7 },
        priority: 'must-keep',
      },
    },
    layout: [
      {
        z: 0,
        name: 'sky and sea',
        instances: [
          {
            instance: 'storm-sky',
            assetId: FIXTURE_IDS.assetLighthouse,
            assetVersionId: FIXTURE_IDS.versionLighthouse,
            transform: { position: { x: 1200, y: 700 }, scale: { x: 1.4, y: 1.4 } },
            depth: 12,
          },
        ],
      },
      {
        z: 1,
        name: 'the tower',
        instances: [
          {
            instance: 'lighthouse',
            assetId: FIXTURE_IDS.assetLighthouse,
            assetVersionId: FIXTURE_IDS.versionLighthouse,
            transform: { position: { x: 1200, y: 1500 } },
            depth: 1,
          },
        ],
      },
    ],
    blocking: [],
    dialogue: [],
    audio: {
      sfx: [{ key: 'sfx/sea/heavy-swell', startMs: 0, loop: true }],
      music: {
        key: 'music/tide-theme/low',
        action: 'start',
        mood: 'unresolved',
        intensity: 0.3,
      },
    },
    safeArea: { x: 0.12, y: 0.08, width: 0.76, height: 0.84 },
    focusTarget: {
      instance: 'lighthouse',
      region: { x: 0.38, y: 0.1, width: 0.24, height: 0.7 },
      priority: 'must-keep',
    },
  },
  {
    id: FIXTURE_IDS.shotTwo,
    index: 1,
    durationMs: 6800,
    beatRef: FIXTURE_IDS.beatCatalyst,
    sceneSpace: {
      ...sceneSpace,
      overrides: { '9:16': { x: 0.3, y: 0, width: 0.4, height: 1 } },
    },
    camera: {
      framing: 'medium',
      move: 'dolly-in',
      focusTarget: {
        instance: 'mahtab',
        region: { x: 0.3, y: 0.2, width: 0.4, height: 0.6 },
        priority: 'must-keep',
      },
    },
    layout: [
      {
        z: 0,
        name: 'lamp room',
        instances: [
          {
            instance: 'lamp-room',
            assetId: FIXTURE_IDS.assetLighthouse,
            assetVersionId: FIXTURE_IDS.versionLighthouse,
            transform: {},
            depth: 3,
            tint: '#8fa7b3',
          },
        ],
      },
      {
        z: 1,
        instances: [
          {
            instance: 'mahtab',
            assetId: FIXTURE_IDS.assetMahtab,
            assetVersionId: FIXTURE_IDS.versionMahtab,
            variantId: FIXTURE_IDS.variantMahtabStorm,
            transform: { position: { x: 1080, y: 1400 } },
            depth: 1,
          },
        ],
      },
    ],
    blocking: [
      {
        instance: 'mahtab',
        clip: 'light-the-lamp',
        startMs: 400,
        durationMs: 3600,
        loop: 'once',
        blendMs: 200,
      },
      {
        instance: 'mahtab',
        clip: 'breathe-shallow',
        startMs: 4000,
        durationMs: 2800,
        loop: 'loop',
        speed: 0.8,
        blendMs: 300,
      },
    ],
    dialogue: [
      {
        speakerRef: FIXTURE_IDS.mahtab,
        text: 'I am not talking to you.',
        subtext:
          'She is talking to it. Saying so out loud is the first concession, and she ' +
          'knows it while she says it.',
        delivery: {
          emotion: 'braced',
          intensity: 0.55,
          pace: 'measured',
          volume: 'low',
          note: 'Said to the lamp, not to the room.',
        },
        startMs: 3800,
        durationMs: 1600,
      },
    ],
    audio: {
      sfx: [{ key: 'sfx/water/floor-pool', startMs: 1200, gain: 0.4 }],
      music: {
        key: 'music/tide-theme/low',
        action: 'continue',
        mood: 'unresolved',
        intensity: 0.35,
      },
    },
    safeArea: { x: 0.14, y: 0.1, width: 0.72, height: 0.8 },
    focusTarget: {
      instance: 'mahtab',
      region: { x: 0.34, y: 0.18, width: 0.32, height: 0.56 },
      priority: 'must-keep',
    },
  },
  {
    id: FIXTURE_IDS.shotThree,
    index: 2,
    durationMs: 5200,
    beatRef: FIXTURE_IDS.beatTurn,
    sceneSpace,
    camera: {
      framing: 'extreme-close',
      move: 'static',
      focusTarget: {
        instance: null,
        region: { x: 0.35, y: 0.4, width: 0.3, height: 0.2 },
        priority: 'must-keep',
      },
    },
    layout: [
      {
        z: 0,
        name: 'the water line',
        instances: [
          {
            instance: 'tide-line',
            assetId: FIXTURE_IDS.assetTideLine,
            assetVersionId: FIXTURE_IDS.versionTideLine,
            transform: { position: { x: 1200, y: 1200 }, scale: { x: 2, y: 2 } },
            depth: 0.6,
            opacity: 0.85,
          },
        ],
      },
    ],
    blocking: [
      {
        instance: 'tide-line',
        clip: 'creep-uphill',
        startMs: 0,
        durationMs: 5200,
        loop: 'hold-last',
      },
    ],
    dialogue: [
      {
        speakerRef: FIXTURE_IDS.theTide,
        text: 'The Shabnam went down at the third bell, mother.',
        subtext:
          'Not a threat and not a plea - it is producing the one fact that makes ' +
          'refusing it impossible.',
        delivery: {
          emotion: 'tender',
          intensity: 0.3,
          pace: 'slow',
          volume: 'whisper',
        },
        startMs: 1400,
        durationMs: 2600,
        phonemes: [
          { phoneme: 'DH', startMs: 0, durationMs: 90 },
          { phoneme: 'AH', startMs: 90, durationMs: 120 },
        ],
      },
    ],
    audio: {
      sfx: [],
      music: { key: 'music/tide-theme/low', action: 'swell', mood: 'inevitable', intensity: 0.8 },
    },
    safeArea: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    focusTarget: {
      instance: 'tide-line',
      region: { x: 0.35, y: 0.4, width: 0.3, height: 0.2 },
      priority: 'must-keep',
    },
  },
];
