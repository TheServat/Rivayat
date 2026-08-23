/**
 * `AssetSpec` + `StyleBible` + references → one generation request (RV-120).
 *
 * Pure, and that is the requirement rather than a preference: "given the same spec,
 * when composed twice, then the requests are byte-identical". The seed is derived from
 * the spec hash rather than drawn, the clauses are concatenated in a fixed order, and
 * nothing here reads a clock. A composer that was not a pure function of its inputs
 * would make the content-addressed store's promise unverifiable.
 *
 * References are returned as **hashes**, not bytes. The blob load is IO, and keeping it
 * out of here is what lets the byte-identity test compare two composed requests
 * directly instead of comparing megabytes of PNG.
 */

import {
  ConflictError,
  type AppError,
  type Result,
  type Sha256,
  contentHash,
  err,
  hashSeed,
  ok,
  stableStringify,
} from '@rv/shared-kernel';
import type { AssetReference, AssetSpec, Sha256Hex, Size, StyleBible } from '@rv/contracts';

import type { SubjectRoute } from './decomposition-policy';

export interface ComposedRequest {
  readonly prompt: string;
  readonly negativePrompt: string;
  readonly size: Size;
  /** Derived from the style seed and the spec hash. Never drawn. */
  readonly seed: number;
  /** In priority order: identity anchors first, then style, then everything else. */
  readonly references: readonly AssetReference[];
  /** `sha256` of the prompt pair, recorded on provenance so a take is traceable. */
  readonly promptHash: Sha256;
  readonly route: SubjectRoute;
}

/**
 * How much prompt the target model's text encoder can actually use.
 *
 * Not a preference - a measured property of the lane. **A/B, same graph, same seed
 * 4067317284, same 6 steps, `dreamshaper_8` + `lcm-lora-sdv1-5`:** the 1663-character
 * composed prompt below produced one assembled structure, and a 350-character prompt
 * with the layout instruction first produced a genuine parts sheet with the components
 * separated. The two images are `A-style-first-1663-chars.png` and
 * `B-layout-first-350-chars.png` under `workspace/produce-demo/_probe/`.
 *
 * The mechanism is research §2's: SD 1.5 conditions on **CLIP-L, 77 tokens**, and
 * ComfyUI feeds a longer prompt through as several concatenated 77-token windows. A
 * layout instruction sitting at word 200 of 260 is in the last window, competing with
 * five windows of style adjectives that bag-of-words CLIP weights just as heavily. The
 * instruction is not truncated; it is diluted, which looks the same from the outside.
 *
 * `long` is the default and is the shape a T5-XXL or Gemini prompt wants: style first,
 * because those encoders do read the whole thing and the style is the frame.
 */
export type PromptEncoder = 'clip-77' | 'long';

/**
 * Style clauses kept when the encoder is `clip-77`.
 *
 * The paper-cutout preset compiles to nineteen comma-separated clauses, most of which
 * are hex codes that tokenise to five or six tokens each and mean nothing to CLIP. Four
 * is what fits alongside the subject and the layout instruction inside one window.
 */
const CLIP_STYLE_CLAUSES = 4;

export interface ComposeRequestInput {
  readonly spec: AssetSpec;
  readonly style: StyleBible;
  readonly route: SubjectRoute;
  /** Additional references resolved by the caller - typically the identity turnaround. */
  readonly extraReferences?: readonly AssetReference[];
  /** Appended verbatim. The repair loop's channel for "and this time, ...". */
  readonly repairClause?: string;
  /** Defaults to `long`, which is the behaviour every caller had before this existed. */
  readonly encoder?: PromptEncoder;
}

/**
 * Priority order for reference images.
 *
 * Identity first because character drift is the failure the audience notices; style
 * anchors next; `avoid` last, because a provider that truncates the reference list
 * should lose the counter-example rather than the face.
 */
const REFERENCE_PRIORITY: Readonly<Record<AssetReference['role'], number>> = {
  'identity-anchor': 0,
  'style-anchor': 1,
  'pose-guide': 2,
  'palette-guide': 3,
  avoid: 4,
};

export function composeGenerationRequest(
  input: ComposeRequestInput,
): Result<ComposedRequest, AppError> {
  const { spec, style, route } = input;

  // A style that is not locked has no frozen checksum, and the checksum is a component
  // of the dedup key. Generating against a moving style would write assets that can
  // never be found again.
  if (style.lockedAt === null) {
    return err(
      new ConflictError({
        message: 'style-not-locked',
        context: { styleBibleId: style.id, semanticKey: spec.semanticKey },
      }),
    );
  }

  const subjectClause = style.prompts.bySubject[spec.subjectClass];
  const layout = layoutClause(spec, route);
  const repair = input.repairClause === undefined ? [] : [input.repairClause];

  // Order is the whole difference on a 77-token encoder: what the picture *is* has to
  // arrive before the adjectives describing how it looks, because the encoder gives
  // them equal weight and there is only room for one of the two.
  const clauses =
    (input.encoder ?? 'long') === 'clip-77'
      ? [
          layout,
          spec.description,
          ...(subjectClause === undefined ? [] : [subjectClause]),
          trimClauses(style.prompts.positive, CLIP_STYLE_CLAUSES),
          ...repair,
        ]
      : [
          style.prompts.positive,
          ...(subjectClause === undefined ? [] : [subjectClause]),
          spec.description,
          layout,
          ...repair,
        ];

  const negatives = [style.prompts.negative, ...style.visual.negative];

  const references = [...spec.references, ...(input.extraReferences ?? [])].sort(
    (left, right) =>
      REFERENCE_PRIORITY[left.role] - REFERENCE_PRIORITY[right.role] ||
      right.weight - left.weight ||
      compare(left.imageHash, right.imageHash),
  );

  const prompt = clauses.join('. ');
  const negativePrompt = negatives.join(', ');

  return ok({
    prompt,
    negativePrompt,
    size: spec.canvas,
    // Style seed plus spec identity: two assets in one style must not share a seed, and
    // the same asset must keep its own across re-runs and across machines.
    seed: hashSeed(`${String(style.seed)}:${contentHash(canonicalSpecForSeed(spec))}`),
    references,
    promptHash: contentHash({ prompt, negativePrompt }),
    route,
  });
}

/**
 * The layout instruction, which differs by lane because the finding says it must.
 *
 * On the parts-sheet lane the grid is requested **and described as advisory**: the
 * splitter segments by connected components, so a model that puts a wing 30 px off the
 * grid still yields a usable wing. Asking for the grid still helps - it is what stops
 * the model drawing a finished, overlapping composition - but nothing downstream
 * depends on the cells landing where they were asked for.
 */
function layoutClause(spec: AssetSpec, route: SubjectRoute): string {
  if (route.decomposition === 'single-layer') {
    return `Draw the whole subject as one piece, centred, on a flat neutral field with generous margins`;
  }

  if (route.decomposition === 'segmented') {
    return `Draw the complete subject in a single neutral-field illustration, full body, unoccluded, arms and legs clear of the torso so the silhouette of every limb reads separately`;
  }

  const names = spec.parts.map((part) => `${part.name} (${part.description})`);
  const columns = Math.ceil(Math.sqrt(spec.parts.length));
  return [
    `Draw a parts sheet: ${String(spec.parts.length)} separated components on one flat neutral field`,
    `arranged loosely in ${String(columns)} columns, reading order left to right then top to bottom`,
    `no two components touching or overlapping, each fully visible with its own margin`,
    `the components are: ${names.join('; ')}`,
  ].join(', ');
}

/**
 * The spec fields that legitimately move the seed.
 *
 * Deliberately not the whole spec: `quality` selects the canvas and the provider tier
 * but should not re-roll the composition, so a draft and its promoted final are the
 * same picture at two resolutions (RV-131 promotes "with the same seed and prompt").
 */
function canonicalSpecForSeed(spec: AssetSpec): Record<string, unknown> {
  return {
    semanticKey: spec.semanticKey,
    archetype: spec.archetype,
    subjectClass: spec.subjectClass,
    description: spec.description,
    parts: [...spec.parts].map((part) => part.name).sort(),
  };
}

/**
 * The first `keep` comma-separated clauses of a compiled style prompt.
 *
 * A prefix rather than a curated subset: `compilePositiveClause` emits medium, palette
 * and surface in that order, so the front of the string is the half a 77-token encoder
 * can act on and the tail is the half it cannot.
 */
function trimClauses(clause: string, keep: number): string {
  return clause
    .split(',')
    .slice(0, keep)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(', ');
}

/** Byte order over hex hashes, so the reference order is total and stable. */
function compare(left: Sha256Hex, right: Sha256Hex): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Exported for the provenance record: the exact bytes the request was built from. */
export function requestFingerprint(request: ComposedRequest): string {
  return stableStringify({
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    size: request.size,
    seed: request.seed,
    references: request.references,
  });
}
