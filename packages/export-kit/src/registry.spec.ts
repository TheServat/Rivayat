import { describe, expect, it } from 'vitest';
import { isErr, isOk, ok, unwrap } from '@rv/shared-kernel';

import { ExporterRegistry, createDefaultRegistry } from './registry';
import type { Exporter } from './port';
import { SharpPngEncoder } from './__fixtures__/images';
import { testClock } from './__fixtures__/ids';
import { hierarchyIr, richIr, testMotion } from './__fixtures__/ir';
import { partImages, rigFixture } from './__fixtures__/rig';

function stubExporter(id: string): Exporter {
  return {
    id,
    label: id,
    formatSpec: 'stub',
    requires: [],
    capabilities: { exact: new Set(), approximate: new Map() },
    export: () =>
      Promise.resolve(
        ok({
          format: id,
          artifacts: [],
          warnings: [],
          stats: {
            totalBytes: 0,
            keyframeCount: 0,
            bakedKeyframeCount: 0,
            sampledFrames: 0,
            sampleStride: 1,
          },
        }),
      ),
  };
}

describe('ExporterRegistry', () => {
  it('adding a format is a registration, never an edit to the registry', () => {
    const registry = new ExporterRegistry();
    registry.register(stubExporter('rive'));
    expect(unwrap(registry.get('rive')).label).toBe('rive');
  });

  it('refuses two implementations of one format id, which is a wiring mistake', () => {
    const registry = new ExporterRegistry();
    registry.register(stubExporter('rive'));
    expect(() => registry.register(stubExporter('rive'))).toThrow();
  });

  it('returns a not-found result for an unknown format rather than throwing', () => {
    const result = new ExporterRegistry().get('nope');
    expect(isErr(result)).toBe(true);
    if (isOk(result)) return;
    expect(result.error.kind).toBe('not-found');
  });

  it('lists formats in registration order', () => {
    const registry = new ExporterRegistry();
    registry.register(stubExporter('a'));
    registry.register(stubExporter('b'));
    expect(registry.list().map((exporter) => exporter.id)).toEqual(['a', 'b']);
  });

  it('exports through the registry without any caller branching on the format', async () => {
    const registry = createDefaultRegistry({ clock: testClock() });
    const output = unwrap(
      await registry.export('lottie', { ir: hierarchyIr(), motion: testMotion() }),
    );
    expect(output.format).toBe('lottie');
    expect(output.artifacts).toHaveLength(1);
  });

  it('surfaces an unknown format as a failure from `export` too', async () => {
    const registry = createDefaultRegistry({ clock: testClock() });
    expect(isErr(await registry.export('psd', { ir: hierarchyIr() }))).toBe(true);
  });
});

describe('preview', () => {
  it('answers "what would I lose?" for every format before anything is exported', () => {
    const registry = createDefaultRegistry({
      clock: testClock(),
      encoder: new SharpPngEncoder(),
    });
    const preview = registry.preview(richIr());

    expect(preview.map((entry) => entry.format)).toEqual([
      'lottie',
      'dragonbones',
      'sprite-atlas',
      'frame-sequence',
    ]);

    const lottie = preview.find((entry) => entry.format === 'lottie');
    const frames = preview.find((entry) => entry.format === 'frame-sequence');

    // Lottie keeps more than a frame sequence does, which is the whole basis for choosing
    // between them.
    expect(lottie?.warnings.length ?? 0).toBeLessThan(frames?.warnings.length ?? 0);
    expect(lottie?.warnings.some((warning) => warning.feature === 'node:fx-emitter')).toBe(true);
  });

  it('costs nothing but the IR - no encoder, no parts, no rig', () => {
    const registry = createDefaultRegistry({ clock: testClock() });
    expect(registry.preview(hierarchyIr()).every((entry) => Array.isArray(entry.warnings))).toBe(
      true,
    );
  });
});

describe('createDefaultRegistry', () => {
  it('registers only the formats its dependencies can actually serve', () => {
    const bare = createDefaultRegistry({ clock: testClock() });
    expect(bare.list().map((exporter) => exporter.id)).toEqual(['lottie', 'dragonbones']);

    const full = createDefaultRegistry({ clock: testClock(), encoder: new SharpPngEncoder() });
    expect(full.list().map((exporter) => exporter.id)).toEqual([
      'lottie',
      'dragonbones',
      'sprite-atlas',
      'frame-sequence',
    ]);
  });

  it('wires the encoder into DragonBones so its texture page is written', async () => {
    const registry = createDefaultRegistry({ clock: testClock(), encoder: new SharpPngEncoder() });
    const { rig, parts } = rigFixture();
    const output = unwrap(
      await registry.export('dragonbones', {
        ir: hierarchyIr(),
        rig,
        parts: partImages(parts),
        motion: testMotion(),
      }),
    );
    expect(output.artifacts.map((entry) => entry.path)).toContain('hierarchy_tex.png');
  });

  it('every registered format declares an id, a label and a published spec', () => {
    const registry = createDefaultRegistry({ clock: testClock(), encoder: new SharpPngEncoder() });
    for (const exporter of registry.list()) {
      expect(exporter.id.length).toBeGreaterThan(0);
      expect(exporter.label.length).toBeGreaterThan(0);
      expect(exporter.formatSpec.length).toBeGreaterThan(10);
    }
  });
});

describe('the governing principle', () => {
  it('exposes no importer: an export is a projection and never comes back', async () => {
    const api: Record<string, unknown> = await import('./index');
    const inbound = Object.keys(api).filter((name) => /^(import|parse|read|from)[A-Z]/u.test(name));
    expect(inbound).toEqual([]);

    for (const exporter of createDefaultRegistry({ clock: testClock() }).list()) {
      const members = [
        ...Object.keys(exporter),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(exporter) as object),
      ];
      expect(members).toContain('export');
      expect(members).not.toContain('import');
    }
  });
});
