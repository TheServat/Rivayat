/**
 * S3 Cast: one character, written from the inside out, then drawn from the psychology.
 *
 * Two use-cases from `@rv/story-engine`, in an order that is itself the design:
 *
 *  1. `GenerateCharacterSheetUseCase` - identity, the dramatic engine (want / need /
 *     wound / lie / ghost), the voice block, the arc and the motion signature, and only
 *     *then* a visual descriptor derived from them by the art director, who is shown the
 *     psychology and nothing else about the plot. It also refuses a voice that is not
 *     distinct from the cast already minted, after one bounded retry.
 *  2. `GenerateCharacterStatesUseCase` - every expression, pose and outfit the story
 *     needs, each as a finished image prompt, with the cartesian demand computed rather
 *     than generated.
 *
 * This service does the two things the engine deliberately does not: it turns the
 * finished `CharacterPayload` into an `Entity` in the bi-temporal graph, and it turns
 * the variant demand into the editable grid the Characters screen renders.
 *
 * **The voices are compared against the cast as it grows, not against the brief.** Each
 * character is generated with every previously-minted voice in front of it, so the
 * distinctness check has something to fail against. That means the order is
 * load-bearing, and it is the candidates' own order - most important first, as intake
 * ranked them - rather than whatever the store happened to return.
 */

import {
  Entity,
  Ids,
  type CharacterEntity,
  type EntityId,
  type NamedVisualState,
  type SeriesId,
  type StoryTime,
} from '@rv/contracts';
import type { StructuredTrace } from '@rv/prompt-kit';
import {
  GenerateCharacterSheetUseCase,
  GenerateCharacterStatesUseCase,
  slugify,
  type CastCandidate,
  type CharacterStatesResult,
  type NamedVoice,
  type OutlineContext,
  type StoryEngineDeps,
  type StyleBrief,
} from '@rv/story-engine';
import { ValidationError, err, isErr, ok, type AppError, type Result } from '@rv/shared-kernel';

import { CharacterStates, type CharacterStateCell } from './cast.contracts';

/** Where in the fiction a character first exists, before any scene has said. */
export const FIRST_APPEARANCE: StoryTime = { ordinal: 0 };

export interface GenerateCastMemberInput {
  readonly seriesId: SeriesId;
  readonly candidate: CastCandidate;
  readonly context: OutlineContext;
  readonly style: StyleBrief;
  /** Voices already minted for this series. The distinctness check runs against these. */
  readonly existingCast: readonly NamedVoice[];
  /** The image model a generate on this grid would run on, for the estimate line. */
  readonly imageModel: string | null;
  readonly identityFloor: number;
  readonly signal?: AbortSignal;
}

export interface CastMemberResult {
  readonly entity: CharacterEntity;
  readonly states: CharacterStates;
  readonly voice: NamedVoice;
  /** True when the voice had to be regenerated to clear the distinctness bar. */
  readonly regeneratedForDistinctness: boolean;
  readonly traces: readonly StructuredTrace[];
}

export interface CastServiceDeps {
  readonly ids: Ids;
}

export class CastService {
  readonly #ids: Ids;

  constructor(deps: CastServiceDeps) {
    this.#ids = deps.ids;
  }

  async generate(
    engine: StoryEngineDeps,
    input: GenerateCastMemberInput,
  ): Promise<Result<CastMemberResult, AppError>> {
    const sheet = await new GenerateCharacterSheetUseCase(engine).execute({
      context: input.context,
      candidate: input.candidate,
      style: input.style,
      existingCast: input.existingCast,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (isErr(sheet)) return sheet;

    const characterSlug = slugify(input.candidate.name, 'character');
    const states = await new GenerateCharacterStatesUseCase(engine).execute({
      name: sheet.value.name,
      payload: sheet.value.payload,
      style: input.style,
      characterSlug,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (isErr(states)) return states;

    // The sheet comes back with empty wardrobe / expression / pose sets by design - S3b
    // owns them - so the filled `visual` block is merged back before the entity is
    // parsed. An entity stored with the empty sets would describe a character nobody
    // can draw.
    const entity = Entity.safeParse({
      id: this.#ids.entity(),
      seriesId: input.seriesId,
      kind: 'character',
      canonicalName: sheet.value.name,
      aliases: [],
      summary: input.candidate.premiseRole,
      firstAppearance: FIRST_APPEARANCE,
      importance: input.candidate.importance,
      assetRefs: [],
      embedding: [],
      payload: { ...sheet.value.payload, visual: states.value.visual },
    });
    if (!entity.success) {
      return err(
        new ValidationError({
          message: `S3 produced a sheet for "${sheet.value.name}" that is not a valid Entity`,
          context: {
            reason: 'invalid-character-entity',
            character: sheet.value.name,
            issues: entity.error.issues.map((issue) => issue.path.map(String).join('.')),
          },
        }),
      );
    }
    if (entity.data.kind !== 'character') {
      // Unreachable: the literal above is `character`. Narrowing rather than asserting,
      // because a cast member that is not a character is a programmer error and the
      // discriminated union is the only thing that can prove it is not one.
      return err(
        new ValidationError({
          message: `S3 produced a non-character entity for "${sheet.value.name}"`,
          context: { reason: 'invalid-character-entity' },
        }),
      );
    }

    return ok({
      entity: entity.data,
      states: gridOf(states.value, {
        imageModel: input.imageModel,
        identityFloor: input.identityFloor,
      }),
      voice: { name: sheet.value.name, voice: sheet.value.payload.voice },
      regeneratedForDistinctness: sheet.value.regeneratedForDistinctness,
      traces: [...sheet.value.traces, ...states.value.traces],
    });
  }
}

/**
 * The variant demand, as the editable grid.
 *
 * Every cell starts `missing` and carries the prompt the engine composed. `missing` is
 * the honest starting state: S3 decides *what* has to be drawn, S6 draws it, and a grid
 * that opened as `ready` would claim artwork that does not exist.
 *
 * `estimateNanoUsd` stays 0. Pricing a cell needs an `AssetSpec` - the estimator is
 * `nanoUsd(rate[quality] * parts.length)` - and S3 does not build one; S4 does. Putting
 * a plausible number here would be a quote nobody can honour. See the report in
 * `modules/narrative/narrative.module.ts`.
 */
export function gridOf(
  result: CharacterStatesResult,
  options: { readonly imageModel: string | null; readonly identityFloor: number },
): CharacterStates {
  const intensity = new Map<string, number>();
  for (const state of [...result.expressionSet, ...result.poseSet] as readonly NamedVisualState[]) {
    intensity.set(state.slug, state.intensity);
  }

  const cells: CharacterStateCell[] = [];

  // One full-body turnaround per outfit, first: it is what the identity anchor is
  // generated from, and every expression and pose is scored against it.
  for (const outfit of result.wardrobeStates) {
    cells.push({
      semanticKey: `char/${result.characterSlug}/wardrobe`,
      variantKey: `${outfit.slug}-turnaround`,
      wardrobeSlug: outfit.slug,
      stateSlug: 'turnaround',
      stateKind: 'wardrobe',
      label: outfit.label,
      prompt: outfit.description,
      intensity: outfit.intensity,
      status: 'missing',
      estimateNanoUsd: 0,
    });
  }

  for (const demand of result.variants) {
    cells.push({
      semanticKey: demand.semanticKey,
      variantKey: demand.variantKey,
      wardrobeSlug: demand.wardrobeSlug,
      stateSlug: demand.stateSlug,
      stateKind: demand.stateKind,
      label: demand.label,
      prompt: demand.prompt,
      intensity: intensity.get(demand.stateSlug) ?? 0.7,
      status: 'missing',
      estimateNanoUsd: 0,
    });
  }

  return CharacterStates.parse({
    identityFloor: options.identityFloor,
    imageModel: options.imageModel,
    cells,
  });
}

/** The entity ids of every character already in a graph, for a re-run that must not duplicate. */
export function characterNames(entities: readonly Entity[]): ReadonlyMap<string, EntityId> {
  const byName = new Map<string, EntityId>();
  for (const entity of entities) {
    if (entity.kind !== 'character') continue;
    byName.set(entity.canonicalName.trim().toLowerCase(), entity.id);
  }
  return byName;
}
