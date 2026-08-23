/**
 * What a preset *is*, and why it is not simply a stored `StyleBibleDraft`.
 *
 * Two reasons.
 *
 *  1. **A preset has a localised identity and a bible does not.** `StyleBible.name` is
 *     one `Label`, because a bible is a machine document. A preset is a thing a person
 *     picks off a shelf, and the shelf is Persian-first, so it carries `LocalisedText`
 *     for both its name and its description.
 *  2. **A preset never stores its prompt fragments.** They are compiled from
 *     `visual` at load. If a preset shipped hand-written prompt text, then editing a
 *     preset's `shading.steps` in the UI would change the checksum and the asset keys
 *     and nothing at all about the pixels - which is the precise failure the whole
 *     derived-prompt design exists to prevent. Compiling them here means a preset
 *     cannot drift from its own description even in principle.
 */

import {
  type ArtMedium,
  type LocalisedText,
  MotionStyle,
  RenderTreatment,
  type Slug,
  StyleBibleDraft,
  VisualStyle,
} from '@rv/contracts';
import type { z } from 'zod';

import { compilePromptFragments } from '../prompts/compile';

/**
 * A preset as its author writes it.
 *
 * The blocks are schema *inputs*, not outputs, so a preset omits everything it is happy
 * to take the default for - which keeps the interesting fields of each preset visible
 * instead of buried in thirty restatements of a default.
 */
export interface StylePresetDefinition {
  readonly id: Slug;
  readonly name: LocalisedText;
  readonly description: LocalisedText;
  /**
   * The base seed every asset in this style is generated from.
   *
   * Distinct per preset so two styles never accidentally produce the same composition
   * from the same prompt, and fixed per preset so a style is reproducible a year later.
   */
  readonly seed: number;
  readonly visual: z.input<typeof VisualStyle>;
  readonly motion: z.input<typeof MotionStyle>;
  readonly render?: z.input<typeof RenderTreatment>;
  /** Why this style exists and what it is for. Carried onto the bible. */
  readonly notes?: string;
}

/** A preset after validation, with its prompts compiled. */
export interface StylePreset {
  readonly id: Slug;
  readonly name: LocalisedText;
  readonly description: LocalisedText;
  readonly medium: ArtMedium;
  readonly draft: StyleBibleDraft;
}

export interface PresetDraftOptions {
  /**
   * Which locale supplies `StyleBible.name`.
   *
   * Defaults to Persian because that is the product's default UI locale; English is
   * available for anyone who would rather have a greppable name in the logs.
   */
  readonly locale?: keyof LocalisedText;
}

/**
 * Validates a definition and compiles its prompts.
 *
 * Throws rather than returning a `Result`: a malformed preset is programmer error in
 * this repository's own source, and the earliest possible failure is at module load
 * rather than when a user picks it off the shelf.
 */
export function toStylePreset(
  definition: StylePresetDefinition,
  options: PresetDraftOptions = {},
): StylePreset {
  const visual = VisualStyle.parse(definition.visual);
  const motion = MotionStyle.parse(definition.motion);
  const render = RenderTreatment.parse(definition.render ?? {});
  const locale = options.locale ?? 'fa';

  const draft = StyleBibleDraft.parse({
    name: definition.name[locale] ?? definition.name.fa,
    origin: 'preset',
    visual,
    motion,
    render,
    prompts: compilePromptFragments({ visual }),
    anchors: [],
    seed: definition.seed,
    ...(definition.notes === undefined ? {} : { notes: definition.notes }),
  });

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    medium: visual.medium,
    draft,
  };
}
