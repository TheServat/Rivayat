/**
 * `Part[] → atlas.png + atlas.json` in **TexturePacker JSON-hash** format.
 *
 * One published convention, named, rather than a private shape nobody else can read:
 * JSON-hash is what TexturePacker emits by default and what Phaser 3 loads directly via
 * `this.load.atlas(key, 'atlas.png', 'atlas.json')`, and PixiJS reads it through
 * `Assets.load`. Choosing an existing format is the entire reason this exporter is worth
 * writing - a private one would need a private loader, and then the atlas would be no
 * more portable than the IR it came from.
 *
 * An atlas is **imagery, not a timeline**. It carries no animation whatsoever, so a rich
 * IR exports with a long list of dropped features, and that list is correct: the file
 * genuinely does not contain them. The frame-sequence exporter is the format that
 * carries motion as pixels.
 */

import { type AppError, type Result, ValidationError, err, isErr, ok } from '@rv/shared-kernel';
import { type IrFeature, detectIrFeatures } from '@rv/contracts';

import type { ExportOptions } from '../options';
import type { ImageEncoderPort } from '../pixels';
import {
  type ExportArtifact,
  type ExportInput,
  type ExportOutput,
  type Exporter,
  binaryArtifact,
  jsonArtifact,
  totalBytes,
} from '../port';
import {
  type ApproximationNote,
  type FormatCapabilities,
  UnsupportedFeaturesError,
  diffFeatures,
  lossyWarnings,
} from '../warnings';
import { type AtlasFrameSource, type AtlasPage, packAtlas, resolveAtlasOptions } from './pack';

export const ATLAS_FORMAT_ID = 'sprite-atlas';

/**
 * What an atlas can carry.
 *
 * Almost nothing, and deliberately declared that way. The only IR features that survive
 * are the ones that name imagery; every animated channel, every behaviour and the whole
 * camera are absent from the file by construction.
 */
export const ATLAS_CAPABILITIES: FormatCapabilities = {
  exact: new Set<IrFeature>(),
  approximate: new Map<IrFeature, ApproximationNote>([
    [
      'node:asset-instance',
      {
        disposition: 'restructured',
        detail:
          'the instance’s parts are packed as atlas frames; the placement, the rig and the timeline are not part of an atlas',
      },
    ],
    [
      'node:part',
      {
        disposition: 'restructured',
        detail: 'packed as an atlas frame keyed by the part’s name',
      },
    ],
  ]),
};

/** TexturePacker JSON-hash, as a type rather than as a shape assembled by hand. */
interface TexturePackerFrame {
  readonly frame: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
  readonly rotated: false;
  readonly trimmed: boolean;
  /** Where the trimmed pixels sit inside the original frame, and how big they are. */
  readonly spriteSourceSize: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
  readonly sourceSize: { readonly w: number; readonly h: number };
  readonly pivot: { readonly x: number; readonly y: number };
}

interface TexturePackerAtlas {
  readonly frames: Readonly<Record<string, TexturePackerFrame>>;
  readonly meta: {
    readonly app: string;
    readonly version: string;
    readonly image: string;
    readonly format: 'RGBA8888';
    readonly size: { readonly w: number; readonly h: number };
    readonly scale: string;
    readonly related_multi_packs?: readonly string[];
  };
}

export class AtlasExporter implements Exporter {
  readonly id = ATLAS_FORMAT_ID;
  readonly label = 'Sprite atlas';
  readonly formatSpec =
    'TexturePacker JSON-hash (`frames` keyed by name, `meta.image`/`meta.size`); loadable by Phaser 3 `load.atlas` and PixiJS `Assets.load`';
  readonly requires = ['parts'] as const;
  readonly capabilities = ATLAS_CAPABILITIES;

  readonly #encoder: ImageEncoderPort;

  constructor(deps: { readonly encoder: ImageEncoderPort }) {
    this.#encoder = deps.encoder;
  }

  async export(
    input: ExportInput,
    options: ExportOptions = {},
  ): Promise<Result<ExportOutput, AppError>> {
    const parts = input.parts;
    if (parts === undefined || parts.length === 0) {
      return err(
        new ValidationError({
          message:
            'the sprite-atlas export needs `parts`: an atlas is imagery, and the IR carries none',
        }),
      );
    }

    const resolved = resolveAtlasOptions(options.atlas ?? {}, 'atlas');
    if (isErr(resolved)) return resolved;
    const opts = resolved.value;

    const sources: readonly AtlasFrameSource[] = parts.map((entry) => ({
      name: `${entry.part.name}.png`,
      image: entry.image,
      sourceSize: entry.part.size,
      pivot: entry.part.pivot,
    }));

    const packed = await packAtlas(sources, opts, this.#encoder);
    if (isErr(packed)) return packed;

    const artifacts = describePages(packed.value, opts.name, this.#encoder.mediaType);

    const warnings = diffFeatures(detectIrFeatures(input.ir), ATLAS_CAPABILITIES);
    if (options.strict === true) {
      const lossy = lossyWarnings(warnings);
      if (lossy.length > 0) return err(new UnsupportedFeaturesError(this.id, lossy));
    }

    const frameCount = packed.value.reduce((sum, page) => sum + page.frames.length, 0);
    return ok({
      format: this.id,
      artifacts,
      warnings,
      stats: {
        totalBytes: totalBytes(artifacts),
        // An atlas has no timeline, so it has no keyframes. Frames are counted as the
        // sampled quantity, which is what a caller sizing the output actually wants.
        keyframeCount: 0,
        bakedKeyframeCount: 0,
        sampledFrames: frameCount,
        sampleStride: 1,
      },
    });
  }
}

/** Page 0 is `<name>.png`; overflow pages are `<name>-1.png` and so on. */
function pageBaseName(name: string, index: number): string {
  return index === 0 ? name : `${name}-${String(index)}`;
}

function describePages(
  pages: readonly AtlasPage[],
  name: string,
  mediaType: string,
): readonly ExportArtifact[] {
  const artifacts: ExportArtifact[] = [];

  for (const page of pages) {
    const base = pageBaseName(name, page.index);
    const imagePath = `${base}.png`;

    const frames: Record<string, TexturePackerFrame> = {};
    for (const frame of page.frames) {
      frames[frame.name] = {
        frame: {
          x: frame.rect.x,
          y: frame.rect.y,
          w: frame.rect.width,
          h: frame.rect.height,
        },
        rotated: false,
        trimmed: frame.trimmed,
        spriteSourceSize: {
          x: frame.trimOffset.x,
          y: frame.trimOffset.y,
          w: frame.rect.width,
          h: frame.rect.height,
        },
        sourceSize: { w: frame.sourceSize.width, h: frame.sourceSize.height },
        pivot: { x: frame.pivot.x, y: frame.pivot.y },
      };
    }

    const others = pages
      .filter((other) => other.index !== page.index)
      .map((other) => `${pageBaseName(name, other.index)}.json`);

    const atlas: TexturePackerAtlas = {
      frames,
      meta: {
        app: '@rv/export-kit',
        version: '1.0',
        image: imagePath,
        format: 'RGBA8888',
        size: { w: page.size.width, h: page.size.height },
        scale: '1',
        // No timestamp and no `smartupdate` digest: both would make two identical atlases
        // differ, which is the one property this file is required to have.
        ...(others.length > 0 ? { related_multi_packs: others } : {}),
      },
    };

    artifacts.push(binaryArtifact(imagePath, mediaType, page.image.data));
    artifacts.push(jsonArtifact(`${base}.json`, atlas));
  }

  return artifacts;
}

/** Builds atlas sources from named bitmaps, for callers that are not packing parts. */
export function atlasSourcesFromImages(
  images: ReadonlyMap<string, AtlasFrameSource['image']>,
): readonly AtlasFrameSource[] {
  return [...images].map(([name, image]) => ({ name, image }));
}
