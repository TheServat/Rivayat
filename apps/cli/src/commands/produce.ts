/**
 * `rv assets produce` - S6 on the real local lane.
 *
 * This is the wiring, and nothing else: every decision it makes is a binding, not a
 * behaviour. `ProduceAssetsUseCase` in `@rv/asset-engine` owns the chain; the registry
 * owns dedup; `ComfyUiAdapter` owns the GPU. What lives here is the set of concrete
 * adapters an app has to choose - SQLite for the index, the filesystem CAS for the
 * bytes, SQLite again for the produce checkpoints, ComfyUI for the pixels.
 *
 * It exists to answer one question that no test can: does the chain survive contact
 * with a real diffusion model? A parts-sheet prompt that comes back as a single blob
 * is a result, not a bug in this file, and the summary prints the numbers that say so
 * - components found versus parts planned, per-step seconds, alpha coverage.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  type AnimationClip,
  type AssetSpec,
  Ids,
  type Rig,
  type RunId,
  type SemanticKey,
  type StyleBible,
  type StyleBibleId,
} from '@rv/contracts';
import {
  ChainedMatting,
  DeriveAssetSpecUseCase,
  type LaneBinding,
  PngRaster,
  ProduceAssetsUseCase,
  type ProduceProgress,
  type ProducedAsset,
  ThresholdMatting,
} from '@rv/asset-engine';
import {
  FlatRateAssetCostEstimator,
  RegisterAssetVersionUseCase,
  ResolveAssetDemandUseCase,
} from '@rv/asset-registry';
import { lock } from '@rv/core-domain';
import {
  DrizzleAssetRepository,
  DrizzleProduceCheckpointRepository,
  FsBlobStore,
  createDatabase,
} from '@rv/persistence';
import {
  BudgetGuard,
  COMFYUI_DEFAULT_BASE_URL,
  ComfyUiAdapter,
  CostMeter,
  OllamaAdapter,
  loadComfyWorkflows,
} from '@rv/providers';
import { findPreset, materialiseStyleBible } from '@rv/style-engine';
import {
  type Clock,
  type Result,
  UNIT,
  type Unit,
  type AppError,
  ValidationError,
  err,
  isErr,
  ok,
  toIso,
} from '@rv/shared-kernel';

// ── the three props ─────────────────────────────────────────────────────────

/**
 * Props, not characters, and that is the finding rather than a convenience.
 *
 * Research §3: SD 1.5 collapses a character parts-sheet request into a costume
 * turnaround, because CLIP-L at 77 tokens cannot carry a multi-clause layout
 * instruction. Inanimate subjects have no turnaround prior to fall back on, so this is
 * the set the free local lane is expected to survive. One of the three plans a single
 * part, so the single-layer branch is exercised on real pixels too.
 */
const DEMO_REQUIREMENTS = [
  {
    semanticKey: 'prop/street-lamp/terrace' as SemanticKey,
    label: 'Terrace street lamp',
    description:
      'A cast-iron street lamp in four separate pieces: the round mounting base, the lower post, the upper post, and the glass lantern head',
    archetype: 'articulated-prop' as const,
    subjectClass: 'prop' as const,
    canvas: { width: 768, height: 512 },
  },
  {
    semanticKey: 'prop/lamp-cart/laden' as SemanticKey,
    label: 'Lamplighter handcart',
    description:
      'A two-wheeled wooden handcart in separate pieces: the cart frame seen from the side, the stacked oil-can load, and two identical spoked wheels',
    archetype: 'wheeled' as const,
    subjectClass: 'prop' as const,
    canvas: { width: 768, height: 512 },
  },
  {
    semanticKey: 'prop/wick-key/brass' as SemanticKey,
    label: 'Brass wick key',
    description: 'A small worn brass wick key, one solid piece, seen flat from the side',
    archetype: 'rigid-prop' as const,
    subjectClass: 'prop' as const,
    canvas: { width: 512, height: 512 },
  },
] as const;

/**
 * The run id a resumed run has to keep.
 *
 * `StageCheckpoint`s belong to a `PipelineRun`, and this stage's checkpoint key is
 * `(runId, assetKey, step, attempt)` - so "kill it and start it again" only skips work
 * if the second process claims the *same* run. A CLI that minted a fresh id every
 * invocation would look resumable in a test and regenerate everything in practice,
 * which is the failure this file exists to catch. `--fresh` is the deliberate opt-out.
 */
export async function resolveRunId(
  workspaceDir: string,
  options: { readonly fresh: boolean; readonly explicit: string | undefined; readonly ids: Ids },
): Promise<RunId> {
  const path = join(workspaceDir, 'produce-run.json');
  if (options.explicit !== undefined) return options.explicit;
  if (!options.fresh) {
    try {
      const stored = JSON.parse(await readFile(path, 'utf8')) as { runId?: string };
      if (typeof stored.runId === 'string') return stored.runId;
    } catch {
      // No previous run. Fall through and mint one.
    }
  }
  const runId = options.ids.run();
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(path, JSON.stringify({ runId }, null, 2), 'utf8');
  return runId;
}

// ── options ─────────────────────────────────────────────────────────────────

export interface ProduceDemoOptions {
  readonly outDir: string;
  readonly workspaceDir: string;
  readonly workflowDir: string;
  readonly comfyHost: string;
  readonly dbUrl: string;
  readonly assetStoreDir: string;
  readonly steps: number;
  readonly concurrency: number;
  readonly bakeFrames: number;
  readonly runId: RunId;
  readonly clock: Clock;
  readonly fresh: boolean;
  /**
   * Ollama vision model for the quality gate, or absent to skip it.
   *
   * Opt-in because it is slow here for a physical reason: `gemma4:26b` is 18 GB on a
   * 6 GB card, so it runs mostly on the CPU. It is also the only thing in the chain
   * that can tell four photographs *of* a street lamp from four street-lamp
   * components - the splitter, the assigner and the rigger all accept both.
   */
  readonly visionModel: string | undefined;
  readonly ollamaHost: string | undefined;
  readonly onProgress: (event: ProduceProgress) => void;
}

export interface ProduceDemoReport {
  readonly style: { readonly id: StyleBibleId; readonly checksum: string; readonly seed: number };
  readonly estimateNanoUsd: number;
  readonly spentNanoUsd: number;
  readonly registered: readonly ProducedAsset[];
  readonly reused: readonly { readonly semanticKey: string }[];
  readonly rejected: readonly { readonly semanticKey: string }[];
  readonly failed: readonly {
    readonly semanticKey: string;
    readonly step: string;
    readonly message: string;
  }[];
  readonly byStep: Record<string, { ran: number; durationMs: number }>;
  readonly exported: readonly string[];
  readonly totalMs: number;
}

/**
 * A locked bible from the shelf, so the run is against a real frozen style.
 *
 * `lock` recomputes the checksum, and the checksum is a component of the dedup key -
 * so a hand-built bible with a made-up checksum would write assets nothing could ever
 * find again.
 */
export function demoStyle(clock: Clock, ids: Ids): Result<StyleBible, AppError> {
  const preset = findPreset('paper-cutout');
  if (isErr(preset)) return preset;
  const materialised = materialiseStyleBible({
    draft: preset.value.draft,
    id: ids.styleBible(),
    clock,
  });
  return lock(materialised, toIso(clock.now()));
}

export function demoSpecs(style: StyleBible, quality: 'draft' | 'preview'): AssetSpec[] {
  const derive = new DeriveAssetSpecUseCase();
  const specs: AssetSpec[] = [];
  for (const requirement of DEMO_REQUIREMENTS) {
    const derived = derive.execute({
      source: {
        kind: 'requirement',
        requirement: {
          semanticKey: requirement.semanticKey,
          label: requirement.label,
          description: requirement.description,
          archetype: requirement.archetype,
          subjectClass: requirement.subjectClass,
        },
      },
      quality,
      canvas: requirement.canvas,
    });
    if (isErr(derived)) throw derived.error;
    specs.push(derived.value);
  }
  // The style seeds every generation; nothing here draws a random number.
  void style;
  return specs;
}

export async function produceDemo(
  options: ProduceDemoOptions,
): Promise<Result<ProduceDemoReport, AppError>> {
  const startedAt = options.clock.now();
  const ids = new Ids();

  const style = demoStyle(options.clock, ids);
  if (isErr(style)) return style;

  const workflows = await loadComfyWorkflows(options.workflowDir);
  if (isErr(workflows)) return workflows;

  const database = createDatabase(options.dbUrl);
  if (isErr(database)) return database;

  try {
    const blobs = new FsBlobStore({ root: options.assetStoreDir });
    const repository = new DrizzleAssetRepository(database.value);
    const meter = new CostMeter({ clock: options.clock, projectId: ids.project() });

    const comfy = new ComfyUiAdapter({
      workflows: workflows.value,
      baseUrl: options.comfyHost,
      clock: options.clock,
      defaults: { steps: options.steps },
      generationTimeoutMs: 300_000,
    });

    // One lane, bound explicitly. A character spec in this run would fail by name
    // rather than quietly generating without its identity anchors.
    const localLane: LaneBinding = {
      images: comfy,
      provider: 'comfyui',
      model: 'dreamshaper_8.safetensors',
      // SD 1.5 conditions on CLIP-L at 77 tokens. Declared here rather than inferred
      // from the lane name, because the same graphs will host SDXL and FLUX later and
      // FLUX's T5-XXL wants the long shape (research §2).
      promptEncoder: 'clip-77',
    };

    // The durable store, on the same handle the asset index uses. `--fresh` is honoured
    // upstream by minting a new run id: the checkpoint key is
    // `(runId, assetKey, step, attempt)`, so a fresh run matches no row and re-runs
    // every step, without this file having to know what "fresh" means.
    const checkpoints = new DrizzleProduceCheckpointRepository(database.value);

    const produce = new ProduceAssetsUseCase({
      resolver: new ResolveAssetDemandUseCase({
        repository,
        estimator: new FlatRateAssetCostEstimator(),
      }),
      registrar: new RegisterAssetVersionUseCase({ repository, ids, clock: options.clock }),
      budget: new BudgetGuard({
        policy: {
          perRunNanoUsd: 1_000_000_000,
          perDayNanoUsd: 5_000_000_000,
          perProjectNanoUsd: null,
          confirmAboveNanoUsd: null,
          onExceed: 'abort',
        },
        ledger: meter,
        clock: options.clock,
      }),
      lanes: { byLane: { 'local-parts-sheet': localLane } },
      raster: new PngRaster(),
      // Threshold first with the default tolerance, then a wider one: the parts sheet
      // is drawn on a field the prompt asked to be flat, and a model that shades it
      // slightly still keys cleanly at 46->72 rather than needing a segmentation model
      // and a 400 MB download.
      matting: new ChainedMatting([
        new ThresholdMatting(),
        new ThresholdMatting({ tolerance: 30 * 30 * 3, softTolerance: 72 * 72 * 3 }),
      ]),
      blobs,
      ids,
      clock: options.clock,
      checkpoints,
      ledger: meter,
      pricer: meter,
      ...(options.visionModel === undefined
        ? {}
        : {
            vision: new OllamaAdapter({
              model: options.visionModel,
              ...(options.ollamaHost === undefined ? {} : { baseUrl: options.ollamaHost }),
              timeoutMs: 600_000,
            }),
            visionBinding: { provider: 'ollama' as const, model: options.visionModel },
          }),
    });

    const specs = demoSpecs(style.value, 'draft');

    const produced = await produce.execute({
      specs,
      style: style.value,
      runId: options.runId,
      approved: true,
      concurrency: options.concurrency,
      bake: { clips: ['idle'], settings: { frames: options.bakeFrames } },
      onProgress: options.onProgress,
    });
    if (isErr(produced)) return produced;

    const exported = await exportAssets(produced.value.registered, blobs, options.outDir);
    if (isErr(exported)) return err(exported.error);

    return ok({
      style: {
        id: style.value.id,
        checksum: style.value.checksum,
        seed: style.value.seed,
      },
      estimateNanoUsd: produced.value.ledger.estimatedNanoUsd,
      spentNanoUsd: produced.value.ledger.spentNanoUsd,
      registered: produced.value.registered,
      reused: produced.value.reused.map((asset) => ({ semanticKey: asset.semanticKey })),
      rejected: produced.value.rejected.map((asset) => ({ semanticKey: asset.semanticKey })),
      failed: produced.value.failed.map((failure) => ({
        semanticKey: failure.semanticKey,
        step: failure.step,
        message: failure.error.message,
      })),
      byStep: Object.fromEntries(
        Object.entries(produced.value.ledger.byStep).map(([step, tally]) => [
          step,
          { ran: tally.ran, durationMs: tally.durationMs },
        ]),
      ),
      exported: exported.value,
      totalMs: Math.max(0, options.clock.now() - startedAt),
    });
  } finally {
    database.value.close();
  }
}

/**
 * Puts the parts and the atlas somewhere a person can open them.
 *
 * The content store addresses everything by hash, which is right for the pipeline and
 * useless for looking at: `link` is the seam the store provides for exactly this, so
 * the demo asks for named copies rather than reaching past the port.
 */
async function exportAssets(
  assets: readonly ProducedAsset[],
  blobs: FsBlobStore,
  outDir: string,
): Promise<Result<string[], AppError>> {
  const written: string[] = [];
  for (const asset of assets) {
    const folder = join(outDir, asset.semanticKey.replace(/\//g, '_'));
    await mkdir(folder, { recursive: true });

    const files: { hash: string; name: string }[] = [
      { hash: asset.sourceImageHash, name: '00-generated.png' },
      { hash: asset.matteImageHash, name: '01-matted.png' },
      ...asset.parts.map((part, index) => ({
        hash: part.imageHash,
        name: `part-${String(index + 1)}-${part.name}.png`,
      })),
      // Numbered by position, not by clip name: a clip whose frames do not fit
      // `maxSize` spills to a second page, and two pages under one filename means the
      // second silently replaces the first.
      ...asset.sheets.flatMap((sheet, index) => [
        { hash: sheet.atlasImageHash, name: `atlas-${sheet.clipName}-p${String(index)}.png` },
        { hash: sheet.atlasJsonHash, name: `atlas-${sheet.clipName}-p${String(index)}.json` },
      ]),
    ];

    for (const file of files) {
      const bytes = await blobs.get(file.hash);
      if (isErr(bytes)) return bytes;
      const target = join(folder, file.name);
      await writeFile(target, bytes.value);
      written.push(target);
    }

    await writeFile(join(folder, 'asset.json'), JSON.stringify(describe(asset), null, 2), 'utf8');
    written.push(join(folder, 'asset.json'));
  }
  return ok(written);
}

function describe(asset: ProducedAsset): Record<string, unknown> {
  return {
    semanticKey: asset.semanticKey,
    assetKey: asset.key,
    assetId: asset.assetId,
    versionId: asset.versionId,
    lane: asset.lane,
    decomposition: asset.decomposition,
    matteEngine: asset.matteEngine,
    plannedParts: asset.plannedParts,
    foundParts: asset.foundParts,
    unfilled: asset.unfilled,
    parts: asset.parts.map((part) => ({
      name: part.name,
      role: part.role,
      bounds: part.bounds,
      pivot: part.pivot,
      alphaCoverage: Number(part.alphaCoverage.toFixed(4)),
      imageHash: part.imageHash,
    })),
    rig: rigSummary(asset.rig),
    clips: asset.clips.map(clipSummary),
    sheets: asset.sheets,
    degraded: asset.degraded,
    resumed: asset.resumed,
    costNanoUsd: asset.costNanoUsd,
    durationMs: asset.durationMs,
  };
}

function rigSummary(rig: Rig): Record<string, unknown> {
  return {
    id: rig.id,
    templateId: rig.templateId,
    bones: rig.bones.map((bone) => ({
      role: bone.role,
      parent: bone.parentId,
      rest: bone.rest.position,
      boundParts: bone.partIds.length,
    })),
    meshes: rig.meshes.length,
    ikChains: rig.ikChains.length,
  };
}

function clipSummary(clip: AnimationClip): Record<string, unknown> {
  return { name: clip.name, durationMs: clip.durationMs, fps: clip.fps, irHash: clip.irHash };
}

/** Prevents an accidental "it produced nothing and said nothing" run. */
export async function assertWorkflowsPresent(directory: string): Promise<Result<Unit, AppError>> {
  try {
    const entries = await readdir(directory);
    if (!entries.includes('txt2img-lcm-draft.json')) {
      return err(
        new ValidationError({
          message: `no txt2img-lcm-draft.json in ${directory}`,
          context: { directory, entries },
        }),
      );
    }
    return ok(UNIT);
  } catch (caught) {
    return err(
      new ValidationError({
        message: `cannot read the ComfyUI workflow directory ${directory}`,
        context: { directory },
        cause: caught,
      }),
    );
  }
}

export function defaultOptions(
  env: NodeJS.ProcessEnv,
  clock: Clock,
  runId: RunId,
): Omit<ProduceDemoOptions, 'onProgress'> {
  const workspaceDir = resolve(env.RV_WORKSPACE_DIR ?? 'workspace');
  return {
    outDir: resolve(join(workspaceDir, 'produce-demo')),
    workspaceDir,
    workflowDir: resolve(env.RV_COMFYUI_WORKFLOW_DIR ?? 'tools/comfy-workflows'),
    comfyHost: env.COMFYUI_HOST ?? COMFYUI_DEFAULT_BASE_URL,
    // Deliberately **not** `RV_DB_URL`. The demo is a demo: it must not write into
    // the project index the API is serving, and SQLite in WAL mode holds the file open
    // while that process lives, so sharing it would also make the demo unrunnable
    // whenever the API is up.
    dbUrl: `file:${join(workspaceDir, 'produce-demo.db')}`,
    assetStoreDir: resolve(join(workspaceDir, 'produce-demo-assets')),
    steps: 6,
    concurrency: 2,
    bakeFrames: 8,
    runId,
    clock,
    fresh: false,
    visionModel: undefined,
    ollamaHost: env.OLLAMA_HOST,
  };
}

const NEWLINE = '\n';

// ── the summary a person reads ──────────────────────────────────────────────

/**
 * The numbers that decide whether the lane works, and nothing decorative.
 *
 * Parts found versus parts planned is the headline: research §3 predicts that props
 * survive a parts-sheet prompt and characters do not, and this is the column that
 * either confirms it on this GPU or does not.
 */
export function renderProduceReport(report: ProduceDemoReport, outDir: string): string {
  const lines: string[] = [''];
  lines.push(
    `  style ${report.style.id}  checksum ${report.style.checksum.slice(0, 12)}  seed ${String(report.style.seed)}`,
  );
  lines.push(
    `  estimate $${(report.estimateNanoUsd / 1e9).toFixed(4)}   actually spent $${(report.spentNanoUsd / 1e9).toFixed(4)}   wall ${(report.totalMs / 1000).toFixed(1)}s`,
  );
  lines.push('');
  lines.push(
    `  ${'asset'.padEnd(26)} ${'parts'.padEnd(7)} ${'matte'.padEnd(14)} ${'bones'.padEnd(6)} ${'clips'.padEnd(6)} ${'atlas'.padEnd(12)} secs`,
  );
  for (const asset of report.registered) {
    const atlas = asset.sheets[0];
    lines.push(
      `  ${asset.semanticKey.padEnd(26)} ` +
        `${`${String(asset.foundParts)}/${String(asset.plannedParts)}`.padEnd(7)} ` +
        `${asset.matteEngine.padEnd(14)} ` +
        `${String(asset.rig.bones.length).padEnd(6)} ` +
        `${String(asset.clips.length).padEnd(6)} ` +
        `${(atlas === undefined ? '-' : `${String(atlas.atlasSize.width)}x${String(atlas.atlasSize.height)}`).padEnd(12)} ` +
        `${(asset.durationMs / 1000).toFixed(1)}`,
    );
    if (asset.unfilled.length > 0) {
      lines.push(`  ${''.padEnd(26)} unfilled: ${asset.unfilled.join(', ')}`);
    }
    for (const part of asset.parts) {
      lines.push(
        `  ${''.padEnd(28)}- ${part.name.padEnd(14)} ` +
          `${String(part.size.width)}x${String(part.size.height)} at (${String(part.bounds.x)},${String(part.bounds.y)})  ` +
          `alpha ${(part.alphaCoverage * 100).toFixed(1)}%`,
      );
    }
  }

  for (const asset of report.reused) lines.push(`  ${asset.semanticKey.padEnd(26)} cache hit`);
  for (const asset of report.rejected) {
    lines.push(`  ${asset.semanticKey.padEnd(26)} rejected by the quality gate`);
  }
  for (const failure of report.failed) {
    lines.push(`  ${failure.semanticKey.padEnd(26)} FAILED at ${failure.step}: ${failure.message}`);
  }

  lines.push('');
  lines.push('  per step (ran / total seconds)');
  for (const [step, tally] of Object.entries(report.byStep)) {
    if (tally.ran === 0 && tally.durationMs === 0) continue;
    lines.push(
      `    ${step.padEnd(10)} ${String(tally.ran).padStart(2)}  ${(tally.durationMs / 1000).toFixed(2)}s`,
    );
  }

  lines.push('');
  lines.push(`  ${String(report.exported.length)} files written under ${outDir}`);
  lines.push('');
  return lines.join(NEWLINE);
}
