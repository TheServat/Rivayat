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
  /** `sha256` of the prompt pair *and the slots*, so a take is traceable to both. */
  readonly promptHash: Sha256;
  readonly route: SubjectRoute;
  /**
   * The same request again, as slots, for a provider with a parts-sheet graph.
   *
   * Present only on a `parts-sheet` route. Both forms are composed because the composer
   * cannot know which port will run - `PartsSheetPort` is optional and an adapter
   * declares whether it serves one - and composing lazily at the call site would put a
   * second copy of the prompt rules downstream of the pure function that owns them.
   *
   * The two are **not** redundant: `prompt` carries the layout instruction as prose,
   * because a plain `txt2img` graph has nowhere else to put it, while the slots leave
   * the layout to the workflow file that owns the scaffold.
   */
  readonly partsSheet?: PartsSheetSlots;
}

/**
 * What `txt2img-lcm-parts-sheet.json` leaves open, mirroring `PartsSheetRequest`.
 *
 * Declared here rather than imported from `@rv/providers` so the composer stays a pure
 * function of domain inputs: this package builds the values, the adapter decides what
 * a placeholder is called.
 */
export interface PartsSheetSlots {
  readonly subject: string;
  readonly parts: readonly string[];
  readonly style: string;
  readonly background: string;
  readonly grid: { readonly cols: number; readonly rows: number };
}

/**
 * The field a parts sheet is asked to be drawn on, when the lane does not say.
 *
 * A flat, unsaturated grey: it keys cleanly, it is not in the paper-cutout palette, and
 * it is the value `txt2img-lcm-parts-sheet.md` records as verified. The RGB half of the
 * same declaration lives on `LaneBinding.backgroundHint`; the two describe one colour
 * and drift apart the moment either is changed alone.
 */
export const DEFAULT_PARTS_SHEET_BACKGROUND = 'flat neutral light grey';

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
  /** The flat field the lane asks for. Defaults to {@link DEFAULT_PARTS_SHEET_BACKGROUND}. */
  readonly background?: string;
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
  const partsSheet = partsSheetSlots(input);

  return ok({
    prompt,
    negativePrompt,
    size: spec.canvas,
    // Style seed plus spec identity: two assets in one style must not share a seed, and
    // the same asset must keep its own across re-runs and across machines.
    seed: hashSeed(`${String(style.seed)}:${contentHash(canonicalSpecForSeed(spec))}`),
    references,
    // The slots join the hash only when they exist, so every non-parts-sheet asset ever
    // recorded keeps the promptHash it was registered with.
    promptHash: contentHash(
      partsSheet === undefined
        ? { prompt, negativePrompt }
        : { prompt, negativePrompt, partsSheet },
    ),
    route,
    ...(partsSheet === undefined ? {} : { partsSheet }),
  });
}

/**
 * The slot form of the same request, for a lane whose graph owns the scaffold.
 *
 * `undefined` on every route but `parts-sheet` - a single-layer or segmented asset has
 * no components to lay out, and offering slots for it would invite a caller to run the
 * sheet graph on a subject the policy deliberately routed away from it.
 *
 * Two details are load-bearing:
 *
 * - **`style` is trimmed for a 77-token encoder**, exactly as the prose prompt is. The
 *   scaffold in node 4 is already ~50 tokens of layout instruction; nineteen clauses of
 *   compiled style on top of it push the layout out of the first CLIP window, which is
 *   the measured failure `PromptEncoder` documents.
 * - **The repair clause rides on `style`.** The graph has no repair slot and inventing
 *   one would change what the workflow file means. `{{style}}` is interpolated
 *   immediately after the subject as a comma list, which is where a corrective clause
 *   both parses and carries weight; appending it to `{{parts}}` would make the splitter
 *   look for a component named after the instruction.
 */
function partsSheetSlots(input: ComposeRequestInput): PartsSheetSlots | undefined {
  const { spec, style, route } = input;
  if (route.decomposition !== 'parts-sheet') return undefined;

  const positive =
    (input.encoder ?? 'long') === 'clip-77'
      ? trimClauses(style.prompts.positive, CLIP_STYLE_CLAUSES)
      : style.prompts.positive;

  const cols = Math.ceil(Math.sqrt(spec.parts.length));
  return {
    subject: spec.description,
    parts: spec.parts.map((part) => part.name),
    style: input.repairClause === undefined ? positive : `${positive}, ${input.repairClause}`,
    background: input.background ?? DEFAULT_PARTS_SHEET_BACKGROUND,
    grid: { cols, rows: Math.ceil(spec.parts.length / cols) },
  };
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
    ...(request.partsSheet === undefined ? {} : { partsSheet: request.partsSheet }),
  });
}
