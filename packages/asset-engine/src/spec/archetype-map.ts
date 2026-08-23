/**
 * The tables that turn "what this is in the story" into "how it rigs".
 *
 * RV-126 is blunt about where the archetype comes from: **the `AssetSpec`, not the
 * pixels**, and a source-scan test in that story asserts there is no pixel-based
 * guessing. These maps are the other half of that promise - the archetype is decided
 * here, from the narrative entity's `kind` and its payload, before anything is drawn.
 *
 * Every map is `Record<Union, …>` rather than a `switch`, so adding an entity kind or
 * an archetype breaks the build here instead of falling through at runtime.
 */

import type {
  AssetArchetype,
  Entity,
  EntityKind,
  QualityTarget,
  Size,
  SubjectClass,
} from '@rv/contracts';

/**
 * The archetype an entity gets when nobody says otherwise.
 *
 * A default, deliberately: a creature is a quadruped far more often than it is
 * anything else, but "six-legged, wall-crawling" is a fact the story engine knows and
 * this table cannot, so `DeriveAssetSpecUseCase` takes an explicit override and this
 * only fills the gap.
 */
export const DEFAULT_ARCHETYPE_BY_ENTITY_KIND: Readonly<Record<EntityKind, AssetArchetype>> = {
  character: 'biped',
  creature: 'quadruped',
  prop: 'rigid-prop',
  location: 'backdrop',
  vehicle: 'wheeled',
  faction: 'ui-element',
  concept: 'ui-element',
  event: 'particle-fx',
  substance: 'water',
};

/** Which style-bible prompt fragment applies. */
export const SUBJECT_CLASS_BY_ENTITY_KIND: Readonly<Record<EntityKind, SubjectClass>> = {
  character: 'character',
  creature: 'creature',
  prop: 'prop',
  location: 'architecture',
  vehicle: 'prop',
  faction: 'ui',
  concept: 'ui',
  event: 'fx',
  substance: 'fx',
};

/**
 * Generation resolution per quality target - the measured ladder, not a guess.
 *
 * Research §2 benchmarked the free lane on this machine: 512² at 4 steps is 1.42 s,
 * 768² is 3.25 s, 1024² is 7.59 s at 5839 MiB, which is 95 % of a 6 GB card. 1280²
 * thrashes. So `final` stops at 1024 and the ladder below it is the two rungs that
 * were actually timed.
 */
export const CANVAS_BY_QUALITY: Readonly<Record<QualityTarget, Size>> = {
  draft: { width: 512, height: 512 },
  preview: { width: 768, height: 768 },
  final: { width: 1024, height: 1024 },
};

/** Nominal on-screen height, so a prop and a tree share one scale space. */
export const NOMINAL_HEIGHT_BY_ARCHETYPE: Readonly<Partial<Record<AssetArchetype, number>>> = {
  tree: 900,
  backdrop: 1080,
  crowd: 400,
  grass: 120,
  shrub: 240,
  'ui-element': 200,
};

export const DEFAULT_NOMINAL_HEIGHT = 512;

/**
 * The archetype implied by an entity's payload, where the payload actually says.
 *
 * Only two kinds carry a usable signal, and both are structured flags rather than
 * prose: a prop that declares `riggable` articulates, and a vehicle that declares it
 * does too. Nothing here reads a description - inferring "six legs" from
 * `CreaturePayload.anatomy` is a language-model job that belongs upstream in S3, and
 * doing it with keyword matching would produce a confident, wrong rig.
 */
export function archetypeFromPayload(entity: Entity): AssetArchetype | undefined {
  if (entity.kind === 'prop') {
    return entity.payload.riggable ? 'articulated-prop' : 'rigid-prop';
  }
  if (entity.kind === 'vehicle') {
    return entity.payload.riggable ? 'wheeled' : 'rigid-prop';
  }
  return undefined;
}
