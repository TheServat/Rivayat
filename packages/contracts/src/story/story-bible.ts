/**
 * The story bible - the whole work as one tree.
 *
 * `Series → Season → Episode → Act → Sequence → Scene → Beat`, exactly the hierarchy in
 * docs/02 §1. Seven levels looks like a lot until you try to generate a ten-episode
 * series in one call and watch episode 7 forget who the antagonist was. DOC (prior-art
 * §B) is the fix: expand exactly one level at a time, and bind each expansion to what
 * its parent said it should be. That binding is `plannedSummary` - every node carries
 * the parent's instruction verbatim alongside the content it actually produced, so a
 * critique pass can ask "did this scene do the job the sequence assigned it?" without
 * re-reading the whole tree. DOME adds the other half: for any episode that has not
 * aired, the plan itself may be rewritten as memory accumulates.
 *
 * One deliberate departure from the diagram in docs/02 §1, which draws `SeriesBible` as
 * a sibling of `Season[]` under a `Series` node: here the bible *is* the root and holds
 * the seasons. A DOC expansion has to validate a child against its parent, and a root
 * that is split across two documents gives it two parents to reconcile. One document,
 * one root.
 */

import { err, ok, type Result } from '@rv/shared-kernel';
import { z } from 'zod';

import {
  Fps,
  IsoInstant,
  Label,
  Millis,
  NonEmptyString,
  PositiveInt,
  Prose,
  StoryInterval,
  Unit01,
} from '../primitives/common';
import {
  ActId,
  BeatId,
  EntityId,
  EpisodeId,
  OpenLoopId,
  SceneId,
  SeasonId,
  SequenceId,
  SeriesId,
  StyleBibleId,
} from '../primitives/ids';

// ── delivery format ─────────────────────────────────────────────────────────

/**
 * The four frames anything ships in.
 *
 * They are declared on the bible rather than discovered at render time because the
 * shot composer has to know, while it is placing assets, which crops it is committing
 * to keep legible. See `shot.ts` for how one composition satisfies all of them.
 *
 * Deliberately **not** `render/format.ts`'s `FormatAspectRatio`, and the two must stay
 * separate. `FormatAspectRatio` is an open `width:height` string, because
 * `DeliveryPlatform: 'custom'` exists and a platform may state any ratio it likes. This
 * is the closed set *we* compose and reframe for, and closed is the point: it is a
 * shot's obligation list and an enum in the JSON Schema a model fills, so a fifth
 * aspect has to be a decision rather than a typo.
 *
 * Separate does not mean unrelated. Every member here has to be *deliverable*, which
 * means at least one entry of `FORMAT_PRESETS` must actually ship in it - otherwise a
 * shot can be obliged to stay legible in a crop nothing encodes. Nothing in either type
 * can express that, so it is asserted instead: see "every authoring aspect is realised
 * by at least one delivery preset" in `render/format.spec.ts`, which also recomputes
 * each preset's declared ratio from its own pixel dimensions.
 */
export const DELIVERY_ASPECTS = ['16:9', '9:16', '1:1', '4:5'] as const;

export const DeliveryAspect = z.enum(DELIVERY_ASPECTS);
export type DeliveryAspect = z.infer<typeof DeliveryAspect>;

export const TargetFormat = z
  .strictObject({
    masterAspect: DeliveryAspect.default('16:9').describe(
      'The aspect the series is composed for. Every other deliverable is derived from ' +
        'this one by reframing, never by recomposing.',
    ),
    deliverables: z
      .array(DeliveryAspect)
      .min(1)
      .describe(
        'Every aspect this series must ship in. Include the master aspect. Listing an ' +
          'aspect here obliges every shot to declare a safe area that survives that crop.',
      ),
    fps: Fps.describe('Frame rate of the master render. 24 for film feel, 30 for social.'),
    episodeDurationMs: PositiveInt.describe(
      'Target runtime of one episode in milliseconds. Must be greater than zero.',
    ),
  })
  .superRefine((format, ctx) => {
    // "Include the master aspect" is stated in the field description above, which is
    // all the model filling this in ever sees - and a description is advice, not a
    // constraint. A master aspect that is not itself a deliverable means every shot is
    // composed for a crop the series never ships.
    if (format.deliverables.length > 0 && !format.deliverables.includes(format.masterAspect)) {
      ctx.addIssue({
        code: 'custom',
        path: ['deliverables'],
        message: `deliverables must include the master aspect ${format.masterAspect}`,
      });
    }
    if (new Set(format.deliverables).size !== format.deliverables.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['deliverables'],
        message: 'deliverables must not repeat an aspect',
      });
    }
  });
export type TargetFormat = z.infer<typeof TargetFormat>;

// ── canon ───────────────────────────────────────────────────────────────────

/**
 * A fictional law.
 *
 * Kept separate from the premise because these are the statements the continuity
 * checker is allowed to fail an episode over. A premise can be reinterpreted; "the dead
 * do not speak" cannot be, and the moment it is, the audience stops believing anything.
 */
export const WorldRule = z.strictObject({
  scope: z
    .enum(['physics', 'magic', 'technology', 'biology', 'society', 'economy', 'metaphysics'])
    .describe('Which layer of the world this law governs.'),
  statement: Prose.describe(
    'The law, stated as something a scene can violate. Write it so a reader can point ' +
      'at a shot and say yes or no, for example: the dead cannot speak, and no ' +
      'character has ever heard one.',
  ),
  inviolable: z
    .boolean()
    .default(true)
    .describe(
      'True if breaking this is a bug. Set false only for a law the story intends to ' +
        'break on purpose at some point - and then say where in consequenceIfBroken.',
    ),
  consequenceIfBroken: Prose.optional().describe(
    'What it costs in the fiction when this law bends. Omit for a law that simply never bends.',
  ),
});
export type WorldRule = z.infer<typeof WorldRule>;

/**
 * How hard the series holds its own past.
 *
 * Non-negotiable #7 says aired canon is immutable; this is where a series says what
 * immutable means for it. A tightly plotted mystery wants `forbidden`; a loose
 * anthology can live with `allowed-with-approval`. `reveal-only` is the useful middle
 * and the default: a later episode may show that an earlier scene meant something else,
 * but may not show that it did not happen.
 */
export const CanonPolicy = z.strictObject({
  freezeOnAir: z
    .boolean()
    .default(true)
    .describe(
      'True if airing an episode freezes the facts it asserted. Turning this off ' +
        'disables the continuity guarantee entirely.',
    ),
  retcon: z
    .enum(['forbidden', 'reveal-only', 'allowed-with-approval'])
    .default('reveal-only')
    .describe(
      'What a later episode may do to an earlier one. "reveal-only" permits hidden ' +
        'truths to surface but forbids contradicting anything already shown.',
    ),
  strictness: z
    .enum(['strict', 'balanced', 'loose'])
    .default('strict')
    .describe(
      'How aggressively the continuity checker blocks a draft. "strict" fails on any ' +
        'contradiction, "loose" only on contradictions the audience would notice.',
    ),
});
export type CanonPolicy = z.infer<typeof CanonPolicy>;

// ── episode lifecycle ───────────────────────────────────────────────────────

/**
 * The episode lifecycle from docs/02 §1, in order.
 *
 * Each state names the artefact that now exists: `outlined` has a beat tree, `boarded`
 * has shots, `asset-resolved` has a hit/miss plan and a price, and so on. `aired` is
 * the one that matters - it is where the facts the episode asserted become canon.
 */
export const EPISODE_STATUSES = [
  'draft',
  'outlined',
  'scripted',
  'boarded',
  'asset-resolved',
  'choreographed',
  'rendered',
  'aired',
] as const;

export const EpisodeStatus = z.enum(EPISODE_STATUSES);
export type EpisodeStatus = z.infer<typeof EpisodeStatus>;

/**
 * The legal moves, as data rather than as a `switch`.
 *
 * A table can be asserted total in a test, rendered in the UI, and shipped to the
 * client; a `switch` buried in a use-case can do none of those and quietly grows a
 * default branch. Every non-terminal state may advance exactly one step, and may fall
 * back exactly one step - the fall-back is how editing works, because dropping from
 * `boarded` to `scripted` is precisely the signal that invalidates the board and
 * everything after it. A deeper revert is a sequence of single steps, which keeps each
 * intermediate invalidation observable instead of collapsing several into one jump.
 *
 * `aired` has no outgoing edges, and that is the whole point: non-negotiable #7 lives
 * in this empty array.
 */
export const EPISODE_STATUS_TRANSITIONS: Readonly<Record<EpisodeStatus, readonly EpisodeStatus[]>> =
  {
    draft: ['outlined'],
    outlined: ['draft', 'scripted'],
    scripted: ['outlined', 'boarded'],
    boarded: ['scripted', 'asset-resolved'],
    'asset-resolved': ['boarded', 'choreographed'],
    choreographed: ['asset-resolved', 'rendered'],
    rendered: ['choreographed', 'aired'],
    aired: [],
  };

// ── dialogue ────────────────────────────────────────────────────────────────

/**
 * One phoneme, timed relative to the start of its line.
 *
 * Relative rather than absolute so a line can be re-timed, or moved to a different
 * shot, without rewriting every phoneme under it.
 */
export const PhonemeTiming = z.strictObject({
  phoneme: NonEmptyString.describe(
    'Phoneme or viseme symbol, in whatever alphabet the aligner emits (ARPAbet, IPA, or ' +
      'a viseme code). It is looked up in the rig mouth chart, so it must match the ' +
      'chart the style bible declared.',
  ),
  startMs: Millis.describe('Offset from the start of the line, in milliseconds.'),
  durationMs: PositiveInt.describe('How long the mouth holds this shape, in milliseconds.'),
});
export type PhonemeTiming = z.infer<typeof PhonemeTiming>;

/**
 * How the line is said.
 *
 * Structured rather than free text because two consumers read it and neither can parse
 * a sentence: the TTS adapter needs `emotion`/`intensity`/`pace`, and the choreographer
 * turns `intensity` into gesture amplitude on the speaker's rig.
 */
export const DeliveryNote = z.strictObject({
  emotion: Label.describe(
    'The single dominant emotion, one word, for example "bitter", "pleading", "flat". ' +
      'Name what the character feels, not what the audience should.',
  ),
  intensity: Unit01.describe(
    'How far the emotion is pushed, 0 for barely detectable to 1 for as far as this ' +
      'character ever goes. It also scales gesture amplitude on the rig.',
  ),
  pace: z.enum(['slow', 'measured', 'quick', 'rushed']).describe('Speaking rate for this line.'),
  volume: z
    .enum(['whisper', 'low', 'normal', 'raised', 'shout'])
    .describe('Loudness for this line.'),
  note: Prose.optional().describe(
    'Anything the four fields above cannot carry, for example "trails off on the last ' +
      'word" or "starts before the previous speaker finishes".',
  ),
});
export type DeliveryNote = z.infer<typeof DeliveryNote>;

/**
 * One spoken line.
 *
 * `subtext` is mandatory. IBSEN-style per-character actor calls (prior-art §B) only
 * stop sounding identical when each line records what the character is actually doing
 * with it, and a writer who has to fill this field cannot write a line that is only its
 * surface. Where a character means exactly what they say, say so - that is information
 * too.
 */
export const DialogueLine = z.strictObject({
  speakerRef: EntityId.describe('The entity speaking. Must be present in the scene.'),
  text: Prose.describe('The words spoken, verbatim, in the series language.'),
  subtext: Prose.describe(
    'What the character is actually doing with this line - the want under the words, ' +
      'for example: sounds like an apology, is actually a test of whether she still ' +
      'flinches. If the line is entirely sincere, write that.',
  ),
  delivery: DeliveryNote.describe('How the line is performed.'),
  startMs: Millis.default(0).describe(
    'Offset from the start of the shot, in milliseconds. Lines may overlap; that is an ' +
      'interruption.',
  ),
  durationMs: PositiveInt.optional().describe(
    'Measured length of the rendered audio. Left out until the voice has been ' +
      'synthesised - do not guess it.',
  ),
  phonemes: z
    .array(PhonemeTiming)
    .default([])
    .describe(
      'Forced-alignment output driving lip-sync. Empty until the audio exists; never ' +
        'authored by hand.',
    ),
});
export type DialogueLine = z.infer<typeof DialogueLine>;

// ── the outline envelope ────────────────────────────────────────────────────

/**
 * The three fields every node in the tree carries, root included.
 *
 * `summary` is what this node *is*; `plannedSummary` is what its parent *asked for*.
 * Keeping both is what makes a DOC expansion checkable - drift between them is the
 * earliest detectable symptom of a series losing its plot, and it is detectable one
 * level at a time instead of at the end.
 */
const outlineCore = {
  title: Label.describe(
    'A short title for this node. It is shown to the audience only at series and ' +
      'episode level; below that it is a working name for the writers.',
  ),
  summary: Prose.describe(
    'What this node actually contains, written after it was expanded. One paragraph. ' +
      'Describe what happens, not what it is about.',
  ),
  plannedSummary: Prose.nullable().describe(
    'Verbatim, the instruction the parent level gave for this node, copied before ' +
      'expanding it. Never rewrite it to match what you produced - the gap between this ' +
      'and summary is exactly what the critique pass measures. Null only at the series ' +
      'root, whose parent is the brief.',
  ),
} as const;

const outlineShape = {
  ordinal: PositiveInt.describe(
    'Position among siblings, starting at 1. Contiguous - no gaps, no duplicates.',
  ),
  ...outlineCore,
} as const;

/**
 * The outline fields shared by every node below the series root.
 *
 * Exported so the planner can validate a bare expansion - a list of scene stubs, say -
 * before it has anything to attach them to.
 */
export const OutlineEnvelope = z.strictObject(outlineShape);
export type OutlineEnvelope = z.infer<typeof OutlineEnvelope>;

/**
 * Reports the sibling list whose ordinals are not `1..n`.
 *
 * `ordinal` says "Contiguous - no gaps, no duplicates" in its own description, and a
 * description is the only thing a model filling this in ever reads - it is not a
 * constraint, and `.superRefine` is dropped from the emitted JSON Schema entirely (see
 * docs/00-research.md §1). So a DOC expansion that returns scenes numbered 1, 2, 2 or
 * 1, 2, 4 parses cleanly today and only surfaces later as an outline the critique pass
 * cannot align against its parent, or a beat list a shot list silently reorders.
 *
 * Applied by every level that owns children rather than by the child itself, because
 * contiguity is a property of the *list*: a `Beat` on its own cannot know it is the
 * third of three.
 */
function checkSiblingOrdinals(
  siblings: readonly { readonly ordinal: number }[],
  ctx: z.RefinementCtx,
  path: string,
): void {
  const ordinals = siblings.map((sibling) => sibling.ordinal);
  // Zod runs an object-level check even when a member failed one of its own checks, so
  // an out-of-range ordinal reaches here already carrying a precise issue of its own.
  // Reporting the same mistake a second time at the list level gives the repair loop
  // two things to fix for one error.
  if (ordinals.some((ordinal) => !Number.isInteger(ordinal) || ordinal < 1)) return;
  const expected = ordinals.map((_, index) => index + 1);
  const sorted = [...ordinals].sort((a, b) => a - b);
  if (sorted.some((value, index) => value !== expected[index])) {
    ctx.addIssue({
      code: 'custom',
      path: [path],
      message: `${path} must be numbered 1..${String(ordinals.length)} with no gaps or duplicates, got [${ordinals.join(', ')}]`,
    });
  }
}

// ── the hierarchy, leaf upward ──────────────────────────────────────────────

/**
 * What a beat does structurally.
 *
 * Named by dramatic function rather than by position, because "the third beat" tells a
 * generator nothing and "the catalyst" tells it everything about what has to change.
 */
export const BEAT_FUNCTIONS = [
  'setup',
  'catalyst',
  'debate',
  'turn',
  'escalation',
  'midpoint',
  'reveal',
  'reversal',
  'crisis',
  'climax',
  'resolution',
  'denouement',
  'button',
] as const;

export const BeatFunction = z.enum(BEAT_FUNCTIONS);
export type BeatFunction = z.infer<typeof BeatFunction>;

/**
 * The smallest unit of change.
 *
 * A beat is the atom the shot list is built against - every `Shot` points at one - so
 * it has to be small enough that a single camera setup can carry it.
 */
export const Beat = z.strictObject({
  id: BeatId,
  ...outlineShape,
  function: BeatFunction.describe('The structural job this beat does inside its scene.'),
  movesEntityRefs: z
    .array(EntityId)
    .min(1)
    .describe(
      'The entities whose situation, knowledge or relationships this beat changes. At ' +
        'least one - a beat that changes nothing for nobody is not a beat, it is a ' +
        'description.',
    ),
});
export type Beat = z.infer<typeof Beat>;

/** Where a dramatic value sits on its axis at a given moment. */
export const VALUE_CHARGES = [
  'strong-negative',
  'negative',
  'neutral',
  'positive',
  'strong-positive',
] as const;

export const ValueCharge = z.enum(VALUE_CHARGES);
export type ValueCharge = z.infer<typeof ValueCharge>;

/**
 * The charge a scene moves, and which way.
 *
 * Held as an axis plus two charges rather than as prose so it is mechanically
 * comparable: a run of scenes whose `from` equals their `to` is a stalled act, and that
 * is a query, not a reading job.
 */
export const EmotionalValueShift = z.strictObject({
  axis: Label.describe(
    'The one value at stake in this scene, named as a noun, for example "trust", ' +
      '"safety", "belonging". One axis per scene; if two move, the scene is two scenes.',
  ),
  from: ValueCharge.describe('Where that value stands when the scene opens.'),
  to: ValueCharge.describe(
    'Where it stands when the scene closes. Equal to "from" means the scene did not ' +
      'turn, which is worth flagging even when it is intentional.',
  ),
});
export type EmotionalValueShift = z.infer<typeof EmotionalValueShift>;

/**
 * A scene: one place, one continuous stretch of story time, one value turn.
 *
 * The POV reference is the load-bearing field. docs/02 §3 stores what is true and what
 * each character believes as separate edges, and the scene writer is handed the *POV
 * entity's* view of the world rather than the narrator's - which is the mechanism that
 * stops a character acting on information they do not have.
 */
export const Scene = z
  .strictObject({
    id: SceneId,
    ...outlineShape,
    locationRef: EntityId.describe('The location entity this scene plays in. Exactly one.'),
    presentEntityRefs: z
      .array(EntityId)
      .default([])
      .describe(
        'Every entity physically present, including props and creatures that matter. ' +
          'Anyone who speaks must be here. An empty list means an empty location, which ' +
          'is legal and rare.',
      ),
    povEntityRef: EntityId.nullable().describe(
      'Whose knowledge bounds this scene. The writer is shown only what this entity ' +
        'knows. Null for a scene deliberately narrated from outside anyone, which forfeits ' +
        'the dramatic-irony guard.',
    ),
    goal: Prose.describe(
      'What the POV entity - or the scene itself, if there is no POV - is trying to get. ' +
        'Concrete and achievable inside this scene.',
    ),
    conflict: Prose.describe(
      'What stands in the way. Never "nothing"; a scene without it is a transition.',
    ),
    outcome: Prose.describe(
      'How it ends: got it, did not get it, or got it and it cost something. State which.',
    ),
    storyInterval: StoryInterval.describe(
      'When this scene happens inside the fiction. Use the ordinal for ordering and the ' +
        'label for the audience.',
    ),
    valueShift: EmotionalValueShift.describe('The value this scene turns, and which way.'),
    beats: z.array(Beat).min(1).describe('The beats of this scene, in playing order.'),
  })
  .superRefine((scene, ctx) => {
    checkSiblingOrdinals(scene.beats, ctx, 'beats');
  });
export type Scene = z.infer<typeof Scene>;

/**
 * A run of scenes that poses one question and answers it.
 *
 * The level exists so the shot composer has something bigger than a scene and smaller
 * than an act to pace against; without it, every episode ends up flat.
 *
 * This is the **authoring document**: it embeds whole `Scene`s. For the storage
 * projection that names them by id instead, see {@link SequenceOutline}.
 */
const sequenceBase = z.strictObject({
  id: SequenceId,
  ...outlineShape,
  dramaticQuestion: Prose.describe(
    'The question this sequence opens and closes, phrased as a yes/no question, for ' +
      'example: will she reach the lighthouse before the tide?',
  ),
  scenes: z.array(Scene).min(1).describe('The scenes of this sequence, in playing order.'),
});

export const Sequence = sequenceBase.superRefine((sequence, ctx) => {
  checkSiblingOrdinals(sequence.scenes, ctx, 'scenes');
});
export type Sequence = z.infer<typeof Sequence>;

/**
 * An act. The **authoring document**; see {@link ActOutline} for the storage projection.
 */
const actBase = z.strictObject({
  id: ActId,
  ...outlineShape,
  turningPoint: Prose.describe(
    'The single irreversible change this act delivers - what is no longer possible ' +
      'afterwards.',
  ),
  sequences: z.array(Sequence).min(1).describe('The sequences of this act, in playing order.'),
});

export const Act = actBase.superRefine((act, ctx) => {
  checkSiblingOrdinals(act.sequences, ctx, 'sequences');
});
export type Act = z.infer<typeof Act>;

/**
 * "Present if and only if status is aired", shared by the episode and its projection.
 *
 * The whole of non-negotiable #7's bookkeeping. An episode marked `aired` with no
 * `airedAt` cannot be replayed as-of the moment it aired, which is exactly the query
 * the bi-temporal graph exists to answer; an unaired episode carrying an air date is a
 * canon freeze nobody performed. Extracted rather than duplicated onto
 * {@link EpisodeOutline}, because the projection is the form that is actually *stored*
 * - if only one of the two enforces this, it will be the one nothing writes to.
 */
function checkAirState(
  episode: { readonly status: EpisodeStatus; readonly airedAt?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (episode.status === 'aired' && episode.airedAt === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['airedAt'],
      message: 'an aired episode must record when it aired - its canon freezes at that instant',
    });
  }
  if (episode.status !== 'aired' && episode.airedAt !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['airedAt'],
      message: `only an aired episode may carry airedAt; this one is ${episode.status}`,
    });
  }
}

/**
 * One episode.
 *
 * `status` is the gate everything else hangs off: below `aired` the whole subtree is
 * mutable and the planner may re-outline it as memory accumulates (DOME), at `aired`
 * the facts it asserted are frozen.
 *
 * This is the **authoring document**, and it is one tree: acts hold sequences hold
 * scenes hold beats, whole. That is the right shape to generate, critique and hand to a
 * writer, and the wrong shape to store - see {@link EpisodeOutline}.
 */
const episodeBase = z.strictObject({
  id: EpisodeId,
  ...outlineShape,
  status: EpisodeStatus.describe(
    'Where this episode is in its lifecycle. Only EPISODE_STATUS_TRANSITIONS may move it.',
  ),
  logline: Prose.describe('One sentence: who wants what, and what is in the way, this episode.'),
  coldOpen: Prose.optional().describe(
    'What plays before the title, if anything. Omit for an episode that starts at act one.',
  ),
  cliffhanger: Prose.optional().describe(
    'The unresolved thing the episode ends on. Omit for a self-contained episode or a finale.',
  ),
  opensLoops: z
    .array(OpenLoopId)
    .default([])
    .describe('Open loops this episode plants. Each one is a promise the series now owes.'),
  closesLoops: z.array(OpenLoopId).default([]).describe('Open loops this episode pays off.'),
  airedAt: IsoInstant.optional().describe(
    'When the episode aired, in authoring time. Present if and only if status is "aired".',
  ),
  acts: z.array(Act).min(1).describe('The acts of this episode, in playing order.'),
});

export const Episode = episodeBase.superRefine((episode, ctx) => {
  checkSiblingOrdinals(episode.acts, ctx, 'acts');
  checkAirState(episode, ctx);
});
export type Episode = z.infer<typeof Episode>;

/**
 * One season.
 *
 * `styleBibleRef` sits here as well as on the series because a season is the only place
 * a restyle is safe: the style checksum is part of every asset key, so pointing season
 * 2 at a new style bible regenerates season 2's assets and leaves season 1 intact and
 * still re-renderable (docs/02 §5).
 */
export const Season = z
  .strictObject({
    id: SeasonId,
    ...outlineShape,
    arc: Prose.describe(
      'The change this season delivers across its episodes - the state the world is in ' +
        'when it opens and when it closes.',
    ),
    styleBibleRef: StyleBibleId.optional().describe(
      'Style bible for this season, overriding the series one. Omit unless this season is ' +
        'deliberately restyled.',
    ),
    episodes: z.array(Episode).min(1).describe('The episodes of this season, in airing order.'),
  })
  .superRefine((season, ctx) => {
    checkSiblingOrdinals(season.episodes, ctx, 'episodes');
  });
export type Season = z.infer<typeof Season>;

/**
 * The root: everything the series is, plus everything it has planned.
 *
 * A standalone short is one season holding one episode. There is no second code path -
 * the single-episode case is the degenerate case of this one, which is why nothing
 * downstream ever asks "is this a series?".
 */
export const SeriesBible = z
  .strictObject({
    id: SeriesId,
    ...outlineCore,
    premise: Prose.describe(
      'The engine of the series in two or three sentences: the situation, the pressure it ' +
        'puts on the lead, and why it does not resolve in one episode.',
    ),
    themes: z
      .array(Label)
      .min(1)
      .max(8)
      .describe(
        'What the series argues about, as noun phrases, for example ["inherited guilt", ' +
          '"the price of being believed"]. Not genres, not adjectives.',
      ),
    tone: z
      .array(Label)
      .min(1)
      .max(12)
      .describe(
        'Adjectives fixing the register. Carried through from the brief unless it changed.',
      ),
    genre: z
      .array(Label)
      .min(1)
      .max(4)
      .describe(
        'One to four genre labels, most defining first, for example ["folk horror", "mystery"].',
      ),
    rulesOfTheWorld: z
      .array(WorldRule)
      .default([])
      .describe(
        'The fictional laws this series may not break. Write down the ones the audience ' +
          'will infer anyway - an unstated rule is one nobody can check.',
      ),
    targetFormat: TargetFormat.describe('Frame rate, master aspect, and every aspect that ships.'),
    canonPolicy: CanonPolicy.describe('How hard this series holds its own past.'),
    styleBibleRef: StyleBibleId.optional().describe(
      'The locked style bible for the series. Absent while the bible is drafted before ' +
        'style lock; present from then on.',
    ),
    seasons: z.array(Season).min(1).describe('The seasons, in airing order. At least one.'),
  })
  .superRefine((bible, ctx) => {
    checkSiblingOrdinals(bible.seasons, ctx, 'seasons');
  });
export type SeriesBible = z.infer<typeof SeriesBible>;

// ── the storage projection ──────────────────────────────────────────────────

/**
 * The same episode with its scenes reduced to references.
 *
 * ## Two forms, and which is which
 *
 * `Episode` above is the **authoring document**: one tree, scenes and beats embedded,
 * exactly what a DOC expansion produces and what a critique pass reads. `EpisodeOutline`
 * here is the **storage projection**: the same episode with the two purely structural
 * levels (`Act`, `Sequence`) kept whole and the scenes named by id.
 *
 * Storing the authoring form verbatim duplicates every scene body inside its episode
 * row, so rewriting one scene rewrites the entire episode - which is both a write
 * amplification and a lost-update race between two people editing different scenes of
 * the same episode. Nothing queries an act, and a re-outline rewrites all of them at
 * once, so the acts and sequences stay in one document while the scenes get rows.
 *
 * ## Why it is derived rather than written out
 *
 * `.omit()` + `.extend()` off the very same base object the authoring schema is built
 * from. A field added to `Sequence` lands in `SequenceOutline` on the next compile, with
 * its description, its default and its constraints intact - and `story-bible.spec.ts`
 * asserts the key sets still line up, so a future `.extend()` that quietly shadows a
 * field fails a test instead of producing a projection that silently drops data on its
 * way to disk.
 *
 * The ordinal-contiguity guard is re-applied because it is the projection that gets
 * written and read back: an invariant enforced only on the form nothing stores is an
 * invariant nothing enforces.
 */
export const SequenceOutline = sequenceBase.omit({ scenes: true }).extend({
  sceneIds: z
    .array(SceneId)
    .min(1)
    .describe(
      'The scenes of this sequence, in playing order, by id. Order is the contract - the scene rows carry an ordinal, but this list is what decides what plays after what.',
    ),
});
export type SequenceOutline = z.infer<typeof SequenceOutline>;

/** An act with its sequences outlined the same way. See {@link SequenceOutline}. */
export const ActOutline = actBase
  .omit({ sequences: true })
  .extend({
    sequences: z
      .array(SequenceOutline)
      .min(1)
      .describe('The sequences of this act, in playing order, with their scenes as ids.'),
  })
  .superRefine((act, ctx) => {
    checkSiblingOrdinals(act.sequences, ctx, 'sequences');
  });
export type ActOutline = z.infer<typeof ActOutline>;

/**
 * An episode as it is stored: everything except the scene bodies.
 *
 * This is what goes in the `episodes` row. {@link toEpisodeOutline} and
 * {@link fromEpisodeOutline} are the two halves of the round trip, and
 * {@link episodeScenes} is the other output of the split - the scene documents that
 * become rows of their own.
 */
export const EpisodeOutline = episodeBase
  .omit({ acts: true })
  .extend({
    acts: z
      .array(ActOutline)
      .min(1)
      .describe('The acts of this episode, in playing order, with their scenes as ids.'),
  })
  .superRefine((episode, ctx) => {
    checkSiblingOrdinals(episode.acts, ctx, 'acts');
    checkAirState(episode, ctx);
  });
export type EpisodeOutline = z.infer<typeof EpisodeOutline>;

/** Projects one sequence. Total: every authoring sequence has an outline. */
export function toSequenceOutline(sequence: Sequence): SequenceOutline {
  const { scenes, ...rest } = sequence;
  return { ...rest, sceneIds: scenes.map((scene) => scene.id) };
}

/** Projects one act. */
export function toActOutline(act: Act): ActOutline {
  const { sequences, ...rest } = act;
  return { ...rest, sequences: sequences.map(toSequenceOutline) };
}

/**
 * Splits an authoring episode into the half that goes in the episode row.
 *
 * Paired with {@link episodeScenes}, which returns the other half. Two functions rather
 * than one returning both, because the two halves are written to two tables in one
 * transaction and a caller that wants only the outline - re-reading a structure to
 * count acts, say - should not have to materialise every scene body to get it.
 */
export function toEpisodeOutline(episode: Episode): EpisodeOutline {
  const { acts, ...rest } = episode;
  return { ...rest, acts: acts.map(toActOutline) };
}

/**
 * Every scene of an episode, flattened into playing order.
 *
 * Playing order, not storage order: the tree is already ordered, so flattening it is
 * the definition of the order the scenes play in, and a caller that re-derives it from
 * ordinals is re-deriving something it was handed.
 */
export function episodeScenes(episode: Episode): readonly Scene[] {
  return episode.acts.flatMap((act) => act.sequences.flatMap((sequence) => sequence.scenes));
}

/**
 * Rebuilds the authoring document from the projection and the scene rows.
 *
 * Returns the ids it could not resolve rather than a generic failure, because that list
 * *is* the diagnosis: an outline naming a scene no row carries means the two tables
 * were written out of step, and the operator needs to know which scenes to go and look
 * for. Throwing would be wrong on both counts - a missing row is an expected failure of
 * a read, not a programmer error (CLAUDE.md §2), and an exception carries the first
 * missing id at best.
 *
 * The result is deliberately *not* parsed here. It is the caller's business whether to
 * `Episode.parse` it - a repository reading rows it wrote itself may not want to pay
 * for a full validation of every beat on every read, and one that does can ask.
 */
export function fromEpisodeOutline(
  outline: EpisodeOutline,
  scenes: readonly Scene[],
): Result<Episode, readonly SceneId[]> {
  const byId = new Map<SceneId, Scene>(scenes.map((scene) => [scene.id, scene]));
  const missing: SceneId[] = [];

  const acts = outline.acts.map((act) => {
    const sequences = act.sequences.map((sequence) => {
      const { sceneIds, ...rest } = sequence;
      const resolved: Scene[] = [];
      for (const sceneId of sceneIds) {
        const scene = byId.get(sceneId);
        if (scene === undefined) missing.push(sceneId);
        else resolved.push(scene);
      }
      return { ...rest, scenes: resolved };
    });
    return { ...act, sequences };
  });

  if (missing.length > 0) return err(missing);
  const { acts: _projected, ...rest } = outline;
  return ok({ ...rest, acts });
}
