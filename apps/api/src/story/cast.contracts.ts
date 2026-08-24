/**
 * The character state grid on the wire, mirroring what the Characters screen validates.
 *
 * Same standing as `story.contracts.ts`: these belong in `@rv/contracts`, the studio
 * declared them first in `apps/web/src/features/characters/api/graph.ts`, and a third
 * definition inside `@rv/contracts` while two already exist would be the drift the rule
 * exists to prevent. The gap is reported in `modules/narrative/narrative.module.ts`.
 *
 * The grid is the artefact S3 is actually judged on. `GenerateCharacterStatesUseCase`'s
 * header states the standard bluntly - *a character who arrives with three expressions
 * and one outfit is a failure of the code, not of the artist* - and this is the shape
 * that carries the result to somewhere a person can edit it. Every `prompt` here is the
 * **exact text an image model receives**, composed by the engine from the style clause,
 * the character descriptor, the outfit and the state body; it is editable in place
 * because an art director correcting one cell must not have to regenerate the character.
 */

import { Label, NanoUsdAmount, Prose, SemanticKey, Slug, Unit01 } from '@rv/contracts';
import { z } from 'zod';

/**
 * Where one cell of the grid stands.
 *
 * `stale` is the state an edit turns on: an edited prompt is a different `specHash`, so
 * exactly that cell becomes a cache miss, and the grid has to say so *before* anything
 * is regenerated. `rejected` is not a missing image - it is an image that reached the
 * identity gate and failed it, which is a diagnosis somebody can act on.
 */
export const STATE_CELL_STATUSES = ['ready', 'missing', 'generating', 'stale', 'rejected'] as const;
export const StateCellStatus = z.enum(STATE_CELL_STATUSES);
export type StateCellStatus = z.infer<typeof StateCellStatus>;

export const STATE_KINDS = ['expression', 'pose', 'wardrobe'] as const;
export const StateKind = z.enum(STATE_KINDS);
export type StateKind = z.infer<typeof StateKind>;

/**
 * One `(outfit × state)` the pipeline must produce, with the prompt behind it.
 *
 * `variantKey` and `semanticKey` together are half of the asset dedup key, so they are
 * shown rather than hidden: "why did this regenerate" has a precise answer and the
 * answer is these two strings plus the prompt.
 */
export const CharacterStateCell = z.strictObject({
  semanticKey: SemanticKey,
  variantKey: Slug,
  wardrobeSlug: Slug,
  stateSlug: Slug,
  stateKind: StateKind,
  label: Label,
  /** The exact text an image model receives. Editable in place. */
  prompt: Prose,
  intensity: Unit01.default(0.7),
  status: StateCellStatus.default('missing'),
  /** Content hash of the rendered image, when one exists. */
  imageHash: z.string().min(1).max(128).optional(),
  /** Against the identity anchors. Absent until it has been scored. */
  identityMatch: Unit01.optional(),
  estimateNanoUsd: NanoUsdAmount.default(0),
});
export type CharacterStateCell = z.infer<typeof CharacterStateCell>;

export const CharacterStates = z.strictObject({
  /** The score below which a cell is flagged rather than trusted. From the settings. */
  identityFloor: Unit01.default(0.82),
  /** The model a generate on this screen would run on, for the estimate line. */
  imageModel: Label.nullable().default(null),
  cells: z.array(CharacterStateCell).max(512).default([]),
});
export type CharacterStates = z.infer<typeof CharacterStates>;

/**
 * What a cell edit may change.
 *
 * The prompt and nothing else. `variantKey` is part of the dedup key and part of the
 * URL; letting an edit move it would orphan whatever artwork already exists under the
 * old one, which is the same reason `GenerateCharacterStatesUseCase` *drops* a duplicate
 * slug rather than renaming it.
 */
export const CharacterStateEdit = z.strictObject({ prompt: Prose });
export type CharacterStateEdit = z.infer<typeof CharacterStateEdit>;
