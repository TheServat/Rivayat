/**
 * Archetype to skeleton, as a lookup table.
 *
 * CLAUDE.md §2 forbids a `switch` on a style, format or provider name in core; the
 * same reasoning applies to archetypes, and more sharply, because there are twenty of
 * them and the union will grow. `TEMPLATE_BY_ARCHETYPE` is `Record<AssetArchetype,
 * RigTemplate>`, so adding a value to the enum in `@rv/contracts` breaks *this file* at
 * compile time rather than surfacing as a runtime miss on the first asset of that kind.
 */

import {
  type AssetArchetype,
  type PartPlan,
  type RigTemplate,
  RigTemplate as RigTemplateSchema,
} from '@rv/contracts';

import type { RigBlueprint } from './blueprint';
import {
  ARTICULATED_CHAIN,
  BIPED,
  CLOTH,
  CROWD_TILE,
  FOLIAGE_CLUMP,
  HINGED_PANEL,
  QUADRUPED,
  RADIAL_LIMBS,
  RIGID_SINGLE,
  SERPENTINE,
  TREE,
  VOLUMETRIC,
  WHEELED,
  WINGED,
} from './blueprints';

export type { RigBlueprint } from './blueprint';
export {
  ARTICULATED_CHAIN,
  BIPED,
  CLOTH,
  CROWD_TILE,
  FOLIAGE_CLUMP,
  HINGED_PANEL,
  QUADRUPED,
  RADIAL_LIMBS,
  RIGID_SINGLE,
  SERPENTINE,
  TREE,
  VOLUMETRIC,
  WHEELED,
  WINGED,
} from './blueprints';

/**
 * Which skeleton each archetype uses, and what it calls its clips.
 *
 * Where a blueprint is shared, the clip names are not: `cloud` drifts, `fire`
 * flickers and `water` laps, and the clip name is what a shot's blocking asks for by
 * hand. Sharing the bone graph is an implementation detail; sharing the vocabulary
 * would be a product decision, and the wrong one.
 */
const BINDINGS: Readonly<
  Record<
    AssetArchetype,
    { readonly blueprint: RigBlueprint; readonly clipNames?: readonly string[] }
  >
> = {
  biped: { blueprint: BIPED },
  quadruped: { blueprint: QUADRUPED },
  winged: { blueprint: WINGED },
  serpentine: { blueprint: SERPENTINE },
  'multi-limbed': { blueprint: RADIAL_LIMBS },
  tree: { blueprint: TREE },
  shrub: { blueprint: FOLIAGE_CLUMP },
  grass: { blueprint: FOLIAGE_CLUMP, clipNames: ['idle', 'sway', 'wind-gust', 'trample'] },
  cloud: { blueprint: VOLUMETRIC, clipNames: ['idle', 'drift', 'billow', 'dissipate'] },
  water: { blueprint: VOLUMETRIC, clipNames: ['idle', 'lap', 'surge', 'settle'] },
  fire: { blueprint: VOLUMETRIC, clipNames: ['idle', 'flicker', 'flare', 'gutter'] },
  wheeled: { blueprint: WHEELED },
  'door-hinged': { blueprint: HINGED_PANEL },
  cloth: { blueprint: CLOTH },
  'rigid-prop': { blueprint: RIGID_SINGLE },
  'articulated-prop': { blueprint: ARTICULATED_CHAIN },
  crowd: { blueprint: CROWD_TILE },
  'particle-fx': { blueprint: VOLUMETRIC, clipNames: ['idle', 'emit', 'burst', 'fade'] },
  backdrop: { blueprint: RIGID_SINGLE, clipNames: ['idle', 'parallax-drift'] },
  'ui-element': { blueprint: RIGID_SINGLE, clipNames: ['idle', 'enter', 'exit', 'pulse'] },
};

/** How many archetypes share each blueprint - decides whether the id needs qualifying. */
const SHARE_COUNT = ((): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const binding of Object.values(BINDINGS)) {
    counts.set(binding.blueprint.id, (counts.get(binding.blueprint.id) ?? 0) + 1);
  }
  return counts;
})();

function templateId(blueprint: RigBlueprint, archetype: AssetArchetype): string {
  return (SHARE_COUNT.get(blueprint.id) ?? 1) > 1 ? `${blueprint.id}-${archetype}` : blueprint.id;
}

/**
 * Accumulated rest position of every bone, in normalised canvas space.
 *
 * Needed twice: to give each `PartPlan` an `attachHint` the splitter can assign
 * against, and to place a bone whose part never came back. Computed here rather than
 * stored on the blueprint so the two can never disagree.
 */
export function blueprintWorldRest(
  blueprint: RigBlueprint,
): ReadonlyMap<string, { readonly x: number; readonly y: number }> {
  const world = new Map<string, { x: number; y: number }>();
  // Bones are authored parent-before-child, and `expandTemplate` asserts it, so one
  // forward pass resolves the whole tree.
  for (const bone of blueprint.bones) {
    const parent =
      bone.parentRole === null ? { x: 0, y: 0 } : (world.get(bone.parentRole) ?? { x: 0, y: 0 });
    world.set(bone.role, { x: parent.x + bone.rest.dx, y: parent.y + bone.rest.dy });
  }
  return world;
}

function expandTemplate(archetype: AssetArchetype): RigTemplate {
  const binding = BINDINGS[archetype];
  const blueprint = binding.blueprint;

  return RigTemplateSchema.parse({
    id: templateId(blueprint, archetype),
    archetype,
    label: blueprint.label,
    description: blueprint.description,
    bones: blueprint.bones.map((bone) => ({
      name: bone.role,
      role: bone.role,
      parentRole: bone.parentRole,
      rest: {
        position: { x: bone.rest.dx, y: bone.rest.dy },
        rotation: bone.rest.rotation ?? 0,
        length: bone.rest.length,
        scale: { x: 1, y: 1 },
      },
      ...(bone.constraint === undefined ? {} : { constraint: bone.constraint }),
      zOrderBias: bone.zOrderBias ?? 0,
    })),
    ikChains: (blueprint.chains ?? []).map((chain) => ({
      id: chain.id,
      rootRole: chain.rootRole,
      endRole: chain.endRole,
      chainLength: chain.chainLength,
      iterations: 8,
      poleAngle: chain.poleAngle ?? 0,
    })),
    anchors: (blueprint.anchors ?? []).map((anchor) => ({
      name: anchor.name,
      boneRole: anchor.boneRole,
      offset: anchor.offset ?? { x: 0, y: 0 },
      rotation: 0,
    })),
    clipNames: binding.clipNames ?? blueprint.clipNames,
  });
}

/**
 * Every archetype's template, expanded once at load.
 *
 * Eager rather than lazy so a malformed blueprint fails at import - the earliest
 * possible moment, and long before a user is waiting on a generation.
 */
export const TEMPLATE_BY_ARCHETYPE: Readonly<Record<AssetArchetype, RigTemplate>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(BINDINGS) as AssetArchetype[]).map((archetype) => [
      archetype,
      expandTemplate(archetype),
    ]),
  ) as Record<AssetArchetype, RigTemplate>,
);

export function templateFor(archetype: AssetArchetype): RigTemplate {
  return TEMPLATE_BY_ARCHETYPE[archetype];
}

export function blueprintFor(archetype: AssetArchetype): RigBlueprint {
  return BINDINGS[archetype].blueprint;
}

/**
 * The parts an archetype's rig needs, as a spec can ask for them.
 *
 * This is the join that makes auto-rigging work: the plan's `role` is the template's
 * bone role, so a part that comes back under its planned name binds to its bone with
 * no matching heuristic at all. `subjectLabel` is folded into each description because
 * an image model handed "left forearm, elbow to wrist" with no subject draws a
 * disembodied arm.
 */
/**
 * Expected extent of each part, as a fraction of the canvas.
 *
 * The bone's rest `length` is the only size the system knows before anything is drawn,
 * and it is a good enough proxy: a forearm bone is 0.11 and a canopy bone is 0.20, so
 * a blob four times either size is visibly the wrong candidate. Derived rather than
 * declared so the two cannot drift.
 */
export function extentByRole(archetype: AssetArchetype): ReadonlyMap<string, number> {
  return new Map(
    blueprintFor(archetype)
      .bones.filter((bone) => bone.part !== undefined)
      .map((bone) => [bone.role, bone.rest.length]),
  );
}

export function partPlansFor(archetype: AssetArchetype, subjectLabel: string): PartPlan[] {
  const blueprint = blueprintFor(archetype);
  const world = blueprintWorldRest(blueprint);
  const rolesWithParts = new Set(
    blueprint.bones.filter((bone) => bone.part !== undefined).map((bone) => bone.role),
  );
  const parentRole = new Map(blueprint.bones.map((bone) => [bone.role, bone.parentRole]));

  /** Nearest ancestor that actually owns a part; a bone-only parent is skipped. */
  const nearestPartAncestor = (role: string): string | undefined => {
    let cursor = parentRole.get(role) ?? null;
    while (cursor !== null) {
      if (rolesWithParts.has(cursor)) return cursor;
      cursor = parentRole.get(cursor) ?? null;
    }
    return undefined;
  };

  return blueprint.bones
    .filter(
      (bone): bone is typeof bone & { part: NonNullable<typeof bone.part> } =>
        bone.part !== undefined,
    )
    .map((bone) => {
      const at = world.get(bone.role) ?? { x: 0.5, y: 0.5 };
      const parent = nearestPartAncestor(bone.role);
      return {
        name: bone.role,
        role: bone.role,
        description: `${subjectLabel}: ${bone.part.description}`,
        zOrder: bone.part.zOrder,
        attachHint: { x: at.x, y: at.y },
        ...(parent === undefined ? {} : { parent }),
        deformable: bone.part.deformable ?? false,
        optional: bone.part.optional ?? false,
      } satisfies PartPlan;
    });
}
