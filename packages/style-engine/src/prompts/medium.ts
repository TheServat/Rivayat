/**
 * What each medium sounds like to an image model, and what it implies must be absent.
 *
 * A lookup table rather than a `switch`, per CLAUDE.md §2: adding a medium to the
 * `ArtMedium` enum should break this object at compile time and nothing else. The
 * `satisfies Record<ArtMedium, ...>` is what makes that happen.
 *
 * Each medium carries three things because the compiler needs three different registers:
 * a natural-language `clause` for models conditioned on T5 or an LLM encoder, a
 * comma-separated `tags` list for the CLIP-conditioned local lane (research §2: SD 1.5
 * and SDXL both cap at 77 CLIP tokens and read them close to bag-of-words), and the
 * `negatives` that the medium itself rules out - a woodblock print with a soft airbrush
 * gradient in it is not a woodblock print.
 */

import type { ArtMedium, VisualStyle } from '@rv/contracts';

export interface MediumPhrasing {
  /** Natural-language description of the physical medium. */
  readonly clause: string;
  /** CLIP-friendly tags, shortest-first, for the 77-token local lane. */
  readonly tags: readonly string[];
  /** What this medium structurally cannot contain. */
  readonly negatives: readonly string[];
}

export const MEDIUM_PHRASING = {
  'flat-vector': {
    clause: 'flat vector illustration with crisp geometric shapes and no gradients',
    tags: ['flat vector', 'crisp shapes', 'graphic illustration'],
    negatives: ['photographic depth of field', 'airbrush gradient', 'canvas texture'],
  },
  painterly: {
    clause: 'painterly digital illustration with visible directional brush strokes',
    tags: ['painterly', 'brush strokes', 'digital painting'],
    negatives: ['flat vector fill', 'hard vector edge', 'pixel grid'],
  },
  watercolour: {
    clause:
      'watercolour on cold-pressed paper, pigment blooming and pooling at the edges of each wash',
    tags: ['watercolour', 'wet on wet', 'paper bloom', 'soft wash'],
    negatives: ['hard vector edge', 'airbrush gradient', 'digital glow'],
  },
  gouache: {
    clause:
      'opaque gouache on toned paper, matte chalky pigment laid down in flat confident shapes',
    tags: ['gouache', 'opaque matte paint', 'toned paper'],
    negatives: ['glossy highlight', 'transparent wash', 'digital glow'],
  },
  'paper-cutout': {
    clause:
      'layered cut-paper collage, each element a separate torn sheet casting a short hard drop shadow',
    tags: ['cut paper', 'layered collage', 'torn edge', 'drop shadow'],
    negatives: ['soft airbrush gradient', 'blended shading', 'photographic depth of field'],
  },
  collage: {
    clause: 'mixed-media collage of found papers, tape and printed fragments assembled in layers',
    tags: ['mixed media collage', 'found paper', 'assembled layers'],
    negatives: ['clean vector fill', 'smooth gradient'],
  },
  'ink-comic': {
    clause:
      'brush-and-ink comic art, confident tapering strokes and solid black spotting for weight',
    tags: ['ink brush', 'comic art', 'spotted blacks', 'bold linework'],
    negatives: ['soft airbrush gradient', 'photographic lighting', 'muddy midtones'],
  },
  manga: {
    clause: 'manga pen-and-screentone artwork, fine even linework with adhesive tone for value',
    tags: ['manga', 'screentone', 'pen line', 'monochrome tone'],
    negatives: ['painterly blending', 'airbrush gradient'],
  },
  'pixel-art': {
    clause:
      'hand-placed pixel art on a strict pixel grid, every pixel deliberate and aligned to the lattice',
    tags: ['pixel art', 'pixel grid', 'limited palette', 'hard pixel edges'],
    negatives: ['anti-aliasing', 'blur', 'gradient dithering by filter', 'upscaling artefacts'],
  },
  'low-poly-2d': {
    clause: 'low-polygon 2D illustration built from flat triangular facets of solid colour',
    tags: ['low poly', 'triangular facets', 'faceted shading'],
    negatives: ['organic curve', 'soft gradient', 'texture noise'],
  },
  claymation: {
    clause:
      'photographed plasticine models under studio lights, thumbprints and tool marks visible in the clay',
    tags: ['plasticine', 'stop motion clay', 'thumbprint texture', 'studio light'],
    negatives: ['flat vector fill', 'ink outline', 'pixel grid'],
  },
  'felt-craft': {
    clause: 'hand-sewn felt and wool craft diorama, fuzzy fibre edges and visible running stitches',
    tags: ['felt craft', 'wool fibre', 'visible stitching', 'soft handmade'],
    negatives: ['hard vector edge', 'glossy plastic surface', 'ink outline'],
  },
  woodblock: {
    clause:
      'ukiyo-e woodblock print, flat keyed colour areas over a carved keyblock line, slight registration offset between plates',
    tags: ['woodblock print', 'keyblock line', 'flat colour plate', 'registration offset'],
    negatives: ['soft airbrush gradient', 'photographic lighting', 'blended midtones'],
  },
  'chalk-pastel': {
    clause:
      'soft chalk pastel dragged across toothy paper, dry pigment catching only the raised grain',
    tags: ['chalk pastel', 'toothy paper', 'dry pigment', 'dusty edge'],
    negatives: ['glossy surface', 'hard vector edge', 'digital glow'],
  },
  'photo-collage': {
    clause: 'cut-out photographic fragments recombined into an illustrated scene',
    tags: ['photo collage', 'cut out photography', 'recombined fragments'],
    negatives: ['hand-drawn outline', 'flat vector fill'],
  },
  // `custom` deliberately contributes nothing: the schema already refuses a custom
  // medium without a `mediumNote`, and the note is the description. Inventing a phrase
  // here would put words in the art director's mouth.
  custom: {
    clause: '',
    tags: [],
    negatives: [],
  },
} as const satisfies Record<ArtMedium, MediumPhrasing>;

/** Universal negatives. Nothing in this pipeline ever wants any of them. */
export const UNIVERSAL_NEGATIVES: readonly string[] = [
  'text',
  'lettering',
  'watermark',
  'signature',
  'jpeg artefacts',
  'blurry',
  'low resolution',
  'cropped subject',
  'extra limbs',
  'duplicated subject',
];

export const BACKGROUND_PHRASING = {
  'flat-color': 'set against a single flat field of colour with no scene behind it',
  gradient: 'set against a smooth two-tone gradient field',
  painted: 'set against a fully painted background scene',
  'layered-parallax': 'set against discrete depth layers separated for parallax',
  minimal: 'set against an almost empty background, only what the composition needs',
  'detailed-scene': 'set inside a dense, fully realised environment',
} as const satisfies Record<VisualStyle['backgroundTreatment'], string>;
