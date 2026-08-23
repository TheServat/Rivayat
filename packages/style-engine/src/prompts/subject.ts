/**
 * Per-`SubjectClass` guidance, derived from the same structured fields.
 *
 * A tree and a face need different instructions out of the *same* style. "Two hard
 * tonal bands" applied to foliage means silhouetted leaf clusters; applied to a face it
 * means a hard terminator down the cheek. Rather than let the asset engine guess, each
 * subject class gets a clause computed from the fields that matter most to it.
 *
 * An ordered array rather than an object literal so the emission order of
 * `PromptFragments.bySubject` is fixed by construction - the fragments are hashed into
 * the style checksum, and object key order is not something to leave to chance.
 */

import type { SubjectClass, VisualStyle } from '@rv/contracts';

import { band, fixed, joinClauses, plural } from './words';

type SubjectClause = (visual: VisualStyle) => string;

export const SUBJECT_CLAUSES: readonly (readonly [SubjectClass, SubjectClause])[] = [
  [
    'character',
    (visual: VisualStyle): string =>
      joinClauses([
        `full figure at about ${fixed(visual.shape.headToBodyRatio, 1)} heads tall`,
        visual.shape.silhouetteRule,
        band(visual.shape.exaggeration, [
          'restrained, believable expression',
          'lightly pushed expression',
          'clearly pushed expression',
          'strongly pushed cartoon expression',
          'wildly exaggerated expression',
        ]),
        visual.palette.organicRamp.length === 0
          ? 'skin and hair drawn from the main palette'
          : `skin and hair drawn only from ${visual.palette.organicRamp.join(', ')}`,
        'front-facing three-quarter view, arms clear of the torso so the silhouette reads',
      ]),
  ],
  [
    'creature',
    (visual: VisualStyle): string =>
      joinClauses([
        band(visual.shape.roundness, [
          'bony angular anatomy',
          'lean angular anatomy',
          'balanced anatomy',
          'soft rounded anatomy',
          'plush, almost spherical anatomy',
        ]),
        visual.shape.silhouetteRule,
        `fur, feathers or scales resolved at ${band(visual.shape.detailDensity, [
          'pure silhouette level',
          'clumped mass level',
          'group level',
          'individual level',
          'single-strand level',
        ])}`,
        'side-on three-quarter view so limbs do not overlap',
      ]),
  ],
  [
    'prop',
    (visual: VisualStyle): string =>
      joinClauses([
        'single isolated object, no scene around it',
        band(visual.shape.detailDensity, [
          'reduced to its most recognisable shape',
          'simplified with only defining details',
          'the defining details plus surface wear',
          'fully detailed including manufacture marks',
          'exhaustively detailed, every join and scratch',
        ]),
        `reads in ${plural(visual.shading.steps, 'value')} so it stays legible at thumbnail size`,
      ]),
  ],
  [
    'foliage',
    (visual: VisualStyle): string =>
      joinClauses([
        'leaves grouped into readable clusters, never drawn individually',
        band(visual.texture.edgeRoughness, [
          'smooth continuous canopy outline',
          'gently uneven canopy outline',
          'broken, clumpy canopy outline',
          'torn and irregular canopy outline',
          'shredded, deeply notched canopy outline',
        ]),
        'trunk and boughs separable as distinct masses for rigging',
        visual.palette.organicRamp.length === 0
          ? undefined
          : `organic surfaces keyed to ${visual.palette.organicRamp.join(', ')}`,
      ]),
  ],
  [
    'architecture',
    (visual: VisualStyle): string =>
      joinClauses([
        band(visual.shape.roundness, [
          'strict straight-edged construction',
          'mostly straight-edged construction',
          'straight construction with softened corners',
          'hand-built leaning construction',
          'wobbly storybook construction with no straight edge',
        ]),
        'flat orthographic-leaning perspective, no vanishing-point distortion',
        `${plural(visual.shading.steps, 'tonal plane')} so walls, roof and openings separate`,
      ]),
  ],
  [
    'sky',
    (visual: VisualStyle): string =>
      joinClauses([
        'no ground, no horizon line, sky only',
        band(visual.palette.contrastFloor, [
          'flat even sky with almost no value change',
          'gently graded sky',
          'clearly graded sky',
          'strongly graded sky',
          'dramatic sky with near-black and near-white areas',
        ]),
        'clouds as flat shapes belonging to the palette, not photographic vapour',
      ]),
  ],
  [
    'ground',
    (visual: VisualStyle): string =>
      joinClauses([
        'seamless tileable ground plane, top-lit, no cast shadow from anything off-frame',
        // Ground is the one surface where grain and fibre read as the same thing - a
        // combined roughness, capped, rather than two separate clauses fighting.
        band(Math.min(1, visual.texture.grain + visual.texture.paperFiber), [
          'uniform untextured surface',
          'faintly broken surface',
          'visibly broken surface',
          'heavily textured surface',
          'coarse, deeply textured surface',
        ]),
      ]),
  ],
  [
    'water',
    (visual: VisualStyle): string =>
      joinClauses([
        'water as stacked flat bands of colour, not photographic reflection',
        `highlights as ${plural(visual.shading.steps, 'discrete shape')}, never a continuous specular sheen`,
        band(visual.shape.roundness, [
          'sharp chevron wave shapes',
          'angular wave shapes',
          'mixed wave shapes',
          'rounded rolling wave shapes',
          'soft bubbling wave shapes',
        ]),
      ]),
  ],
  [
    'fx',
    (visual: VisualStyle): string =>
      joinClauses([
        'effect drawn in the same medium as everything else, never a glowing digital overlay',
        band(visual.shape.exaggeration, [
          'physically plausible shapes',
          'lightly stylised shapes',
          'stylised graphic shapes',
          'strongly graphic symbol-like shapes',
          'pure symbol shapes with no physicality',
        ]),
        'fully transparent background so it can be composited over any layer',
      ]),
  ],
  [
    'ui',
    (visual: VisualStyle): string =>
      joinClauses([
        'interface element flat-on to camera, no perspective',
        `drawn in the ${visual.palette.harmony} palette so it belongs to the world`,
        'legible at one third of its drawn size',
      ]),
  ],
];
