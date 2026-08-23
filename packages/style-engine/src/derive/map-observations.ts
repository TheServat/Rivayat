/**
 * Observations to fields.
 *
 * Every mapping in this file is a lookup table, and that is the point: the model
 * supplies evidence, this supplies judgement, and the judgement is reviewable in one
 * place rather than distributed across a prompt nobody can diff.
 *
 * Two design decisions worth defending.
 *
 * **The mapped medium's preset is the base.** Rather than assembling a bible field by
 * field and hoping the defaults cohere, derivation starts from the preset for the
 * medium it observed and overrides only what it measured. A reference set that shows an
 * outline but no shading therefore still gets a complete, internally coherent style
 * instead of a document that is half a paper cutout and half nothing.
 *
 * **Motion is inherited, never inferred.** The references are still images. A model
 * asked how a still image moves will answer confidently and be wrong, and the answer
 * would land in the one block of the bible whose whole purpose is to stop look and
 * movement drifting apart. So motion comes from the preset for the observed medium -
 * cut paper hinges, wet paint drifts - and the user edits it with the probe sheet in
 * front of them.
 */

import {
  type ArtMedium,
  type NamedColor,
  type StyleAnchor,
  type StyleBibleDraft,
  VisualStyle,
} from '@rv/contracts';

import { oklabDistance, parseHex, rgbToOklab } from '../colour/oklab';
import type { MeasuredPalette } from '../colour/palette';
import { compilePromptFragments } from '../prompts/compile';
import { STYLE_PRESETS } from '../presets/index';
import type { StylePreset } from '../presets/preset';
import type { StyleObservations, SurfaceImpression } from './observations';

const MEDIUM_BY_IMPRESSION = {
  'vector-flat': 'flat-vector',
  'printed-ink': 'ink-comic',
  'wet-paint': 'watercolour',
  'opaque-paint': 'gouache',
  'dry-pigment': 'chalk-pastel',
  'cut-paper': 'paper-cutout',
  'woven-fabric': 'felt-craft',
  'modelled-clay': 'claymation',
  'pixel-grid': 'pixel-art',
  'carved-print': 'woodblock',
  photographic: 'photo-collage',
} as const satisfies Record<SurfaceImpression, ArtMedium>;

const LINE_WEIGHT = {
  none: 0,
  hairline: 0.1,
  thin: 0.25,
  medium: 0.45,
  thick: 0.7,
  'very-thick': 0.9,
} as const satisfies Record<StyleObservations['outline']['thickness'], number>;

const LINE_VARIABILITY = {
  uniform: 0.05,
  'slightly-modulated': 0.35,
  'strongly-modulated': 0.8,
} as const satisfies Record<StyleObservations['outline']['uniformity'], number>;

const LINE_COLOR_MODE = {
  black: 'black',
  'darker-than-fill': 'darker-fill',
  coloured: 'tinted',
  'same-as-fill': 'none',
  'no-outline': 'none',
} as const satisfies Record<
  StyleObservations['outline']['colour'],
  VisualStyle['line']['colorMode']
>;

const LINE_ROUGHNESS = {
  'ruler-straight': 0.02,
  'slightly-uneven': 0.2,
  'hand-wobbled': 0.55,
  scratchy: 0.85,
} as const satisfies Record<StyleObservations['outline']['steadiness'], number>;

const SHADING_MODEL = {
  none: 'flat',
  hard: 'cel',
  soft: 'soft',
  textured: 'painterly',
  hatched: 'crosshatch',
  dotted: 'stipple',
} as const satisfies Record<StyleObservations['shading']['edge'], VisualStyle['shading']['model']>;

/** Degrees in the bible's convention: 0 = from the right, counter-clockwise. */
const LIGHT_DEGREES = {
  right: 0,
  'upper-right': 45,
  above: 90,
  'upper-left': 135,
  left: 180,
  'lower-left': 225,
  below: 270,
  'lower-right': 315,
  // Flat, directionless light is a real answer, and 90 (straight down) is the reading
  // that produces the least wrong shadows when there is no evidence either way.
  'no-clear-direction': 90,
} as const satisfies Record<StyleObservations['shading']['lightFrom'], number>;

const RIM_LIGHT = { none: 0, faint: 0.15, clear: 0.4, strong: 0.7 } as const satisfies Record<
  StyleObservations['shading']['rimLight'],
  number
>;

const CONTACT_SHADOWS = {
  none: 0,
  faint: 0.2,
  defined: 0.45,
  deep: 0.75,
} as const satisfies Record<StyleObservations['shading']['contactShadows'], number>;

const PRESENCE_VALUE = {
  none: 0,
  subtle: 0.2,
  noticeable: 0.5,
  dominant: 0.85,
} as const satisfies Record<StyleObservations['texture']['grain'], number>;

const ROUNDNESS = {
  sharp: 0.05,
  'mostly-sharp': 0.25,
  mixed: 0.5,
  'mostly-round': 0.75,
  round: 0.95,
} as const satisfies Record<StyleObservations['forms']['corners'], number>;

const EXAGGERATION = {
  realistic: 0.05,
  'slightly-stylised': 0.25,
  'clearly-stylised': 0.5,
  'strongly-caricatured': 0.75,
  extreme: 0.95,
} as const satisfies Record<StyleObservations['forms']['proportions'], number>;

const DETAIL_DENSITY = {
  pictographic: 0.1,
  sparse: 0.3,
  moderate: 0.5,
  dense: 0.7,
  intricate: 0.9,
} as const satisfies Record<StyleObservations['forms']['detail'], number>;

const BACKGROUND = {
  'flat-colour': 'flat-color',
  gradient: 'gradient',
  'painted-scene': 'painted',
  'stacked-depth-layers': 'layered-parallax',
  'almost-empty': 'minimal',
  'dense-detail': 'detailed-scene',
} as const satisfies Record<StyleObservations['background'], VisualStyle['backgroundTreatment']>;

const CONTRAST_FLOOR = {
  'very-low': 0.15,
  low: 0.3,
  moderate: 0.45,
  high: 0.65,
  'very-high': 0.8,
} as const satisfies Record<StyleObservations['valueContrast'], number>;

/** Roles are assigned by prominence order; past the named roles everything is neutral. */
const ROLE_BY_RANK: readonly NonNullable<NamedColor['role']>[] = [
  'primary',
  'secondary',
  'accent',
  'background',
  'shadow',
  'highlight',
];

/**
 * The preset that stands in for an observed medium.
 *
 * `photo-collage` has no preset - the library covers the eleven media the pipeline can
 * generate reliably - so it falls back to the flat-vector base, which contributes only
 * defaults for the fields observation does not cover.
 */
export function basePresetForMedium(medium: ArtMedium): StylePreset {
  const match = STYLE_PRESETS.find((preset) => preset.medium === medium);
  if (match !== undefined) return match;
  const fallback = STYLE_PRESETS[0];
  if (fallback === undefined) throw new Error('the preset library is empty');
  return fallback;
}

/**
 * Names the measured swatches by borrowing from the model's described colours.
 *
 * The hexes come from the pixels because a measured colour is exact and a described one
 * is a guess - but "moss" is worth far more to a prompt than "tone 3", and naming is
 * the one part of this a model is genuinely better at. Nearest in OKLab, so a described
 * colour only lends its name to a measurement it actually resembles.
 */
function nameSwatches(
  measured: MeasuredPalette,
  described: StyleObservations['colours'],
): readonly NamedColor[] {
  const describedLab = described.map((colour) => {
    const { r, g, b } = parseHex(colour.hex);
    return { name: colour.name, lab: rgbToOklab(r, g, b) };
  });

  return measured.swatches.map((swatch, index) => {
    const { r, g, b } = parseHex(swatch.hex);
    const lab = rgbToOklab(r, g, b);
    let bestName = `tone ${String(index + 1)}`;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of describedLab) {
      const distance = oklabDistance(lab, candidate.lab);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestName = candidate.name;
      }
    }
    const role = ROLE_BY_RANK[index];
    return {
      name: bestName,
      hex: swatch.hex,
      ...(role === undefined ? {} : { role }),
    };
  });
}

function describedSwatches(described: StyleObservations['colours']): readonly NamedColor[] {
  return described.map((colour, index) => {
    const role = ROLE_BY_RANK[index];
    return {
      name: colour.name,
      hex: colour.hex,
      ...(role === undefined ? {} : { role }),
    };
  });
}

export interface MapObservationsInput {
  readonly observations: StyleObservations;
  readonly name: string;
  readonly seed: number;
  /**
   * Palette measured from the reference pixels.
   *
   * `null` when no `RasterPort` was wired up, in which case the model's described
   * colours are used and the result says so.
   */
  readonly measuredPalette: MeasuredPalette | null;
  readonly anchors: readonly StyleAnchor[];
}

/**
 * Builds the proposed draft.
 *
 * Pure and total: same observations in, byte-identical draft out, which is what makes
 * the "derive twice, get the same bible" acceptance criterion meaningful.
 */
export function observationsToDraft(input: MapObservationsInput): StyleBibleDraft {
  const observed = input.observations;
  const medium = MEDIUM_BY_IMPRESSION[observed.surface.impression];
  const base = basePresetForMedium(medium);
  const baseVisual = base.draft.visual;

  const colors =
    input.measuredPalette !== null && input.measuredPalette.swatches.length >= 3
      ? nameSwatches(input.measuredPalette, observed.colours)
      : describedSwatches(observed.colours);

  const visual = VisualStyle.parse({
    medium,
    palette: {
      colors,
      harmony: observed.colourRelationship,
      contrastFloor: CONTRAST_FLOOR[observed.valueContrast],
      organicRamp: observed.organicColours,
    },
    line: {
      present: observed.outline.present,
      weight: LINE_WEIGHT[observed.outline.thickness],
      variability: LINE_VARIABILITY[observed.outline.uniformity],
      colorMode: LINE_COLOR_MODE[observed.outline.colour],
      taper: observed.outline.tapered ? 0.6 : 0.05,
      roughness: LINE_ROUGHNESS[observed.outline.steadiness],
    },
    shading: {
      model: SHADING_MODEL[observed.shading.edge],
      steps: observed.shading.bands,
      lightDirection: LIGHT_DEGREES[observed.shading.lightFrom],
      // Kept from the preset: a shadow's hue is genuinely hard to read off a reference
      // and easy for a model to hallucinate, and the preset's answer is at least
      // coherent with the medium.
      ...(baseVisual.shading.ambientTint === undefined
        ? {}
        : { ambientTint: baseVisual.shading.ambientTint }),
      rimLight: RIM_LIGHT[observed.shading.rimLight],
      occlusionStrength: CONTACT_SHADOWS[observed.shading.contactShadows],
    },
    texture: {
      grain: PRESENCE_VALUE[observed.texture.grain],
      paperFiber: PRESENCE_VALUE[observed.texture.paperFibre],
      halftone: PRESENCE_VALUE[observed.texture.halftone],
      edgeRoughness: PRESENCE_VALUE[observed.texture.edgeRaggedness],
      brushVisibility: PRESENCE_VALUE[observed.texture.brushMarks],
    },
    shape: {
      roundness: ROUNDNESS[observed.forms.corners],
      exaggeration: EXAGGERATION[observed.forms.proportions],
      headToBodyRatio: observed.forms.headsPerBody,
      silhouetteRule: observed.forms.readableAsSilhouette
        ? 'Subjects stay recognisable filled in solid black, as they are in the references.'
        : 'Subjects are read by their internal detail rather than their outline; keep interior contrast high.',
      detailDensity: DETAIL_DENSITY[observed.forms.detail],
    },
    backgroundTreatment: BACKGROUND[observed.background],
    negative: observed.notablyAbsent,
  });

  return {
    name: input.name,
    origin: 'derived',
    visual,
    // Still images cannot testify about movement - see the module note.
    motion: base.draft.motion,
    render: base.draft.render,
    prompts: compilePromptFragments({ visual }),
    anchors: [...input.anchors],
    seed: input.seed,
    notes: [
      `Derived from ${String(input.anchors.length)} reference image(s).`,
      `Surface read as "${observed.surface.impression}": ${observed.surface.evidence}`,
      `Motion inherited from the "${base.id}" preset - still references say nothing about movement. Review it before locking.`,
      input.measuredPalette === null
        ? 'Palette described by the model; no pixel decoder was available to measure one.'
        : `Palette measured from ${String(input.measuredPalette.sampled)} sampled pixels.`,
    ].join('\n'),
  };
}
