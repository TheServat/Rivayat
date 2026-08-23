/**
 * Which lane a subject is generated in, and how its parts are obtained.
 *
 * This file is research §3's finding turned into configuration rather than into a
 * buried heuristic. The finding: **props decompose, characters do not.** Asked for a
 * parts sheet, SD 1.5 returns a costume/turnaround sheet - a picture *of* a character
 * from several angles - instead of separated limbs. That is a model limit, not a
 * prompt limit: SD 1.5 conditions on CLIP-L at 77 tokens with bag-of-words semantics,
 * and §2 records that SDXL is not expected to fix it because it is still CLIP at 77
 * tokens. The "reference sheet = turnaround" prior is universal and a 4-step distilled
 * model does not argue.
 *
 * So the pipeline does not fight it. A prop, a tree, a building is asked for as a
 * parts sheet on the free local lane and comes back separable by construction. A
 * character is generated **whole**, on the multi-reference cloud lane that buys
 * identity consistency (§2, §3), and decomposed afterwards by segmentation.
 *
 * It is a table, and the table is an input, because the finding has an expiry date:
 * §2 records `txt2img-flux-schnell-parts-sheet.json` as the experiment that would
 * settle whether a T5-XXL text encoder at 512 tokens decomposes characters where CLIP
 * cannot, and it is **unrun**. When it runs, the answer is one entry in this map, not
 * a rewrite.
 */

import type { AssetSpec, SubjectClass } from '@rv/contracts';

/** How the parts are obtained once an image exists. RV-125's fallback chain. */
export type DecompositionStrategy = 'parts-sheet' | 'segmented' | 'single-layer';

/**
 * Which generation lane produces the pixels.
 *
 * `local-parts-sheet` is the free ComfyUI lane of research §2 - 1.42 s at 512², $0.
 * `cloud-multi-reference` is the paid lane whose reason for existing is that Gemini
 * image models are `text+image -> text+image` and therefore accept the style anchors
 * and identity turnaround as references on every call.
 */
export type GenerationLane = 'local-parts-sheet' | 'cloud-multi-reference';

export interface SubjectRoute {
  readonly lane: GenerationLane;
  /** Tried first. */
  readonly decomposition: DecompositionStrategy;
  /** Tried in order when the one before fails its completeness check. */
  readonly fallbacks: readonly DecompositionStrategy[];
  /** Why, in one sentence. Recorded on provenance and shown in the UI. */
  readonly reason: string;
}

export interface DecompositionPolicy {
  readonly bySubject: Readonly<Partial<Record<SubjectClass, SubjectRoute>>>;
  readonly fallback: SubjectRoute;
}

const PARTS_SHEET: SubjectRoute = {
  lane: 'local-parts-sheet',
  decomposition: 'parts-sheet',
  fallbacks: ['segmented', 'single-layer'],
  reason:
    'Inanimate subjects survive a parts-sheet prompt: the model has no turnaround prior to fall back on, so the pieces come out separated on the neutral field (research §3).',
};

const IDENTITY_LOCKED: SubjectRoute = {
  lane: 'cloud-multi-reference',
  decomposition: 'segmented',
  fallbacks: ['single-layer'],
  reason:
    'A parts-sheet prompt collapses into a costume turnaround for characters and creatures (research §3), so the subject is generated whole with identity anchors as references and decomposed afterwards.',
};

const SINGLE_MASS: SubjectRoute = {
  lane: 'local-parts-sheet',
  decomposition: 'single-layer',
  fallbacks: [],
  reason: 'A sky, a body of water or an effect has no separable parts; it animates by mesh deform.',
};

/**
 * The default routing. Every subject class states its answer.
 *
 * `Record<SubjectClass, …>` on the `bySubject` half would force a route for classes
 * that genuinely want the default, so it is partial and `fallback` carries the rest -
 * but every class the finding actually distinguishes is named here explicitly, because
 * "why did my character go to the cloud lane" must be answerable by reading one table.
 */
export const DEFAULT_DECOMPOSITION_POLICY: DecompositionPolicy = {
  bySubject: {
    character: IDENTITY_LOCKED,
    creature: IDENTITY_LOCKED,
    prop: PARTS_SHEET,
    foliage: PARTS_SHEET,
    architecture: PARTS_SHEET,
    ground: PARTS_SHEET,
    ui: PARTS_SHEET,
    sky: SINGLE_MASS,
    water: SINGLE_MASS,
    fx: SINGLE_MASS,
  },
  fallback: PARTS_SHEET,
};

/**
 * A policy that keeps everything on the free lane.
 *
 * `rv assets produce --lane free` (RV-131): identity consistency degrades, and the run
 * costs nothing. Exported rather than assembled at the call site so "what does the
 * free lane actually change" has one answer.
 */
export const FREE_LANE_POLICY: DecompositionPolicy = {
  bySubject: {
    character: {
      ...IDENTITY_LOCKED,
      lane: 'local-parts-sheet',
      reason: `${IDENTITY_LOCKED.reason} Forced onto the free local lane, so identity rests on seed and prompt alone.`,
    },
    creature: {
      ...IDENTITY_LOCKED,
      lane: 'local-parts-sheet',
      reason: `${IDENTITY_LOCKED.reason} Forced onto the free local lane, so identity rests on seed and prompt alone.`,
    },
    sky: SINGLE_MASS,
    water: SINGLE_MASS,
    fx: SINGLE_MASS,
  },
  fallback: PARTS_SHEET,
};

/**
 * The route for one spec.
 *
 * A single-part spec is always single-layer whatever the table says: asking for a
 * parts sheet of one part produces a grid with one cell, which is a picture, and then
 * the splitter looks for boundaries that were never drawn.
 */
export function routeSubject(
  spec: AssetSpec,
  policy: DecompositionPolicy = DEFAULT_DECOMPOSITION_POLICY,
): SubjectRoute {
  const route = policy.bySubject[spec.subjectClass] ?? policy.fallback;
  if (spec.parts.length > 1) return route;
  return {
    ...route,
    decomposition: 'single-layer',
    fallbacks: [],
    reason: `${route.reason} This spec plans a single part, so there is nothing to decompose.`,
  };
}
