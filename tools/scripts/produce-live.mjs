/**
 * The three-asset live produce, wired the way the engines now expect.
 *
 *     node node_modules/tsx/dist/cli.mjs tools/scripts/produce-live.mjs [--fresh]
 *
 * It is the same chain `rv assets produce` drives - `ProduceAssetsUseCase` over the real
 * ComfyUI on the 6 GB card, the real registry, the real content store - with the three
 * bindings this round of work added, and it exists because those three are *wiring*
 * decisions that live in the composition root:
 *
 *  1. **`defaultMattingChain()`** rather than two hand-built threshold tiers, so a
 *     refusal escalates to BiRefNet instead of failing the asset.
 *  2. **`backgroundPrompt`** on the lane, which only reaches a provider that has the
 *     parts-sheet graph. `loadComfyWorkflows` now finds that graph on its own, so the
 *     adapter reports `servesPartsSheet: true` and `GenerateAssetVersionUseCase` routes
 *     to it with no further configuration.
 *  3. **`qwen3-vl:4b`** as the quality gate, benchmarked against three alternatives on
 *     the same rejected take (`tools/scripts/vision-gate-bench.mjs`).
 *
 * `backgroundHint` is deliberately *not* set: the RGB half of the declaration would make
 * the key measure distance from a colour the model was merely asked for rather than one
 * it actually drew, and `sampleBackground` reading the corners is the better estimator
 * whenever the field really is flat. The prompt half costs nothing and helps.
 *
 * Imported by file URL: pnpm links workspace packages into each package's own
 * `node_modules`, not the root's, so a bare specifier from `tools/` does not resolve.
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

const { DeriveAssetSpecUseCase, PngRaster, ProduceAssetsUseCase, defaultMattingChain } =
  await import(pkg('asset-engine'));
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
  OLLAMA_RECOMMENDED_VISION_MODEL,
  OllamaAdapter,
  loadComfyWorkflows,
  supportsPartsSheet,
} = await import(pkg('providers'));
const { findPreset, materialiseStyleBible } = await import(pkg('style-engine'));
const { SystemClock, isErr, toIso, unwrap } = await import(pkg('shared-kernel'));
const { Ids } = await import(pkg('contracts'));

// ── the three props ─────────────────────────────────────────────────────────

/**
 * The same three the CLI demo uses, so the table is comparable run to run.
 *
 * Props, not characters: research §3 records that SD 1.5 collapses a character
 * parts-sheet request into a costume turnaround. One of the three plans a single part,
 * which exercises the single-layer branch on real pixels too.
 */
const REQUIREMENTS = [
  {
    semanticKey: 'prop/street-lamp/terrace',
    label: 'Terrace street lamp',
    description:
      'A cast-iron street lamp in four separate pieces: the round mounting base, the lower post, the upper post, and the glass lantern head',
    archetype: 'articulated-prop',
    subjectClass: 'prop',
    canvas: { width: 768, height: 512 },
  },
  {
    semanticKey: 'prop/lamp-cart/laden',
    label: 'Lamplighter handcart',
    description:
      'A two-wheeled wooden handcart in separate pieces: the cart frame seen from the side, the stacked oil-can load, and two identical spoked wheels',
    archetype: 'wheeled',
    subjectClass: 'prop',
    canvas: { width: 768, height: 512 },
  },
  {
    semanticKey: 'prop/wick-key/brass',
    label: 'Brass wick key',
    description: 'A small worn brass wick key, one solid piece, seen flat from the side',
    archetype: 'rigid-prop',
    subjectClass: 'prop',
    canvas: { width: 512, height: 512 },
  },
];

const fresh = process.argv.includes('--fresh');
const WORKSPACE = join(ROOT, 'workspace');
const OUT = join(WORKSPACE, 'produce-live');
const STORE = join(WORKSPACE, 'produce-live-assets');
const DB = join(WORKSPACE, 'produce-live.db');
const RUN_FILE = join(WORKSPACE, 'produce-live-run.json');

if (fresh) {
  for (const path of [OUT, STORE, DB, `${DB}-wal`, `${DB}-shm`, RUN_FILE]) {
    rmSync(path, { recursive: true, force: true });
  }
}
mkdirSync(OUT, { recursive: true });

const clock = new SystemClock();
const ids = new Ids();
const runId = resolveRunId();

// ── wiring ──────────────────────────────────────────────────────────────────

const preset = unwrap(findPreset('paper-cutout'));
const style = unwrap(
  lock(
    materialiseStyleBible({ draft: preset.draft, id: ids.styleBible(), clock }),
    toIso(clock.now()),
  ),
);

const workflows = unwrap(await loadComfyWorkflows(join(ROOT, 'tools', 'comfy-workflows')));
const database = unwrap(createDatabase(`file:${DB}`));
const blobs = new FsBlobStore({ root: STORE });
const repository = new DrizzleAssetRepository(database);
const meter = new CostMeter({ clock, projectId: ids.project() });

const comfy = new ComfyUiAdapter({
  workflows,
  baseUrl: process.env.COMFYUI_HOST ?? COMFYUI_DEFAULT_BASE_URL,
  clock,
  defaults: { steps: 6 },
  generationTimeoutMs: 300_000,
});

/**
 * `RV_LIVE_VISION_MODEL=off` runs the chain with no quality gate.
 *
 * Not a convenience switch: it is the only way to see the rest of the pipeline while the
 * gate is doing its job. SD 1.5 at 6-8 LCM steps does not draw paper-cutout, the gate
 * knows it, and a rejected take is never rigged - so with the gate on, nothing
 * downstream of `score` runs at all. Gate off measures the splitter, the rigger and the
 * atlas packer; gate on measures the generator.
 */
const visionModel = process.env.RV_LIVE_VISION_MODEL ?? OLLAMA_RECOMMENDED_VISION_MODEL;
const gateOn = visionModel !== 'off';

console.log(`run          ${runId}${fresh ? '  (fresh)' : ''}`);
console.log(
  `style        ${style.id}  checksum ${style.checksum.slice(0, 12)}  seed ${style.seed}`,
);
console.log(`comfyui      ${process.env.COMFYUI_HOST ?? COMFYUI_DEFAULT_BASE_URL}`);
console.log(
  `parts sheet  ${supportsPartsSheet(comfy) ? 'yes - txt2img-lcm-parts-sheet.json' : 'NO'}`,
);
const matting = defaultMattingChain({
  birefnet: { cacheDir: join(WORKSPACE, 'cache', 'huggingface', 'transformers') },
});
console.log(`matting      ${matting.engine}`);
console.log(`vision gate  ${gateOn ? visionModel : 'off (RV_LIVE_VISION_MODEL=off)'}`);
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
    byLane: {
      'local-parts-sheet': {
        images: comfy,
        provider: 'comfyui',
        model: 'dreamshaper_8.safetensors',
        promptEncoder: 'clip-77',
        backgroundPrompt: 'flat solid uniform light grey, no vignette, no gradient, no floor',
      },
    },
  },
  raster: new PngRaster(),
  matting,
  blobs,
  ids,
  clock,
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

// ── run ─────────────────────────────────────────────────────────────────────

const derive = new DeriveAssetSpecUseCase();
const specs = REQUIREMENTS.map((requirement) =>
  unwrap(
    derive.execute({
      source: { kind: 'requirement', requirement },
      quality: 'draft',
      canvas: requirement.canvas,
    }),
  ),
);

const startedAt = Date.now();
const produced = unwrap(
  await produce.execute({
    specs,
    style,
    runId,
    approved: true,
    concurrency: 2,
    bake: { clips: ['idle'], settings: { frames: 8 } },
    onProgress: (event) => {
      process.stdout.write(`  ${event.step.padEnd(9)} ${event.semanticKey}\n`);
    },
  }),
);
const totalMs = Date.now() - startedAt;
database.close();

// ── the table ───────────────────────────────────────────────────────────────

console.log();
console.log(
  `  estimate $${(produced.ledger.estimatedNanoUsd / 1e9).toFixed(4)}   spent $${(produced.ledger.spentNanoUsd / 1e9).toFixed(4)}   wall ${(totalMs / 1000).toFixed(1)}s`,
);
console.log();
console.log(
  `  ${'asset'.padEnd(26)} ${'parts'.padEnd(7)} ${'matte'.padEnd(34)} ${'bones'.padEnd(6)} ${'clips'.padEnd(6)} ${'atlas'.padEnd(12)} secs`,
);
const exported = [];
for (const asset of produced.registered) {
  const atlas = asset.sheets[0];
  console.log(
    `  ${asset.semanticKey.padEnd(26)} ` +
      `${`${asset.foundParts}/${asset.plannedParts}`.padEnd(7)} ` +
      `${asset.matteEngine.padEnd(34)} ` +
      `${String(asset.rig.bones.length).padEnd(6)} ` +
      `${String(asset.clips.length).padEnd(6)} ` +
      `${(atlas === undefined ? '-' : `${atlas.atlasSize.width}x${atlas.atlasSize.height}`).padEnd(12)} ` +
      `${(asset.durationMs / 1000).toFixed(1)}`,
  );
  for (const part of asset.parts) {
    console.log(
      `  ${''.padEnd(28)}- ${part.name.padEnd(14)} ${part.size.width}x${part.size.height} ` +
        `at (${part.bounds.x},${part.bounds.y})  alpha ${(part.alphaCoverage * 100).toFixed(1)}%`,
    );
  }
  exported.push(...(await exportAsset(asset)));
}
for (const asset of produced.reused) console.log(`  ${asset.semanticKey.padEnd(26)} cache hit`);
for (const asset of produced.rejected) {
  console.log(`  ${asset.semanticKey.padEnd(26)} REJECTED by the quality gate`);
  for (const failure of asset.failures) {
    console.log(`  ${''.padEnd(28)}${failure.key} ${failure.score.toFixed(2)} < ${failure.floor}`);
  }
}
for (const failure of produced.failed) {
  console.log(
    `  ${failure.semanticKey.padEnd(26)} FAILED at ${failure.step}: ${failure.error.message}`,
  );
}

console.log('\n  per step (ran / total seconds)');
for (const [step, tally] of Object.entries(produced.ledger.byStep)) {
  if (tally.ran === 0 && tally.durationMs === 0) continue;
  console.log(
    `    ${step.padEnd(10)} ${String(tally.ran).padStart(2)}  ${(tally.durationMs / 1000).toFixed(2)}s`,
  );
}
console.log(`\n  ${exported.length} files under ${OUT}`);

// ── helpers ─────────────────────────────────────────────────────────────────

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
    ...asset.sheets.flatMap((sheet, index) => [
      { hash: sheet.atlasImageHash, name: `atlas-${sheet.clipName}-p${index}.png` },
      { hash: sheet.atlasJsonHash, name: `atlas-${sheet.clipName}-p${index}.json` },
    ]),
  ];

  const written = [];
  for (const file of files) {
    const bytes = await blobs.get(file.hash);
    if (isErr(bytes)) continue;
    const target = join(folder, file.name);
    writeFileSync(target, bytes.value);
    written.push(target);
  }
  const summary = {
    semanticKey: asset.semanticKey,
    lane: asset.lane,
    decomposition: asset.decomposition,
    matteEngine: asset.matteEngine,
    plannedParts: asset.plannedParts,
    foundParts: asset.foundParts,
    unfilled: asset.unfilled,
    degraded: asset.degraded,
    parts: asset.parts.map((part) => ({
      name: part.name,
      role: part.role,
      bounds: part.bounds,
      alphaCoverage: Number(part.alphaCoverage.toFixed(4)),
      imageHash: part.imageHash,
    })),
    bones: asset.rig.bones.map((bone) => bone.role),
    clips: asset.clips.map((clip) => ({ name: clip.name, irHash: clip.irHash })),
    sheets: asset.sheets,
    costNanoUsd: asset.costNanoUsd,
    durationMs: asset.durationMs,
  };
  writeFileSync(join(folder, 'asset.json'), JSON.stringify(summary, null, 2), 'utf8');
  written.push(join(folder, 'asset.json'));
  return written;
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
  mkdirSync(WORKSPACE, { recursive: true });
  writeFileSync(RUN_FILE, JSON.stringify({ runId: minted }, null, 2), 'utf8');
  return minted;
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
