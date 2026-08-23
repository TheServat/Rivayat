import { describe, expect, it } from 'vitest';
import { isErr, isOk, unwrap } from '@rv/shared-kernel';

import { AtlasExporter, atlasSourcesFromImages } from './atlas-exporter';
import { blankImage, compositeImage, cropImage } from '../pixels';
import { SharpPngEncoder, decodePng, solid } from '../__fixtures__/images';
import { hierarchyIr, richIr } from '../__fixtures__/ir';
import { partImages, rigFixture } from '../__fixtures__/rig';
import { artifact, readJson } from '../__fixtures__/read';

interface TexturePackerAtlas {
  frames: Record<
    string,
    {
      frame: { x: number; y: number; w: number; h: number };
      rotated: boolean;
      trimmed: boolean;
      spriteSourceSize: { x: number; y: number; w: number; h: number };
      sourceSize: { w: number; h: number };
      pivot: { x: number; y: number };
    }
  >;
  meta: {
    app: string;
    image: string;
    format: string;
    size: { w: number; h: number };
    scale: string;
    related_multi_packs?: string[];
  };
}

const exporter = new AtlasExporter({ encoder: new SharpPngEncoder() });

function fixtureInput(): {
  ir: ReturnType<typeof hierarchyIr>;
  parts: ReturnType<typeof partImages>;
} {
  const { parts } = rigFixture();
  return { ir: hierarchyIr(), parts: partImages(parts) };
}

describe('AtlasExporter', () => {
  it('declares what it needs and which published format it writes', () => {
    expect(exporter.id).toBe('sprite-atlas');
    expect(exporter.requires).toEqual(['parts']);
    expect(exporter.formatSpec).toContain('TexturePacker JSON-hash');
  });

  it('refuses to write an atlas with no imagery, rather than an empty page', async () => {
    const result = await exporter.export({ ir: hierarchyIr() });
    expect(isErr(result)).toBe(true);
    if (isOk(result)) return;
    expect(result.error.kind).toBe('validation');
  });

  it('emits one PNG and one JSON, both hashed', async () => {
    const output = unwrap(await exporter.export(fixtureInput()));

    expect(output.artifacts.map((entry) => entry.path)).toEqual(['atlas.png', 'atlas.json']);
    expect(artifact(output, 'atlas.png').mediaType).toBe('image/png');
    expect(artifact(output, 'atlas.png').sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(output.stats.totalBytes).toBeGreaterThan(0);
    expect(output.stats.sampledFrames).toBe(2);
  });

  it('writes TexturePacker JSON-hash, field for field', async () => {
    const output = unwrap(await exporter.export(fixtureInput()));
    const atlas = readJson<TexturePackerAtlas>(output, 'atlas.json');

    expect(Object.keys(atlas.frames).sort()).toEqual(['branch.png', 'trunk.png']);
    expect(atlas.meta.image).toBe('atlas.png');
    expect(atlas.meta.format).toBe('RGBA8888');
    expect(atlas.meta.scale).toBe('1');
    expect(atlas.meta.size.w).toBeGreaterThan(0);
    expect(atlas.meta.related_multi_packs).toBeUndefined();

    const trunk = atlas.frames['trunk.png'];
    expect(trunk?.rotated).toBe(false);
    expect(trunk?.trimmed).toBe(true);
    expect(trunk?.spriteSourceSize.w).toBe(trunk?.frame.w);
    expect(trunk?.sourceSize).toEqual({ w: 60, h: 200 });
    expect(trunk?.pivot).toEqual({ x: 0.5, y: 0.5 });
  });

  it('carries each part’s own pivot rather than assuming the centre', async () => {
    const output = unwrap(await exporter.export(fixtureInput()));
    const atlas = readJson<TexturePackerAtlas>(output, 'atlas.json');
    expect(atlas.frames['branch.png']?.pivot).toEqual({ x: 0.1, y: 0.9 });
  });

  it('produces a byte-identical atlas across runs', async () => {
    const first = unwrap(await exporter.export(fixtureInput()));
    const second = unwrap(await exporter.export(fixtureInput()));

    expect(second.artifacts.map((entry) => entry.sha256)).toEqual(
      first.artifacts.map((entry) => entry.sha256),
    );
  });

  it('produces the same atlas whatever order the parts arrive in', async () => {
    const forwards = unwrap(await exporter.export(fixtureInput()));
    const input = fixtureInput();
    const backwards = unwrap(
      await exporter.export({ ir: input.ir, parts: [...input.parts].reverse() }),
    );

    expect(backwards.artifacts.map((entry) => entry.sha256)).toEqual(
      forwards.artifacts.map((entry) => entry.sha256),
    );
  });

  it('round-trips a trimmed frame to the same on-screen position once the offset is applied', async () => {
    const input = fixtureInput();
    const output = unwrap(await exporter.export(input));
    const atlas = readJson<TexturePackerAtlas>(output, 'atlas.json');
    const page = await decodePng(artifact(output, 'atlas.png').bytes);

    for (const entry of input.parts) {
      const frame = atlas.frames[`${entry.part.name}.png`];
      if (frame === undefined) throw new Error(`missing frame for ${entry.part.name}`);

      const cut = unwrap(
        cropImage(page, {
          x: frame.frame.x,
          y: frame.frame.y,
          width: frame.frame.w,
          height: frame.frame.h,
        }),
      );
      const restored = compositeImage(
        blankImage({ width: frame.sourceSize.w, height: frame.sourceSize.h }),
        cut,
        frame.spriteSourceSize.x,
        frame.spriteSourceSize.y,
      );
      expect(restored.data).toEqual(entry.image.data);
    }
  });

  it('cross-references overflow pages the way TexturePacker does', async () => {
    // Two 100×100 frames and a 128×128 page: exactly one fits per page.
    const parts = rigFixture().parts.map((part) => ({
      ...part,
      size: { width: 100, height: 100 },
    }));
    const output = unwrap(
      await exporter.export(
        { ir: hierarchyIr(), parts: partImages(parts) },
        { atlas: { maxSize: 128, padding: 0, trim: false } },
      ),
    );

    expect(output.artifacts.map((entry) => entry.path)).toEqual([
      'atlas.png',
      'atlas.json',
      'atlas-1.png',
      'atlas-1.json',
    ]);
    expect(readJson<TexturePackerAtlas>(output, 'atlas.json').meta.related_multi_packs).toEqual([
      'atlas-1.json',
    ]);
    expect(readJson<TexturePackerAtlas>(output, 'atlas-1.json').meta.related_multi_packs).toEqual([
      'atlas.json',
    ]);
  });

  it('honours a custom base name', async () => {
    const output = unwrap(await exporter.export(fixtureInput(), { atlas: { name: 'tree-parts' } }));
    expect(output.artifacts.map((entry) => entry.path)).toEqual([
      'tree-parts.png',
      'tree-parts.json',
    ]);
  });

  it('surfaces a bad option as a typed failure', async () => {
    const result = await exporter.export(fixtureInput(), { atlas: { padding: -3 } });
    expect(isErr(result)).toBe(true);
  });

  it('reports that an atlas carries no timeline at all', async () => {
    const { parts } = rigFixture();
    const output = unwrap(await exporter.export({ ir: richIr(), parts: partImages(parts) }));
    const byFeature = new Map(
      output.warnings.map((warning) => [warning.feature, warning.disposition]),
    );

    expect(byFeature.get('behaviour:blink')).toBe('dropped');
    expect(byFeature.get('camera:track')).toBe('dropped');
    expect(byFeature.get('track:position')).toBe('dropped');
    expect(byFeature.get('node:asset-instance')).toBe('restructured');
    expect(output.stats.keyframeCount).toBe(0);
  });

  it('fails under strict, because there is no lossless atlas of an animation', async () => {
    const { parts } = rigFixture();
    const result = await exporter.export(
      { ir: richIr(), parts: partImages(parts) },
      { strict: true },
    );
    expect(isErr(result)).toBe(true);
  });
});

describe('atlasSourcesFromImages', () => {
  it('names frames from the map keys, for a caller that is not packing parts', () => {
    const sources = atlasSourcesFromImages(
      new Map([
        ['a.png', solid(2, 2)],
        ['b.png', solid(3, 3)],
      ]),
    );
    expect(sources.map((source) => source.name)).toEqual(['a.png', 'b.png']);
  });
});
