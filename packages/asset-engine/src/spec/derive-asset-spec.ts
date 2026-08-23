/**
 * Entity or scene requirement in, `AssetSpec` out.
 *
 * The one thing this use-case exists to guarantee: the `PartPlan[]` it produces comes
 * from the **archetype's rig template**, so the parts that come back later bind to
 * bones by name with no matching pass. Hand-authoring a part list beside a rig
 * template is how you get a rig with an arm where a wing should be, and the join is
 * cheap enough to make structural.
 *
 * It is pure - no clock, no IO, no provider - which is why the same entity always
 * derives the same spec and therefore the same dedup key.
 */

import { type AppError, type Result, ValidationError, err, ok } from '@rv/shared-kernel';
import {
  type AssetArchetype,
  type AssetReference,
  AssetSpec,
  type Entity,
  type EntityKind,
  type NamedVisualState,
  type Prose,
  type QualityTarget,
  type SemanticKey,
  type Sha256Hex,
  type Size,
  type SubjectClass,
  type VariantSpec,
} from '@rv/contracts';

import { partPlansFor } from '../rig/templates/index';
import {
  CANVAS_BY_QUALITY,
  DEFAULT_ARCHETYPE_BY_ENTITY_KIND,
  DEFAULT_NOMINAL_HEIGHT,
  NOMINAL_HEIGHT_BY_ARCHETYPE,
  SUBJECT_CLASS_BY_ENTITY_KIND,
  archetypeFromPayload,
} from './archetype-map';

/**
 * A thing a shot needs that no narrative entity models.
 *
 * Ground planes, sky layers, dust motes, a generic crate. They never earn a node in
 * the world model, and they still need an on-style, rigged, cached asset.
 */
export interface SceneRequirement {
  readonly semanticKey: SemanticKey;
  readonly label: string;
  readonly description: Prose;
  readonly archetype: AssetArchetype;
  readonly subjectClass: SubjectClass;
  readonly tags?: readonly string[];
}

export type AssetSpecSource =
  | { readonly kind: 'entity'; readonly entity: Entity }
  | { readonly kind: 'requirement'; readonly requirement: SceneRequirement };

export interface DeriveAssetSpecInput {
  readonly source: AssetSpecSource;
  readonly quality?: QualityTarget;
  /**
   * Overrides the archetype the entity's kind and payload imply.
   *
   * Present because S3 knows things this package cannot: `CreaturePayload.anatomy`
   * says "six legs, wall-crawling" in prose, and the model that wrote it is the right
   * thing to turn that into `multi-limbed`.
   */
  readonly archetype?: AssetArchetype;
  /** Style anchors from the locked bible, and identity anchors for a character. */
  readonly references?: readonly AssetReference[];
  readonly canvas?: Size;
  readonly nominalHeight?: number;
  /** Extra variants beyond the ones the payload already implies. */
  readonly extraVariants?: readonly VariantSpec[];
}

export class DeriveAssetSpecUseCase {
  execute(input: DeriveAssetSpecInput): Result<AssetSpec, AppError> {
    const draft =
      input.source.kind === 'entity'
        ? fromEntity(input.source.entity, input)
        : fromRequirement(input.source.requirement, input);

    const parsed = AssetSpec.safeParse(draft);
    if (!parsed.success) {
      return err(
        new ValidationError({
          message: 'derived AssetSpec does not validate',
          context: { semanticKey: draft.semanticKey },
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        }),
      );
    }
    return ok(parsed.data);
  }
}

interface Draft {
  semanticKey: string;
  archetype: AssetArchetype;
  subjectClass: SubjectClass;
  label: string;
  description: string;
  tags: readonly string[];
  canvas: Size;
  nominalHeight: number;
  parts: ReturnType<typeof partPlansFor>;
  variants: readonly VariantSpec[];
  references: readonly AssetReference[];
  quality: QualityTarget;
  requireAlpha: boolean;
}

function fromEntity(entity: Entity, input: DeriveAssetSpecInput): Draft {
  const archetype =
    input.archetype ??
    archetypeFromPayload(entity) ??
    DEFAULT_ARCHETYPE_BY_ENTITY_KIND[entity.kind];
  const quality = input.quality ?? 'preview';
  return {
    semanticKey: semanticKeyFor(entity),
    archetype,
    subjectClass: SUBJECT_CLASS_BY_ENTITY_KIND[entity.kind],
    label: entity.canonicalName,
    description: entity.summary,
    tags: [...new Set([entity.kind, entity.importance, ...entity.aliases.map(slugify)])].filter(
      isSlug,
    ),
    canvas: input.canvas ?? CANVAS_BY_QUALITY[quality],
    nominalHeight: input.nominalHeight ?? nominalHeightFor(archetype),
    parts: partPlansFor(archetype, entity.canonicalName),
    variants: [...variantsFor(entity), ...(input.extraVariants ?? [])],
    references: input.references ?? [],
    quality,
    requireAlpha: archetype !== 'backdrop',
  };
}

function fromRequirement(requirement: SceneRequirement, input: DeriveAssetSpecInput): Draft {
  const quality = input.quality ?? 'preview';
  return {
    semanticKey: requirement.semanticKey,
    archetype: input.archetype ?? requirement.archetype,
    subjectClass: requirement.subjectClass,
    label: requirement.label,
    description: requirement.description,
    tags: (requirement.tags ?? []).filter(isSlug),
    canvas: input.canvas ?? CANVAS_BY_QUALITY[quality],
    nominalHeight:
      input.nominalHeight ?? nominalHeightFor(input.archetype ?? requirement.archetype),
    parts: partPlansFor(input.archetype ?? requirement.archetype, requirement.label),
    variants: input.extraVariants ?? [],
    references: input.references ?? [],
    quality,
    requireAlpha: (input.archetype ?? requirement.archetype) !== 'backdrop',
  };
}

function nominalHeightFor(archetype: AssetArchetype): number {
  return NOMINAL_HEIGHT_BY_ARCHETYPE[archetype] ?? DEFAULT_NOMINAL_HEIGHT;
}

/**
 * `kind/name` - the library address.
 *
 * Derived from the canonical name rather than from the entity id, because the point of
 * the semantic key is that two episodes asking for the same oak tree collide. A ULID
 * would never collide, which is exactly the wrong property here.
 */
function semanticKeyFor(entity: Entity): string {
  return `${SEMANTIC_PREFIX[entity.kind]}/${slugify(entity.canonicalName)}`;
}

const SEMANTIC_PREFIX: Readonly<Record<EntityKind, string>> = {
  character: 'char',
  creature: 'fauna',
  prop: 'prop',
  location: 'place',
  vehicle: 'vehicle',
  faction: 'faction',
  concept: 'concept',
  event: 'event',
  substance: 'substance',
};

/** An extractor that has already been narrowed to the kind it handles. */
type VariantExtractor<K extends EntityKind> = (
  entity: Extract<Entity, { kind: K }>,
) => readonly VariantSpec[];

/**
 * Which of an entity's payload lists become variants.
 *
 * A table rather than a chain of `if`s so a new entity kind cannot quietly contribute
 * nothing: the mapped type forces every kind to state its answer, even when the answer
 * is "none".
 *
 * Each extractor is typed against its *own* payload, so none of them re-checks `kind`.
 * The alternative - one signature taking the whole union and re-narrowing inside -
 * writes nine guards that the discriminated union already makes unreachable, and an
 * unreachable guard is a branch no test can cover and a reader has to think about.
 */
const VARIANT_SOURCES: { readonly [K in EntityKind]: VariantExtractor<K> } = {
  character: (entity) => [
    ...entity.payload.visual.expressionSet.map((state) => fromVisualState(state, 'expression')),
    ...entity.payload.visual.poseSet.map((state) => fromVisualState(state, 'pose')),
    ...entity.payload.visual.wardrobe.map((set) => ({
      key: `wardrobe-${set.slug}`,
      label: set.label,
      instruction: `Re-dress the subject: ${set.description}`,
      affectedParts: [],
    })),
  ],
  creature: (entity) =>
    entity.payload.stateVariants.map((state) => fromVisualState(state, 'state')),
  prop: (entity) =>
    entity.payload.conditionVariants.map((state) => fromVisualState(state, 'condition')),
  vehicle: (entity) =>
    entity.payload.conditionVariants.map((state) => fromVisualState(state, 'condition')),
  location: (entity) => [
    ...entity.payload.timeOfDayVariants.map((time) => ({
      key: `light-${time}`,
      label: time,
      instruction: `Relight the scene for ${time} without redrawing it.`,
      affectedParts: [],
    })),
    ...entity.payload.weatherVariants.map((weather) => ({
      key: `weather-${weather}`,
      label: weather,
      instruction: `Apply ${weather} to the scene without redrawing it.`,
      affectedParts: [],
    })),
    ...entity.payload.moodVariants.map((state) => fromVisualState(state, 'mood')),
  ],
  faction: () => [],
  concept: () => [],
  event: () => [],
  substance: () => [],
};

function variantsFor(entity: Entity): readonly VariantSpec[] {
  // One cast, here, because a lookup into a mapped type loses the correlation between
  // the key and the value. It is safe by construction: `entity.kind` selected the
  // extractor, so the extractor's parameter type is exactly `entity`'s type.
  const extract = VARIANT_SOURCES[entity.kind] as (candidate: Entity) => readonly VariantSpec[];
  return extract(entity);
}

function fromVisualState(state: NamedVisualState, prefix: string): VariantSpec {
  return {
    key: `${prefix}-${state.slug}`,
    label: state.label,
    instruction: state.description,
    affectedParts: [],
  };
}

/** Anchor hashes are `AssetReference`s; this is the shorthand callers actually want. */
export function identityAnchors(hashes: readonly Sha256Hex[]): AssetReference[] {
  return hashes.map((imageHash) => ({ imageHash, role: 'identity-anchor', weight: 1 }));
}

export function styleAnchors(hashes: readonly Sha256Hex[], weight = 0.8): AssetReference[] {
  return hashes.map((imageHash) => ({ imageHash, role: 'style-anchor', weight }));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
