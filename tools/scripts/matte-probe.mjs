/**
 * Run the real matting chain against a real PNG and say which tier cut it.
 *
 * The chain's escalation is unit-tested with a scripted segmentation model, which
 * proves the *routing*. It cannot prove that BiRefNet actually cuts the picture SD 1.5
 * drew - only a 224 MB download and a real inference can, and neither belongs in CI.
 * This is that check, run by hand:
 *
 *     node node_modules/tsx/dist/cli.mjs tools/scripts/matte-probe.mjs <input.png> [outDir]
 *
 * It writes three PNGs so the result is inspectable rather than merely reported: the
 * RGBA cutout, the alpha plane as opaque greyscale, and the cutout composited over
 * magenta - which is the only one of the three in which a halo is visible at a glance.
 *
 * `HF_TOKEN` is read out of the root `.env` when present. It is never printed.
 *
 * ## Why the imports look like that
 *
 * `pnpm` links workspace packages into each *package's* `node_modules`, not the root's,
 * so a bare `@rv/asset-engine` from `tools/` does not resolve. Importing the source file
 * by URL does: everything it imports in turn resolves from its own directory, where the
 * links exist. tsx transforms the TypeScript on the way in.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const pkg = (name) => pathToFileURL(join(ROOT, 'packages', name, 'src', 'index.ts')).href;

for (const line of safeRead(join(ROOT, '.env')).split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const { PngRaster, alphaCleanliness, alphaCoverage, cornersAreTransparent, defaultMattingChain } =
  await import(pkg('asset-engine'));
const { isErr } = await import(pkg('shared-kernel'));

const input = process.argv[2];
const outDir = process.argv[3] ?? join(ROOT, 'workspace', 'matte-probe');
if (!input) {
  console.error('usage: matte-probe.mjs <input.png> [outDir]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const raster = new PngRaster();
const decoded = raster.decode({ mimeType: 'image/png', data: new Uint8Array(readFileSync(input)) });
if (isErr(decoded)) {
  console.error(`cannot decode ${input}: ${decoded.error.message}`);
  process.exit(1);
}
console.log(`input ${basename(input)}  ${decoded.value.width}x${decoded.value.height}`);

const chain = defaultMattingChain({
  birefnet: { cacheDir: join(ROOT, 'workspace', 'cache', 'huggingface', 'transformers') },
});
console.log(`chain  ${chain.engine}`);

const startedAt = Date.now();
const matted = await chain.matte({ image: decoded.value });
const seconds = ((Date.now() - startedAt) / 1000).toFixed(2);

if (isErr(matted)) {
  console.error(`\nevery tier refused after ${seconds}s: ${matted.error.message}`);
  for (const [key, value] of Object.entries(matted.error.context ?? {})) {
    console.error(`  ${key}: ${JSON.stringify(value)}`);
  }
  process.exit(1);
}

for (const skipped of matted.value.fallbacks) {
  console.log(`  skipped ${skipped.engine}: ${skipped.reason}`);
}
console.log(`  cut by  ${matted.value.engine} in ${seconds}s`);
console.log(`  coverage    ${alphaCoverage(matted.value.image).toFixed(4)}`);
console.log(`  cleanliness ${alphaCleanliness(matted.value.image).toFixed(4)}`);
console.log(`  corners transparent: ${String(cornersAreTransparent(matted.value.image))}`);

const stem = basename(input)
  .replace(/\.png$/i, '')
  .slice(0, 24);
const { width, height, data } = matted.value.image;
write(`${stem}-cutout.png`, matted.value.image);
write(`${stem}-alpha.png`, { width, height, data: alphaAsGrey(data, width * height) });
write(`${stem}-over-magenta.png`, { width, height, data: overMagenta(data, width * height) });

function write(name, image) {
  const encoded = raster.encode(image);
  if (isErr(encoded)) {
    console.error(`  could not encode ${name}: ${encoded.error.message}`);
    return;
  }
  const path = join(outDir, name);
  writeFileSync(path, encoded.value.data);
  console.log(`  wrote ${path}`);
}

function alphaAsGrey(rgba, pixels) {
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const a = rgba[i * 4 + 3];
    out[i * 4] = a;
    out[i * 4 + 1] = a;
    out[i * 4 + 2] = a;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Alpha is invisible against a white viewer background; magenta is not. */
function overMagenta(rgba, pixels) {
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const a = rgba[i * 4 + 3] / 255;
    out[i * 4] = Math.round(rgba[i * 4] * a + 255 * (1 - a));
    out[i * 4 + 1] = Math.round(rgba[i * 4 + 1] * a);
    out[i * 4 + 2] = Math.round(rgba[i * 4 + 2] * a + 255 * (1 - a));
    out[i * 4 + 3] = 255;
  }
  return out;
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
