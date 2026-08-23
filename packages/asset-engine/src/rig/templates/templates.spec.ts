import { describe, expect, it } from 'vitest';
import { AssetArchetype, RigTemplate } from '@rv/contracts';

import {
  blueprintWorldRest,
  blueprintFor,
  extentByRole,
  partPlansFor,
  templateFor,
  TEMPLATE_BY_ARCHETYPE,
} from './index';

const ARCHETYPES = AssetArchetype.options;

describe('the rig template library', () => {
  it('covers every archetype the contracts declare', () => {
    // The enum is the source of truth. A new archetype with no template would otherwise
    // surface as an undefined lookup on the first asset of that kind.
    expect(Object.keys(TEMPLATE_BY_ARCHETYPE).sort()).toEqual([...ARCHETYPES].sort());
  });

  it.each(ARCHETYPES)('%s expands to a schema-valid template', (archetype) => {
    const parsed = RigTemplate.safeParse(templateFor(archetype));
    expect(parsed.success).toBe(true);
  });

  it.each(ARCHETYPES)('%s has exactly one root and no dangling parent role', (archetype) => {
    const template = templateFor(archetype);
    const roles = new Set(template.bones.map((bone) => bone.role));

    expect(template.bones.filter((bone) => bone.parentRole === null)).toHaveLength(1);
    for (const bone of template.bones) {
      if (bone.parentRole !== null) expect(roles.has(bone.parentRole)).toBe(true);
    }
    for (const chain of template.ikChains) {
      expect(roles.has(chain.rootRole)).toBe(true);
      expect(roles.has(chain.endRole)).toBe(true);
    }
    for (const anchor of template.anchors) {
      expect(roles.has(anchor.boneRole)).toBe(true);
    }
  });

  it.each(ARCHETYPES)('%s declares bones parent-before-child', (archetype) => {
    // `blueprintWorldRest` resolves the tree in one forward pass and silently places a
    // forward-referenced bone at the origin, so the ordering is load-bearing.
    const seen = new Set<string>();
    for (const bone of blueprintFor(archetype).bones) {
      if (bone.parentRole !== null) expect(seen.has(bone.parentRole)).toBe(true);
      seen.add(bone.role);
    }
  });

  it.each(ARCHETYPES)('%s yields at least one part plan, bound to its own roles', (archetype) => {
    const plans = partPlansFor(archetype, 'Test subject');
    const roles = new Set(templateFor(archetype).bones.map((bone) => bone.role));

    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(roles.has(plan.role)).toBe(true);
      expect(plan.description).toContain('Test subject');
      expect(plan.attachHint).toBeDefined();
    }
    // Names are the dedup key's business: two parts sharing one is a silent overwrite.
    expect(new Set(plans.map((plan) => plan.name)).size).toBe(plans.length);
  });

  it('parents a part to the nearest ancestor that owns a part, skipping bone-only joints', () => {
    // A biped's `hips` bone carries no part, so a thigh's parent must be `torso`.
    const plans = partPlansFor('biped', 'Kael');
    const thigh = plans.find((plan) => plan.name === 'leg-upper-left');
    expect(thigh?.parent).toBe('torso');
  });

  it('derives an expected extent for each planned part from the bone length', () => {
    const extents = extentByRole('tree');
    expect(extents.get('trunk')).toBeGreaterThan(0);
    expect(extents.get('canopy')).toBeGreaterThan(0);
    expect(extents.has('nonexistent-role')).toBe(false);
  });

  it('accumulates world rest positions down the chain', () => {
    const world = blueprintWorldRest(blueprintFor('cloth'));
    const header = world.get('header');
    const lower = world.get('panel-lower');
    expect(header).toBeDefined();
    expect(lower?.y).toBeGreaterThan(header?.y ?? 0);
  });

  it('gives two archetypes that share a skeleton distinct ids and clip vocabularies', () => {
    const cloud = templateFor('cloud');
    const fire = templateFor('fire');

    expect(cloud.id).not.toBe(fire.id);
    expect(cloud.clipNames).not.toEqual(fire.clipNames);
    // Same shape underneath, which is the whole reason they share a blueprint.
    expect(cloud.bones.map((bone) => bone.role)).toEqual(fire.bones.map((bone) => bone.role));
  });

  it('keeps a one-to-one blueprint id unqualified', () => {
    expect(templateFor('tree').id).toBe('tree-standard');
    expect(templateFor('cloud').id).toBe('volumetric-drift-cloud');
  });
});
