/**
 * Which local vision model can run the quality gate while ComfyUI holds the card.
 *
 * The gate works - it caught a 2x2 contact sheet of photographs that the splitter, the
 * assigner and the rigger had all happily turned into four bones. What it could not do
 * is run: `gemma4:26b` is 18 GB and Ollama refuses to start it beside ComfyUI's 3.4 GB
 * ("llama-server reported out-of-memory during startup"), and `qwen3.5:latest` at 9.7 B
 * took 44 s and 21 s for two images. So this benchmarks candidates that fit.
 *
 *     node node_modules/tsx/dist/cli.mjs tools/scripts/vision-gate-bench.mjs [model ...]
 *
 * Three things are measured per model, because speed alone is a trap - a fast gate that
 * misses the defect is worse than no gate:
 *
 *  1. **Does it catch the defect.** The real rubric, from the real locked StyleBible,
 *     scored against the real rejected take. `style-match` has to land under its 0.6
 *     floor. This is the only result that decides anything.
 *  2. **Does it actually see.** The same rubric against a flat synthetic sheet that is
 *     much closer to the paper-cutout style. A model that scores both alike is not
 *     looking at the pixels, and a plausible-sounding score from a blind model is the
 *     worst possible outcome. A direct count question ("how many separate photographs")
 *     is asked as a second, independent check.
 *  3. **Seconds per image**, twice, so the cold load is separated from the warm call.
 *
 * Everything is imported by file URL: pnpm links workspace packages into each package's
 * own `node_modules`, not the root's, so a bare specifier from `tools/` does not resolve.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const pkg = (name) => pathToFileURL(join(ROOT, 'packages', name, 'src', 'index.ts')).href;
const fixture = (name, file) =>
  pathToFileURL(join(ROOT, 'packages', name, 'src', '__fixtures__', file)).href;

for (const line of safeRead(join(ROOT, '.env')).split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const { DeriveAssetSpecUseCase, buildRubric } = await import(pkg('asset-engine'));
const { paintSheet } = await import(fixture('asset-engine', 'images.ts'));
const { findPreset, materialiseStyleBible } = await import(pkg('style-engine'));
const { lock } = await import(pkg('core-domain'));
const { OllamaAdapter } = await import(pkg('providers'));
const { SystemClock, isErr, toIso, unwrap } = await import(pkg('shared-kernel'));
const { Ids } = await import(pkg('contracts'));

const CANDIDATES =
  process.argv.length > 2
    ? process.argv.slice(2)
    : ['qwen3-vl:4b', 'qwen3-vl:2b', 'minicpm-v4.6:1b', 'qwen3.5:latest'];

const OUT = join(ROOT, 'workspace', 'vision-gate-bench');
mkdirSync(OUT, { recursive: true });

// ── the rubric the gate really asks ─────────────────────────────────────────

const clock = new SystemClock();
const ids = new Ids();
const preset = unwrap(findPreset('paper-cutout'));
const style = unwrap(
  lock(
    materialiseStyleBible({ draft: preset.draft, id: ids.styleBible(), clock }),
    toIso(clock.now()),
  ),
);
const spec = unwrap(
  new DeriveAssetSpecUseCase().execute({
    source: {
      kind: 'requirement',
      requirement: {
        semanticKey: 'prop/street-lamp/terrace',
        label: 'Terrace street lamp',
        description:
          'A cast-iron street lamp in four separate pieces: the round mounting base, the lower post, the upper post, and the glass lantern head',
        archetype: 'articulated-prop',
        subjectClass: 'prop',
      },
    },
    quality: 'draft',
    canvas: { width: 768, height: 512 },
  }),
);
const rubric = buildRubric(style, spec);
console.log(`style   ${style.visual.medium} / ${style.visual.shading.model}`);
console.log(`rubric  ${rubric.map((c) => c.key).join(', ')}\n`);

// ── the two images ──────────────────────────────────────────────────────────

/** The take the gate rejected: four photographs of a house, in a 2x2 contact sheet. */
const DEFECT = join(
  ROOT,
  'workspace/produce-demo-assets/9e/9e71baacbf9f102292b0dcb880f24bfa63a2338b2ea15c44a3a9ce226f654132',
);
const defect = { mimeType: 'image/png', data: new Uint8Array(readFileSync(DEFECT)) };

/**
 * A flat synthetic sheet: four separated blocks of solid colour on a flat grey field.
 *
 * Not a good asset - it is not meant to be. It is the *control*: it has no photographic
 * texture, no depth of field and no cast shadow, so any model that is really looking has
 * to score it above four photographs on "is this paper-cutout with flat shading".
 */
const control = await paintSheet(768, 512, [
  { x: 60, y: 60, width: 180, height: 180, color: { r: 196, g: 92, b: 64 } },
  { x: 330, y: 60, width: 180, height: 180, color: { r: 92, g: 116, b: 96 } },
  { x: 60, y: 300, width: 180, height: 150, color: { r: 214, g: 176, b: 112 } },
  { x: 330, y: 300, width: 180, height: 150, color: { r: 70, g: 74, b: 92 } },
]);
writeFileSync(join(OUT, 'control-flat-sheet.png'), control.data);

/**
 * A question whose answer is only in the pixels.
 *
 * Phrased as a rubric criterion so it travels the same validated path as a real score -
 * the digit goes in `reason`, which the score sheet already requires to be a non-empty
 * string. A model that cannot see guesses, and we see it guess.
 */
const COUNT_RUBRIC = [
  {
    key: 'photo-count',
    question:
      'Count the separate rectangular photographs tiled inside this image. Put that count, as a single digit, in `reason`. Set `score` to 1.',
  },
];

/**
 * A third, distinct image, so the warm timing is a measurement rather than a cache read.
 *
 * Research §2 records the same trap for ComfyUI: re-POSTing an identical graph returns
 * the previous image in ~10 ms and produces a fictitious benchmark. Ollama does the same
 * thing with an identical prompt+image - the repeat of the defect image came back in
 * 1.0-1.3 s against 10 s for a picture the model had not seen. Every timed call below is
 * therefore on a *different* image.
 */
const THIRD = join(
  ROOT,
  'workspace/produce-demo-assets/d0/d062ce0ef5eb550239b47b5f16918bd18255e53e7a751f064a528a19b179b1de',
);
const third = { mimeType: 'image/png', data: new Uint8Array(readFileSync(THIRD)) };

// ── run ─────────────────────────────────────────────────────────────────────

const rows = [];
for (const model of CANDIDATES) {
  const adapter = new OllamaAdapter({
    model,
    baseUrl: process.env.OLLAMA_HOST,
    timeoutMs: 900_000,
    capabilities: ['vision-scoring'],
  });

  console.log(`── ${model} ${'─'.repeat(Math.max(0, 56 - model.length))}`);

  // First call on the defect: includes loading the model beside ComfyUI's 3.4 GB.
  const cold = await timedScore(adapter, defect, rubric);
  if (cold.error) {
    console.log(`   FAILED: ${cold.error}`);
    console.log();
    rows.push({ model, note: cold.error });
    continue;
  }
  const onControl = await timedScore(adapter, control, rubric);
  const onThird = await timedScore(adapter, third, rubric);
  const counted = await timedScore(adapter, defect, COUNT_RUBRIC);
  const repeat = await timedScore(adapter, defect, rubric);

  const styleOnDefect = scoreOf(cold.scores, 'style-match');
  const styleOnControl = scoreOf(onControl.scores, 'style-match');
  const caught = styleOnDefect !== null && styleOnDefect < 0.6;
  const discriminates =
    styleOnControl !== null && styleOnDefect !== null && styleOnControl - styleOnDefect > 0.1;
  const warm = Number(((onControl.seconds + onThird.seconds) / 2).toFixed(1));

  console.log(`   first call ${cold.seconds}s (loads the model)`);
  console.log(
    `   warm, unseen images: ${onControl.seconds}s, ${onThird.seconds}s -> ${warm}s/image`,
  );
  console.log(`   same image again: ${repeat.seconds}s  <- cache, not a measurement`);
  console.log(`   style-match  defect ${fmt(styleOnDefect)}  control ${fmt(styleOnControl)}`);
  console.log(`   caught the contact sheet: ${caught ? 'YES' : 'no'}`);
  console.log(`   rubric discriminates:     ${discriminates ? 'YES' : 'no'}`);
  console.log(
    `   counts the photographs:   ${JSON.stringify(counted.scores?.[0]?.reason ?? counted.error)}`,
  );
  for (const entry of cold.scores ?? []) {
    console.log(`     ${entry.key}: ${entry.score} - ${entry.reason}`);
  }
  console.log();

  rows.push({
    model,
    coldSeconds: cold.seconds,
    warmSecondsPerImage: warm,
    repeatSeconds: repeat.seconds,
    styleOnDefect,
    styleOnControl,
    caught,
    discriminates,
    counted: counted.scores?.[0]?.reason ?? counted.error,
  });
}

console.log(
  'model               first   warm/img  style(defect)  style(control)  caught  discriminates',
);
for (const row of rows) {
  if (row.note) {
    console.log(`${row.model.padEnd(19)} ${row.note}`);
    continue;
  }
  console.log(
    `${row.model.padEnd(19)} ${`${String(row.coldSeconds)}s`.padStart(6)} ${`${String(row.warmSecondsPerImage)}s`.padStart(9)}` +
      `  ${fmt(row.styleOnDefect).padStart(12)}  ${fmt(row.styleOnControl).padStart(14)}` +
      `  ${(row.caught ? 'YES' : 'no').padStart(6)}  ${(row.discriminates ? 'YES' : 'no').padStart(13)}`,
  );
}
writeFileSync(join(OUT, 'results.json'), JSON.stringify(rows, null, 2));
console.log(`wrote ${join(OUT, 'results.json')}`);

// ── helpers ─────────────────────────────────────────────────────────────────

async function timedScore(adapter, image, criteria) {
  const startedAt = Date.now();
  const scored = await adapter.score({ image, rubric: criteria });
  const seconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
  if (isErr(scored)) return { seconds, error: `${scored.error.code}: ${scored.error.message}` };
  return { seconds, scores: scored.value.scores, overall: scored.value.overall };
}

function scoreOf(scores, key) {
  return scores?.find((entry) => entry.key === key)?.score ?? null;
}

function fmt(value) {
  return value === null || value === undefined ? '-' : value.toFixed(2);
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
