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

/**
 * "There is no importer" is a structural claim, so it is checked structurally.
 *
 * A prefix match on the public API is not enough on its own: `parseLottie` is caught by
 * it and `lottieToIr`, `decodeLottie`, `loadLottie` and a `LottieImporter` class all walk
 * straight past. So the check is three-layered - a vocabulary matched at word boundaries
 * anywhere in a name, the same vocabulary applied to every `export`ed declaration in the
 * package's own source (not only what `index.ts` happens to re-export), and the port's
 * one-verb shape asserted on every registered implementation.
 */
const INBOUND_VERBS: readonly string[] = [
  'import',
  'parse',
  'deserialize',
  'deserialise',
  'decode',
  'unpack',
  'ingest',
  'load',
  'read',
];

/** Formats this package writes. A name that mentions one *and* a direction is suspect. */
const FOREIGN_FORMATS: readonly string[] = [
  'lottie',
  'dragonbones',
  'atlas',
  'spine',
  'rive',
  'aseprite',
  'psd',
  'svg',
  'gif',
];

function wordsOf(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .toLowerCase()
    .split(' ')
    .filter((word) => word.length > 0);
}

/**
 * `parseLottie`, `LottieImporter`, `lottieToIr`, `fromLottie`, `irFromLottie` - all of them.
 *
 * Two rules, because an importer has two possible shapes. Either it names an inbound verb,
 * or it names a foreign format together with a direction that ends at the IR. Neither rule
 * fires on `toSegmentEase` or `atlasSourcesFromImages`, which convert *outwards* and would
 * make a cruder ban unusable.
 */
function namesAnInboundConversion(name: string): boolean {
  const words = wordsOf(name);
  if (words.some((word) => INBOUND_VERBS.includes(word) || word === 'importer')) return true;

  if (!words.some((word) => FOREIGN_FORMATS.includes(word))) return false;
  const ir = words.indexOf('ir');
  const to = words.indexOf('to');
  const from = words.indexOf('from');
  // "<format> to ir": the arrow points at us.
  if (to >= 0 && ir > to) return true;
  // "from <format>" or "ir from <format>": likewise.
  return from === 0 || (from > 0 && ir >= 0 && ir < from);
}

/** Every `export`ed top-level declaration in the shipped source. */
async function exportedDeclarations(): Promise<readonly { file: string; name: string }[]> {
  const { readdir, readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  // Resolved from this file, not from `process.cwd()`. `walk('src')` passes under
  // `cd packages/export-kit && vitest run` and fails under the root `pnpm test`,
  // where the working directory is the repo root and there is no `src` there.
  const src = dirname(fileURLToPath(import.meta.url));

  const found: { file: string; name: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Fixtures are test scaffolding and are not shipped; `readJson` there is a test
        // helper reading this package's own output, not an importer of a foreign format.
        if (entry.name !== '__fixtures__') await walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
      const source = await readFile(full, 'utf8');
      const pattern =
        /^export\s+(?:async\s+)?(?:function|class|const|let|abstract\s+class)\s+([A-Za-z0-9_$]+)/gmu;
      for (const match of source.matchAll(pattern)) {
        const name = match[1];
        if (name !== undefined) found.push({ file: full, name });
      }
    }
  };
  await walk(src);
  return found;
}

describe('the governing principle', () => {
  it('exposes no importer: an export is a projection and never comes back', async () => {
    const api: Record<string, unknown> = await import('./index');
    const inbound = Object.keys(api).filter(namesAnInboundConversion);
    expect(inbound, 'the public API names an inbound conversion').toEqual([]);
  });

  it('scans the source it claims to scan, rather than an empty directory', async () => {
    // The other half of the path bug. A scan resolved against the wrong directory fails
    // loudly with ENOENT; a scan resolved against a directory that *exists* but holds
    // nothing it recognises returns `[]` and the guard below passes while checking
    // nothing at all. So the scan has to prove it found the package first.
    const declared = await exportedDeclarations();
    const names = new Set(declared.map((entry) => entry.name));

    expect(declared.length).toBeGreaterThan(40);
    // One export from each corner of the package, so a subdirectory dropping out of the
    // walk is caught rather than just a total collapse.
    for (const known of [
      'LottieExporter',
      'DragonBonesExporter',
      'AtlasExporter',
      'FramesExporter',
      'ExporterRegistry',
      'UnsupportedFeaturesError',
      // `IR_FEATURES` deliberately absent: the vocabulary lives in `@rv/contracts` now and
      // this package only re-exports it. A landmark has to be something declared here, or
      // the scan is being checked against a file it cannot see.
      'toCompositionSpace',
    ]) {
      expect(names, `the source scan never reached ${known}`).toContain(known);
    }
  });

  it('declares no inbound conversion anywhere in the shipped source, re-exported or not', async () => {
    // A `parseLottie` that is never added to `index.ts` is still a reverse mapping living
    // in the package, and the next person to need it only has to add one export line.
    const offenders = (await exportedDeclarations())
      .filter((entry) => namesAnInboundConversion(entry.name))
      .map((entry) => `${entry.file}: ${entry.name}`);
    expect(offenders).toEqual([]);
  });

  it('recognises the shapes an importer would actually be given', () => {
    // The guard above is only worth anything if it fires. These are the names a reasonable
    // person would reach for, and the scan has to catch every one of them.
    for (const name of [
      'parseLottie',
      'lottieToIr',
      'fromLottie',
      'LottieImporter',
      'decodeDragonBones',
      'deserialiseAtlas',
      'readAnimationIr',
      'load_lottie',
      'unpackAtlas',
    ]) {
      expect(namesAnInboundConversion(name), `${name} slipped through`).toBe(true);
    }
  });

  it('does not mistake an outbound conversion for an importer', () => {
    // `toSegmentEase` maps our easing onto Lottie's; `atlasSourcesFromImages` builds an
    // input. A scan that banned every `to`/`from` would fail on both and get switched off.
    for (const name of [
      'toSegmentEase',
      'atlasSourcesFromImages',
      'frameCountOf',
      'sampleFrames',
    ]) {
      expect(namesAnInboundConversion(name), `${name} was wrongly flagged`).toBe(false);
    }
  });

  it('gives the port exactly one verb, on every registered implementation', () => {
    for (const exporter of createDefaultRegistry({ clock: testClock() }).list()) {
      const members = [
        ...Object.keys(exporter),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(exporter) as object),
      ].filter((member) => member !== 'constructor');

      expect(members).toContain('export');
      const methods = members.filter(
        (member) => typeof (exporter as unknown as Record<string, unknown>)[member] === 'function',
      );
      expect(methods, `${exporter.id} has a second verb`).toEqual(['export']);
    }
  });
});
