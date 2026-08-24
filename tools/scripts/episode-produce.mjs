/**
 * S6 for the demo episode: six assets, the real chain, the real gate, on the free lane.
 *
 *     node node_modules/tsx/dist/cli.mjs tools/scripts/episode-produce.mjs [--fresh]
 *
 * ## Why this is not `rv assets produce`
 *
 * `apps/cli/src/commands/produce.ts` hard-codes `findPreset('paper-cutout')` and three
 * street-lamp props. Both are the demo it was written for, neither is a flag, and
 * `apps/cli` has a live owner - so this is the same `ProduceAssetsUseCase` with the
 * same adapters and a different asset list, not a second pipeline. Every binding below
 * matches `produce.ts` except the three the sweep changed:
 *
 *  1. **`flat-vector`, not `paper-cutout`.** `tools/scripts/style-sweep.mjs` scored all
 *     eleven presets against the real rubric with the real judge:
 *     `paper-cutout` scores `style-match 0.00` on a single subject in every sampler
 *     regime tested, and `flat-vector` scores 1.00 on characters, trees, skies and a
 *     parts sheet across two regimes and two seeds. Picking the style the free lane can
 *     draw is the finding, not a workaround.
 *  2. **`qwen3-vl:4b` as the gate**, from `vision-gate-bench.mjs`: it catches the known
 *     defect at 0.00, scores a flat control at 1.00 and costs 2.8 s an image. `.env`
 *     still names `gemma4:26b`, which Ollama reports with **no vision capability at all**.
 *  3. **The `cfg-lane` graph set and an all-parts-sheet policy.** LCM at cfg 1.8 draws
 *     the right *style* and the wrong *subject*; eps at cfg 7.0 draws both. And the
 *     composed `clip-77` prose prompt loses its style clause out of CLIP's first window
 *     behind `SUBJECT_CLAUSES`, so every asset goes through the parts-sheet port, whose
 *     slots let the graph put the style where the encoder reads it. Both are measured;
 *     `tools/comfy-workflows/cfg-lane/README.md` has the A/B and the numbers.
 *
 * There is one character in this cast and that is a finding, not a scope cut. Thirty-odd
 * sampled takes are in `workspace/tmp/probe`: the free lane returns a usable full-body
 * flat-vector figure for roughly one prompt in two and never returned a second, visibly
 * different one. Research §3 predicts it and `decomposition-policy.ts` says why - a
 * character wants the multi-reference cloud lane, and ComfyUI refuses references outright.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const pkg = (name) => pathToFileURL(join(ROOT, 'packages', name, 'src', 'index.ts')).href;

for (const line of safeRead(join(ROOT, '.env')).split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const {
  DEFAULT_THRESHOLDS,
  DeriveAssetSpecUseCase,
  PngRaster,
  ProduceAssetsUseCase,
  defaultMattingChain,
} = await import(pkg('asset-engine'));
const { FlatRateAssetCostEstimator, RegisterAssetVersionUseCase, ResolveAssetDemandUseCase } =
  await import(pkg('asset-registry'));
const { lock } = await import(pkg('core-domain'));
const { DrizzleAssetRepository, DrizzleProduceCheckpointRepository, FsBlobStore, createDatabase } =
  await import(pkg('persistence'));
const {
  BudgetGuard,
  COMFYUI_DEFAULT_BASE_URL,
  ComfyUiAdapter,
  CostMeter,
  OllamaAdapter,
  loadComfyWorkflows,
  supportsPartsSheet,
} = await import(pkg('providers'));
const { findPreset, materialiseStyleBible } = await import(pkg('style-engine'));
const { SystemClock, isErr, toIso, unwrap } = await import(pkg('shared-kernel'));
const { Ids } = await import(pkg('contracts'));

// ── the cast and set of E01 ─────────────────────────────────────────────────

/**
 * Five assets, and each one's `subjectClass`/`archetype` pair is a routing decision.
 *
 * Every one is `rigid-prop`, so every plan is a single part named `body` and every asset
 * comes back as one cutout. The rigs that matter are built in the IR, one node per
 * asset instance, with the pivot placed on the joint - see `tools/scripts/episode-compose.mjs`.
 * That is the honest shape for this lane: asked for four separated pieces of one object
 * it returns a tray of unrelated icons, and asked for one object it returns one object.
 *
 * Descriptions carry all the semantics, and they are short on purpose: `{{prompt}}` is
 * `spec.description` verbatim and it shares CLIP's first 77-token window with the
 * four-clause style prefix.
 *
 * ## Two wordings that are measurements, not taste
 *
 * **"a single standing figure", not "a girl"** and **a square canvas, not a portrait
 * one.** Twenty-six sampled takes are in `workspace/tmp/probe/desc`: "a girl"/"a boy" on
 * a 512x768 canvas returned a photoreal cropped portrait every time and the gate scored
 * `style-match 0.00`; "a single standing figure ... whole figure visible" on 512x512
 * returns a flat full-body figure. Both nouns and both aspect ratios were tried against
 * the same style clause, so this is the prior in `dreamshaper_8` and not the prompt
 * compiler.
 *
 * **There is one human in the cast, and that is a finding.** Twelve further takes tried
 * to produce a second, differently-dressed figure; none came back as a usable full-body
 * flat-vector character - the model returns a head-and-shoulders portrait or a
 * three-up costume turnaround, which is exactly the prior `decomposition-policy.ts`
 * documents for characters. R-04's "character-consistency drift" is not a future risk on
 * this lane; it is the current state, and the cloud multi-reference lane is what the
 * architecture already says buys it.
 */
const REQUIREMENTS = [
  {
    semanticKey: 'env/skyline/dusk',
    label: 'City skyline',
    description:
      'flat vector, a long low row of simple flat-roofed houses and one domed tower, one solid dark colour, plain flat background',
    archetype: 'rigid-prop',
    subjectClass: 'architecture',
    canvas: { width: 1024, height: 512 },
  },
  {
    semanticKey: 'char/mina/rooftop',
    label: 'Mina',
    description:
      'simple flat vector illustration of a standing person in a long teal tunic, arms lifted forward, whole figure visible, plain flat background, no shading',
    archetype: 'rigid-prop',
    subjectClass: 'character',
    canvas: { width: 512, height: 512 },
  },
  {
    semanticKey: 'prop/kite/sail',
    label: 'Kite sail',
    description:
      'flat vector, one diamond-shaped paper kite with crossed spars, plain flat background',
    archetype: 'rigid-prop',
    subjectClass: 'prop',
    canvas: { width: 512, height: 512 },
  },
  {
    semanticKey: 'prop/kite/bow',
    label: 'Tail bow',
    description: 'flat vector, one small ribbon bow tied on a short string, plain flat background',
    archetype: 'rigid-prop',
    subjectClass: 'prop',
    canvas: { width: 512, height: 512 },
  },
  {
    semanticKey: 'prop/water-tank/rooftop',
    label: 'Rooftop water tank',
    description:
      'flat vector, one round rooftop water tank standing on four short legs, plain flat background',
    archetype: 'rigid-prop',
    subjectClass: 'prop',
    canvas: { width: 512, height: 512 },
  },
  {
    semanticKey: 'flora/rooftop-tree/potted',
    label: 'Rooftop tree',
    description:
      'flat vector, one small potted tree, a plain round clay pot with a straight trunk and one rounded leafy canopy, plain flat background',
    archetype: 'rigid-prop',
    subjectClass: 'foliage',
    canvas: { width: 512, height: 512 },
  },
];

const PRESET = process.env.RV_EPISODE_PRESET ?? 'flat-vector';
const fresh = process.argv.includes('--fresh');
const only = argValue('--only');

const WORKSPACE = join(ROOT, 'workspace');
const OUT = join(WORKSPACE, 'demo', 'episode', 'assets');
const STORE = join(WORKSPACE, 'demo', 'episode', 'cas');
const DB = join(WORKSPACE, 'demo', 'episode', 'episode.db');
const RUN_FILE = join(WORKSPACE, 'demo', 'episode', 'produce-run.json');
const MANIFEST = join(WORKSPACE, 'demo', 'episode', 'assets.json');

if (fresh) {
  for (const path of [OUT, STORE, DB, `${DB}-wal`, `${DB}-shm`, RUN_FILE, MANIFEST]) {
    rmSync(path, { recursive: true, force: true });
  }
}
mkdirSync(OUT, { recursive: true });

const clock = new SystemClock();
const ids = new Ids();
const runId = resolveRunId();

const preset = unwrap(findPreset(PRESET));
const style = unwrap(
  lock(
    materialiseStyleBible({ draft: preset.draft, id: ids.styleBible(), clock }),
    toIso(clock.now()),
  ),
);

/**
 * `cfg-lane`, not the parent directory. Its README carries the two measurements:
 * LCM at cfg 1.8 draws photoreal product shots where eps at cfg 7.0 draws the style,
 * and its parts-sheet graph is a single-subject scaffold rather than an exploded view.
 */
const workflows = unwrap(
  await loadComfyWorkflows(join(ROOT, 'tools', 'comfy-workflows', 'cfg-lane')),
);
const database = unwrap(createDatabase(`file:${DB}`));
const blobs = new FsBlobStore({ root: STORE });
const repository = new DrizzleAssetRepository(database);
const meter = new CostMeter({ clock, projectId: ids.project() });

/**
 * 24 steps at cfg 7.0 with the LCM LoRA off, on both graphs.
 *
 * The sweep's `lcm-8` cell scores `style-match 1.00` and still draws the wrong *thing*:
 * a distilled model at cfg 1.8 follows the noun and drops the rest of the clause. At
 * cfg 7.0 the same prompts come back as the subject that was asked for, at 3-4x the
 * seconds. On a five-asset episode that is 40 s against 12 s, once.
 */
const comfy = new ComfyUiAdapter({
  workflows,
  baseUrl: process.env.COMFYUI_HOST ?? COMFYUI_DEFAULT_BASE_URL,
  clock,
  defaults: {
    steps: 24,
    cfg: 7.0,
    sampler: 'dpmpp_2m',
    scheduler: 'karras',
    // Loaded and contributing nothing, so the two regimes differ by numbers rather than
    // by graph shape. `cfg-lane` sets `ModelSamplingDiscrete(eps)` to match.
    lora_strength: 0,
  },
  partsSheetDefaults: { steps: 24, cfg: 7.0 },
  generationTimeoutMs: 300_000,
});

const visionModel = process.env.RV_EPISODE_VISION_MODEL ?? 'qwen3-vl:4b';
const gateOn = visionModel !== 'off';

const matting = defaultMattingChain({
  birefnet: { cacheDir: join(WORKSPACE, 'cache', 'huggingface', 'transformers') },
});

console.log(`run          ${runId}${fresh ? '  (fresh)' : ''}`);
console.log(`preset       ${PRESET}  checksum ${style.checksum.slice(0, 12)}  seed ${style.seed}`);
console.log(`comfyui      ${process.env.COMFYUI_HOST ?? COMFYUI_DEFAULT_BASE_URL}`);
console.log(`parts sheet  ${supportsPartsSheet(comfy) ? 'yes' : 'NO'}   matting ${matting.engine}`);
console.log(`vision gate  ${gateOn ? visionModel : 'off'}`);
console.log();

const produce = new ProduceAssetsUseCase({
  resolver: new ResolveAssetDemandUseCase({
    repository,
    estimator: new FlatRateAssetCostEstimator(),
  }),
  registrar: new RegisterAssetVersionUseCase({ repository, ids, clock }),
  budget: new BudgetGuard({
    policy: {
      perRunNanoUsd: 1_000_000_000,
      perDayNanoUsd: 5_000_000_000,
      perProjectNanoUsd: null,
      confirmAboveNanoUsd: null,
      onExceed: 'abort',
    },
    ledger: meter,
    clock,
  }),
  lanes: {
    // Every subject on the free lane, and every subject through the **parts-sheet
    // port** - which is the only port that hands the graph its slots separately, and
    // `cfg-lane`'s scaffold needs them separate to put the style where CLIP can read
    // it. `archetype: 'rigid-prop'` makes the plan one part, so `{{parts}}` and the
    // grid slots go unused and the splitter has one blob to find.
    policy: {
      bySubject: {},
      fallback: {
        lane: 'local-parts-sheet',
        decomposition: 'parts-sheet',
        fallbacks: ['single-layer'],
        reason:
          'cfg-lane serves a single-subject scaffold on the parts-sheet port; see tools/comfy-workflows/cfg-lane/README.md',
      },
    },
    byLane: {
      'local-parts-sheet': {
        images: comfy,
        provider: 'comfyui',
        model: 'dreamshaper_8.safetensors',
        promptEncoder: 'clip-77',
        // Grey, and magenta was tried and is worse. The theory was that a chroma-key
        // field would key harder because no preset palette contains magenta; what
        // actually happened is that SD 1.5 put the magenta **in the subjects** - pink
        // buildings, pink kite panels - and left the field grey and graded anyway
        // (`workspace/tmp/probe/magenta.png`). `alpha-cleanliness` went from 0.57 to 0.12.
        // A colour named in the prompt is a colour in the picture, not a colour behind it.
        backgroundPrompt:
          'flat solid uniform light grey, no vignette, no gradient, no floor, no shadow',
      },
    },
  },
  raster: new PngRaster(),
  matting,
  blobs,
  ids,
  clock,
  /**
   * Eight repairs, not the default two.
   *
   * `DEFAULT_THRESHOLDS.maxRepairs = 2` is the right bound for a lane that bills per
   * image. This one does not: a take costs 5-8 GPU-seconds and $0.0000, and the free
   * lane's hit rate on a flat-vector character is roughly one in two. Raising the bound
   * is the sanctioned way to spend that - the floors are untouched, so nothing enters
   * the library that would not have entered it at two repairs.
   */
  thresholds: { ...DEFAULT_THRESHOLDS, maxRepairs: 8 },
  checkpoints: new DrizzleProduceCheckpointRepository(database),
  ledger: meter,
  pricer: meter,
  ...(gateOn
    ? {
        vision: new OllamaAdapter({
          model: visionModel,
          baseUrl: process.env.OLLAMA_HOST,
          timeoutMs: 900_000,
          capabilities: ['vision-scoring'],
        }),
        visionBinding: { provider: 'ollama', model: visionModel },
      }
    : {}),
});

// See cfg-lane/README.md: ComfyUI 0.33 does not unpatch the LCM LoRA when the next
// graph asks for strength 0 and eps sampling, and the sampler then returns pure noise.
// One unload before the run is enough because nothing here switches regime mid-run.
await fetch(`${process.env.COMFYUI_HOST ?? COMFYUI_DEFAULT_BASE_URL}/free`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ unload_models: true, free_memory: true }),
});
await new Promise((done) => setTimeout(done, 1500));

const derive = new DeriveAssetSpecUseCase();
const chosen = REQUIREMENTS.filter((r) => only === undefined || r.semanticKey.includes(only));
const specs = chosen.map((requirement) =>
  unwrap(
    derive.execute({
      source: { kind: 'requirement', requirement },
      quality: 'draft',
      canvas: requirement.canvas,
    }),
  ),
);

for (const spec of specs) {
  console.log(
    `  plan ${spec.semanticKey.padEnd(24)} ${spec.archetype.padEnd(16)} parts: ${spec.parts.map((p) => p.name).join(', ')}`,
  );
}
console.log();

const startedAt = Date.now();
const produced = unwrap(
  await produce.execute({
    specs,
    style,
    runId,
    approved: true,
    // Serial. Two ComfyUI prompts in flight on a 6 GB card is where DynamicVRAM starts
    // thrashing, and the gate wants the card too.
    concurrency: 1,
    bake: { clips: ['idle'], settings: { frames: 8 } },
    onProgress: (event) => {
      console.log(
        `  ${event.step.padEnd(9)} ${event.phase.padEnd(7)} ${event.semanticKey.padEnd(24)} ` +
          `${String(event.durationMs).padStart(6)} ms${event.detail === undefined ? '' : `  ${event.detail}`}`,
      );
    },
  }),
);
const totalMs = Date.now() - startedAt;
database.close();

// ── report and export ───────────────────────────────────────────────────────

console.log();
console.log(
  `  estimate $${(produced.ledger.estimatedNanoUsd / 1e9).toFixed(4)}   spent $${(produced.ledger.spentNanoUsd / 1e9).toFixed(4)}   wall ${(totalMs / 1000).toFixed(1)}s`,
);
console.log();

const manifest = { runId, preset: PRESET, styleChecksum: style.checksum, assets: [] };

for (const asset of produced.registered) {
  console.log(
    `  ${asset.semanticKey.padEnd(24)} ${asset.decomposition.padEnd(13)} ` +
      `parts ${asset.foundParts}/${asset.plannedParts}  ${asset.matteEngine.padEnd(26)} ` +
      `bones ${String(asset.rig.bones.length).padStart(2)}  clips ${String(asset.clips.length)}  ` +
      `${(asset.durationMs / 1000).toFixed(1)}s  scores ${fmtScores(asset.scores)}`,
  );
  for (const part of asset.parts) {
    console.log(
      `      ${part.name.padEnd(14)} ${String(part.size.width).padStart(4)}x${String(part.size.height).padEnd(4)} ` +
        `at (${String(part.bounds.x).padStart(4)},${String(part.bounds.y).padStart(4)})  alpha ${(part.alphaCoverage * 100).toFixed(1)}%`,
    );
  }
  manifest.assets.push(await exportAsset(asset));
}
for (const asset of produced.reused) console.log(`  ${asset.semanticKey.padEnd(24)} cache hit`);
for (const asset of produced.rejected) {
  console.log(`  ${asset.semanticKey.padEnd(24)} REJECTED by the quality gate`);
  for (const failure of asset.failures) {
    console.log(`      ${failure.key} ${failure.score.toFixed(2)} < ${failure.floor}`);
  }
}
for (const failure of produced.failed) {
  console.log(
    `  ${failure.semanticKey.padEnd(24)} FAILED at ${failure.step}: ${failure.error.message}`,
  );
}

writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\n  manifest ${MANIFEST}`);
console.log(`  files    ${OUT}`);

if (produced.rejected.length > 0 || produced.failed.length > 0) process.exitCode = 3;

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Everything the composer needs, on disk and in one JSON.
 *
 * Part bounds are kept in the *matted canvas* frame, not re-normalised: the rig's bone
 * rests are in the same frame, so an IR that places a part and pivots it about a bone
 * is doing arithmetic in one coordinate system rather than two.
 */
async function exportAsset(asset) {
  const folder = join(OUT, asset.semanticKey.replace(/\//g, '_'));
  mkdirSync(folder, { recursive: true });

  const files = [
    { hash: asset.sourceImageHash, name: '00-generated.png' },
    { hash: asset.matteImageHash, name: '01-matted.png' },
    ...asset.parts.map((part, index) => ({
      hash: part.imageHash,
      name: `part-${index + 1}-${part.name}.png`,
    })),
  ];
  const written = {};
  for (const file of files) {
    const bytes = await blobs.get(file.hash);
    if (isErr(bytes)) continue;
    writeFileSync(join(folder, file.name), bytes.value);
    written[file.name] = join(folder, file.name);
  }

  const record = {
    semanticKey: asset.semanticKey,
    assetId: asset.assetId,
    versionId: asset.versionId,
    decomposition: asset.decomposition,
    matteEngine: asset.matteEngine,
    plannedParts: asset.plannedParts,
    foundParts: asset.foundParts,
    unfilled: asset.unfilled,
    degraded: asset.degraded,
    scores: asset.scores,
    folder,
    matte: written['01-matted.png'],
    parts: asset.parts.map((part, index) => ({
      id: part.id,
      name: part.name,
      role: part.role,
      bounds: part.bounds,
      size: part.size,
      alphaCoverage: part.alphaCoverage,
      file: written[`part-${index + 1}-${part.name}.png`],
    })),
    rig: asset.rig,
    clips: asset.clips.map((clip) => ({ name: clip.name, irHash: clip.irHash })),
    canvas: REQUIREMENTS.find((r) => r.semanticKey === asset.semanticKey)?.canvas,
  };
  writeFileSync(join(folder, 'asset.json'), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

function fmtScores(scores) {
  if (scores === undefined) return '(gate off)';
  return `style ${scores.styleMatch.toFixed(2)} alpha ${scores.alphaCleanliness.toFixed(2)} silh ${scores.silhouetteReadability.toFixed(2)} parts ${scores.partCompleteness.toFixed(2)} overall ${scores.overall.toFixed(2)}`;
}

function resolveRunId() {
  if (!fresh) {
    try {
      const stored = JSON.parse(readFileSync(RUN_FILE, 'utf8'));
      if (typeof stored.runId === 'string') return stored.runId;
    } catch {
      // No previous run. Mint one.
    }
  }
  const minted = ids.run();
  mkdirSync(join(WORKSPACE, 'demo', 'episode'), { recursive: true });
  writeFileSync(RUN_FILE, JSON.stringify({ runId: minted }, null, 2), 'utf8');
  return minted;
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
