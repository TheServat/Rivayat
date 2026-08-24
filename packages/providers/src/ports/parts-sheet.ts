/**
 * Generating a *parts sheet* - the layout, not a picture.
 *
 * Research §3's approach in one port: "ask the image model for parts by design -
 * prompt for a parts sheet with each part isolated on a neutral field - rather than
 * fighting to decompose a finished render". Pieces that were never joined do not need
 * to be cut apart, and `tools/comfy-workflows/txt2img-lcm-parts-sheet.json` is the
 * graph that asks for them. That graph owns the layout scaffold and the separability
 * negatives; what it needs from a caller is a *structured* request - the subject, the
 * component names, the style anchor, the field colour and the grid - because those go
 * into five different places in two prompts, not into one string.
 *
 * ## Why this is a second port and not a field on `ImageGenerationRequest`
 *
 * An optional `partsSheet` field on the existing request would be **silently ignored**
 * by every adapter that has no such graph, and the caller would get one assembled
 * illustration back believing it had asked for six separated pieces. That is the
 * silent-substitution failure `UnsupportedCapabilityError` exists to prevent. A narrow
 * second port makes the absence visible: {@link supportsPartsSheet} answers before
 * anything is spent, and a caller that gets `false` routes around it (CLAUDE.md §2 -
 * "an adapter that cannot implement a capability declares it, and the router routes
 * around it").
 *
 * ## Why it is not a member of `Capability`
 *
 * Deliberately, and it is a trade-off worth stating. `Capability` is what the
 * **router** dispatches on, and at that level nothing has changed: an adapter that
 * serves parts sheets is still an `image-generation` provider, and a caller asking
 * "who can draw pixels" must still find it. Which *graph* runs is decided upstream by
 * `DecompositionPolicy` from the subject class, not by the router from a capability -
 * so a `Capability` member would add a routing axis nobody routes on, and would force
 * every `Record<Capability, …>` in `@rv/contracts`, `@rv/settings` and the settings UI
 * to grow an entry for a mode the user never picks.
 *
 * The cost of that choice: `CapabilityMatrix.register` cannot check this declaration
 * the way it checks the other six. The contract suite checks it instead - every adapter
 * is asserted to either serve the port completely or not be recognised by the guard at
 * all, which closes the same hole one layer up.
 */

import type { Size } from '@rv/contracts';
import type { AppError, Result } from '@rv/shared-kernel';

import type { ImageResult } from './image-generation';

/**
 * The slots a parts-sheet graph fills, one field per placeholder.
 *
 * Structured rather than pre-joined because the graph interpolates them into different
 * sentences: `subject` and `parts` land in the same clause but at different points,
 * `background` lands in a third, and `grid` lands in the layout instruction *and*
 * constrains the canvas aspect. A caller that flattened them to one prompt string
 * would be re-deriving the scaffold the workflow file owns.
 */
export interface PartsSheetRequest {
  /** The subject to decompose, as a noun phrase - "a two-wheeled wooden handcart". */
  readonly subject: string;
  /**
   * Component names in intended reading order, left to right then top to bottom.
   *
   * Names only. A description per part dilutes a 77-token encoder past the point where
   * the layout instruction survives (see `request-composer.ts`, `PromptEncoder`).
   */
  readonly parts: readonly string[];
  /** The locked style anchor. Identical across every asset in a series. */
  readonly style: string;
  /**
   * The field the parts sit on, as the generator should be *asked* for it.
   *
   * Half of a pair: the other half is the RGB the matting stage keys out. They must
   * describe the same colour, which is why both are declared on the lane rather than
   * one being guessed from the other.
   */
  readonly background: string;
  /**
   * Advisory cell count. SD 1.5 will not honour it exactly.
   *
   * Kept anyway because asking for a grid is what stops the model drawing a finished
   * overlapping composition - but nothing downstream slices by arithmetic, and the
   * splitter segments by alpha connectivity instead.
   */
  readonly grid: { readonly cols: number; readonly rows: number };
  /** Prepended to the graph's own fixed separability tail; it cannot be removed. */
  readonly negativePrompt?: string;
  readonly size?: Size;
  readonly count?: number;
  readonly seed?: number;
  readonly signal?: AbortSignal;
}

export interface PartsSheetPort {
  /**
   * Whether *this instance* can serve a parts sheet.
   *
   * An instance property rather than a static fact about the class: the same
   * `ComfyUiAdapter` serves it or does not depending on whether the workflow set it was
   * constructed with contains the graph. A class-level claim would be right in
   * development and wrong on a machine where the file was not deployed.
   */
  readonly servesPartsSheet: boolean;
  generatePartsSheet(request: PartsSheetRequest): Promise<Result<ImageResult, AppError>>;
}

/**
 * Whether `candidate` will really draw a parts sheet.
 *
 * Checks the method *and* the flag, because those answer different questions: the
 * method says the adapter type knows about parts sheets, the flag says this particular
 * instance was given what it needs to run one. An adapter that has the method and
 * reports `false` is not a bug - it is the declaration, and the caller is expected to
 * fall back to `generateImage` and record that it did.
 */
export function supportsPartsSheet(candidate: unknown): candidate is PartsSheetPort {
  if (candidate === null || typeof candidate !== 'object') return false;
  const port = candidate as Partial<PartsSheetPort>;
  return typeof port.generatePartsSheet === 'function' && port.servesPartsSheet === true;
}
