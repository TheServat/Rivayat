/**
 * Composing the text an image model is actually handed.
 *
 * `NamedVisualState.description` says it plainly: "This text is the generation prompt".
 * So a state is not finished when a writer has described a face - it is finished when the
 * style clause, the character's derived descriptor, the outfit and the state body have
 * been composed into one string that can be posted to an image endpoint unmodified.
 *
 * Doing that composition *here*, deterministically, rather than asking the model to do it
 * has three consequences worth the file:
 *
 *  - The style fragment is present in every single prompt, identically. A model asked to
 *    "remember to include the style" includes it in seven prompts out of nine.
 *  - The prompts hash stably, so the asset registry's `specHash` changes when - and only
 *    when - something a human edited changed.
 *  - A user editing one state's body text does not have to re-type the style clause, and
 *    cannot accidentally delete it.
 */

import type { CharacterVisual, NamedColor, WardrobeSet } from '@rv/contracts';
import { composePrompt, section } from '@rv/prompt-kit';

import { inlineList, orElse } from '../support/format';
import type { StyleBrief } from '../support/style-brief';

/** The derived descriptor, rendered once and reused by every state prompt. */
export interface CharacterDescriptor {
  readonly name: string;
  readonly visual: Pick<
    CharacterVisual,
    'silhouetteNote' | 'build' | 'height' | 'palette' | 'distinguishingMarks'
  >;
  readonly species: string;
  readonly age: string;
}

function paletteNames(palette: readonly NamedColor[]): readonly string[] {
  return palette.map((color) => `${color.name} ${color.hex}`);
}

/** The block that identifies this character, identical across all of their prompts. */
export function renderCharacterDescriptor(descriptor: CharacterDescriptor): string {
  const { visual } = descriptor;
  return [
    `${descriptor.name}, ${descriptor.age}, ${descriptor.species}.`,
    `Build: ${visual.build}. Height: ${visual.height}.`,
    `Silhouette: ${visual.silhouetteNote}`,
    `Colours: ${inlineList(paletteNames(visual.palette), 'series palette')}`,
    `Identifying marks: ${inlineList(visual.distinguishingMarks, 'none')}`,
  ].join('\n');
}

export interface StatePromptInput {
  readonly style: StyleBrief;
  readonly descriptor: CharacterDescriptor;
  /** The outfit worn in this prompt. Absent for a wardrobe-agnostic reference. */
  readonly wardrobe?: Pick<WardrobeSet, 'label' | 'description'>;
  /** What the state is called, e.g. "cornered". */
  readonly label: string;
  /** The body of the state: brow, mouth, shoulders, hands, weight. Never a feeling. */
  readonly body: string;
  /** 0 is a suggestion, 1 is theatrical. Passed through to the prompt as a stated value. */
  readonly intensity: number;
  /** "facial expression" or "full-body pose" - what the frame is of. */
  readonly framing: string;
}

/**
 * Builds one finished image prompt.
 *
 * Order is deliberate and stable: style first (image models weight early tokens more
 * heavily and the style must win), then who this is, then what they are wearing, then what
 * they are doing, then the negatives. Reordering it changes every `specHash` in the
 * library, so it is a decision, not a formatting preference.
 */
export function composeStatePrompt(input: StatePromptInput): string {
  return composePrompt(
    input.style.positiveFragment,
    input.style.characterFragment,
    section('Character', renderCharacterDescriptor(input.descriptor)),
    input.wardrobe === undefined
      ? undefined
      : section('Wearing', `${input.wardrobe.label}. ${input.wardrobe.description}`),
    section(
      input.framing,
      `${input.label}: ${input.body}\nPush the state to ${input.intensity.toFixed(2)} of this character's full range.`,
    ),
    section('Composition', input.style.silhouetteRule),
    section('Never include', orElse(input.style.negativeFragment, 'nothing declared')),
  );
}
