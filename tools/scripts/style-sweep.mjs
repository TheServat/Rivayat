/**
 * Which style / checkpoint / sampler combination the free lane can actually draw.
 *
 *     node node_modules/tsx/dist/cli.mjs tools/scripts/style-sweep.mjs [--phase screen|depth|subjects]
 *
 * The live produce run rejected all three of its assets at `style-match 0.00` against a
 * 0.6 floor, and the diagnosis on file is "SD 1.5 at 6-8 LCM steps cannot draw
 * paper-cutout". That diagnosis names one preset, one sampler regime and one prompt
 * shape without having varied any of them. This varies all three and reports the score.
 *
 * Three axes, each of which has a live reason to be suspected:
 *
 *  1. **preset** - eleven of them, and `paper-cutout` is the one whose own compiled
 *     style clause contains "casting a short hard drop shadow", which the parts-sheet
 *     graph then lists in its negative. A style that argues with itself is not a fair
 *     test of the checkpoint.
 *  2. **prompt form** - `request-composer` sends the first four comma clauses of the
 *     natural-language positive (hex codes and all); `style-engine/prompts/model-phrasing`
 *     compiles a *tag* form for exactly this encoder and is never reached in production
 *     because it is keyed `comfyui:sd1.5-lcm` while the adapter reports
 *     `comfyui:dreamshaper_8.safetensors`. Both forms are swept.
 *  3. **sampler regime** - LCM at 4-12 steps and cfg 1.2-2.0 against ordinary
 *     eps-prediction at 24-30 steps and cfg 7-8.5 with the LoRA off. LCM is a
 *     distillation: it trades prompt adherence for step count, and style *is* prompt
 *     adherence.
 *
 * The gate is the real one: `buildRubric(style, spec)` from `@rv/asset-engine`, scored
 * by `qwen3-vl:4b` through the real `OllamaAdapter`. `vision-gate-bench.mjs` establishes
 * that this judge catches the known defect at 0.00, scores a flat control at 1.00, and
 * counts the four photographs correctly - so a 0.00 here is a statement about the
 * pixels, not about the judge.
 *
 * Generation and scoring are separated into phases on purpose: ComfyUI holds ~3.4 GB of
 * a 6 GB card and Ollama needs 3.3 GB for the judge. Interleaving them makes both swap.
 * Everything is generated, ComfyUI is told to free, then everything is scored.
 *
 * ## The regime switch has to unload the model, and that is a measured defect
 *
 * ComfyUI 0.33.0 does not fully unpatch `lcm-lora-sdv1-5` when the next graph in the
 * same session asks for `strength 0.0` and `ModelSamplingDiscrete(sampling: "eps")`.
 * The sampler then runs a still-distilled UNet at cfg 7 and returns **pure RGB noise**.
 * Reproduced three times, deterministically:
 *
 *   X1  lcm  strength 1.0, 8 steps, cfg 1.8                    -> clean image
 *   X2  eps  strength 0.0, 24 steps, cfg 7.0, straight after   -> noise
 *   X3  the same graph as X2 after POST /free {unload_models}  -> clean image
 *
 * So cells are ordered by regime and the model is unloaded whenever the regime changes.
 * The first 44-cell run of this sweep did not do that and scored every eps cell 0.00
 * on noise, which would have read as "cfg 7 cannot draw either" - the same shape of
 * wrong answer the sweep exists to correct.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const pkg = (name) => pathToFileURL(join(ROOT, 'packages', name, 'src', 'index.ts')).href;

for (const line of safeRead(join(ROOT, '.env')).split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const { DeriveAssetSpecUseCase, buildRubric } = await import(pkg('asset-engine'));
const { PRESET_DEFINITIONS, compileTagPrompt, findPreset, materialiseStyleBible } = await import(
  pkg('style-engine')
);
const { lock } = await import(pkg('core-domain'));
const { OllamaAdapter, buildGraph } = await import(pkg('providers'));
const { SystemClock, isErr, toIso, unwrap } = await import(pkg('shared-kernel'));
const { Ids } = await import(pkg('contracts'));

const COMFY = process.env.COMFYUI_HOST ?? 'http://127.0.0.1:8288';
const JUDGE = process.env.RV_SWEEP_JUDGE ?? 'qwen3-vl:4b';
const OUT = join(ROOT, 'workspace', 'demo', 'sweep');
const WORKFLOWS = join(ROOT, 'tools', 'comfy-workflows');
mkdirSync(OUT, { recursive: true });

const phase = argValue('--phase') ?? 'screen';
const onlyStage = argValue('--stage'); // generate | score | both
const SEED = Number(argValue('--seed') ?? 424_242);

// ── the sampler regimes ─────────────────────────────────────────────────────

/**
 * `eps` regimes turn the LCM scaffolding off rather than removing the nodes.
 *
 * `ModelSamplingDiscrete(sampling: "eps")` is what an SD 1.5 checkpoint already is, so
 * it is a no-op, and `strength 0` makes `LoraLoader` a pass-through. The graph shape
 * therefore stays byte-comparable across regimes and the only difference between an LCM
 * cell and an eps cell is the four numbers a caller can already set.
 */
const REGIMES = {
  'lcm-4': {
    sampling: 'lcm',
    lora: 1.0,
    steps: 4,
    cfg: 1.2,
    sampler: 'lcm',
    scheduler: 'sgm_uniform',
  },
  'lcm-8': {
    sampling: 'lcm',
    lora: 1.0,
    steps: 8,
    cfg: 1.8,
    sampler: 'lcm',
    scheduler: 'sgm_uniform',
  },
  'lcm-12': {
    sampling: 'lcm',
    lora: 1.0,
    steps: 12,
    cfg: 2.0,
    sampler: 'lcm',
    scheduler: 'sgm_uniform',
  },
  'eps-24': {
    sampling: 'eps',
    lora: 0.0,
    steps: 24,
    cfg: 7.0,
    sampler: 'dpmpp_2m',
    scheduler: 'karras',
  },
  'eps-30': {
    sampling: 'eps',
    lora: 0.0,
    steps: 30,
    cfg: 8.5,
    sampler: 'dpmpp_2m',
    scheduler: 'karras',
  },
};

// ── the subject under test ──────────────────────────────────────────────────

/** The same four-part prop the live run rejected, so the numbers are comparable. */
const LAMP = {
  semanticKey: 'prop/street-lamp/terrace',
  label: 'Terrace street lamp',
  description:
    'A cast-iron street lamp in four separate pieces: the round mounting base, the lower post, the upper post, and the glass lantern head',
  archetype: 'articulated-prop',
  subjectClass: 'prop',
  canvas: { width: 768, height: 512 },
};

const clock = new SystemClock();
const ids = new Ids();
const derive = new DeriveAssetSpecUseCase();

const styles = new Map();
for (const def of PRESET_DEFINITIONS) {
  const preset = unwrap(findPreset(def.id));
  styles.set(
    def.id,
    unwrap(
      lock(
        materialiseStyleBible({ draft: preset.draft, id: ids.styleBible(), clock }),
        toIso(clock.now()),
      ),
    ),
  );
}

const lampSpec = unwrap(
  derive.execute({
    source: { kind: 'requirement', requirement: LAMP },
    quality: 'draft',
    canvas: LAMP.canvas,
  }),
);

// ── the cells ───────────────────────────────────────────────────────────────

const PRESET_IDS = PRESET_DEFINITIONS.map((def) => def.id);

function cellsForScreen() {
  const cells = [];
  for (const presetId of PRESET_IDS) {
    for (const regime of ['lcm-8', 'eps-24']) {
      for (const form of ['clip4', 'tags']) {
        cells.push({ presetId, regime, form, probe: 'parts-sheet' });
      }
    }
  }
  return cells;
}

function cellsForDepth() {
  const finalists = (argValue('--presets') ?? '').split(',').filter(Boolean);
  const cells = [];
  for (const presetId of finalists) {
    for (const regime of ['lcm-4', 'lcm-8', 'lcm-12', 'eps-24', 'eps-30']) {
      cells.push({ presetId, regime, form: argValue('--form') ?? 'tags', probe: 'parts-sheet' });
      cells.push({ presetId, regime, form: argValue('--form') ?? 'tags', probe: 'draft-prop' });
    }
  }
  return cells;
}

function cellsForSubjects() {
  const finalists = (argValue('--presets') ?? '').split(',').filter(Boolean);
  const regime = argValue('--regime') ?? 'eps-24';
  const form = argValue('--form') ?? 'tags';
  const cells = [];
  for (const presetId of finalists) {
    for (const probe of [
      'draft-character',
      'draft-tree',
      'draft-prop',
      'draft-sky',
      'parts-sheet',
    ]) {
      cells.push({ presetId, regime, form, probe });
    }
  }
  return cells;
}

// Regime-major, so the unload-on-switch below costs one checkpoint reload per regime
// rather than one per cell.
const CELLS = (
  phase === 'depth' ? cellsForDepth() : phase === 'subjects' ? cellsForSubjects() : cellsForScreen()
).sort(
  (left, right) =>
    left.regime.localeCompare(right.regime) ||
    left.probe.localeCompare(right.probe) ||
    left.presetId.localeCompare(right.presetId) ||
    left.form.localeCompare(right.form),
);

// ── generation ──────────────────────────────────────────────────────────────

const partsSheetGraph = JSON.parse(
  readFileSync(join(WORKFLOWS, 'txt2img-lcm-parts-sheet.json'), 'utf8'),
);
const draftGraph = JSON.parse(readFileSync(join(WORKFLOWS, 'txt2img-lcm-draft.json'), 'utf8'));

const DRAFT_SUBJECTS = {
  'draft-prop': {
    subjectClass: 'prop',
    subject: 'a single hand-thrown ceramic water jug with one handle, standing upright',
    size: { width: 512, height: 512 },
  },
  'draft-character': {
    subjectClass: 'character',
    subject:
      'a single standing figure in a plain tunic, arms relaxed at the sides, neutral expression, full body visible',
    size: { width: 512, height: 512 },
  },
  'draft-tree': {
    subjectClass: 'foliage',
    subject: 'a single mature broadleaf tree with a visible trunk and three main boughs',
    size: { width: 512, height: 512 },
  },
  'draft-sky': {
    subjectClass: 'sky',
    subject: 'an empty daytime sky with three or four scattered clouds and no horizon',
    size: { width: 512, height: 512 },
  },
};

function styleTextFor(style, form) {
  if (form === 'tags') return compileTagPrompt(style.visual);
  return style.prompts.positive.split(', ').slice(0, 4).join(', ');
}

function cellId(cell) {
  const seed = SEED === 424_242 ? '' : `__s${String(SEED)}`;
  return `${cell.presetId}__${cell.regime}__${cell.form}__${cell.probe}${seed}`;
}

function applyRegime(graph, regime) {
  const patched = structuredClone(graph);
  patched['3'].inputs.sampling = regime.sampling;
  return patched;
}

async function generate(cell) {
  const style = styles.get(cell.presetId);
  const regime = REGIMES[cell.regime];
  const styleText = styleTextFor(style, cell.form);
  const file = join(OUT, `${cellId(cell)}.png`);
  if (existsSync(file) && !process.argv.includes('--regenerate')) {
    return { file, cached: true, seconds: 0 };
  }

  const common = {
    lora_strength: regime.lora,
    steps: regime.steps,
    cfg: regime.cfg,
    sampler: regime.sampler,
    scheduler: regime.scheduler,
    checkpoint: argValue('--checkpoint') ?? 'dreamshaper_8.safetensors',
    lora: 'lcm-lora-sdv1-5.safetensors',
    batch_size: 1,
    seed: SEED,
    filename_prefix: 'sweep',
    negative: style.prompts.negative,
  };

  let built;
  if (cell.probe === 'parts-sheet') {
    built = unwrap(
      buildGraph(applyRegime(partsSheetGraph, regime), {
        ...common,
        prompt: lampSpec.description,
        parts: lampSpec.parts.map((part) => part.name).join(', '),
        style: styleText,
        background: 'flat solid uniform light grey, no vignette, no gradient, no floor',
        grid_cols: 2,
        grid_rows: 2,
        width: LAMP.canvas.width,
        height: LAMP.canvas.height,
      }),
    );
  } else {
    const probe = DRAFT_SUBJECTS[cell.probe];
    built = unwrap(
      buildGraph(applyRegime(draftGraph, regime), {
        ...common,
        prompt: `${probe.subject}, ${styleText}, centred on a flat plain background, full subject visible with generous margin`,
        width: probe.size.width,
        height: probe.size.height,
      }),
    );
  }

  const startedAt = Date.now();
  const bytes = await runComfy(built.prompt);
  const seconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
  writeFileSync(file, bytes);
  return { file, cached: false, seconds };
}

async function runComfy(prompt) {
  const queued = await fetch(`${COMFY}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: 'rivayat-sweep' }),
  });
  if (!queued.ok) throw new Error(`POST /prompt ${queued.status}: ${await queued.text()}`);
  const { prompt_id: promptId } = await queued.json();

  for (let attempt = 0; attempt < 2400; attempt += 1) {
    await sleep(250);
    const response = await fetch(`${COMFY}/history/${promptId}`);
    const history = await response.json();
    const entry = history[promptId];
    if (entry === undefined) continue;
    const status = entry.status?.status_str;
    if (status === 'error') throw new Error(`ComfyUI error: ${JSON.stringify(entry.status)}`);
    const images = Object.values(entry.outputs ?? {}).flatMap((out) => out.images ?? []);
    if (images.length === 0) continue;
    const ref = images[0];
    const view = await fetch(
      `${COMFY}/view?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder ?? '')}&type=${encodeURIComponent(ref.type ?? 'output')}`,
    );
    return Buffer.from(await view.arrayBuffer());
  }
  throw new Error('timed out waiting for ComfyUI');
}

// ── scoring ─────────────────────────────────────────────────────────────────

const judge = new OllamaAdapter({
  model: JUDGE,
  baseUrl: process.env.OLLAMA_HOST,
  timeoutMs: 600_000,
  capabilities: ['vision-scoring'],
});

async function score(cell, file) {
  const style = styles.get(cell.presetId);
  const spec =
    cell.probe === 'parts-sheet'
      ? lampSpec
      : unwrap(
          derive.execute({
            source: {
              kind: 'requirement',
              requirement: {
                semanticKey: `probe/${cell.probe}`,
                label: cell.probe,
                description: DRAFT_SUBJECTS[cell.probe].subject,
                archetype: 'rigid-prop',
                // A `character` spec adds `identity-match`, which needs a turnaround
                // this sweep does not have; scoring it against nothing would report a
                // style failure that is really a missing reference.
                subjectClass: 'prop',
              },
            },
            quality: 'draft',
            canvas: DRAFT_SUBJECTS[cell.probe].size,
          }),
        );
  const rubric = buildRubric(style, spec);
  const image = { mimeType: 'image/png', data: new Uint8Array(readFileSync(file)) };
  const scored = await judge.score({ image, rubric });
  if (isErr(scored)) return { error: `${scored.error.code}: ${scored.error.message}` };
  const byKey = Object.fromEntries(scored.value.scores.map((entry) => [entry.key, entry]));
  return {
    styleMatch: byKey['style-match']?.score ?? null,
    silhouette: byKey['silhouette-readability']?.score ?? null,
    styleReason: byKey['style-match']?.reason ?? '',
    silhouetteReason: byKey['silhouette-readability']?.reason ?? '',
  };
}

// ── run ─────────────────────────────────────────────────────────────────────

console.log(`phase ${phase}   cells ${CELLS.length}   judge ${JUDGE}   seed ${SEED}`);
console.log(`comfy ${COMFY}   out ${OUT}\n`);

const results = [];
if (onlyStage !== 'score') {
  console.log('── generate ──');
  let previousRegime;
  for (const [index, cell] of CELLS.entries()) {
    if (previousRegime !== undefined && previousRegime !== cell.regime) {
      await freeComfy();
      console.log(`  -- regime ${previousRegime} -> ${cell.regime}: unloaded the model`);
    }
    previousRegime = cell.regime;
    const out = await generate(cell);
    console.log(
      `  ${String(index + 1).padStart(3)}/${CELLS.length} ${cellId(cell).padEnd(52)} ${out.cached ? 'cached' : `${out.seconds}s`}`,
    );
    results.push({ ...cell, file: out.file, seconds: out.seconds });
  }
  await freeComfy();
  console.log('  freed ComfyUI VRAM\n');
} else {
  for (const cell of CELLS) results.push({ ...cell, file: join(OUT, `${cellId(cell)}.png`) });
}

if (onlyStage !== 'generate') {
  console.log('── score ──');
  for (const [index, row] of results.entries()) {
    const scored = await score(row, row.file);
    Object.assign(row, scored);
    console.log(
      `  ${String(index + 1).padStart(3)}/${results.length} ${cellId(row).padEnd(52)} ` +
        `style ${fmt(row.styleMatch)}  silhouette ${fmt(row.silhouette)}${row.error ? `  ${row.error}` : ''}`,
    );
  }
}

// ── the matrix ──────────────────────────────────────────────────────────────

console.log(
  `\n${'preset'.padEnd(20)} ${'regime'.padEnd(8)} ${'form'.padEnd(6)} ${'probe'.padEnd(16)} style  silh   gen`,
);
for (const row of [...results].sort(
  (left, right) =>
    (right.styleMatch ?? -1) - (left.styleMatch ?? -1) ||
    left.presetId.localeCompare(right.presetId),
)) {
  console.log(
    `${row.presetId.padEnd(20)} ${row.regime.padEnd(8)} ${row.form.padEnd(6)} ${row.probe.padEnd(16)} ` +
      `${fmt(row.styleMatch).padStart(5)}  ${fmt(row.silhouette).padStart(4)}  ${`${String(row.seconds ?? 0)}s`.padStart(6)}`,
  );
}

const resultFile = join(OUT, `results-${phase}.json`);
writeFileSync(resultFile, JSON.stringify(results, null, 2));
console.log(`\nwrote ${resultFile}`);

// ── helpers ─────────────────────────────────────────────────────────────────

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fmt(value) {
  return value === null || value === undefined ? '-' : value.toFixed(2);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** See the file header: the only reliable way off a stale LoRA patch. */
async function freeComfy() {
  await fetch(`${COMFY}/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
  });
  await sleep(1500);
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
