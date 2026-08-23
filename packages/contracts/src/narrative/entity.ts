/**
 * Entities - the nodes of the narrative graph.
 *
 * Every noun the story can refer to is an `Entity`: a shared envelope (who it is,
 * when it first appears, how much it matters) plus a payload typed by `kind`. The
 * split matters because the envelope is what retrieval, continuity and the asset
 * demand query all read, while the payload is what the generators write. Retrieval
 * never has to know what a `SubstancePayload` looks like.
 *
 * The payloads are deliberately opinionated rather than free-text blobs. A field the
 * schema names is a field the LLM is asked to fill and the continuity engine can
 * check; a field buried in prose is neither.
 */

import { z } from 'zod';

import {
  Label,
  NamedColor,
  NonNegativeInt,
  Prose,
  SemanticKey,
  SignedUnit,
  Slug,
  StoryInterval,
  StoryTime,
  Unit01,
} from '../primitives/common';
import { AssetId, BeatId, EntityId, SeriesId } from '../primitives/ids';

// ── kind and importance ─────────────────────────────────────────────────────

export const ENTITY_KINDS = [
  'character',
  'location',
  'prop',
  'faction',
  'creature',
  'concept',
  'event',
  'vehicle',
  'substance',
] as const;

export const EntityKind = z
  .enum(ENTITY_KINDS)
  .describe('What sort of thing this node is. Determines the shape of `payload`.');
export type EntityKind = z.infer<typeof EntityKind>;

export const IMPORTANCE_LEVELS = [
  'lead',
  'supporting',
  'recurring',
  'background',
  'mentioned',
] as const;

/**
 * How much screen time and budget this entity has earned.
 *
 * On the envelope rather than in a payload because three unrelated subsystems read
 * it: retrieval ranks leads above background, the asset planner generates a full
 * expression set for a lead and a single pose for a `mentioned` entity, and the
 * continuity checker escalates a contradiction about a lead to `error`.
 */
export const Importance = z.enum(IMPORTANCE_LEVELS).describe('Narrative weight of this entity.');
export type Importance = z.infer<typeof Importance>;

// ── links into the asset library ────────────────────────────────────────────

export const ASSET_LINK_ROLES = [
  'turnaround',
  'portrait',
  'expression',
  'pose',
  'wardrobe',
  'establishing',
  'detail',
  'insignia',
  'icon',
] as const;

export const AssetLinkRole = z.enum(ASSET_LINK_ROLES).describe('What this artwork is for.');
export type AssetLinkRole = z.infer<typeof AssetLinkRole>;

/**
 * A narrative-side pointer at the asset library.
 *
 * Keyed by `semanticKey` rather than by a minted asset id, because the graph has to
 * express *demand* before supply exists: "episode 4 needs
 * `char/kael/wardrobe-winter/angry`" is a statement the story engine makes long
 * before anything has been generated, and it is exactly the query that makes the cost
 * estimate exact before a dollar is spent (docs/02 §5). `assetId` fills in once the
 * registry has resolved or minted the artwork.
 */
export const EntityAssetLink = z.strictObject({
  semanticKey: SemanticKey.describe(
    'Library address of the artwork this entity needs, e.g. "char/kael/base".',
  ),
  role: AssetLinkRole,
  variantKey: Slug.optional().describe(
    'Which variant of the asset, e.g. "wardrobe-winter" or "angry". Omit for the base.',
  ),
  assetId: AssetId.optional().describe(
    'Set by the registry once the asset exists. Absent means "not generated yet".',
  ),
});
export type EntityAssetLink = z.infer<typeof EntityAssetLink>;

// ── reusable visual vocabulary ──────────────────────────────────────────────

/**
 * A named, described visual state of something.
 *
 * This is the unit the image pipeline generates from. "The character in different
 * states" is a product requirement, and it only works if each state carries the prose
 * that becomes its prompt - a bare enum of emotion words produces nine pictures of
 * the same neutral face.
 */
export const NamedVisualState = z.strictObject({
  slug: Slug.describe(
    'Stable key for this state. Becomes part of the asset variant key, so it must not change once artwork exists.',
  ),
  label: Label.describe('Human-readable name, e.g. "cornered".'),
  description: Prose.describe(
    'What the state LOOKS like - brow, mouth, shoulders, hands, weight. This text is the generation prompt, so describe the body, not the feeling.',
  ),
  intensity: Unit01.default(0.7).describe(
    'How far to push the state. 0 is a suggestion, 1 is theatrical.',
  ),
});
export type NamedVisualState = z.infer<typeof NamedVisualState>;

/**
 * One outfit, bounded in story time.
 *
 * Outfits are the most common reason a character needs more than one set of artwork
 * across a series, so the validity interval is data rather than a note in the bible:
 * the resolver serves the winter set for beats inside its window and the default set
 * outside it, with no manual bookkeeping.
 */
export const WardrobeSet = z.strictObject({
  slug: Slug.describe(
    'The outfit id, e.g. "wardrobe-winter". Used verbatim as the asset variant key.',
  ),
  label: Label.describe('Human-readable name of the outfit.'),
  description: Prose.describe(
    'Garment by garment, including fabric, wear, and how it sits on the body.',
  ),
  validity: StoryInterval.describe(
    'When in the story this outfit is worn. `from: null` means "from the beginning", `until: null` means "still worn".',
  ),
  palette: z
    .array(NamedColor)
    .max(12)
    .default([])
    .describe('The outfit colours, so the style engine can check them against the bible.'),
});
export type WardrobeSet = z.infer<typeof WardrobeSet>;

// ── character ───────────────────────────────────────────────────────────────

export const CharacterIdentity = z.strictObject({
  age: Label.describe('Age as the audience would state it, e.g. "34", "late teens", "ageless".'),
  /**
   * Kept alongside `age` because the continuity rule pass does age arithmetic
   * (docs/02 §4) and cannot do arithmetic on "late teens". Absent for ageless beings,
   * which is a meaningful answer rather than a missing one.
   */
  ageYears: NonNegativeInt.optional().describe(
    'Numeric age in years at `firstAppearance`, when the fiction has one. Omit for ageless beings.',
  ),
  gender: Label.describe('Free text: fiction is allowed genders the schema has not heard of.'),
  species: Label.default('human').describe('Species or people, e.g. "human", "tideborn".'),
  occupation: Label.describe('What they do, as another character would say it.'),
  origin: Label.describe('Where or what they come from - place, house, culture.'),
});
export type CharacterIdentity = z.infer<typeof CharacterIdentity>;

/**
 * Five bipolar temperament axes.
 *
 * `SignedUnit`, not `Unit01`, and the choice is load-bearing. Each axis has a real
 * opposite pole (cold/warm, deferring/dominant, placid/volatile, closed/open,
 * heedless/conscientious) and a real neutral, so zero carries meaning instead of
 * being the arbitrary midpoint 0.5 that every reader - the LLM filling this in
 * included - would have to remember. The sign alone answers the question the actor
 * agent and the rig parameters actually branch on ("warm or cold?"). It also makes
 * temperament read like `Relation.strength`, so one rule holds across the package:
 * signed means bipolar. Magnitudes whose floor is genuinely nothing - `energy`,
 * `gestureFrequency` - stay `Unit01` by the same rule.
 */
export const Temperament = z.strictObject({
  warmth: SignedUnit.default(0).describe(
    '-1 cold and withholding, 0 even, +1 openly affectionate.',
  ),
  dominance: SignedUnit.default(0).describe('-1 defers by reflex, 0 even, +1 takes the room.'),
  volatility: SignedUnit.default(0).describe(
    '-1 unshakeable, 0 even, +1 detonates without warning.',
  ),
  openness: SignedUnit.default(0).describe('-1 suspicious of the new, 0 even, +1 chases novelty.'),
  conscientiousness: SignedUnit.default(0).describe(
    '-1 heedless, 0 even, +1 rigorous and dutiful.',
  ),
});
export type Temperament = z.infer<typeof Temperament>;

/** The classic dramatic engine, plus the trait lists the actor agent is held to. */
export const CharacterPsych = z.strictObject({
  want: Prose.describe('The conscious, external goal they chase. What they would say out loud.'),
  need: Prose.describe(
    'The unconscious truth they must accept to be whole. Usually contradicts the want.',
  ),
  wound: Prose.describe('The past injury that still governs their behaviour.'),
  lie: Prose.describe('The false belief the wound left behind. The arc is the death of this lie.'),
  ghost: Prose.describe('The specific event that inflicted the wound.'),
  virtues: z.array(Label).max(8).default([]).describe('What is genuinely admirable in them.'),
  flaws: z.array(Label).max(8).default([]).describe('What costs them, repeatedly.'),
  fears: z.array(Label).max(8).default([]).describe('What they will bend the plot to avoid.'),
  values: z.array(Label).max(8).default([]).describe('What they will not trade away.'),
  temperament: Temperament,
});
export type CharacterPsych = z.infer<typeof CharacterPsych>;

export const VOICE_REGISTERS = [
  'formal',
  'neutral',
  'colloquial',
  'vulgar',
  'archaic',
  'technical',
  'poetic',
] as const;
export const VoiceRegister = z.enum(VOICE_REGISTERS);
export type VoiceRegister = z.infer<typeof VoiceRegister>;

export const VERBOSITY_LEVELS = ['terse', 'clipped', 'measured', 'expansive', 'rambling'] as const;
export const Verbosity = z.enum(VERBOSITY_LEVELS);
export type Verbosity = z.infer<typeof Verbosity>;

export const PROFANITY_LEVELS = ['none', 'mild', 'frequent', 'inventive'] as const;
export const ProfanityLevel = z.enum(PROFANITY_LEVELS);
export type ProfanityLevel = z.infer<typeof ProfanityLevel>;

export const SENTENCE_RHYTHMS = [
  'staccato',
  'balanced',
  'flowing',
  'fragmented',
  'looping',
] as const;
export const SentenceRhythm = z.enum(SENTENCE_RHYTHMS);
export type SentenceRhythm = z.infer<typeof SentenceRhythm>;

export const HUMOUR_MODES = [
  'none',
  'dry',
  'sardonic',
  'absurd',
  'self-deprecating',
  'slapstick',
  'gallows',
  'wordplay',
] as const;
export const HumourMode = z.enum(HUMOUR_MODES);
export type HumourMode = z.infer<typeof HumourMode>;

/**
 * How this character sounds. Binding on the actor agent.
 *
 * Exists because the most reliable tell of LLM-written serial fiction is that every
 * character speaks in the same competent middle register. Making voice data rather
 * than vibe gives the dialogue pass something it can be held to, and gives a reviewer
 * something to point at when a line is wrong.
 */
export const CharacterVoice = z.strictObject({
  register: VoiceRegister.default('neutral').describe('The default level of diction.'),
  verbosity: Verbosity.default('measured').describe('How much they say when they could say less.'),
  idiolect: z
    .array(Label)
    .max(16)
    .default([])
    .describe('Words, constructions and metaphor sources that are theirs, e.g. "sailing terms".'),
  verbalTics: z
    .array(Label)
    .max(12)
    .default([])
    .describe('Repeated verbal habits, e.g. "answers a question with a question".'),
  profanity: ProfanityLevel.default('none'),
  sentenceRhythm: SentenceRhythm.default('balanced'),
  humourMode: HumourMode.default('none'),
  silenceHabits: Prose.describe(
    'When and how they go quiet, and what the silence means. Half of a voice is what it withholds.',
  ),
});
export type CharacterVoice = z.infer<typeof CharacterVoice>;

export const CharacterArc = z.strictObject({
  startState: Prose.describe('Who they are when we meet them, stated as behaviour not adjectives.'),
  endState: Prose.describe('Who they are when we leave them. If it equals `startState`, say so.'),
  turningPoints: z
    .array(BeatId)
    .max(64)
    .default([])
    .describe('The beats where the arc actually moves, in story order.'),
});
export type CharacterArc = z.infer<typeof CharacterArc>;

export const BUILDS = [
  'slight',
  'lean',
  'athletic',
  'stocky',
  'heavy',
  'towering',
  'childlike',
] as const;
export const Build = z.enum(BUILDS);
export type Build = z.infer<typeof Build>;

export const PropAffinity = z.strictObject({
  entityId: EntityId.optional().describe(
    'The prop entity, when the object is modelled as one. Omit for generic objects.',
  ),
  label: Label.describe('What the object is, e.g. "her father\'s tally-knife".'),
  note: Prose.describe('What the object does for them, and when they reach for it.'),
});
export type PropAffinity = z.infer<typeof PropAffinity>;

/**
 * Appearance, derived from psychology rather than invented beside it.
 *
 * `expressionSet` and `poseSet` are why this is structured at all: the product
 * promise is "the character, in the states the story needs", and each state has to
 * arrive as a named slug (so the asset key is stable across episodes) carrying prose
 * (so the image model has something to render).
 */
export const CharacterVisual = z.strictObject({
  silhouetteNote: Prose.describe(
    'What makes them readable as a solid black shape at thumbnail size. One distinctive contour, not a list.',
  ),
  build: Build,
  height: Label.describe('Height as the shot planner needs it, e.g. "a head above most", "165cm".'),
  palette: z
    .array(NamedColor)
    .max(12)
    .default([])
    .describe('The colours that are theirs, with roles.'),
  distinguishingMarks: z
    .array(Label)
    .max(12)
    .default([])
    .describe('Scars, tattoos, prosthetics - anything the audience identifies them by.'),
  wardrobe: z
    .array(WardrobeSet)
    .max(32)
    .default([])
    .describe('Every outfit, each bounded in story time.'),
  expressionSet: z
    .array(NamedVisualState)
    .max(32)
    .default([])
    .describe('The faces this character needs. Each entry becomes one generated variant.'),
  poseSet: z
    .array(NamedVisualState)
    .max(32)
    .default([])
    .describe('The body attitudes this character needs. Each entry becomes one generated variant.'),
  propAffinities: z
    .array(PropAffinity)
    .max(16)
    .default([])
    .describe('Objects they habitually carry or reach for.'),
});
export type CharacterVisual = z.infer<typeof CharacterVisual>;

export const GAIT_STYLES = [
  'glide',
  'stride',
  'trudge',
  'bounce',
  'prowl',
  'shuffle',
  'march',
  'limp',
  'drift',
] as const;
export const GaitStyle = z.enum(GAIT_STYLES);
export type GaitStyle = z.infer<typeof GaitStyle>;

export const POSTURES = ['upright', 'slouched', 'coiled', 'rigid', 'loose', 'hunched'] as const;
export const Posture = z.enum(POSTURES);
export type Posture = z.infer<typeof Posture>;

/**
 * How THIS character moves. Feeds the rig's clip parameters directly.
 *
 * The counterpart to `voice`: the other reliable tell of generated animation is that
 * every body moves on the same curves. The choreographer reads these as numbers, not
 * as inspiration.
 */
export const MotionSignature = z.strictObject({
  gaitStyle: GaitStyle.default('stride'),
  posture: Posture.default('upright'),
  gestureFrequency: Unit01.default(0.5).describe(
    '0 keeps the hands still, 1 talks with the whole body.',
  ),
  energy: Unit01.default(0.5).describe('0 conserves every movement, 1 spends freely.'),
  idleBehaviour: Prose.describe(
    'What the body does when nothing is happening. The rig builds its idle clip from this.',
  ),
  tellOnLying: Prose.describe(
    'The involuntary movement that gives them away. The audience learns it before the other characters do.',
  ),
});
export type MotionSignature = z.infer<typeof MotionSignature>;

export const KNOWLEDGE_SCOPES = ['omniscient', 'limited'] as const;
export const KnowledgeScope = z.enum(KNOWLEDGE_SCOPES);
export type KnowledgeScope = z.infer<typeof KnowledgeScope>;

/**
 * A character sheet, psychology first.
 *
 * Appearance is derived from `psych`, not chosen beside it - that ordering is what
 * makes a cast readable in silhouette and consistent in behaviour rather than a set
 * of unrelated portraits.
 */
export const CharacterPayload = z.strictObject({
  identity: CharacterIdentity,
  psych: CharacterPsych,
  voice: CharacterVoice,
  arc: CharacterArc,
  visual: CharacterVisual,
  motionSignature: MotionSignature,
  knowledgeScope: KnowledgeScope.default('limited').describe(
    'Whether this character sees the whole world model or only what the epistemic graph grants them. Almost always "limited": "omniscient" switches off dramatic irony for this character.',
  ),
});
export type CharacterPayload = z.infer<typeof CharacterPayload>;

// ── location ────────────────────────────────────────────────────────────────

export const LOCATION_TYPES = [
  'interior',
  'exterior',
  'mixed',
  'liminal',
  'vehicle-interior',
  'abstract',
] as const;
export const LocationType = z.enum(LOCATION_TYPES);
export type LocationType = z.infer<typeof LocationType>;

export const LOCATION_SCALES = [
  'room',
  'building',
  'street',
  'district',
  'settlement',
  'region',
  'world',
  'realm',
] as const;
export const LocationScale = z.enum(LOCATION_SCALES);
export type LocationScale = z.infer<typeof LocationScale>;

export const TIMES_OF_DAY = [
  'dawn',
  'morning',
  'midday',
  'afternoon',
  'dusk',
  'night',
  'deep-night',
] as const;
export const TimeOfDay = z.enum(TIMES_OF_DAY);
export type TimeOfDay = z.infer<typeof TimeOfDay>;

export const WEATHER_STATES = [
  'clear',
  'overcast',
  'rain',
  'storm',
  'snow',
  'fog',
  'wind',
  'heat-haze',
] as const;
export const Weather = z.enum(WEATHER_STATES);
export type Weather = z.infer<typeof Weather>;

/**
 * A place.
 *
 * The three variant lists are not decoration: they are the multiplicands of the
 * background asset demand for this location, which is what turns "this episode needs
 * fourteen backgrounds" into a graph query instead of a guess. `parentLocation` gives
 * the containment tree the `located-in` rule pass walks when it asks whether two
 * characters could plausibly be in the same place.
 */
export const LocationPayload = z.strictObject({
  locationType: LocationType,
  scale: LocationScale,
  parentLocation: EntityId.nullable()
    .default(null)
    .describe('The location entity that contains this one. `null` for a top-level place.'),
  establishingNote: Prose.describe(
    'The wide shot in one paragraph: what the audience must read in two seconds.',
  ),
  architecture: Prose.describe('Materials, period, state of repair, who built it and why.'),
  soundscape: z
    .array(Label)
    .max(12)
    .default([])
    .describe('What it sounds like. Drives the ambient audio bed.'),
  palette: z.array(NamedColor).max(12).default([]),
  timeOfDayVariants: z
    .array(TimeOfDay)
    .max(7)
    .default([])
    .describe('Lighting states this location must be generated in.'),
  weatherVariants: z
    .array(Weather)
    .max(8)
    .default([])
    .describe('Weather states this location must be generated in.'),
  moodVariants: z
    .array(NamedVisualState)
    .max(16)
    .default([])
    .describe(
      'The same place under different dramatic pressure - the square at festival, the square after. Each entry becomes one generated variant.',
    ),
  affordances: z
    .array(Label)
    .max(16)
    .default([])
    .describe('What characters can do here. Blocking is planned against this list.'),
});
export type LocationPayload = z.infer<typeof LocationPayload>;

// ── prop ────────────────────────────────────────────────────────────────────

export const PROP_SCALES = [
  'handheld',
  'worn',
  'furniture',
  'architectural',
  'vehicle-sized',
  'monumental',
] as const;
export const PropScale = z.enum(PROP_SCALES);
export type PropScale = z.infer<typeof PropScale>;

/**
 * An object.
 *
 * `riggable` is the field that decides money: a rigged prop gets bones, an
 * articulation pass and clips, and costs several times what a flat prop costs. It is
 * therefore refined rather than trusted - declaring a prop riggable without saying
 * what articulates leaves the rig builder nothing to fit, and the failure would
 * surface halfway through a paid pipeline run instead of at the boundary.
 */
export const PropPayload = z
  .strictObject({
    scale: PropScale.describe(
      'Physical size class. Sets the resolution the artwork is generated at.',
    ),
    materials: z
      .array(Label)
      .min(1)
      .max(8)
      .describe('What it is made of, most prominent first. Drives shading and sound.'),
    riggable: z
      .boolean()
      .default(false)
      .describe(
        'True when some part must move independently - a door, a lid, a blade that leaves its sheath.',
      ),
    articulation: Prose.optional().describe(
      'Required when `riggable`: which parts move, around what pivot, through what range.',
    ),
    isUnique: z
      .boolean()
      .default(true)
      .describe(
        'False for set dressing that may recur as generic copies. True for the one sword that matters.',
      ),
    significance: Prose.describe('Why the story cares about this object.'),
    palette: z.array(NamedColor).max(8).default([]),
    conditionVariants: z
      .array(NamedVisualState)
      .max(12)
      .default([])
      .describe(
        'States it is seen in - pristine, notched, burnt. Each entry becomes one generated variant.',
      ),
  })
  .superRefine((prop, ctx) => {
    if (prop.riggable && prop.articulation === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['articulation'],
        message: 'a riggable prop must describe what articulates',
      });
    }
  });
export type PropPayload = z.infer<typeof PropPayload>;

// ── faction ─────────────────────────────────────────────────────────────────

export const FACTION_TYPES = [
  'family',
  'guild',
  'order',
  'army',
  'cult',
  'company',
  'tribe',
  'crew',
  'government',
  'criminal',
] as const;
export const FactionType = z.enum(FACTION_TYPES);
export type FactionType = z.infer<typeof FactionType>;

export const FACTION_HIERARCHIES = [
  'flat',
  'council',
  'strict-hierarchy',
  'cell',
  'charismatic-leader',
] as const;
export const FactionHierarchy = z.enum(FACTION_HIERARCHIES);
export type FactionHierarchy = z.infer<typeof FactionHierarchy>;

/**
 * A group that acts as one.
 *
 * An entity rather than a tag, so a faction can hold relations of its own: it can
 * `command` a character, `own` a location and `fear` another faction, and the
 * epistemic layer can then ask what an organisation collectively knows - which is a
 * different and usually more dangerous question than what its leader knows.
 */
export const FactionPayload = z.strictObject({
  factionType: FactionType,
  ideology: Prose.describe('What they believe, stated the way they would state it.'),
  goal: Prose.describe("What they are trying to achieve inside the story's timeframe."),
  methods: Prose.describe('What they are willing to do to get it. This is the interesting field.'),
  hierarchy: FactionHierarchy.default('strict-hierarchy'),
  ranks: z.array(Label).max(16).default([]).describe('Rank names, most senior first.'),
  memberEstimate: NonNegativeInt.optional().describe(
    'Rough headcount, when the fiction fixes one.',
  ),
  seat: EntityId.nullable().default(null).describe('The location entity they operate from.'),
  reputation: SignedUnit.default(0).describe(
    '-1 openly reviled, 0 unremarkable, +1 widely admired. Public perception, not the truth.',
  ),
  insignia: Prose.describe(
    'The mark, banner or uniform detail that identifies them on screen. Generated once, reused everywhere.',
  ),
  palette: z.array(NamedColor).max(8).default([]),
});
export type FactionPayload = z.infer<typeof FactionPayload>;

// ── creature ────────────────────────────────────────────────────────────────

export const CREATURE_SIZE_CLASSES = [
  'tiny',
  'small',
  'medium',
  'large',
  'huge',
  'colossal',
] as const;
export const CreatureSizeClass = z.enum(CREATURE_SIZE_CLASSES);
export type CreatureSizeClass = z.infer<typeof CreatureSizeClass>;

export const CREATURE_INTELLIGENCE_LEVELS = ['mindless', 'animal', 'cunning', 'sapient'] as const;
export const CreatureIntelligence = z.enum(CREATURE_INTELLIGENCE_LEVELS);
export type CreatureIntelligence = z.infer<typeof CreatureIntelligence>;

/**
 * A non-person living thing.
 *
 * Separate from `character` because the rig archetype differs - a quadruped is not a
 * biped with extra bones - and because a creature usually has no psychology worth
 * modelling. A creature that acquires one should be promoted to a character rather
 * than have this payload grow to meet it.
 */
export const CreaturePayload = z.strictObject({
  species: Label.describe('What it is called, in-world.'),
  sizeClass: CreatureSizeClass,
  intelligence: CreatureIntelligence.default('animal').describe(
    'Anything above "animal" needs epistemic edges of its own.',
  ),
  anatomy: Prose.describe(
    'Limb count, symmetry, how it is put together. The rig archetype is chosen from this.',
  ),
  silhouetteNote: Prose.describe('What makes it readable as a shape before it is lit.'),
  gait: GaitStyle.default('prowl').describe('How it moves when it is not hurrying.'),
  movementNote: Prose.describe(
    'Locomotion in detail - what leads, what drags, what it does when startled.',
  ),
  hostility: SignedUnit.default(0).describe(
    '-1 seeks out people for company, 0 indifferent, +1 hunts them.',
  ),
  abilities: z.array(Label).max(12).default([]).describe('What it can do that a person cannot.'),
  vocalisations: z.array(Label).max(8).default([]).describe('The sounds it makes, and when.'),
  palette: z.array(NamedColor).max(8).default([]),
  stateVariants: z
    .array(NamedVisualState)
    .max(16)
    .default([])
    .describe('Calm, threatened, feeding, wounded. Each entry becomes one generated variant.'),
});
export type CreaturePayload = z.infer<typeof CreaturePayload>;

// ── concept ─────────────────────────────────────────────────────────────────

export const CONCEPT_TYPES = [
  'magic-system',
  'technology',
  'law',
  'tradition',
  'religion',
  'prophecy',
  'theme',
  'language',
  'currency',
  'disease',
] as const;
export const ConceptType = z.enum(CONCEPT_TYPES);
export type ConceptType = z.infer<typeof ConceptType>;

export const CONCEPT_DIFFUSION_LEVELS = ['common', 'specialist', 'secret'] as const;
export const ConceptDiffusion = z.enum(CONCEPT_DIFFUSION_LEVELS);
export type ConceptDiffusion = z.infer<typeof ConceptDiffusion>;

/**
 * An abstraction the story treats as real: a magic system, a law, a prophecy.
 *
 * `rules` and `costs` are arrays of hard constraints rather than one block of prose
 * because they are the rules-of-the-world the writer may not break, and a continuity
 * finding has to quote the specific rule that was broken. `diffusion` stops the whole
 * cast from casually knowing a secret system: it seeds the epistemic layer's default
 * for this concept.
 */
export const ConceptPayload = z.strictObject({
  conceptType: ConceptType,
  definition: Prose.describe('What it is, in one paragraph an outsider would understand.'),
  rules: z
    .array(Prose)
    .max(24)
    .default([])
    .describe('Hard constraints. Each one is quotable by the continuity checker.'),
  costs: z
    .array(Prose)
    .max(16)
    .default([])
    .describe('What using or breaking it costs. A system without costs generates no drama.'),
  manifestation: Prose.describe(
    'How it looks and sounds on screen. This is the FX brief for the whole series.',
  ),
  diffusion: ConceptDiffusion.default('common').describe(
    'How widely it is known. "secret" means a character needs an explicit `knows` edge before they may act on it.',
  ),
  palette: z.array(NamedColor).max(8).default([]),
});
export type ConceptPayload = z.infer<typeof ConceptPayload>;

// ── event ───────────────────────────────────────────────────────────────────

export const EVENT_TYPES = [
  'battle',
  'ceremony',
  'disaster',
  'discovery',
  'betrayal',
  'journey',
  'trial',
  'founding',
  'death',
  'birth',
] as const;
export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

/**
 * A happening the cast refers to as a thing.
 *
 * A node rather than a beat, because the interesting ones happened before the series
 * started and are known to different characters in different, incompatible versions.
 * Only the epistemic layer can express that, and it can only express it about a node.
 */
export const EventPayload = z.strictObject({
  eventType: EventType,
  occurredAt: StoryTime.describe('When it happened in the fiction, which may be long before E01.'),
  place: EntityId.nullable().default(null).describe('The location entity where it happened.'),
  participants: z.array(EntityId).max(64).default([]),
  account: Prose.describe('What actually happened. The truth, regardless of who believes it.'),
  consequences: Prose.describe('What the world is like afterwards that it was not before.'),
  disputed: z
    .boolean()
    .default(false)
    .describe('True when characters hold materially different versions of it. Seeds belief edges.'),
});
export type EventPayload = z.infer<typeof EventPayload>;

// ── vehicle ─────────────────────────────────────────────────────────────────

export const VEHICLE_TYPES = ['land', 'sea', 'air', 'space', 'mount-drawn', 'other'] as const;
export const VehicleType = z.enum(VEHICLE_TYPES);
export type VehicleType = z.infer<typeof VehicleType>;

/**
 * Something the cast travels in.
 *
 * Not a prop: a vehicle articulates by default, contains people (so it takes part in
 * `located-in` queries as a container) and needs interior artwork as well as
 * exterior.
 */
export const VehiclePayload = z.strictObject({
  vehicleType: VehicleType,
  propulsion: Label.describe('What moves it, e.g. "eight oars", "a bound wind".'),
  capacity: NonNegativeInt.optional().describe('How many it carries, when the fiction fixes it.'),
  riggable: z
    .boolean()
    .default(true)
    .describe('Vehicles almost always articulate. False only for a static wreck.'),
  materials: z.array(Label).min(1).max(8),
  interiorLocation: EntityId.nullable()
    .default(null)
    .describe('The location entity for its inside, when scenes play out in there.'),
  palette: z.array(NamedColor).max(8).default([]),
  conditionVariants: z.array(NamedVisualState).max(12).default([]),
});
export type VehiclePayload = z.infer<typeof VehiclePayload>;

// ── substance ───────────────────────────────────────────────────────────────

export const SUBSTANCE_TYPES = [
  'metal',
  'mineral',
  'liquid',
  'gas',
  'organic',
  'fabric',
  'magical',
  'synthetic',
] as const;
export const SubstanceType = z.enum(SUBSTANCE_TYPES);
export type SubstanceType = z.infer<typeof SubstanceType>;

export const RARITY_LEVELS = ['ubiquitous', 'common', 'uncommon', 'rare', 'unique'] as const;
export const Rarity = z.enum(RARITY_LEVELS);
export type Rarity = z.infer<typeof Rarity>;

/**
 * A material the plot turns on: the ore, the poison, the dye only one house can make.
 *
 * Separate from `prop` because a substance is a mass noun - it is owned, traded and
 * sought in quantities rather than as one object - and because its art brief is about
 * how it behaves under light rather than what shape it is.
 */
export const SubstancePayload = z.strictObject({
  substanceType: SubstanceType,
  rarity: Rarity.default('common'),
  appearance: Prose.describe(
    'How it reads on screen - colour, translucency, how it moves and catches light.',
  ),
  properties: z
    .array(Label)
    .max(12)
    .default([])
    .describe('What it does. One capability per entry.'),
  hazard: Prose.optional().describe('How it harms, if it does.'),
  palette: z.array(NamedColor).max(8).default([]),
});
export type SubstancePayload = z.infer<typeof SubstancePayload>;

// ── the envelope and the union ──────────────────────────────────────────────

/**
 * The fields every entity has, whatever it is.
 *
 * Everything here is read by machinery that must not care about `kind`: retrieval
 * ranks on `importance`, the timeline orders on `firstAppearance`, semantic search
 * reads `embedding`, and the asset planner reads `assetRefs`. Payload-specific data
 * belongs in the payload precisely so that this list stays short enough to load for
 * every node in the graph at once.
 */
export const EntityEnvelope = z.strictObject({
  id: EntityId,
  seriesId: SeriesId,
  canonicalName: Label.describe('The name the series bible uses. One name, chosen once.'),
  aliases: z
    .array(Label)
    .max(32)
    .default([])
    .describe(
      'Every other name this is called by, including what individual characters call it. The extractor resolves mentions against this list.',
    ),
  summary: Prose.describe(
    'One paragraph, regenerated whenever the entity changes. This is what retrieval hands the writer when the full sheet will not fit the budget.',
  ),
  firstAppearance: StoryTime.describe('The earliest story time at which this exists on screen.'),
  importance: Importance.default('background'),
  assetRefs: z.array(EntityAssetLink).max(256).default([]),
  embedding: z
    .array(z.number())
    .max(4096)
    .default([])
    .describe('Machine-populated semantic vector. Leave it empty; the extractor fills it.'),
});
export type EntityEnvelope = z.infer<typeof EntityEnvelope>;

/**
 * A node in the world model.
 *
 * Discriminated on `kind` so that narrowing on `kind` gives the right `payload` type
 * with no cast and no runtime check, and so that a payload sent under the wrong kind
 * is rejected at the boundary rather than surviving as a half-populated object three
 * layers in. The union is exhaustive over `EntityKind` by construction - adding a
 * kind without giving it a payload does not compile.
 */
export const Entity = z.discriminatedUnion('kind', [
  EntityEnvelope.extend({ kind: z.literal('character'), payload: CharacterPayload }),
  EntityEnvelope.extend({ kind: z.literal('location'), payload: LocationPayload }),
  EntityEnvelope.extend({ kind: z.literal('prop'), payload: PropPayload }),
  EntityEnvelope.extend({ kind: z.literal('faction'), payload: FactionPayload }),
  EntityEnvelope.extend({ kind: z.literal('creature'), payload: CreaturePayload }),
  EntityEnvelope.extend({ kind: z.literal('concept'), payload: ConceptPayload }),
  EntityEnvelope.extend({ kind: z.literal('event'), payload: EventPayload }),
  EntityEnvelope.extend({ kind: z.literal('vehicle'), payload: VehiclePayload }),
  EntityEnvelope.extend({ kind: z.literal('substance'), payload: SubstancePayload }),
]);
export type Entity = z.infer<typeof Entity>;

/** Narrowed aliases, so a call site can say what it means without re-deriving it. */
export type CharacterEntity = Extract<Entity, { kind: 'character' }>;
export type LocationEntity = Extract<Entity, { kind: 'location' }>;
export type PropEntity = Extract<Entity, { kind: 'prop' }>;
