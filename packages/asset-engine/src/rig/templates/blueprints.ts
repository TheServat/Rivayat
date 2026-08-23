/**
 * The skeletons themselves.
 *
 * Fourteen blueprints cover all twenty `AssetArchetype` values, because the archetype
 * enum is cut by *what a thing depicts* while a skeleton is decided by *how it
 * articulates*: a cloud, a flame and a splash are one deforming mass with a wisp, and
 * giving each its own bone graph would be three copies of the same four numbers.
 * Where two archetypes share a skeleton they still get their own `RigTemplate` and
 * their own clip names, because a cloud drifts and a fire flickers.
 *
 * Positions are fractions of the asset canvas: `x` from the left edge, `y` from the
 * top, `dx`/`dy` relative to the parent bone. They are a **fallback pose** - fitting
 * overwrites any bone whose part actually came back with that part's alpha centroid.
 */

import type { RigBlueprint } from './blueprint';

/** Two-legged, two-armed: the character skeleton. */
export const BIPED: RigBlueprint = {
  id: 'biped-standard',
  label: 'Biped',
  description: 'Upright two-legged figure with a segmented spine and four-bone limbs.',
  bones: [
    // Spine-rooted rather than hip-rooted: the torso is the part that exists, and a
    // root bone with no part leaves every limb's `PartPlan` parented to nothing.
    {
      role: 'torso',
      parentRole: null,
      rest: { dx: 0.5, dy: 0.46, length: 0.16 },
      part: { description: 'torso and shoulders, from waist to collarbone', zOrder: 2 },
    },
    { role: 'hips', parentRole: 'torso', rest: { dx: 0, dy: 0.14, length: 0.06 } },
    {
      role: 'head',
      parentRole: 'torso',
      rest: { dx: 0, dy: -0.16, length: 0.13 },
      part: { description: 'head and face, neutral expression, neck stub included', zOrder: 6 },
    },
    {
      role: 'arm-upper-left',
      parentRole: 'torso',
      rest: { dx: -0.08, dy: -0.11, length: 0.12 },
      part: { description: 'left upper arm, shoulder to elbow', zOrder: 1 },
    },
    {
      role: 'arm-lower-left',
      parentRole: 'arm-upper-left',
      rest: { dx: 0, dy: 0.12, length: 0.11 },
      part: { description: 'left forearm, elbow to wrist', zOrder: 1 },
      constraint: { minRotation: -150, maxRotation: 0 },
    },
    {
      role: 'hand-left',
      parentRole: 'arm-lower-left',
      rest: { dx: 0, dy: 0.11, length: 0.04 },
      part: { description: 'left hand, relaxed open palm', zOrder: 1 },
    },
    {
      role: 'arm-upper-right',
      parentRole: 'torso',
      rest: { dx: 0.08, dy: -0.11, length: 0.12 },
      part: { description: 'right upper arm, shoulder to elbow', zOrder: 5 },
    },
    {
      role: 'arm-lower-right',
      parentRole: 'arm-upper-right',
      rest: { dx: 0, dy: 0.12, length: 0.11 },
      part: { description: 'right forearm, elbow to wrist', zOrder: 5 },
      constraint: { minRotation: 0, maxRotation: 150 },
    },
    {
      role: 'hand-right',
      parentRole: 'arm-lower-right',
      rest: { dx: 0, dy: 0.11, length: 0.04 },
      part: { description: 'right hand, relaxed open palm', zOrder: 5 },
    },
    {
      role: 'leg-upper-left',
      parentRole: 'hips',
      rest: { dx: -0.04, dy: 0.03, length: 0.16 },
      part: { description: 'left thigh, hip to knee', zOrder: 1 },
    },
    {
      role: 'leg-lower-left',
      parentRole: 'leg-upper-left',
      rest: { dx: 0, dy: 0.16, length: 0.15 },
      part: { description: 'left shin, knee to ankle', zOrder: 1 },
      constraint: { minRotation: 0, maxRotation: 150 },
    },
    {
      role: 'foot-left',
      parentRole: 'leg-lower-left',
      rest: { dx: 0, dy: 0.15, length: 0.05 },
      part: { description: 'left foot, side profile', zOrder: 1 },
    },
    {
      role: 'leg-upper-right',
      parentRole: 'hips',
      rest: { dx: 0.04, dy: 0.03, length: 0.16 },
      part: { description: 'right thigh, hip to knee', zOrder: 4 },
    },
    {
      role: 'leg-lower-right',
      parentRole: 'leg-upper-right',
      rest: { dx: 0, dy: 0.16, length: 0.15 },
      part: { description: 'right shin, knee to ankle', zOrder: 4 },
      constraint: { minRotation: 0, maxRotation: 150 },
    },
    {
      role: 'foot-right',
      parentRole: 'leg-lower-right',
      rest: { dx: 0, dy: 0.15, length: 0.05 },
      part: { description: 'right foot, side profile', zOrder: 4 },
    },
  ],
  chains: [
    { id: 'arm-left', rootRole: 'arm-upper-left', endRole: 'hand-left', chainLength: 3 },
    { id: 'arm-right', rootRole: 'arm-upper-right', endRole: 'hand-right', chainLength: 3 },
    { id: 'leg-left', rootRole: 'leg-upper-left', endRole: 'foot-left', chainLength: 3 },
    { id: 'leg-right', rootRole: 'leg-upper-right', endRole: 'foot-right', chainLength: 3 },
  ],
  anchors: [
    { name: 'grip-left', boneRole: 'hand-left' },
    { name: 'grip-right', boneRole: 'hand-right' },
    { name: 'speech', boneRole: 'head', offset: { x: 0, y: -0.08 } },
    { name: 'eye-line', boneRole: 'head' },
  ],
  clipNames: ['idle', 'walk', 'run', 'talk', 'gesture', 'turn', 'react'],
};

/** Four-legged body carried on a horizontal spine. */
export const QUADRUPED: RigBlueprint = {
  id: 'quadruped-standard',
  label: 'Quadruped',
  description: 'Horizontal body with a neck, a tail and four two-bone legs.',
  bones: [
    {
      role: 'body',
      parentRole: null,
      rest: { dx: 0.5, dy: 0.5, length: 0.3 },
      part: { description: 'barrel of the body, shoulder to haunch, side view', zOrder: 2 },
    },
    {
      role: 'neck',
      parentRole: 'body',
      rest: { dx: -0.17, dy: -0.06, length: 0.1 },
      part: { description: 'neck, side view', zOrder: 3 },
    },
    {
      role: 'head',
      parentRole: 'neck',
      rest: { dx: -0.09, dy: -0.05, length: 0.09 },
      part: { description: 'head in profile, ears and muzzle included', zOrder: 4 },
    },
    {
      role: 'tail',
      parentRole: 'body',
      rest: { dx: 0.18, dy: -0.02, length: 0.14 },
      part: { description: 'tail, side view', zOrder: 1, deformable: true },
      constraint: { springStiffness: 0.4, springDamping: 0.6 },
    },
    {
      role: 'leg-front-left',
      parentRole: 'body',
      rest: { dx: -0.13, dy: 0.09, length: 0.13 },
      part: { description: 'near foreleg, shoulder to hock', zOrder: 1 },
    },
    {
      role: 'paw-front-left',
      parentRole: 'leg-front-left',
      rest: { dx: 0, dy: 0.13, length: 0.05 },
      part: { description: 'near forefoot', zOrder: 1 },
    },
    {
      role: 'leg-front-right',
      parentRole: 'body',
      rest: { dx: -0.1, dy: 0.09, length: 0.13 },
      part: { description: 'far foreleg, shoulder to hock', zOrder: 3 },
    },
    {
      role: 'paw-front-right',
      parentRole: 'leg-front-right',
      rest: { dx: 0, dy: 0.13, length: 0.05 },
      part: { description: 'far forefoot', zOrder: 3 },
    },
    {
      role: 'leg-back-left',
      parentRole: 'body',
      rest: { dx: 0.12, dy: 0.09, length: 0.13 },
      part: { description: 'near hind leg, haunch to hock', zOrder: 1 },
    },
    {
      role: 'paw-back-left',
      parentRole: 'leg-back-left',
      rest: { dx: 0, dy: 0.13, length: 0.05 },
      part: { description: 'near hind foot', zOrder: 1 },
    },
    {
      role: 'leg-back-right',
      parentRole: 'body',
      rest: { dx: 0.15, dy: 0.09, length: 0.13 },
      part: { description: 'far hind leg, haunch to hock', zOrder: 3 },
    },
    {
      role: 'paw-back-right',
      parentRole: 'leg-back-right',
      rest: { dx: 0, dy: 0.13, length: 0.05 },
      part: { description: 'far hind foot', zOrder: 3 },
    },
  ],
  chains: [
    { id: 'front-left', rootRole: 'leg-front-left', endRole: 'paw-front-left', chainLength: 2 },
    { id: 'front-right', rootRole: 'leg-front-right', endRole: 'paw-front-right', chainLength: 2 },
    { id: 'back-left', rootRole: 'leg-back-left', endRole: 'paw-back-left', chainLength: 2 },
    { id: 'back-right', rootRole: 'leg-back-right', endRole: 'paw-back-right', chainLength: 2 },
  ],
  anchors: [
    { name: 'saddle', boneRole: 'body' },
    { name: 'eye-line', boneRole: 'head' },
  ],
  clipNames: ['idle', 'walk', 'trot', 'run', 'graze', 'alert'],
};

/** Anything that flies on a membrane or a feathered plane. */
export const WINGED: RigBlueprint = {
  id: 'winged-standard',
  label: 'Winged',
  description: 'Compact body with two two-segment wings, a tail and two legs.',
  bones: [
    {
      role: 'body',
      parentRole: null,
      rest: { dx: 0.5, dy: 0.5, length: 0.18 },
      part: { description: 'body and breast, side view', zOrder: 2 },
    },
    {
      role: 'head',
      parentRole: 'body',
      rest: { dx: -0.08, dy: -0.09, length: 0.07 },
      part: { description: 'head with beak or muzzle, in profile', zOrder: 3 },
    },
    {
      role: 'tail',
      parentRole: 'body',
      rest: { dx: 0.13, dy: 0.02, length: 0.1 },
      part: { description: 'tail fan', zOrder: 1, deformable: true },
    },
    {
      role: 'wing-left',
      parentRole: 'body',
      rest: { dx: -0.02, dy: -0.03, length: 0.14 },
      part: { description: 'near wing, inner section, spread', zOrder: 1, deformable: true },
    },
    {
      role: 'wing-left-tip',
      parentRole: 'wing-left',
      rest: { dx: -0.15, dy: -0.02, length: 0.13 },
      part: { description: 'near wing, outer primaries', zOrder: 1, deformable: true },
    },
    {
      role: 'wing-right',
      parentRole: 'body',
      rest: { dx: 0.02, dy: -0.03, length: 0.14 },
      part: { description: 'far wing, inner section, spread', zOrder: 4, deformable: true },
    },
    {
      role: 'wing-right-tip',
      parentRole: 'wing-right',
      rest: { dx: 0.15, dy: -0.02, length: 0.13 },
      part: { description: 'far wing, outer primaries', zOrder: 4, deformable: true },
    },
    {
      role: 'leg-left',
      parentRole: 'body',
      rest: { dx: -0.02, dy: 0.09, length: 0.07 },
      part: { description: 'near leg and foot', zOrder: 1, optional: true },
    },
    {
      role: 'leg-right',
      parentRole: 'body',
      rest: { dx: 0.02, dy: 0.09, length: 0.07 },
      part: { description: 'far leg and foot', zOrder: 3, optional: true },
    },
  ],
  chains: [
    { id: 'wing-left', rootRole: 'wing-left', endRole: 'wing-left-tip', chainLength: 2 },
    { id: 'wing-right', rootRole: 'wing-right', endRole: 'wing-right-tip', chainLength: 2 },
  ],
  anchors: [
    { name: 'perch', boneRole: 'leg-left' },
    { name: 'eye-line', boneRole: 'head' },
  ],
  clipNames: ['idle', 'flap', 'glide', 'take-off', 'land', 'hop'],
};

/** A head and a chain of body segments: snakes, eels, worms, ropes of smoke. */
export const SERPENTINE: RigBlueprint = {
  id: 'serpentine-chain',
  label: 'Serpentine',
  description: 'Head plus a six-segment spring chain that propagates motion to the tail.',
  bones: [
    {
      role: 'head',
      parentRole: null,
      rest: { dx: 0.2, dy: 0.5, length: 0.08 },
      part: { description: 'head in profile', zOrder: 7 },
    },
    ...[1, 2, 3, 4, 5, 6].map((index) => ({
      role: `segment-${String(index)}`,
      parentRole: index === 1 ? 'head' : `segment-${String(index - 1)}`,
      rest: { dx: 0.1, dy: 0, length: 0.1 },
      part: {
        description: `body segment ${String(index)} of six, tapering toward the tail`,
        zOrder: 7 - index,
        deformable: true,
      },
      constraint: { springStiffness: 0.5, springDamping: 0.5 },
    })),
  ],
  anchors: [{ name: 'eye-line', boneRole: 'head' }],
  clipNames: ['idle', 'slither', 'coil', 'strike'],
};

/** A radially symmetric body: spiders, cephalopods, many-armed constructs. */
export const RADIAL_LIMBS: RigBlueprint = {
  id: 'radial-limbs',
  label: 'Multi-limbed',
  description: 'Central mass with six limbs fanned around it.',
  bones: [
    {
      role: 'core',
      parentRole: null,
      rest: { dx: 0.5, dy: 0.46, length: 0.14 },
      part: { description: 'central mass of the body', zOrder: 3 },
    },
    ...[0, 1, 2, 3, 4, 5].map((index) => ({
      role: `limb-${String(index + 1)}`,
      parentRole: 'core',
      rest: {
        dx: -0.18 + index * 0.072,
        dy: index % 2 === 0 ? 0.04 : 0.08,
        length: 0.18,
        rotation: -60 + index * 24,
      },
      part: {
        description: `limb ${String(index + 1)} of six, jointed, tapering`,
        zOrder: index < 3 ? 1 : 5,
        deformable: true,
      },
    })),
  ],
  anchors: [{ name: 'eye-line', boneRole: 'core' }],
  clipNames: ['idle', 'scuttle', 'rear', 'grasp'],
};

/** Trunk, boughs and canopy - the archetype every ambient shot leans on. */
export const TREE: RigBlueprint = {
  id: 'tree-standard',
  label: 'Tree',
  description: 'Trunk with two boughs and a three-piece canopy, all wind-deformable.',
  bones: [
    {
      role: 'trunk',
      parentRole: null,
      rest: { dx: 0.5, dy: 0.86, length: 0.4 },
      part: { description: 'trunk with visible bark and root flare', zOrder: 0 },
    },
    {
      role: 'bough-left',
      parentRole: 'trunk',
      rest: { dx: -0.09, dy: -0.32, length: 0.16, rotation: -35 },
      part: { description: 'left bough reaching outward', zOrder: 1, deformable: true },
      constraint: { springStiffness: 0.35, springDamping: 0.7 },
    },
    {
      role: 'bough-right',
      parentRole: 'trunk',
      rest: { dx: 0.09, dy: -0.32, length: 0.16, rotation: 35 },
      part: { description: 'right bough reaching outward', zOrder: 1, deformable: true },
      constraint: { springStiffness: 0.35, springDamping: 0.7 },
    },
    {
      role: 'canopy',
      parentRole: 'trunk',
      rest: { dx: 0, dy: -0.42, length: 0.2 },
      part: { description: 'central leaf mass', zOrder: 2, deformable: true },
    },
    {
      role: 'canopy-left',
      parentRole: 'bough-left',
      rest: { dx: -0.08, dy: -0.06, length: 0.14 },
      part: { description: 'left leaf cluster', zOrder: 2, deformable: true, optional: true },
    },
    {
      role: 'canopy-right',
      parentRole: 'bough-right',
      rest: { dx: 0.08, dy: -0.06, length: 0.14 },
      part: { description: 'right leaf cluster', zOrder: 2, deformable: true, optional: true },
    },
  ],
  anchors: [
    { name: 'canopy-centre', boneRole: 'canopy' },
    { name: 'base', boneRole: 'trunk', offset: { x: 0, y: 0.4 } },
  ],
  clipNames: ['idle', 'sway', 'wind-gust', 'storm'],
};

/** Low growth: a base and a deformable tuft. */
export const FOLIAGE_CLUMP: RigBlueprint = {
  id: 'foliage-clump',
  label: 'Foliage clump',
  description: 'Rooted base with a single deformable mass above it.',
  bones: [
    {
      role: 'base',
      parentRole: null,
      rest: { dx: 0.5, dy: 0.88, length: 0.1 },
      part: { description: 'stems and base where the growth meets the ground', zOrder: 0 },
    },
    {
      role: 'tuft',
      parentRole: 'base',
      rest: { dx: 0, dy: -0.2, length: 0.24 },
      part: { description: 'the leafy mass', zOrder: 1, deformable: true },
      constraint: { springStiffness: 0.3, springDamping: 0.65 },
    },
  ],
  anchors: [{ name: 'top', boneRole: 'tuft' }],
  clipNames: ['idle', 'sway', 'wind-gust'],
};

/** A hanging panel that ripples: banners, curtains, capes, flags. */
export const CLOTH: RigBlueprint = {
  id: 'cloth-hang',
  label: 'Cloth',
  description: 'Fixed header with three deformable panels chained below it.',
  bones: [
    {
      role: 'header',
      parentRole: null,
      rest: { dx: 0.5, dy: 0.1, length: 0.06 },
      part: { description: 'the fixed top edge, rod or seam', zOrder: 0 },
    },
    {
      role: 'panel-upper',
      parentRole: 'header',
      rest: { dx: 0, dy: 0.2, length: 0.24 },
      part: { description: 'upper third of the hanging cloth', zOrder: 1, deformable: true },
      constraint: { springStiffness: 0.55, springDamping: 0.5 },
    },
    {
      role: 'panel-middle',
      parentRole: 'panel-upper',
      rest: { dx: 0, dy: 0.24, length: 0.24 },
      part: { description: 'middle third of the hanging cloth', zOrder: 1, deformable: true },
      constraint: { springStiffness: 0.45, springDamping: 0.5 },
    },
    {
      role: 'panel-lower',
      parentRole: 'panel-middle',
      rest: { dx: 0, dy: 0.24, length: 0.24 },
      part: { description: 'lower third with the hem', zOrder: 1, deformable: true },
      constraint: { springStiffness: 0.35, springDamping: 0.5 },
    },
  ],
  anchors: [{ name: 'hem', boneRole: 'panel-lower' }],
  clipNames: ['idle', 'ripple', 'wind-gust', 'settle'],
};

/** One piece that moves as one piece. */
export const RIGID_SINGLE: RigBlueprint = {
  id: 'rigid-single',
  label: 'Rigid body',
  description: 'A single part on a single bone. Still animatable by transform and mesh.',
  bones: [
    {
      role: 'body',
      parentRole: null,
      rest: { dx: 0.5, dy: 0.5, length: 0.3 },
      part: { description: 'the whole object', zOrder: 0 },
    },
  ],
  anchors: [{ name: 'centre', boneRole: 'body' }],
  clipNames: ['idle', 'bob', 'hit-react'],
};

/** A frame and a leaf that swings on it. */
export const HINGED_PANEL: RigBlueprint = {
  id: 'hinged-panel',
  label: 'Hinged panel',
  description: 'Static frame plus one leaf constrained to a quarter turn.',
  bones: [
    {
      role: 'frame',
      parentRole: null,
      rest: { dx: 0.5, dy: 0.5, length: 0.4 },
      part: { description: 'the surrounding frame or jamb', zOrder: 0 },
    },
    {
      role: 'panel',
      parentRole: 'frame',
      rest: { dx: -0.16, dy: 0, length: 0.32 },
      part: { description: 'the swinging leaf, hinge edge on the left', zOrder: 1 },
      constraint: { minRotation: -100, maxRotation: 0 },
    },
  ],
  anchors: [{ name: 'handle', boneRole: 'panel', offset: { x: 0.24, y: 0 } }],
  clipNames: ['idle', 'open', 'close', 'slam'],
};

/** A jointed arm: cranes, lamps, mechanisms, tools that extend. */
export const ARTICULATED_CHAIN: RigBlueprint = {
  id: 'articulated-chain',
  label: 'Articulated prop',
  description: 'Fixed base and three jointed segments, IK-solvable to the tip.',
  bones: [
    {
      role: 'base',
      parentRole: null,
      rest: { dx: 0.5, dy: 0.82, length: 0.12 },
      part: { description: 'mounting base', zOrder: 0 },
    },
    {
      role: 'segment-1',
      parentRole: 'base',
      rest: { dx: 0, dy: -0.16, length: 0.18 },
      part: { description: 'first segment above the base', zOrder: 1 },
    },
    {
      role: 'segment-2',
      parentRole: 'segment-1',
      rest: { dx: 0, dy: -0.18, length: 0.16 },
      part: { description: 'second segment', zOrder: 1 },
    },
    {
      role: 'tip',
      parentRole: 'segment-2',
      rest: { dx: 0, dy: -0.14, length: 0.08 },
      part: { description: 'working end - head, claw, lamp or blade', zOrder: 2 },
    },
  ],
  chains: [{ id: 'reach', rootRole: 'segment-1', endRole: 'tip', chainLength: 3 }],
  anchors: [{ name: 'tool-point', boneRole: 'tip' }],
  clipNames: ['idle', 'extend', 'retract', 'articulate'],
};

/** A chassis on two wheels that must rotate independently of it. */
export const WHEELED: RigBlueprint = {
  id: 'wheeled-chassis',
  label: 'Wheeled',
  description: 'Chassis with a body shell and two independently spinning wheels.',
  bones: [
    {
      role: 'chassis',
      parentRole: null,
      rest: { dx: 0.5, dy: 0.56, length: 0.4 },
      part: { description: 'chassis and frame, side view', zOrder: 1 },
    },
    {
      role: 'shell',
      parentRole: 'chassis',
      rest: { dx: 0, dy: -0.1, length: 0.18 },
      part: { description: 'body shell, cabin or load', zOrder: 2, optional: true },
    },
    {
      role: 'wheel-front',
      parentRole: 'chassis',
      rest: { dx: -0.16, dy: 0.14, length: 0.1 },
      part: { description: 'front wheel, seen square-on', zOrder: 3 },
    },
    {
      role: 'wheel-rear',
      parentRole: 'chassis',
      rest: { dx: 0.16, dy: 0.14, length: 0.1 },
      part: { description: 'rear wheel, seen square-on', zOrder: 3 },
    },
  ],
  anchors: [{ name: 'seat', boneRole: 'shell' }],
  clipNames: ['idle', 'roll', 'brake', 'bounce'],
};

/** A soft mass that has no skeleton worth the name, plus one trailing wisp. */
export const VOLUMETRIC: RigBlueprint = {
  id: 'volumetric-drift',
  label: 'Volumetric mass',
  description: 'One deforming mass and an optional wisp; motion is mesh, not bones.',
  bones: [
    {
      role: 'mass',
      parentRole: null,
      rest: { dx: 0.5, dy: 0.5, length: 0.3 },
      part: { description: 'the main mass', zOrder: 0, deformable: true },
    },
    {
      role: 'wisp',
      parentRole: 'mass',
      rest: { dx: 0.14, dy: -0.08, length: 0.16 },
      part: {
        description: 'trailing wisp that breaks the silhouette',
        zOrder: 1,
        deformable: true,
        optional: true,
      },
    },
  ],
  anchors: [{ name: 'centre', boneRole: 'mass' }],
  clipNames: ['idle', 'drift', 'billow', 'dissipate'],
};

/** Depth-sorted rows, so a crowd parallaxes instead of sliding as one sheet. */
export const CROWD_TILE: RigBlueprint = {
  id: 'crowd-tile',
  label: 'Crowd',
  description: 'Three depth-sorted rows of figures, each row moving on its own phase.',
  bones: [
    {
      role: 'row-back',
      parentRole: null,
      rest: { dx: 0.5, dy: 0.44, length: 0.4 },
      part: { description: 'back row of figures, smallest and lowest contrast', zOrder: 0 },
    },
    {
      role: 'row-middle',
      parentRole: 'row-back',
      rest: { dx: 0, dy: 0.1, length: 0.4 },
      part: { description: 'middle row of figures', zOrder: 1 },
    },
    {
      role: 'row-front',
      parentRole: 'row-middle',
      rest: { dx: 0, dy: 0.1, length: 0.4 },
      part: { description: 'front row of figures, largest and most detailed', zOrder: 2 },
    },
  ],
  anchors: [{ name: 'centre', boneRole: 'row-middle' }],
  clipNames: ['idle', 'murmur', 'surge'],
};
