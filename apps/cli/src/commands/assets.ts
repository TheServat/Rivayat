/**
 * `rv assets plan | bake | edit` - the M3 demo lines that are not `produce`.
 *
 * `plan` is the screen a human approves before a dollar moves, and the property that
 * makes it useful is negative: `ResolveAssetDemandUseCase` **writes nothing and calls no
 * provider**. It reads the dedup index, prices the misses from a pure estimator, and
 * returns. This command adds no I/O of its own beyond opening the library read-only, so
 * that property survives the trip through the CLI.
 *
 * `bake` is `BakeSheetUseCase`: parts and an IR fragment in, an atlas page out. It is
 * pure arithmetic over bytes that already exist, so it costs nothing and needs no lane.
 *
 * `edit` cannot be implemented here, and says so. See the command's own note.
 */

import { join } from 'node:path';

import { z } from 'zod';
import {
  type AnimationClip,
  type AnimationIR,
  AnimationIR as AnimationIRSchema,
  type Asset,
  type AssetId,
  type AssetSpec,
  type AssetVersion,
  type Part,
  type Sha256Hex,
  StyleBible,
} from '@rv/contracts';
import {
  BakeSheetUseCase,
  DeriveAssetSpecUseCase,
  PngRaster,
  type RgbaImage,
} from '@rv/asset-engine';
import { FlatRateAssetCostEstimator, ResolveAssetDemandUseCase } from '@rv/asset-registry';
import {
  NotFoundError,
  UnsupportedCapabilityError,
  ValidationError,
  formatUsd,
  isErr,
  nanoUsd,
  ok,
  type AppError,
  type Result,
} from '@rv/shared-kernel';

import { flag, option, type ParsedArgs } from '../cli/args';
import type { Command } from '../cli/command';
import type { CliContext } from '../cli/context';
import { EXIT, type ExitCode } from '../cli/exit';
import { emitJson, fail, usageError } from '../cli/report';
import { guardSpend, parseLane } from '../cli/spend';
import { keyValues, table } from '../cli/text';
import {
  AssetRequirementsDocument,
  CharacterStatesDocument,
  type AssetRequirement,
} from '../store/documents';
import { readJson, readJsonOrNull, writeBytes, writeJson } from '../store/json-file';
import { assetPlanPath, sanitise } from '../store/layout';
import { registryLocation, withRegistry } from '../store/registry';
import { resolveProject, type LoadedProject } from '../store/project';
import { findEpisode, loadStory } from './story';

/**
 * What one episode needs drawn.
 *
 * Two sources, merged: the requirements document (props, sets, foliage - whatever S4 or
 * a human wrote down) and every character in the cast, one spec per state kind. A
 * character is one asset with variants, not one asset per expression, which is why the
 * semantic keys collapse to `char/<slug>/expression` and the `(outfit x state)` product
 * lives in the variant key rather than in the plan.
 */
async function requirementsFor(
  project: LoadedProject,
  episodeKey: string,
): Promise<readonly AssetRequirement[]> {
  const document = await readJsonOrNull(
    join(project.paths.assetsDir, 'requirements.json'),
    AssetRequirementsDocument,
    'asset requirements',
  );
  const declared = document.ok && document.value !== null ? document.value.byEpisode : {};
  // `"*"` first so an episode-specific entry with the same key wins the dedup in
  // `ResolveAssetDemandUseCase`, which keeps the first spec it sees per derived key.
  return [...(declared[episodeKey] ?? []), ...(declared['*'] ?? [])];
}

/** Every character state set on disk, as asset requirements. */
async function castRequirements(project: LoadedProject): Promise<readonly AssetRequirement[]> {
  const story = await loadStory(project.paths.story);
  if (!story.ok) return [];

  const requirements: AssetRequirement[] = [];
  for (const member of story.value.cast) {
    const states = await readJsonOrNull(
      join(project.paths.castDir, `${member.slug}.json`),
      CharacterStatesDocument,
      'character states',
    );
    if (!states.ok || states.value === null) continue;
    for (const kind of ['expression', 'pose'] as const) {
      const first = states.value.states.find((state) => state.kind === kind);
      if (first === undefined) continue;
      requirements.push({
        semanticKey: `char/${member.slug}/${kind}`,
        label: `${states.value.name} ${kind}s`,
        description: first.prompt,
        archetype: 'biped',
        subjectClass: 'character',
        tags: [],
      });
    }
  }
  return requirements;
}

function toSpecs(
  requirements: readonly AssetRequirement[],
  quality: 'draft' | 'preview' | 'final',
): Result<readonly AssetSpec[], AppError> {
  const derive = new DeriveAssetSpecUseCase();
  const specs: AssetSpec[] = [];
  for (const requirement of requirements) {
    const derived = derive.execute({
      source: {
        kind: 'requirement',
        requirement: {
          semanticKey: requirement.semanticKey,
          label: requirement.label,
          description: requirement.description,
          archetype: requirement.archetype,
          subjectClass: requirement.subjectClass,
          tags: requirement.tags,
        },
      },
      quality,
      ...(requirement.canvas === undefined ? {} : { canvas: requirement.canvas }),
    });
    if (isErr(derived)) return derived;
    specs.push(derived.value);
  }
  return ok(specs);
}

export const assetsPlanCommand: Command = {
  path: ['assets', 'plan'],
  summary: 'hits, misses and the exact estimate - nothing is generated and nothing is written',
  usage: [
    'rv assets plan --episode <E01> [--quality draft|preview|final] [--budget <usd>]',
    '               [--db <url>] [--store <dir>] [--project <id>] [--json]',
  ],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const episode = option(args, 'episode');
    if (episode === undefined) {
      return usageError(context.io, 'Which episode? e.g. rv assets plan --episode E01', json);
    }

    const project = await resolveProject({
      workspaceRoot: context.workspaceRoot,
      explicit: option(args, 'project'),
      env: context.env,
    });
    if (isErr(project)) return fail(context.io, project.error, { json });

    const bible = await readJson(project.value.paths.style, StyleBible, 'style bible');
    if (isErr(bible)) {
      return fail(
        context.io,
        bible.error.kind === 'not-found'
          ? new NotFoundError('locked style bible', project.value.paths.style, {
              context: { hint: 'every asset key contains the style checksum; lock a style first' },
            })
          : bible.error,
        { json },
      );
    }

    const story = await loadStory(project.value.paths.story);
    const episodeKey = story.ok ? (findEpisode(story.value, episode)?.code ?? episode) : episode;

    const requirements = [
      ...(await requirementsFor(project.value, episodeKey)),
      ...(await castRequirements(project.value)),
    ];
    if (requirements.length === 0) {
      return fail(
        context.io,
        new NotFoundError('asset requirements', episodeKey, {
          context: {
            hint:
              `write ${join(project.value.paths.assetsDir, 'requirements.json')}, or generate a ` +
              'cast with rv cast states',
          },
        }),
        { json },
      );
    }

    const quality = (option(args, 'quality') ?? 'preview') as 'draft' | 'preview' | 'final';
    const specs = toSpecs(requirements, quality);
    if (isErr(specs)) return fail(context.io, specs.error, { json });

    const budgetUsd = Number(option(args, 'budget'));
    const location = registryLocation(context.workspaceRoot, context.env, {
      db: option(args, 'db'),
      store: option(args, 'store'),
    });

    const planned = await withRegistry(location, async ({ repository }) =>
      new ResolveAssetDemandUseCase({
        repository,
        estimator: new FlatRateAssetCostEstimator(),
      }).execute({
        specs: specs.value,
        styleBibleId: bible.value.id,
        styleChecksum: bible.value.checksum,
        ...(Number.isFinite(budgetUsd) && budgetUsd > 0
          ? { budgetNanoUsd: nanoUsd(Math.round(budgetUsd * 1_000_000_000)) }
          : {}),
      }),
    );
    if (isErr(planned)) return fail(context.io, planned.error, { json });

    const path = assetPlanPath(project.value.paths, episodeKey);
    const saved = await writeJson(path, PlanFile, {
      episode: episodeKey,
      styleBibleId: bible.value.id,
      styleChecksum: bible.value.checksum,
      hitCount: planned.value.hitCount,
      missCount: planned.value.missCount,
      totalEstimatedNanoUsd: planned.value.totalEstimatedNanoUsd,
      requiresConfirmation: planned.value.requiresConfirmation,
      resolutions: planned.value.resolutions.map((resolution) => ({
        key: resolution.key,
        semanticKey: resolution.spec.semanticKey,
        outcome: resolution.outcome,
        estimatedCostNanoUsd: resolution.estimatedCostNanoUsd,
        reason: resolution.reason ?? '',
      })),
    });
    if (isErr(saved)) return fail(context.io, saved.error, { json });

    if (json) {
      emitJson(context.io, { plan: saved.value, path });
      return EXIT.ok;
    }

    context.io.out();
    for (const line of keyValues([
      ['episode', episodeKey],
      ['style', `${bible.value.id} (${bible.value.checksum.slice(0, 12)})`],
      ['cache hits', String(planned.value.hitCount)],
      ['misses', String(planned.value.missCount)],
      ['estimate', formatUsd(nanoUsd(planned.value.totalEstimatedNanoUsd))],
      ['needs approval', planned.value.requiresConfirmation ? 'yes' : 'no'],
      ['plan written to', path],
    ])) {
      context.io.out(line);
    }
    context.io.out();
    for (const line of table({
      columns: [
        { header: 'outcome' },
        { header: 'semantic key' },
        { header: 'cost', align: 'right' },
        { header: 'why' },
      ],
      indent: '  ',
      rows: planned.value.resolutions.map((resolution) => [
        resolution.outcome,
        resolution.spec.semanticKey,
        formatUsd(nanoUsd(resolution.estimatedCostNanoUsd)),
        (resolution.reason ?? '').slice(0, 70),
      ]),
    })) {
      context.io.out(line);
    }
    context.io.out();
    context.io.err('  Nothing was generated and nothing was written to the library.');
    return EXIT.ok;
  },
};

export const assetsBakeCommand: Command = {
  path: ['assets', 'bake'],
  summary: 'render one clip of one asset into an atlas page you can open',
  usage: [
    'rv assets bake --asset <assetId|semanticKey> --clip <name> [--frames <n>] [--out <dir>]',
    '               [--db <url>] [--store <dir>] [--project <id>] [--json]',
  ],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const assetHandle = option(args, 'asset');
    const clipName = option(args, 'clip');
    if (assetHandle === undefined || clipName === undefined) {
      return usageError(
        context.io,
        'Both --asset and --clip are required, e.g. rv assets bake --asset flora/oak-tree/mature --clip sway',
        json,
      );
    }

    const project = await resolveProject({
      workspaceRoot: context.workspaceRoot,
      explicit: option(args, 'project'),
      env: context.env,
    });
    if (isErr(project)) return fail(context.io, project.error, { json });

    const bible = await readJson(project.value.paths.style, StyleBible, 'style bible');
    if (isErr(bible)) return fail(context.io, bible.error, { json });

    const outDir = option(args, 'out') ?? join(project.value.paths.assetsDir, 'sheets');
    const frames = Number(option(args, 'frames'));
    const location = registryLocation(context.workspaceRoot, context.env, {
      db: option(args, 'db'),
      store: option(args, 'store'),
    });

    const baked = await withRegistry(location, async ({ repository, blobs }) => {
      const asset = await findAsset(repository, assetHandle);
      if (isErr(asset)) return asset;

      const version = currentVersion(asset.value);
      if (version === undefined) {
        return {
          ok: false as const,
          error: new NotFoundError('current asset version', asset.value.id),
        };
      }

      const clip = version.clips.find((candidate) => candidate.name === clipName);
      if (clip === undefined) {
        return {
          ok: false as const,
          error: new NotFoundError('clip', clipName, {
            context: { available: version.clips.map((candidate) => candidate.name) },
          }),
        };
      }

      const ir = await loadIr(blobs, clip.irHash);
      if (isErr(ir)) return ir;

      const images = await loadPartImages(blobs, version.parts);
      if (isErr(images)) return images;

      const sheets = await new BakeSheetUseCase({
        raster: new PngRaster(),
        blobs,
        clock: context.clock,
      }).execute({
        clip,
        ir: ir.value,
        parts: version.parts,
        images: images.value,
        canvas: version.canvas,
        motion: bible.value.motion,
        ...(Number.isInteger(frames) && frames > 0 ? { settings: { frames } } : {}),
      });
      if (isErr(sheets)) return sheets;

      const written: string[] = [];
      for (const [index, page] of sheets.value.pages.entries()) {
        const bytes = await blobs.get(page.atlasImageHash);
        if (isErr(bytes)) return bytes;
        const base = `${sanitise(asset.value.semanticKey)}-${clip.name}-${String(index)}`;
        const imagePath = join(outDir, `${base}.png`);
        const saved = await writeBytes(imagePath, bytes.value);
        if (isErr(saved)) return saved;
        written.push(imagePath);
      }

      return ok({
        assetId: asset.value.id,
        semanticKey: asset.value.semanticKey,
        clip: clip.name,
        frameCount: sheets.value.frameCount,
        pages: sheets.value.pages.map((page) => ({
          sheetId: page.id,
          atlasImageHash: page.atlasImageHash,
          atlasSize: page.atlasSize,
          frameSize: page.frameSize,
          frameCount: page.frameCount,
        })),
        files: written,
      });
    });
    if (isErr(baked)) return fail(context.io, baked.error, { json });

    if (json) {
      emitJson(context.io, baked.value);
      return EXIT.ok;
    }

    context.io.out();
    for (const line of keyValues([
      ['asset', baked.value.semanticKey],
      ['clip', baked.value.clip],
      ['frames', String(baked.value.frameCount)],
      ['pages', String(baked.value.pages.length)],
    ])) {
      context.io.out(line);
    }
    context.io.out();
    for (const file of baked.value.files) context.io.out(`  ${file}`);
    context.io.out();
    return EXIT.ok;
  },
};

/**
 * `rv assets edit` - the one command in the milestone blocks with nothing behind it.
 *
 * Edit-by-instruction is `ImageEditPort` → matte → split → an `AssetVariant` whose
 * `replacedParts` override only what changed, appended to the version that already
 * exists. Every step of that chain is in `@rv/asset-engine` **except the use-case that
 * sequences them**: there is no `EditAssetVariantUseCase`, and `docs/05-remaining-work.md`
 * §W3 lists "Edit-by-instruction produces a variant with the original intact" as open.
 *
 * Writing that sequence here would put engine logic in the delivery layer, where no test
 * in `@rv/asset-engine` would ever cover it and where the studio could not reuse a line
 * of it. So the command validates its arguments, resolves the asset so a typo is still
 * caught, and refuses by name. It costs nothing and it lies about nothing.
 */
export const assetsEditCommand: Command = {
  path: ['assets', 'edit'],
  summary: 'edit an asset by instruction into a new variant (blocked: see the note)',
  usage: [
    'rv assets edit --asset <assetId|semanticKey> --instruction "<what to change>"',
    '               [--lane free|paid] [--yes] [--project <id>] [--json]',
  ],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const assetHandle = option(args, 'asset');
    const instruction = option(args, 'instruction');
    if (assetHandle === undefined || instruction === undefined) {
      return usageError(
        context.io,
        'Both --asset and --instruction are required, e.g. rv assets edit --asset prop/lantern/lit --instruction "make the lantern brighter"',
        json,
      );
    }
    const lane = parseLane(option(args, 'lane'));
    if (lane === undefined) return usageError(context.io, '--lane must be "free" or "paid"', json);

    const project = await resolveProject({
      workspaceRoot: context.workspaceRoot,
      explicit: option(args, 'project'),
      env: context.env,
    });
    if (isErr(project)) return fail(context.io, project.error, { json });

    const location = registryLocation(context.workspaceRoot, context.env, {
      db: option(args, 'db'),
      store: option(args, 'store'),
    });
    const resolved = await withRegistry(location, async ({ repository }) =>
      findAsset(repository, assetHandle),
    );
    if (isErr(resolved)) return fail(context.io, resolved.error, { json });

    const decision = guardSpend(context.io, {
      what: `edit ${resolved.value.semanticKey}`,
      lane,
      estimateNanoUsd: nanoUsd(lane === 'free' ? 0 : 34_000_000),
      approved: flag(args, 'yes'),
      json,
    });
    if (!decision.proceed) return decision.exit;

    return fail(
      context.io,
      new UnsupportedCapabilityError(
        '@rv/asset-engine',
        'edit-asset-by-instruction - the port, the matting and the part splitter all exist; ' +
          'the use-case that sequences them into an AssetVariant does not. See ' +
          'docs/05-remaining-work.md §W3. Nothing was spent and the asset is untouched.',
      ),
      { json, data: { assetId: resolved.value.id, instruction } },
    );
  },
};

// ── shared helpers ──────────────────────────────────────────────────────────

async function findAsset(
  repository: {
    findById(id: AssetId): Promise<Result<Asset | null>>;
    listSearchRecords(): Promise<Result<readonly { assetId: AssetId; semanticKey: string }[]>>;
  },
  handle: string,
): Promise<Result<Asset, AppError>> {
  const byId = await repository.findById(handle);
  if (isErr(byId)) return byId;
  if (byId.value !== null) return ok(byId.value);

  const records = await repository.listSearchRecords();
  if (isErr(records)) return records;
  const match = records.value.find((record) => record.semanticKey === handle);
  if (match === undefined) {
    return {
      ok: false,
      error: new NotFoundError('asset', handle, {
        context: { known: records.value.map((record) => record.semanticKey).slice(0, 40) },
      }),
    };
  }
  const found = await repository.findById(match.assetId);
  if (isErr(found)) return found;
  if (found.value === null) {
    return { ok: false, error: new NotFoundError('asset', match.assetId) };
  }
  return ok(found.value);
}

function currentVersion(asset: Asset): AssetVersion | undefined {
  return asset.versions.find((version) => version.id === asset.currentVersionId);
}

async function loadIr(
  blobs: { get(hash: Sha256Hex): Promise<Result<Uint8Array>> },
  hash: Sha256Hex,
): Promise<Result<AnimationIR, AppError>> {
  const bytes = await blobs.get(hash);
  if (isErr(bytes)) return bytes;
  const parsed = AnimationIRSchema.safeParse(
    JSON.parse(new TextDecoder().decode(bytes.value)) as unknown,
  );
  if (!parsed.success) {
    return {
      ok: false,
      error: new ValidationError({
        message: `the stored IR fragment ${hash} does not validate`,
        context: {
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
      }),
    };
  }
  return ok(parsed.data);
}

async function loadPartImages(
  blobs: { get(hash: Sha256Hex): Promise<Result<Uint8Array>> },
  parts: readonly Part[],
): Promise<Result<ReadonlyMap<Sha256Hex, RgbaImage>, AppError>> {
  const raster = new PngRaster();
  const images = new Map<Sha256Hex, RgbaImage>();
  for (const part of parts) {
    if (images.has(part.imageHash)) continue;
    const bytes = await blobs.get(part.imageHash);
    if (isErr(bytes)) return bytes;
    const decoded = raster.decode({ mimeType: 'image/png', data: bytes.value });
    if (isErr(decoded)) return decoded;
    images.set(part.imageHash, decoded.value);
  }
  return ok(images);
}

// ── the plan file ───────────────────────────────────────────────────────────

/** What `assets plan` leaves behind for `run` and for a human to re-read. */
const PlanFile = z.strictObject({
  episode: z.string(),
  styleBibleId: z.string(),
  styleChecksum: z.string(),
  hitCount: z.number().int().nonnegative(),
  missCount: z.number().int().nonnegative(),
  totalEstimatedNanoUsd: z.number().int().nonnegative(),
  requiresConfirmation: z.boolean(),
  resolutions: z.array(
    z.strictObject({
      key: z.string(),
      semanticKey: z.string(),
      outcome: z.string(),
      estimatedCostNanoUsd: z.number().int().nonnegative(),
      reason: z.string(),
    }),
  ),
});

/** Reused by `rv run` so the plan is read rather than recomputed. */
export type PlanFile = z.infer<typeof PlanFile>;
export { PlanFile as AssetPlanFile };

/** The clip type, re-exported so `run` can name it without reaching into contracts. */
export type { AnimationClip };
