/**
 * S3 Cast: a character sheet, psychology first.
 *
 * CHIRON (prior-art §B) is the whole shape of this use-case, and it is expressed as a
 * *call order* rather than as an instruction. Two calls, and the second one cannot see
 * anything the first did not produce:
 *
 *  1. **Who they are.** Identity, the dramatic engine (want / need / wound / lie / ghost),
 *     the voice block, the arc, and how they move.
 *  2. **What they look like**, derived from (1) plus the locked style. This call is made
 *     by the art director and is shown the psychology and nothing else about the plot,
 *     which is what makes "derived" true rather than aspirational. It also has to name
 *     which psychological traits drove the silhouette and the palette (RV-082) - a
 *     derivation nobody can state is a decoration.
 *
 * Doing it in one call is cheaper and produces a character whose appearance was invented
 * beside their psychology rather than out of it, which is exactly the failure the
 * ordering exists to prevent.
 *
 * The wardrobe, expression and pose sets come back **empty** here on purpose. They are
 * `GenerateCharacterStatesUseCase`'s job, because each of them has to arrive as a finished
 * image prompt and that is a different piece of work from deciding who someone is.
 */

import { z } from 'zod';
import {
  CharacterArc,
  CharacterIdentity,
  CharacterPsych,
  type CharacterPayload,
  CharacterVisual,
  CharacterVoice,
  KnowledgeScope,
  Label,
  MotionSignature,
  Prose,
} from '@rv/contracts';
import { PromptTemplate, type StructuredTrace } from '@rv/prompt-kit';
import { type AppError, ConflictError, type Result, err, isErr, ok } from '@rv/shared-kernel';

import { ART_DIRECTOR, SCREENWRITER } from '../roles/index';
import type { CastCandidate } from '../intake/normalised-brief';
import { type OutlineContext, renderOutlineContext } from '../outline/context';
import { bulletList, inlineList, orElse } from '../support/format';
import type { StyleBrief } from '../support/style-brief';
import { type StoryEngineDeps, TraceLog, runRoleCall } from '../support/stage-call';
import {
  MIN_DISTINCT_AXES,
  type NamedVoice,
  type VoiceComparison,
  collisions,
  compareAgainstCast,
} from './voice-distinctness';

// ── the two drafts ──────────────────────────────────────────────────────────

/**
 * Everything a character is before anyone has drawn them.
 *
 * `arc.turningPoints` is omitted: it points at `BeatId`s that do not exist yet, and asking
 * a model to invent prefixed ULIDs produces ids that look right and resolve to nothing.
 * The arc is attached to beats later, by the code that has them.
 */
export const CharacterCoreDraft = z.strictObject({
  identity: CharacterIdentity,
  psych: CharacterPsych,
  voice: CharacterVoice,
  arc: CharacterArc.omit({ turningPoints: true }),
  motionSignature: MotionSignature,
  knowledgeScope: KnowledgeScope.describe(
    'Almost always "limited". "omniscient" switches off dramatic irony for this character ' +
      'and should be reserved for a narrator or a god.',
  ),
});
export type CharacterCoreDraft = z.infer<typeof CharacterCoreDraft>;

/**
 * Which psychological traits produced which visual choice.
 *
 * The field that makes the derivation auditable. A silhouette note traceable to "guarded,
 * carries the wound in her shoulders" is a design decision; one traceable to nothing is a
 * preference, and preferences drift between characters.
 */
export const VisualDerivation = z.strictObject({
  silhouetteFrom: z
    .array(Label)
    .min(1)
    .max(6)
    .describe('The psych traits that drove silhouetteNote. Name them as they appear in psych.'),
  paletteFrom: z
    .array(Label)
    .min(1)
    .max(6)
    .describe('The psych traits that drove the palette choice.'),
  note: Prose.describe(
    'One paragraph explaining the derivation, written so a reader who disagrees can say ' +
      'which step they disagree with.',
  ),
});
export type VisualDerivation = z.infer<typeof VisualDerivation>;

/** The appearance call's output: the derived descriptor, minus everything S3b generates. */
export const CharacterVisualDraft = z.strictObject({
  visual: CharacterVisual.omit({ wardrobe: true, expressionSet: true, poseSet: true }),
  derivation: VisualDerivation,
});
export type CharacterVisualDraft = z.infer<typeof CharacterVisualDraft>;

// ── prompts ─────────────────────────────────────────────────────────────────

const CORE_PROMPT = new PromptTemplate<{
  readonly seriesContext: string;
  readonly name: string;
  readonly role: string;
  readonly importance: string;
  readonly premiseRole: string;
  readonly distinguishingTrait: string;
  readonly existingVoices: string;
  readonly directive: string;
}>(
  'cast.core',
  [
    '{{seriesContext}}',
    '',
    '## The character',
    'Name: {{name}}',
    'Structural role: {{role}} ({{importance}})',
    'What they do to the story: {{premiseRole}}',
    'What makes them not interchangeable: {{distinguishingTrait}}',
    '',
    '## Your task',
    'Write this character from the inside out.',
    '',
    'Start with the dramatic engine and make it contradict itself: the want is what they',
    'would say out loud, the need is what they would deny, and the lie is what the wound',
    'left behind. A want and a need that point the same way is a character with nothing to',
    'do.',
    '',
    'The voice block is binding on everyone who writes for them afterwards, so make it',
    'specific enough to be violated. "Measured, neutral, no humour" describes half the',
    'people who have ever lived and constrains nobody.',
    '',
    'The motion signature is read as numbers by the rig, not as inspiration. Say what the',
    'body does when nothing is happening, and what it does when they lie.',
    '',
    '## Voices already in this cast - yours must not be confusable with any of them',
    '{{existingVoices}}',
    '',
    '{{directive}}',
  ].join('\n'),
);

const VISUAL_PROMPT = new PromptTemplate<{
  readonly styleName: string;
  readonly medium: string;
  readonly silhouetteRule: string;
  readonly shapeNote: string;
  readonly paletteNames: string;
  readonly styleNegative: string;
  readonly name: string;
  readonly identity: string;
  readonly psychology: string;
  readonly motion: string;
}>(
  'cast.visual',
  [
    '## The locked style you are designing inside',
    'Style: {{styleName}} ({{medium}})',
    'Silhouette rule every design must satisfy: {{silhouetteRule}}',
    'Shape language: {{shapeNote}}',
    'Series palette - choose from these, do not invent colours: {{paletteNames}}',
    'Never appears: {{styleNegative}}',
    '',
    '## The character, as written',
    'Name: {{name}}',
    '{{identity}}',
    '',
    '### Psychology',
    '{{psychology}}',
    '',
    '### How they move',
    '{{motion}}',
    '',
    '## Your task',
    'Derive how this person looks from who they are. Every choice - build, contour, marks,',
    'colour - must answer to something above. Then record which traits drove the silhouette',
    'and which drove the palette; if you cannot name them, the choice was arbitrary and you',
    'should make a different one.',
    '',
    'Do not design outfits, expressions or poses here. Those are generated separately, from',
    'this descriptor.',
  ].join('\n'),
);

// ── the use-case ────────────────────────────────────────────────────────────

export interface GenerateCharacterSheetInput {
  readonly context: OutlineContext;
  readonly candidate: CastCandidate;
  readonly style: StyleBrief;
  /** Voices already minted for this series. The distinctness check runs against these. */
  readonly existingCast?: readonly NamedVoice[];
  readonly signal?: AbortSignal;
}

export interface CharacterSheetResult {
  readonly name: string;
  readonly payload: CharacterPayload;
  readonly derivation: VisualDerivation;
  /** How this voice compares to every other in the cast. Empty for the first character. */
  readonly voiceComparisons: readonly VoiceComparison[];
  /** True when the voice had to be regenerated to clear the distinctness bar. */
  readonly regeneratedForDistinctness: boolean;
  readonly traces: readonly StructuredTrace[];
}

export class GenerateCharacterSheetUseCase {
  readonly #deps: StoryEngineDeps;

  constructor(deps: StoryEngineDeps) {
    this.#deps = deps;
  }

  async execute(
    input: GenerateCharacterSheetInput,
  ): Promise<Result<CharacterSheetResult, AppError>> {
    const traces = new TraceLog();
    const cast = input.existingCast ?? [];

    const first = await this.#writeCore(input, cast, undefined);
    if (isErr(first)) return first;
    traces.add(first.value.trace);

    let core = first.value.value;
    let comparisons = compareAgainstCast(core.voice, cast);
    let regenerated = false;

    // One bounded retry, and one only. A second failure is not a sampling accident - it
    // means the cast has filled the axis space, and that is a decision for a human.
    if (collisions(comparisons).length > 0) {
      const second = await this.#writeCore(input, cast, collisions(comparisons));
      if (isErr(second)) return second;
      traces.add(second.value.trace);
      core = second.value.value;
      comparisons = compareAgainstCast(core.voice, cast);
      regenerated = true;

      const stillColliding = collisions(comparisons);
      if (stillColliding.length > 0) {
        return err(
          new ConflictError({
            message:
              `"${input.candidate.name}" still sounds like ` +
              `${stillColliding.map((collision) => `"${collision.against}"`).join(', ')} after a ` +
              `regeneration turn: fewer than ${String(MIN_DISTINCT_AXES)} of ` +
              'register/verbosity/idiolect/sentenceRhythm/humourMode differ',
            context: {
              reason: 'voice-not-distinct',
              character: input.candidate.name,
              against: stillColliding.map((collision) => collision.against),
            },
          }),
        );
      }
    }

    const visual = await this.#deriveVisual(input, core);
    if (isErr(visual)) return visual;
    traces.add(visual.value.trace);

    const payload: CharacterPayload = {
      identity: core.identity,
      psych: core.psych,
      voice: core.voice,
      // The arc's turning points are bound to beats once the outline has them; a sheet
      // written before the beats exist honestly has none.
      arc: { ...core.arc, turningPoints: [] },
      visual: {
        ...visual.value.value.visual,
        wardrobe: [],
        expressionSet: [],
        poseSet: [],
      },
      motionSignature: core.motionSignature,
      knowledgeScope: core.knowledgeScope,
    };

    return ok({
      name: input.candidate.name,
      payload,
      derivation: visual.value.value.derivation,
      voiceComparisons: comparisons,
      regeneratedForDistinctness: regenerated,
      traces: traces.traces,
    });
  }

  async #writeCore(
    input: GenerateCharacterSheetInput,
    cast: readonly NamedVoice[],
    colliding: readonly VoiceComparison[] | undefined,
  ): Promise<Result<{ value: CharacterCoreDraft; trace: StructuredTrace }, AppError>> {
    return runRoleCall<CharacterCoreDraft>(this.#deps, {
      role: SCREENWRITER,
      schemaName: 'CharacterCoreDraft',
      schema: CharacterCoreDraft,
      user: CORE_PROMPT.render({
        seriesContext: renderOutlineContext(input.context),
        name: input.candidate.name,
        role: input.candidate.role,
        importance: input.candidate.importance,
        premiseRole: input.candidate.premiseRole,
        distinguishingTrait: input.candidate.distinguishingTrait,
        existingVoices: bulletList(cast.map(describeVoice), 'none yet - this is the first'),
        directive:
          colliding === undefined
            ? 'No additional directive.'
            : 'Your previous attempt sounded like ' +
              colliding.map((collision) => `"${collision.against}"`).join(', ') +
              `. Change at least ${String(MIN_DISTINCT_AXES)} of register, verbosity, ` +
              'idiolect, sentence rhythm and humour mode so this character is audibly a ' +
              'different person - and change the psychology that justifies it, not only the ' +
              'labels.',
      }).text,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async #deriveVisual(
    input: GenerateCharacterSheetInput,
    core: CharacterCoreDraft,
  ): Promise<Result<{ value: CharacterVisualDraft; trace: StructuredTrace }, AppError>> {
    return runRoleCall<CharacterVisualDraft>(this.#deps, {
      role: ART_DIRECTOR,
      schemaName: 'CharacterVisualDraft',
      schema: CharacterVisualDraft,
      user: VISUAL_PROMPT.render({
        styleName: input.style.name,
        medium: input.style.medium,
        silhouetteRule: input.style.silhouetteRule,
        shapeNote: input.style.shapeNote,
        paletteNames: inlineList(input.style.paletteNames, 'no palette declared'),
        styleNegative: orElse(input.style.negativeFragment, 'nothing declared'),
        name: input.candidate.name,
        identity: describeIdentity(core),
        psychology: describePsych(core),
        motion: describeMotion(core),
      }).text,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
}

// ── prompt rendering ────────────────────────────────────────────────────────

export function describeVoice(member: NamedVoice): string {
  const { voice } = member;
  return (
    `${member.name}: ${voice.register}/${voice.verbosity}, rhythm ${voice.sentenceRhythm}, ` +
    `humour ${voice.humourMode}, idiolect ${inlineList(voice.idiolect, 'none')}`
  );
}

function describeIdentity(core: CharacterCoreDraft): string {
  const { identity } = core;
  return [
    `Age: ${identity.age}`,
    `Gender: ${identity.gender}`,
    `Species: ${identity.species}`,
    `Occupation: ${identity.occupation}`,
    `Origin: ${identity.origin}`,
  ].join('\n');
}

function describePsych(core: CharacterCoreDraft): string {
  const { psych } = core;
  const t = psych.temperament;
  return [
    `Want: ${psych.want}`,
    `Need: ${psych.need}`,
    `Wound: ${psych.wound}`,
    `Lie: ${psych.lie}`,
    `Ghost: ${psych.ghost}`,
    `Virtues: ${inlineList(psych.virtues)}`,
    `Flaws: ${inlineList(psych.flaws)}`,
    `Fears: ${inlineList(psych.fears)}`,
    `Values: ${inlineList(psych.values)}`,
    `Temperament (-1..1): warmth ${t.warmth.toFixed(2)}, dominance ${t.dominance.toFixed(2)}, ` +
      `volatility ${t.volatility.toFixed(2)}, openness ${t.openness.toFixed(2)}, ` +
      `conscientiousness ${t.conscientiousness.toFixed(2)}`,
  ].join('\n');
}

function describeMotion(core: CharacterCoreDraft): string {
  const motion = core.motionSignature;
  return [
    `Gait: ${motion.gaitStyle}`,
    `Posture: ${motion.posture}`,
    `Gesture frequency: ${motion.gestureFrequency.toFixed(2)}`,
    `Energy: ${motion.energy.toFixed(2)}`,
    `Idle: ${motion.idleBehaviour}`,
    `Tell on lying: ${motion.tellOnLying}`,
  ].join('\n');
}
