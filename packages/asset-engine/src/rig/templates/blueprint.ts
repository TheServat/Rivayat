/**
 * The compact form a rig template is authored in.
 *
 * A `RigTemplate` in `@rv/contracts` is the *stored* shape - every default spelled
 * out, every chain and anchor listed separately. Authoring twenty of those by hand
 * would be twenty opportunities to bind a wing to the wrong parent, so templates are
 * written as blueprints and expanded once.
 *
 * The other reason the blueprint exists: a bone and the part it moves are declared
 * **together**. That is what makes "part plans come from the archetype's rig template"
 * mechanically true rather than a convention two files apart - the parts a spec asks
 * for and the roles a rig binds are generated from the same list, so a part that comes
 * back always has somewhere to attach.
 */

import type { AssetArchetype } from '@rv/contracts';

/**
 * Where a bone sits, in **normalised canvas space relative to its parent**.
 *
 * Fractions rather than pixels because a template is shared by a 512 px prop and a
 * 2048 px hero, and because `FitRigUseCase` replaces these with measured alpha
 * centroids wherever a real part turned up. What survives fitting is the *topology*
 * and the fallback pose for parts that did not.
 */
export interface BlueprintRest {
  readonly dx: number;
  readonly dy: number;
  readonly length: number;
  readonly rotation?: number;
}

/** The part this bone moves, when it moves one. */
export interface BlueprintPart {
  /** Drawing brief for this piece, before the style bible's clauses are applied. */
  readonly description: string;
  readonly zOrder: number;
  /** Needs a mesh rather than a rigid transform - foliage, cloth, wings, water. */
  readonly deformable?: boolean;
  /** Its absence is acceptable. Optional parts never fail the completeness check. */
  readonly optional?: boolean;
}

export interface BlueprintBone {
  /** Doubles as the bone's `name` and its template `role`. Unique within a blueprint. */
  readonly role: string;
  readonly parentRole: string | null;
  readonly rest: BlueprintRest;
  readonly part?: BlueprintPart;
  readonly zOrderBias?: number;
  readonly constraint?: {
    readonly minRotation?: number;
    readonly maxRotation?: number;
    readonly springStiffness?: number;
    readonly springDamping?: number;
  };
}

export interface BlueprintChain {
  readonly id: string;
  readonly rootRole: string;
  readonly endRole: string;
  readonly chainLength: number;
  readonly poleAngle?: number;
}

export interface BlueprintAnchor {
  readonly name: string;
  readonly boneRole: string;
  readonly offset?: { readonly x: number; readonly y: number };
}

export interface RigBlueprint {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly bones: readonly BlueprintBone[];
  readonly chains?: readonly BlueprintChain[];
  readonly anchors?: readonly BlueprintAnchor[];
  /** Default clip set. An archetype may override it without forking the skeleton. */
  readonly clipNames: readonly string[];
}

/** Which blueprint an archetype uses, and what it calls its clips. */
export interface ArchetypeBinding {
  readonly blueprint: RigBlueprint;
  readonly clipNames?: readonly string[];
  /** Appended to the template id, so `cloud` and `fire` are distinguishable. */
  readonly archetype: AssetArchetype;
}
