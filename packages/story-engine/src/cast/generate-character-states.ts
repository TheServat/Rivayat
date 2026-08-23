/**
 * S3b Cast: the character in every state the story needs, as finished image prompts.
 *
 * This is the use-case the owner named explicitly, and the standard it is held to is
 * blunt: **a character who arrives with three expressions and one outfit is a failure of
 * this code, not of the artist.** docs/01 §4 puts "expression set, pose set, wardrobe, and
 * the generation prompts for each" inside S3 for that reason - the asset pipeline
 * downstream can only produce what it was asked for, and everything it is asked for is
 * decided here.
 *
 * Three things make the output usable rather than merely present:
 *
 *  - **Minimum counts, enforced with a bounded top-up turn.** RV-083 sets 8 expressions, 6
 *    poses, 2 wardrobe sets. A short first response is normal and cheap to fix; a short
 *    second response is a finding, not something to paper over.
 *  - **Unique, stable slugs.** A slug becomes part of an asset variant key, so a duplicate
 *    is two different pictures competing for one cache entry. Duplicates are dropped
 *    rather than renamed, because a renamed slug silently invalidates artwork that already
 *    exists.
 *  - **Composed prompts, not adjectives.** Every `description` returned here is the exact
 *    text an image model receives. See `state-prompt.ts`.
 *
 * The cartesian demand - every outfit crossed with every expression and pose - is computed
 * here too, deterministically, so the resolve stage can price the whole character before
 * anything is generated.
 */

import { z } from 'zod';
import {
  type CharacterPayload,
  type CharacterVisual,
  Label,
  NamedColor,
  type NamedVisualState,
  Prose,
  type SemanticKey,
  Slug,
  StoryInterval,
  Unit01,
  type WardrobeSet,
} from '@rv/contracts';
import { PromptTemplate, type StructuredTrace } from '@rv/prompt-kit';
import { type AppError, type Result, ValidationError, err, isErr, ok } from '@rv/shared-kernel';

import { ART_DIRECTOR } from '../roles/index';
import { bulletList, inlineList, slugify } from '../support/format';
import type { StyleBrief } from '../support/style-brief';
import { type StoryEngineDeps, TraceLog, runRoleCall } from '../support/stage-call';
import { type CharacterDescriptor, composeStatePrompt } from './state-prompt';

// ── the counts this use-case is answerable for ──────────────────────────────

/** RV-083's floor. Raising a minimum is legal; lowering one is a product decision. */
export const STATE_MINIMA = {
  expressions: 8,
  poses: 6,
  wardrobe: 2,
} as const;

/** Guard against a cartesian blow-up: 8 outfits × 32 states is a bill, not a character. */
export const MAX_VARIANT_DEMAND = 256;

// ── drafts ──────────────────────────────────────────────────────────────────

/**
 * One state, as the art director writes it.
 *
 * `body` rather than `description`, and the distinction is the point: the model supplies
 * the *body* of the state and the code composes it into the finished prompt. A model asked
 * for the whole prompt spends most of its output re-typing the style clause, and gets it
 * subtly wrong on the seventh one.
 */
export const VisualStateDraft = z.strictObject({
  slug: Slug.describe(
    'Stable lowercase-hyphenated key, e.g. "cornered". It becomes part of the asset ' +
      'variant key and must never change once artwork exists, so choose a name for the ' +
      'state rather than for this moment in the plot.',
  ),
  label: Label.describe('Human-readable name, e.g. "cornered".'),
  body: Prose.describe(
    'What this state looks like on the body: brow, eyes, mouth, jaw, shoulders, hands, ' +
      'weight. Describe the body, never the feeling - an image model cannot render an ' +
      'adjective.',
  ),
  intensity: Unit01.default(0.7).describe('0 is a suggestion, 1 is theatrical.'),
});
export type VisualStateDraft = z.infer<typeof VisualStateDraft>;

export const WardrobeDraft = z.strictObject({
  slug: Slug.describe('The outfit id, e.g. "wardrobe-winter". Used verbatim as a variant key.'),
  label: Label,
  description: Prose.describe(
    'Garment by garment, including fabric, wear, and how it sits on the body. What the ' +
      'clothes say about the person wearing them is what makes this worth generating.',
  ),
  validity: StoryInterval.default({ from: null, until: null }).describe(
    'When in the story this outfit is worn. Leave both ends null for the default outfit.',
  ),
  palette: z
    .array(NamedColor)
    .max(12)
    .default([])
    .describe('The outfit colours, chosen from the series palette.'),
});
export type WardrobeDraft = z.infer<typeof WardrobeDraft>;

/**
 * The whole state set.
 *
 * The array minima are deliberately `1`, not RV-083's real floor. A response one
 * expression short should be topped up with a targeted second call that knows what is
 * already there, not repaired by a generic "your JSON was wrong" turn that regenerates all
 * eight and renames the ones that were fine.
 */
export const CharacterStateSetDraft = z.strictObject({
  expressions: z
    .array(VisualStateDraft)
    .min(1)
    .max(32)
    .describe(
      'The faces this character needs across the series. Cover the range the story asks ' +
        'for, not the range that is easy: if they are humiliated in episode four, that face ' +
        'belongs here.',
    ),
  poses: z
    .array(VisualStateDraft)
    .min(1)
    .max(32)
    .describe(
      'Whole-body attitudes: how they stand, sit, retreat, threaten, wait. The body is a ' +
        'second face and is on screen far more often.',
    ),
  wardrobe: z
    .array(WardrobeDraft)
    .min(1)
    .max(16)
    .describe('Every outfit, each bounded in story time. A default outfit at minimum.'),
});
export type CharacterStateSetDraft = z.infer<typeof CharacterStateSetDraft>;

// ── prompts ─────────────────────────────────────────────────────────────────

const STATES_PROMPT = new PromptTemplate<{
  readonly styleName: string;
  readonly silhouetteRule: string;
  readonly paletteNames: string;
  readonly name: string;
  readonly descriptor: string;
  readonly psychology: string;
  readonly motion: string;
  readonly minExpressions: number;
  readonly minPoses: number;
  readonly minWardrobe: number;
}>(
  'cast.states',
  [
    '## The locked style',
    'Style: {{styleName}}',
    'Silhouette rule: {{silhouetteRule}}',
    'Series palette: {{paletteNames}}',
    '',
    '## The character',
    'Name: {{name}}',
    '{{descriptor}}',
    '',
    '### Psychology, which every state must be answerable to',
    '{{psychology}}',
    '',
    '### How they move',
    '{{motion}}',
    '',
    '## Your task',
    'Produce the states this character has to exist in.',
    '',
    '- At least {{minExpressions}} expressions.',
    '- At least {{minPoses}} poses.',
    '- At least {{minWardrobe}} wardrobe sets.',
    '',
    'Cover the emotional range the story needs and not the range that is easy to draw. A set',
    'of neutral, happy and sad is useless: what is wanted is the face they make when the lie',
    'is challenged, the pose they hold when they are about to run, the outfit they wear when',
    'they are pretending to be someone else.',
    '',
    'Every state describes the body. Brow, eyes, mouth, jaw, shoulders, hands, weight - and',
    'for a pose, where the weight sits and what the hands are doing. Never a feeling word on',
    'its own.',
    '',
    'Slugs are permanent. They become asset variant keys, so name the state, not the scene.',
  ].join('\n'),
);

const TOP_UP_PROMPT = new PromptTemplate<{
  readonly name: string;
  readonly descriptor: string;
  readonly shortfall: string;
  readonly existing: string;
}>(
  'cast.states.top-up',
  [
    'You are adding to an existing state set for {{name}}, not replacing it.',
    '',
    '{{descriptor}}',
    '',
    '## What is still missing',
    '{{shortfall}}',
    '',
    '## What already exists - do not repeat these slugs, and do not restate these states',
    '{{existing}}',
    '',
    'Return only the additional states. The same rules apply: describe the body, choose',
    'permanent slugs, and pick states the story actually needs rather than the obvious ones',
    'that are left.',
  ].join('\n'),
);

// ── the use-case ────────────────────────────────────────────────────────────

export interface GenerateCharacterStatesInput {
  readonly name: string;
  readonly payload: CharacterPayload;
  readonly style: StyleBrief;
  /**
   * The library name for this character, e.g. `kael`.
   *
   * Defaults to a slug of the name. Supplied explicitly when the canonical name is not
   * ASCII - a Persian name slugs to nothing useful, and the asset key has to be stable and
   * readable in a filesystem path.
   */
  readonly characterSlug?: string;
  readonly minima?: Partial<typeof STATE_MINIMA>;
  readonly signal?: AbortSignal;
}

/** One `(outfit × state)` the asset pipeline must produce, priced before anything is spent. */
export interface CharacterVariantDemand {
  readonly semanticKey: SemanticKey;
  readonly variantKey: Slug;
  readonly wardrobeSlug: Slug;
  readonly stateSlug: Slug;
  readonly stateKind: 'expression' | 'pose';
  readonly label: string;
  /** The finished text an image model receives. */
  readonly prompt: string;
}

export interface CharacterStatesResult {
  readonly characterSlug: string;
  readonly expressionSet: readonly NamedVisualState[];
  readonly poseSet: readonly NamedVisualState[];
  readonly wardrobe: readonly WardrobeSet[];
  /** One full-body reference per outfit. What the turnaround is generated from. */
  readonly wardrobeStates: readonly NamedVisualState[];
  readonly variants: readonly CharacterVariantDemand[];
  /** The character's `visual` block with the three sets filled in, ready to merge back. */
  readonly visual: CharacterVisual;
  readonly toppedUp: boolean;
  /** Slugs a second state tried to reuse. Dropped, never renamed. */
  readonly droppedDuplicateSlugs: readonly string[];
  readonly traces: readonly StructuredTrace[];
}

export class GenerateCharacterStatesUseCase {
  readonly #deps: StoryEngineDeps;

  constructor(deps: StoryEngineDeps) {
    this.#deps = deps;
  }

  async execute(
    input: GenerateCharacterStatesInput,
  ): Promise<Result<CharacterStatesResult, AppError>> {
    const minima = { ...STATE_MINIMA, ...(input.minima ?? {}) };
    const characterSlug = slugify(input.characterSlug ?? input.name, 'character');
    const descriptor = describeFor(input);
    const traces = new TraceLog();

    const first = await runRoleCall<CharacterStateSetDraft>(this.#deps, {
      role: ART_DIRECTOR,
      schemaName: 'CharacterStateSetDraft',
      schema: CharacterStateSetDraft,
      user: STATES_PROMPT.render({
        styleName: input.style.name,
        silhouetteRule: input.style.silhouetteRule,
        paletteNames: inlineList(input.style.paletteNames, 'no palette declared'),
        name: input.name,
        descriptor: renderDescriptorBlock(descriptor),
        psychology: describePsychology(input.payload),
        motion: describeMotion(input.payload),
        minExpressions: minima.expressions,
        minPoses: minima.poses,
        minWardrobe: minima.wardrobe,
      }).text,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (isErr(first)) return first;
    traces.add(first.value.trace);

    const dropped: string[] = [];
    let expressions = dedupeBySlug(first.value.value.expressions, dropped);
    let poses = dedupeBySlug(
      first.value.value.poses,
      dropped,
      new Set(expressions.map((s) => s.slug)),
    );
    let wardrobe = dedupeBySlug(first.value.value.wardrobe, dropped);
    let toppedUp = false;

    const shortfall = describeShortfall({ expressions, poses, wardrobe }, minima);
    if (shortfall !== undefined) {
      toppedUp = true;
      const extra = await runRoleCall<CharacterStateSetDraft>(this.#deps, {
        role: ART_DIRECTOR,
        schemaName: 'CharacterStateSetDraft',
        schema: CharacterStateSetDraft,
        user: TOP_UP_PROMPT.render({
          name: input.name,
          descriptor: renderDescriptorBlock(descriptor),
          shortfall,
          existing: bulletList([
            `Expressions: ${inlineList(
              expressions.map((state) => state.slug),
              'none',
            )}`,
            `Poses: ${inlineList(
              poses.map((state) => state.slug),
              'none',
            )}`,
            `Wardrobe: ${inlineList(
              wardrobe.map((set) => set.slug),
              'none',
            )}`,
          ]),
        }).text,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (isErr(extra)) return extra;
      traces.add(extra.value.trace);

      const stateSlugs = new Set([...expressions, ...poses].map((state) => state.slug));
      expressions = [
        ...expressions,
        ...dedupeBySlug(extra.value.value.expressions, dropped, stateSlugs),
      ];
      poses = [
        ...poses,
        ...dedupeBySlug(
          extra.value.value.poses,
          dropped,
          new Set([...stateSlugs, ...expressions.map((s) => s.slug)]),
        ),
      ];
      wardrobe = [
        ...wardrobe,
        ...dedupeBySlug(
          extra.value.value.wardrobe,
          dropped,
          new Set(wardrobe.map((set) => set.slug)),
        ),
      ];

      const remaining = describeShortfall({ expressions, poses, wardrobe }, minima);
      if (remaining !== undefined) {
        return err(
          new ValidationError({
            message: `State set for "${input.name}" is still short after a top-up turn: ${remaining}`,
            context: {
              reason: 'insufficient-states',
              character: input.name,
              expressions: expressions.length,
              poses: poses.length,
              wardrobe: wardrobe.length,
              minima,
            },
          }),
        );
      }
    }

    const wardrobeSets: WardrobeSet[] = wardrobe.map((set) => ({
      slug: set.slug,
      label: set.label,
      description: set.description,
      validity: set.validity,
      palette: set.palette,
    }));
    // The first outfit is the default: it is what a state prompt wears when the demand
    // does not name one, and it is the outfit the identity anchor is generated in.
    const defaultOutfit = wardrobeSets[0];

    const toState = (draft: VisualStateDraft, framing: string): NamedVisualState => ({
      slug: draft.slug,
      label: draft.label,
      description: composeStatePrompt({
        style: input.style,
        descriptor,
        ...(defaultOutfit === undefined ? {} : { wardrobe: defaultOutfit }),
        label: draft.label,
        body: draft.body,
        intensity: draft.intensity,
        framing,
      }),
      intensity: draft.intensity,
    });

    const expressionSet = expressions.map((draft) => toState(draft, 'Facial expression'));
    const poseSet = poses.map((draft) => toState(draft, 'Full-body pose'));

    const wardrobeStates: NamedVisualState[] = wardrobeSets.map((set) => ({
      slug: set.slug,
      label: set.label,
      description: composeStatePrompt({
        style: input.style,
        descriptor,
        wardrobe: set,
        label: set.label,
        body: set.description,
        intensity: 1,
        framing: 'Full-body reference, neutral expression, arms clear of the torso',
      }),
      intensity: 1,
    }));

    const variants = buildVariantDemand({
      characterSlug,
      style: input.style,
      descriptor,
      wardrobe: wardrobeSets,
      expressions,
      poses,
    });
    if (isErr(variants)) return variants;

    const visual: CharacterVisual = {
      ...input.payload.visual,
      wardrobe: wardrobeSets,
      expressionSet,
      poseSet,
    };

    return ok({
      characterSlug,
      expressionSet,
      poseSet,
      wardrobe: wardrobeSets,
      wardrobeStates,
      variants: variants.value,
      visual,
      toppedUp,
      droppedDuplicateSlugs: dropped,
      traces: traces.traces,
    });
  }
}

// ── deterministic keys and the cartesian demand ─────────────────────────────

/**
 * The variant key for one `(outfit, state)` pair.
 *
 * Deterministic and total: the same pair always yields the same key, which is what RV-083
 * requires and what makes an asset cache hit possible at all. Joined with a single hyphen
 * because both halves are already `Slug`s and a `Slug` may not contain a double hyphen.
 */
export function variantKeyFor(wardrobeSlug: string, stateSlug: string): Slug {
  return `${wardrobeSlug}-${stateSlug}`;
}

interface VariantDemandInput {
  readonly characterSlug: string;
  readonly style: StyleBrief;
  readonly descriptor: CharacterDescriptor;
  readonly wardrobe: readonly WardrobeSet[];
  readonly expressions: readonly VisualStateDraft[];
  readonly poses: readonly VisualStateDraft[];
}

/**
 * Every outfit crossed with every state, with its prompt already composed.
 *
 * Computed rather than generated: the cross product is arithmetic, and asking a model for
 * it would produce a list that is nearly complete and differently ordered every run.
 */
export function buildVariantDemand(
  input: VariantDemandInput,
): Result<readonly CharacterVariantDemand[], ValidationError> {
  const total = input.wardrobe.length * (input.expressions.length + input.poses.length);
  if (total > MAX_VARIANT_DEMAND) {
    return err(
      new ValidationError({
        message: `Cartesian demand for "${input.characterSlug}" is ${String(total)} variants, over the ${String(MAX_VARIANT_DEMAND)} ceiling`,
        context: { reason: 'variant-demand-too-large', total, ceiling: MAX_VARIANT_DEMAND },
      }),
    );
  }

  const demand: CharacterVariantDemand[] = [];
  for (const outfit of input.wardrobe) {
    for (const [kind, states, framing] of [
      ['expression', input.expressions, 'Facial expression'],
      ['pose', input.poses, 'Full-body pose'],
    ] as const) {
      for (const state of states) {
        demand.push({
          semanticKey: `char/${input.characterSlug}/${kind}`,
          variantKey: variantKeyFor(outfit.slug, state.slug),
          wardrobeSlug: outfit.slug,
          stateSlug: state.slug,
          stateKind: kind,
          label: `${outfit.label} / ${state.label}`,
          prompt: composeStatePrompt({
            style: input.style,
            descriptor: input.descriptor,
            wardrobe: outfit,
            label: state.label,
            body: state.body,
            intensity: state.intensity,
            framing,
          }),
        });
      }
    }
  }
  return ok(demand);
}

// ── helpers ─────────────────────────────────────────────────────────────────

interface Slugged {
  readonly slug: string;
}

/**
 * Keeps the first occurrence of each slug, recording what it dropped.
 *
 * Dropped rather than renamed. A slug is part of an asset variant key, so renaming one
 * invalidates artwork that may already exist for it - and a duplicate almost always means
 * the model produced the same state twice, in which case the second copy is not a state
 * anyone is missing.
 */
function dedupeBySlug<T extends Slugged>(
  items: readonly T[],
  dropped: string[],
  alreadySeen: ReadonlySet<string> = new Set(),
): T[] {
  const seen = new Set(alreadySeen);
  const kept: T[] = [];
  for (const item of items) {
    if (seen.has(item.slug)) {
      dropped.push(item.slug);
      continue;
    }
    seen.add(item.slug);
    kept.push(item);
  }
  return kept;
}

interface StateCounts {
  readonly expressions: readonly unknown[];
  readonly poses: readonly unknown[];
  readonly wardrobe: readonly unknown[];
}

/** What is still missing, phrased as an instruction, or `undefined` when nothing is. */
function describeShortfall(have: StateCounts, minima: typeof STATE_MINIMA): string | undefined {
  const missing: string[] = [];
  if (have.expressions.length < minima.expressions) {
    missing.push(
      `${String(minima.expressions - have.expressions.length)} more expression(s) - there are ${String(have.expressions.length)} of ${String(minima.expressions)}`,
    );
  }
  if (have.poses.length < minima.poses) {
    missing.push(
      `${String(minima.poses - have.poses.length)} more pose(s) - there are ${String(have.poses.length)} of ${String(minima.poses)}`,
    );
  }
  if (have.wardrobe.length < minima.wardrobe) {
    missing.push(
      `${String(minima.wardrobe - have.wardrobe.length)} more wardrobe set(s) - there are ${String(have.wardrobe.length)} of ${String(minima.wardrobe)}`,
    );
  }
  return missing.length === 0 ? undefined : missing.join('; ');
}

function describeFor(input: GenerateCharacterStatesInput): CharacterDescriptor {
  return {
    name: input.name,
    visual: input.payload.visual,
    species: input.payload.identity.species,
    age: input.payload.identity.age,
  };
}

function renderDescriptorBlock(descriptor: CharacterDescriptor): string {
  return [
    `${descriptor.age}, ${descriptor.species}, build ${descriptor.visual.build}, ${descriptor.visual.height}.`,
    `Silhouette: ${descriptor.visual.silhouetteNote}`,
    `Marks: ${inlineList(descriptor.visual.distinguishingMarks, 'none')}`,
  ].join('\n');
}

function describePsychology(payload: CharacterPayload): string {
  const { psych } = payload;
  return [
    `Want: ${psych.want}`,
    `Need: ${psych.need}`,
    `Wound: ${psych.wound}`,
    `Lie: ${psych.lie}`,
    `Fears: ${inlineList(psych.fears)}`,
    `Flaws: ${inlineList(psych.flaws)}`,
  ].join('\n');
}

function describeMotion(payload: CharacterPayload): string {
  const motion = payload.motionSignature;
  return `Gait ${motion.gaitStyle}, posture ${motion.posture}, energy ${motion.energy.toFixed(2)}. Idle: ${motion.idleBehaviour}`;
}
