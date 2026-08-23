/**
 * S7 Sequence: a scene becomes `Shot[]`.
 *
 * The division of labour here is the point. The model decides what a director decides -
 * where to cut, how close, who is in frame, what the frame is *about* - and the code
 * decides everything that is arithmetic or is owned by the style bible:
 *
 *  - **Durations** come from `StyleBible.motion.camera.cutRhythm` and sum to the scene
 *    exactly (`pacing.ts`).
 *  - **The safe area** is solved from the canvas and the delivery aspects (`safe-area.ts`),
 *    because "what survives a 9:16 crop" is geometry and not taste.
 *  - **Asset identity** is resolved from the placeables the caller supplies. The model
 *    never sees an `AssetId` and never emits one; it names shot-local handles, which is
 *    the same trade `AssetInstanceKey` makes and for the same reason.
 *
 * Every shot leaves here with a `focusTarget` and a `safeArea` - not because the schema
 * demands them, but because together they are what lets one composition reframe to every
 * delivery format instead of being recomposed per aspect.
 */

import { z } from 'zod';
import {
  type AssetId,
  type AssetInstance,
  type AssetInstanceKey,
  type AssetVersionId,
  CAMERA_MOVES,
  CameraMove,
  type DeliveryAspect,
  type DialogueLine,
  type EntityId,
  FOCUS_PRIORITIES,
  FocusPriority,
  LoopMode,
  NonNegativeInt,
  NormRect,
  PositiveInt,
  Prose,
  SHOT_FRAMINGS,
  type Scene,
  Shot,
  type ShotAction,
  ShotFraming,
  type ShotLayer,
  type Size,
  Slug,
  Unit01,
  type VariantId,
  type CameraGrammar,
} from '@rv/contracts';
import { PromptTemplate, type StructuredTrace } from '@rv/prompt-kit';
import { type AppError, type Result, ValidationError, at, err, isErr, ok } from '@rv/shared-kernel';

import { DIRECTOR } from '../roles/index';
import { bulletList, inlineList } from '../support/format';
import { type StoryEngineDeps, runRoleCall } from '../support/stage-call';
import { distributeDurations, targetShotCount } from './pacing';
import { solveSafeArea } from './safe-area';

// ── what the shot list may place ────────────────────────────────────────────

export const LAYER_BANDS = ['background', 'midground', 'foreground'] as const;
export type LayerBand = (typeof LAYER_BANDS)[number];

/**
 * One asset that already exists and may be placed in this scene.
 *
 * Supplied by the caller because by S7 the assets are real: S5 resolved the demand and S6
 * produced the misses. The shot list is where they are staged, not where they are invented
 * - and pinning the concrete `assetVersionId` here is what makes a re-render of this shot
 * reproduce this shot.
 */
export interface PlaceableAsset {
  /** The shot-local handle the model will use, e.g. `kael-left`. */
  readonly instance: AssetInstanceKey;
  readonly label: string;
  readonly assetId: AssetId;
  readonly assetVersionId: AssetVersionId;
  readonly variantId?: VariantId;
  /** The entity this artwork depicts, when it depicts one. Used to place speakers. */
  readonly entityRef?: EntityId;
  readonly band: LayerBand;
  /**
   * The clips this asset's rig actually registers.
   *
   * A blocking action naming a clip outside this list fails here, with the shot to point
   * at, rather than at choreograph time with a stack trace (RV-087).
   */
  readonly clipVocabulary: readonly string[];
}

export interface BuildShotListInput {
  readonly scene: Scene;
  /** How long this scene runs. The shot durations will sum to exactly this. */
  readonly sceneDurationMs: number;
  readonly camera: CameraGrammar;
  readonly fps: number;
  readonly masterAspect: DeliveryAspect;
  /** Every aspect the series ships. Drives the solved safe area. */
  readonly deliverables: readonly DeliveryAspect[];
  /** The authoring canvas. Compose it wider and taller than any single deliverable needs. */
  readonly canvas: Size;
  readonly placeables: readonly PlaceableAsset[];
  /** Lines from the scene writer, timed from the start of the scene. */
  readonly dialogue?: readonly DialogueLine[];
  /** Overrides the solved safe area. For a shot list with a burned-in caption rail. */
  readonly safeArea?: NormRect;
  readonly signal?: AbortSignal;
}

// ── the plan a director returns ─────────────────────────────────────────────

const ShotInstancePlan = z.strictObject({
  instance: Slug.describe('One of the handles listed as available. Not a new name.'),
  band: z
    .enum(LAYER_BANDS)
    .describe('Which depth band this sits in. Paint order follows: background first.'),
  x: Unit01.describe('Anchor position across the canvas, 0 at the left edge, 1 at the right.'),
  y: Unit01.describe('Anchor position down the canvas, 0 at the top, 1 at the bottom.'),
  scale: z
    .number()
    .min(0.05)
    .max(8)
    .default(1)
    .describe('Size relative to the asset as authored. 1 is as generated.'),
  depth: z
    .number()
    .min(0.01)
    .max(100)
    .default(1)
    .describe(
      'Parallax distance. 1 is the focal plane, below 1 is nearer and travels more, above 1 ' +
        'is farther and lags. Use 1 unless the shot moves.',
    ),
});
export type ShotInstancePlan = z.infer<typeof ShotInstancePlan>;

const ShotActionPlan = z.strictObject({
  instance: Slug.describe('Which placed instance performs.'),
  clip: Slug.describe("A clip from that asset's declared vocabulary. Nothing else resolves."),
  startFraction: Unit01.default(0).describe('When it starts, as a fraction of the shot.'),
  durationFraction: z
    .number()
    .min(0.01)
    .max(1)
    .default(1)
    .describe('How much of the shot it runs for.'),
  loop: LoopMode.default('once'),
});
export type ShotActionPlan = z.infer<typeof ShotActionPlan>;

export const ShotPlan = z.strictObject({
  ordinal: PositiveInt.describe('Position in the shot list, starting at 1. Contiguous.'),
  beatOrdinal: PositiveInt.describe(
    'Which beat of this scene the shot carries, by its number. Exactly one beat per shot.',
  ),
  framing: ShotFraming,
  move: CameraMove,
  weight: z
    .number()
    .min(0.1)
    .max(10)
    .default(1)
    .describe(
      'How long this shot wants to be, relative to the others. 1 is average. Absolute ' +
        'durations are computed from the style bible, not from you.',
    ),
  intent: Prose.describe('What this shot is for, in one sentence. Why the cut lands here.'),
  instances: z
    .array(ShotInstancePlan)
    .min(1)
    .max(16)
    .describe('Everything staged in this shot, from the available handles.'),
  focusInstance: Slug.nullable().describe(
    'What the frame is about, by handle. Null when the subject is not a single asset - a ' +
      'landscape, an empty room.',
  ),
  focusRegion: NormRect.describe(
    'The subject region as fractions of the canvas. Keep it tight: a region covering ' +
      'everything tells the reframer nothing.',
  ),
  focusPriority: FocusPriority.default('must-keep'),
  blocking: z.array(ShotActionPlan).max(24).default([]),
  dialogueLineIndexes: z
    .array(NonNegativeInt)
    .max(32)
    .default([])
    .describe('Which of the numbered scene lines are spoken during this shot, in order.'),
});
export type ShotPlan = z.infer<typeof ShotPlan>;

export const ShotListPlan = z
  .strictObject({
    pacingNote: Prose.describe(
      'One sentence on how you paced this scene and why. Read by the critique pass.',
    ),
    shots: z.array(ShotPlan).min(1).max(64).describe('The shot list, in playing order.'),
  })
  .superRefine((plan, ctx) => {
    const ordinals = plan.shots.map((shot) => shot.ordinal);
    const sorted = [...ordinals].sort((a, b) => a - b);
    if (sorted.some((value, index) => value !== index + 1)) {
      ctx.addIssue({
        code: 'custom',
        path: ['shots'],
        message: `shots must be numbered 1..${String(ordinals.length)} with no gaps or duplicates, got [${ordinals.join(', ')}]`,
      });
    }
  });
export type ShotListPlan = z.infer<typeof ShotListPlan>;

// ── prompt ──────────────────────────────────────────────────────────────────

const SHOT_LIST_PROMPT = new PromptTemplate<{
  readonly sceneTitle: string;
  readonly sceneSummary: string;
  readonly location: string;
  readonly goal: string;
  readonly conflict: string;
  readonly outcome: string;
  readonly beats: string;
  readonly placeables: string;
  readonly dialogue: string;
  readonly canvas: string;
  readonly aspects: string;
  readonly rhythm: string;
  readonly targetShots: number;
  readonly framings: string;
  readonly moves: string;
  readonly priorities: string;
}>(
  'shots.build',
  [
    '## The scene',
    '{{sceneTitle}} - {{location}}',
    '{{sceneSummary}}',
    '',
    'Goal: {{goal}}',
    'Conflict: {{conflict}}',
    'Outcome: {{outcome}}',
    '',
    '### Beats, numbered. Every shot carries exactly one.',
    '{{beats}}',
    '',
    '### Lines, numbered. Assign each to the shot it is spoken in.',
    '{{dialogue}}',
    '',
    '## What you may place',
    'Use these handles exactly. You cannot introduce an asset that is not here.',
    '',
    '{{placeables}}',
    '',
    '## The canvas',
    '{{canvas}}',
    'This composition will be cropped to: {{aspects}}. Compose so that everything carrying',
    "meaning sits near the centre, and put the frame's subject in focusRegion so the",
    'reframer can solve each crop.',
    '',
    '## Pace',
    '{{rhythm}} Aim for about {{targetShots}} shots. Express length as relative weight only;',
    'the absolute durations come from the style bible.',
    '',
    '## Vocabulary',
    'Framings: {{framings}}',
    'Camera moves: {{moves}}',
    'Focus priorities: {{priorities}}',
    '',
    'Every shot needs a focus target. A frame that is about nothing crops to nothing.',
  ].join('\n'),
);

// ── result ──────────────────────────────────────────────────────────────────

export interface ShotListResult {
  readonly shots: readonly Shot[];
  readonly pacingNote: string;
  /** The safe area every shot was solved against. Recorded so a reframe can be explained. */
  readonly safeArea: NormRect;
  readonly trace: StructuredTrace;
}

const BAND_Z: Readonly<Record<LayerBand, number>> = { background: 0, midground: 1, foreground: 2 };

export class BuildShotListUseCase {
  readonly #deps: StoryEngineDeps;

  constructor(deps: StoryEngineDeps) {
    this.#deps = deps;
  }

  async execute(input: BuildShotListInput): Promise<Result<ShotListResult, AppError>> {
    if (input.placeables.length === 0) {
      return err(
        new ValidationError({
          message: 'A shot list needs at least one placeable asset; a shot cannot stage nothing',
          context: { reason: 'no-placeables', sceneId: input.scene.id },
        }),
      );
    }

    const dialogue = input.dialogue ?? [];
    const safeArea =
      input.safeArea ??
      solveSafeArea(input.canvas, dedupeAspects(input.masterAspect, input.deliverables));

    const plan = await runRoleCall<ShotListPlan>(this.#deps, {
      role: DIRECTOR,
      schemaName: 'ShotListPlan',
      schema: ShotListPlan,
      user: SHOT_LIST_PROMPT.render({
        sceneTitle: input.scene.title,
        sceneSummary: input.scene.summary,
        location: input.scene.locationRef,
        goal: input.scene.goal,
        conflict: input.scene.conflict,
        outcome: input.scene.outcome,
        beats: bulletList(
          input.scene.beats.map(
            (beat) => `${String(beat.ordinal)}. [${beat.function}] ${beat.title} - ${beat.summary}`,
          ),
        ),
        dialogue: bulletList(
          dialogue.map(
            (line, index) => `${String(index)}. "${line.text}" (${line.delivery.emotion})`,
          ),
          'no dialogue in this scene',
        ),
        placeables: bulletList(
          input.placeables.map(
            (placeable) =>
              `${placeable.instance} - ${placeable.label} [${placeable.band}]; clips: ${inlineList(placeable.clipVocabulary, 'none registered')}`,
          ),
        ),
        canvas: `${String(input.canvas.width)} x ${String(input.canvas.height)} scene units, mastered for ${input.masterAspect}.`,
        aspects: inlineList([...dedupeAspects(input.masterAspect, input.deliverables)]),
        rhythm: `The style cuts ${input.camera.cutRhythm}, with a nominal shot of ${String(input.camera.defaultShotMs)} ms.`,
        targetShots: targetShotCount({
          sceneDurationMs: input.sceneDurationMs,
          camera: input.camera,
          beatCount: input.scene.beats.length,
        }),
        framings: inlineList([...SHOT_FRAMINGS]),
        moves: inlineList([...CAMERA_MOVES]),
        priorities: inlineList([...FOCUS_PRIORITIES]),
      }).text,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (isErr(plan)) return plan;

    const assembled = this.#assemble(input, plan.value.value, safeArea, dialogue);
    if (isErr(assembled)) return assembled;

    return ok({
      shots: assembled.value,
      pacingNote: plan.value.value.pacingNote,
      safeArea,
      trace: plan.value.trace,
    });
  }

  #assemble(
    input: BuildShotListInput,
    plan: ShotListPlan,
    safeArea: NormRect,
    dialogue: readonly DialogueLine[],
  ): Result<readonly Shot[], ValidationError> {
    const byHandle = new Map(input.placeables.map((placeable) => [placeable.instance, placeable]));
    const beatByOrdinal = new Map(input.scene.beats.map((beat) => [beat.ordinal, beat]));

    const checked = checkPlanReferences(plan, byHandle, beatByOrdinal);
    if (isErr(checked)) return checked;

    const ordered = [...plan.shots].sort((left, right) => left.ordinal - right.ordinal);
    const durations = distributeDurations(
      ordered.map((shot) => shot.weight),
      input.sceneDurationMs,
      input.fps,
    );
    if (isErr(durations)) return durations;

    const reframeTargets = dedupeAspects(input.masterAspect, input.deliverables);
    const shots: Shot[] = [];
    let elapsedMs = 0;

    for (const [index, planned] of ordered.entries()) {
      const durationMs = at(durations.value, index);
      const layout = buildLayout(planned, byHandle, input.canvas);
      const focusTarget = {
        instance: planned.focusInstance,
        region: planned.focusRegion,
        priority: planned.focusPriority,
      };

      const candidate = {
        id: this.#deps.ids.shot(),
        index,
        durationMs,
        beatRef: (beatByOrdinal.get(planned.beatOrdinal) ?? at(input.scene.beats, 0)).id,
        sceneSpace: {
          size: input.canvas,
          masterAspect: input.masterAspect,
          reframeTargets,
          overrides: {},
        },
        camera: { framing: planned.framing, move: planned.move, focusTarget },
        layout,
        blocking: buildBlocking(planned, durationMs),
        dialogue: sliceDialogue(planned, dialogue, elapsedMs, durationMs),
        audio: { sfx: [], music: null },
        safeArea,
        focusTarget,
      };

      // Parsed rather than cast. `Shot`'s own refinement is what catches a focus target or
      // a blocking action pointing at a handle that is not in this shot's layout, and
      // re-implementing that check here would give us two versions of it.
      const parsed = Shot.safeParse(candidate);
      if (!parsed.success) {
        return err(
          new ValidationError({
            message: `Shot ${String(planned.ordinal)} of scene "${input.scene.title}" is not a valid shot`,
            context: {
              reason: 'invalid-shot',
              ordinal: planned.ordinal,
              paths: parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
            },
          }),
        );
      }

      shots.push(parsed.data);
      elapsedMs += durationMs;
    }

    return ok(shots);
  }
}

// ── assembly helpers ────────────────────────────────────────────────────────

function dedupeAspects(
  master: DeliveryAspect,
  deliverables: readonly DeliveryAspect[],
): readonly DeliveryAspect[] {
  return [...new Set<DeliveryAspect>([master, ...deliverables])];
}

/**
 * Every reference the plan makes, checked before anything is assembled.
 *
 * All classes of problem are reported together rather than failing on the first, because a
 * director that used two unknown handles used them for a reason and a caller fixing them
 * one round-trip at a time is a caller paying for four calls.
 */
export function checkPlanReferences(
  plan: ShotListPlan,
  placeables: ReadonlyMap<string, PlaceableAsset>,
  beats: ReadonlyMap<number, { readonly id: string }>,
): Result<true, ValidationError> {
  const unknownHandles = new Set<string>();
  const unknownBeats = new Set<number>();
  const unknownClips = new Set<string>();
  const unplacedFocus = new Set<string>();

  for (const shot of plan.shots) {
    if (!beats.has(shot.beatOrdinal)) unknownBeats.add(shot.beatOrdinal);

    const placed = new Set<string>();
    for (const instance of shot.instances) {
      if (placeables.has(instance.instance)) placed.add(instance.instance);
      else unknownHandles.add(instance.instance);
    }

    for (const action of shot.blocking) {
      const placeable = placeables.get(action.instance);
      if (placeable === undefined) {
        unknownHandles.add(action.instance);
        continue;
      }
      if (!placeable.clipVocabulary.includes(action.clip)) {
        unknownClips.add(`${action.instance}:${action.clip}`);
      }
    }

    if (shot.focusInstance !== null && !placed.has(shot.focusInstance)) {
      unplacedFocus.add(shot.focusInstance);
    }
  }

  const problems: string[] = [];
  if (unknownHandles.size > 0) {
    problems.push(`unknown asset handles: ${[...unknownHandles].join(', ')}`);
  }
  if (unknownBeats.size > 0) {
    problems.push(`beats that are not in this scene: ${[...unknownBeats].join(', ')}`);
  }
  if (unknownClips.size > 0) {
    problems.push(`clips outside the asset's vocabulary: ${[...unknownClips].join(', ')}`);
  }
  if (unplacedFocus.size > 0) {
    problems.push(
      `focus targets that are not staged in their own shot: ${[...unplacedFocus].join(', ')}`,
    );
  }

  if (problems.length > 0) {
    return err(
      new ValidationError({
        message: `The shot plan references things that do not exist - ${problems.join('; ')}`,
        context: {
          reason: 'dangling-shot-reference',
          unknownHandles: [...unknownHandles],
          unknownBeats: [...unknownBeats],
          unknownClips: [...unknownClips],
          unplacedFocus: [...unplacedFocus],
        },
      }),
    );
  }
  return ok(true);
}

function buildLayout(
  planned: ShotPlan,
  placeables: ReadonlyMap<string, PlaceableAsset>,
  canvas: Size,
): readonly ShotLayer[] {
  const bands = new Map<LayerBand, AssetInstance[]>();

  for (const instance of planned.instances) {
    const placeable = placeables.get(instance.instance);
    // `checkPlanReferences` already proved every handle resolves; this narrows the type.
    if (placeable === undefined) continue;

    const band = instance.band;
    const list = bands.get(band) ?? [];
    list.push({
      instance: instance.instance,
      assetId: placeable.assetId,
      assetVersionId: placeable.assetVersionId,
      ...(placeable.variantId === undefined ? {} : { variantId: placeable.variantId }),
      transform: {
        position: { x: instance.x * canvas.width, y: instance.y * canvas.height },
        rotation: 0,
        scale: { x: instance.scale, y: instance.scale },
        skew: { x: 0, y: 0 },
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      depth: instance.depth,
    });
    bands.set(band, list);
  }

  // Paint order is contiguous over the bands that are actually used: `ShotLayer.z` must be
  // unique, and a gap would be harmless but would make a diff of two shots read as a
  // change of depth when only an empty band was dropped.
  return LAYER_BANDS.filter((band) => (bands.get(band)?.length ?? 0) > 0).map((band, index) => ({
    z: index,
    name: band,
    instances: bands.get(band) ?? [],
    // `BAND_Z` is retained as the canonical depth ordering even though `z` is compacted;
    // it is what decides which band paints first when a shot uses only two of the three.
  }));
}

function buildBlocking(planned: ShotPlan, durationMs: number): readonly ShotAction[] {
  return planned.blocking.map((action) => ({
    instance: action.instance,
    clip: action.clip,
    startMs: Math.round(action.startFraction * durationMs),
    durationMs: Math.max(1, Math.round(action.durationFraction * durationMs)),
    loop: action.loop,
    speed: 1,
    blendMs: 0,
  }));
}

/**
 * Re-bases the scene's lines onto the shot that carries them.
 *
 * `DialogueLine.startMs` is "an offset from the start of the shot", and the scene writer
 * timed everything from the start of the *scene*. Getting this wrong puts every line in
 * the last shot at the wrong second, which reads as a lip-sync bug three stages later.
 */
function sliceDialogue(
  planned: ShotPlan,
  dialogue: readonly DialogueLine[],
  shotStartMs: number,
  durationMs: number,
): readonly DialogueLine[] {
  return planned.dialogueLineIndexes
    .map((index) => dialogue[index])
    .filter((line): line is DialogueLine => line !== undefined)
    .map((line) => ({
      ...line,
      startMs: Math.min(Math.max(0, line.startMs - shotStartMs), Math.max(0, durationMs - 1)),
    }));
}

/** The canonical depth ordering of the three bands. Exported for the choreographer. */
export function bandDepthOrder(band: LayerBand): number {
  return BAND_Z[band];
}
