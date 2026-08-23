/**
 * Per-model phrasing overrides.
 *
 * Only one lane actually needs one, and it needs it badly. Research §2: the local
 * ComfyUI lane conditions on CLIP-L (SD 1.5) or CLIP-L + OpenCLIP-bigG (SDXL), both
 * capped at **77 tokens** and both read close to bag-of-words. The natural-language
 * positive clause this engine compiles runs to two hundred tokens of subordinate
 * clauses; handed to SD 1.5 the tail is silently truncated and the clauses that survive
 * are re-ordered into a bag anyway. So the local lane gets a comma-separated tag list,
 * derived from the *same* fields, ordered most-load-bearing first.
 *
 * Cloud image models are conditioned on a T5 or LLM encoder and take the natural
 * clause as written, so they get **no** override: an entry that only restates the
 * default is a second copy of the prompt to keep in step, and the first thing to drift.
 *
 * The override set is derived from `KNOWN_MODELS` rather than hard-coded, so adding a
 * local checkpoint to the catalogue gives it the right phrasing automatically.
 */

import { KNOWN_MODELS, type ModelDescriptor, type VisualStyle, modelRef } from '@rv/contracts';

import { MEDIUM_PHRASING } from './medium';
import { band, dedupeStable, fixed, plural } from './words';

/**
 * Providers whose text encoder cannot take a long natural-language clause.
 *
 * A set of provider kinds, not model ids: the constraint is a property of the
 * checkpoint family the provider runs, and every local checkpoint we can run on 6 GB
 * is CLIP-conditioned.
 */
const TAG_CONDITIONED_PROVIDERS = new Set<ModelDescriptor['provider']>(['comfyui']);

function emitsImages(descriptor: ModelDescriptor): boolean {
  return (
    descriptor.capabilities.includes('image-generation') ||
    descriptor.capabilities.includes('image-edit')
  );
}

/**
 * Builds `PromptFragments.byModel`.
 *
 * Catalogue order is the emission order, and the catalogue is a static array, so this
 * is deterministic without sorting.
 */
export function compileModelOverrides(
  visual: VisualStyle,
  catalogue: readonly ModelDescriptor[] = KNOWN_MODELS,
): Record<string, string> {
  const tags = compileTagPrompt(visual);
  const out: Record<string, string> = {};
  for (const descriptor of catalogue) {
    if (!emitsImages(descriptor)) continue;
    if (!TAG_CONDITIONED_PROVIDERS.has(descriptor.provider)) continue;
    out[modelRef(descriptor.provider, descriptor.id)] = tags;
  }
  return out;
}

/**
 * The 77-token form.
 *
 * Ordered medium → line → shading → texture → form → colour, and colour is last on
 * purpose: it is the one property the negative prompt and the reference images both
 * reinforce, so it is the cheapest thing to lose to truncation.
 */
export function compileTagPrompt(visual: VisualStyle): string {
  const tags: string[] = [...MEDIUM_PHRASING[visual.medium].tags];

  if (visual.mediumNote !== undefined) tags.push(visual.mediumNote);

  tags.push(
    visual.line.present
      ? band(visual.line.weight, [
          'hairline outline',
          'thin outline',
          'clean outline',
          'bold outline',
          'very thick outline',
        ])
      : 'no outline',
  );
  if (visual.line.present && visual.line.roughness >= 0.35) tags.push('wobbly line');
  if (visual.line.present && visual.line.variability >= 0.6) tags.push('modulated line weight');

  tags.push(`${SHADING_TAG[visual.shading.model]} ${plural(visual.shading.steps, 'tone')}`);
  if (visual.shading.rimLight >= 0.35) tags.push('rim light');

  for (const [value, tag] of [
    [visual.texture.grain, 'grainy'],
    [visual.texture.paperFiber, 'paper texture'],
    [visual.texture.halftone, 'halftone'],
    [visual.texture.brushVisibility, 'brush texture'],
    [visual.texture.edgeRoughness, 'rough edges'],
  ] as const) {
    if (value >= 0.35) tags.push(tag);
  }

  tags.push(
    band(visual.shape.roundness, [
      'angular shapes',
      'sharp shapes',
      'balanced shapes',
      'rounded shapes',
      'blobby shapes',
    ]),
    band(visual.shape.detailDensity, [
      'minimal detail',
      'simple detail',
      'moderate detail',
      'detailed',
      'highly detailed',
    ]),
    `${fixed(visual.shape.headToBodyRatio, 1)} head proportions`,
    `${visual.palette.harmony} colours`,
    ...visual.palette.colors.slice(0, 4).map((colour) => colour.name),
    BACKGROUND_TAG[visual.backgroundTreatment],
  );

  return dedupeStable(tags).join(', ');
}

const SHADING_TAG = {
  flat: 'flat colour',
  cel: 'cel shaded',
  soft: 'soft shading',
  crosshatch: 'crosshatched',
  stipple: 'stippled',
  painterly: 'painted shading',
} as const satisfies Record<VisualStyle['shading']['model'], string>;

const BACKGROUND_TAG = {
  'flat-color': 'flat colour background',
  gradient: 'gradient background',
  painted: 'painted background',
  'layered-parallax': 'layered background',
  minimal: 'plain background',
  'detailed-scene': 'detailed background',
} as const satisfies Record<VisualStyle['backgroundTreatment'], string>;
