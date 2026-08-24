/**
 * `rv style list | probe | lock` - the M1 demo, top to bottom.
 *
 * The order in the demo block looks odd until you read
 * `GenerateStyleProbeUseCase`'s header: a probe **is** an image generation, and
 * `assertUsableForGeneration` is the single guard in front of every one of those, so a
 * style must be locked before it can be probed. The flow is therefore
 * materialise → lock → probe → *approve*, and `rv style lock --style <id>` is the
 * approval: it promotes a probed candidate to the project's style and freezes its
 * checksum into every asset key from then on.
 *
 * Nothing here computes a checksum, decides what a preset is, or writes prompt text.
 * `@rv/style-engine` compiles the prompts from the structured fields and
 * `@rv/core-domain` owns the lock; this file is the wiring plus the terminal.
 */

import { StyleBible, type Slug } from '@rv/contracts';
import { isLocked, lock } from '@rv/core-domain';
import {
  GenerateStyleProbeUseCase,
  STYLE_PRESETS,
  findPreset,
  materialiseStyleBible,
  type StyleProbeSheet,
} from '@rv/style-engine';
import {
  NotFoundError,
  ValidationError,
  formatUsd,
  isErr,
  nanoUsd,
  ok,
  toIso,
} from '@rv/shared-kernel';
import { join } from 'node:path';

import { buildImageLanes } from '../adapters/lanes';
import { flag, option, type ParsedArgs } from '../cli/args';
import type { Command } from '../cli/command';
import type { CliContext } from '../cli/context';
import { EXIT, type ExitCode } from '../cli/exit';
import { emitJson, fail, usageError } from '../cli/report';
import { guardSpend, parseLane } from '../cli/spend';
import { keyValues, table } from '../cli/text';
import { readJson, writeBytes, writeJson } from '../store/json-file';
import { resolveProject, saveProject } from '../store/project';

export const styleListCommand: Command = {
  path: ['style', 'list'],
  summary: 'the preset library',
  usage: ['rv style list [--json]'],
  run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    if (json) {
      emitJson(context.io, {
        presets: STYLE_PRESETS.map((preset) => ({
          id: preset.id,
          medium: preset.medium,
          name: preset.name,
          description: preset.description,
        })),
      });
      return Promise.resolve(EXIT.ok);
    }

    context.io.out();
    for (const line of table({
      columns: [{ header: 'id' }, { header: 'medium' }, { header: 'name (en)' }],
      indent: '  ',
      rows: STYLE_PRESETS.map((preset) => [
        preset.id,
        preset.medium,
        preset.name.en ?? preset.name.fa,
      ]),
    })) {
      context.io.out(line);
    }
    context.io.out();
    // Persian on its own lines rather than in a column: a right-to-left cell inside a
    // left-to-right table reorders visually in a bidi-aware terminal, and the fix
    // (U+2068/U+2069 isolates) is drawn as visible boxes on the terminals we checked.
    for (const preset of STYLE_PRESETS) {
      context.io.out(`  ${preset.id}: ${preset.name.fa}`);
    }
    context.io.out();
    return Promise.resolve(EXIT.ok);
  },
};

export const styleProbeCommand: Command = {
  path: ['style', 'probe'],
  summary: 'four tiles from one preset, so a human can say yes before anything is spent',
  usage: [
    'rv style probe --preset <id> [--lane free|paid] [--yes] [--project <id>] [--json]',
    '  --lane free   (default) the local ComfyUI lane; provably $0',
    '  --lane paid   requires --yes; prints the estimate first either way',
  ],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const presetId = option(args, 'preset');
    if (presetId === undefined) {
      return usageError(context.io, 'Which preset? e.g. rv style probe --preset ink-comic', json);
    }
    const lane = parseLane(option(args, 'lane'));
    if (lane === undefined) {
      return usageError(context.io, '--lane must be "free" or "paid"', json);
    }

    const project = await resolveProject({
      workspaceRoot: context.workspaceRoot,
      explicit: option(args, 'project'),
      env: context.env,
    });
    if (isErr(project)) return fail(context.io, project.error, { json });

    const preset = findPreset(presetId);
    if (isErr(preset)) return fail(context.io, preset.error, { json });

    // The guard runs before anything is written, not just before anything is spent. A
    // refused probe that had already minted and stored a candidate bible would leave a
    // style id in the project that no probe sheet exists for.
    //
    // The free lane's estimate is not a guess: ComfyUI runs on hardware we already own,
    // so the ledger records four zeroes and the guard prints $0.0000 before the call.
    const decision = guardSpend(context.io, {
      what: `probe sheet for ${presetId} (4 tiles)`,
      lane,
      estimateNanoUsd: nanoUsd(lane === 'free' ? 0 : 4 * 34_000_000),
      approved: flag(args, 'yes'),
      json,
    });
    if (!decision.proceed) return decision.exit;

    // Locked before it is drawn, exactly as `assertUsableForGeneration` requires. This
    // is not the *approval* - that is `style lock` - it is the freeze that makes the
    // checksum a stable component of every dedup key the probe's images are stored under.
    const materialised = materialiseStyleBible({
      draft: preset.value.draft,
      id: context.ids.styleBible(),
      clock: context.clock,
    });
    const locked = lock(materialised, toIso(context.clock.now()));
    if (isErr(locked)) return fail(context.io, locked.error, { json });

    const candidatePath = join(project.value.paths.stylesDir, `${locked.value.id}.json`);
    const stored = await writeJson(candidatePath, StyleBible, locked.value);
    if (isErr(stored)) return fail(context.io, stored.error, { json });

    const built = await buildImageLanes({
      env: context.env,
      cwd: context.cwd,
      clock: context.clock,
    });
    if (isErr(built)) return fail(context.io, built.error, { json });

    const port = built.value.lanes[lane];
    if (port === undefined) {
      return fail(
        context.io,
        new ValidationError({
          message:
            `The "${lane}" image lane is not available on this machine: ` +
            `${built.value.unavailable[lane] ?? 'no adapter wired'}`,
          context: { lane, unavailable: built.value.unavailable },
        }),
        { json },
      );
    }

    const probe = new GenerateStyleProbeUseCase({
      imageLanes: { [lane]: port },
      clock: context.clock,
    });
    const sheet = await probe.execute({ bible: locked.value, lane });
    if (isErr(sheet)) return fail(context.io, sheet.error, { json });

    const written = await writeTiles(project.value.paths.probeDir, sheet.value);
    if (isErr(written)) return fail(context.io, written.error, { json });

    if (json) {
      emitJson(context.io, {
        styleBibleId: sheet.value.styleBibleId,
        checksum: sheet.value.styleChecksum,
        lane: sheet.value.lane,
        totalCostNanoUsd: sheet.value.totalCostNanoUsd,
        costIsComplete: sheet.value.costIsComplete,
        candidatePath,
        tiles: sheet.value.tiles.map((tile, index) => ({
          subject: tile.subject.key,
          seed: tile.seed,
          modelRef: tile.modelRef,
          costNanoUsd: tile.costNanoUsd,
          path: written.value[index] ?? null,
        })),
      });
      return EXIT.ok;
    }

    context.io.out();
    for (const line of keyValues([
      ['style', sheet.value.styleBibleId],
      ['checksum', sheet.value.styleChecksum],
      ['lane', sheet.value.lane],
      [
        'cost',
        `${formatUsd(sheet.value.totalCostNanoUsd)}${sheet.value.costIsComplete ? '' : ' (incomplete: a model was not in the price catalogue)'}`,
      ],
    ])) {
      context.io.out(line);
    }
    context.io.out();
    for (const path of written.value) context.io.out(`  ${path}`);
    context.io.out();
    context.io.out(`  Approve it with: rv style lock --style ${sheet.value.styleBibleId}`);
    context.io.out();
    return EXIT.ok;
  },
};

export const styleLockCommand: Command = {
  path: ['style', 'lock'],
  summary: 'approve a probed candidate: freeze its checksum onto the project',
  usage: ['rv style lock --style <styleBibleId> [--project <id>] [--json]'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const styleId = option(args, 'style');
    if (styleId === undefined) {
      return usageError(context.io, 'Which style? e.g. rv style lock --style sty_01J…', json);
    }

    const project = await resolveProject({
      workspaceRoot: context.workspaceRoot,
      explicit: option(args, 'project'),
      env: context.env,
    });
    if (isErr(project)) return fail(context.io, project.error, { json });

    const candidatePath = join(project.value.paths.stylesDir, `${styleId}.json`);
    const candidate = await readJson(candidatePath, StyleBible, 'style bible');
    if (isErr(candidate)) {
      return fail(
        context.io,
        candidate.error.kind === 'not-found'
          ? new NotFoundError('style bible', styleId, {
              context: { hint: 'probe one first: rv style probe --preset <id>' },
            })
          : candidate.error,
        { json },
      );
    }

    // Idempotent: probing already locked it, so re-locking would fail the state check.
    // Approval is about which bible the *project* uses, not about locking twice.
    const resolved = isLocked(candidate.value)
      ? ok(candidate.value)
      : lock(candidate.value, toIso(context.clock.now()));
    if (isErr(resolved)) return fail(context.io, resolved.error, { json });

    const persisted = await writeJson(project.value.paths.style, StyleBible, resolved.value);
    if (isErr(persisted)) return fail(context.io, persisted.error, { json });

    const updated = await saveProject(
      project.value,
      { styleBibleId: resolved.value.id },
      context.clock,
    );
    if (isErr(updated)) return fail(context.io, updated.error, { json });

    if (json) {
      emitJson(context.io, {
        projectId: project.value.record.id,
        styleBibleId: resolved.value.id,
        checksum: resolved.value.checksum,
        lockedAt: resolved.value.lockedAt,
        path: project.value.paths.style,
      });
      return EXIT.ok;
    }

    context.io.out();
    for (const line of keyValues([
      ['project', project.value.record.id],
      ['style', resolved.value.id],
      ['checksum', resolved.value.checksum],
      ['locked at', resolved.value.lockedAt ?? '(already locked)'],
    ])) {
      context.io.out(line);
    }
    context.io.out();
    return EXIT.ok;
  },
};

/** Writes each tile as `probe-<checksum>-<subject>.png` and returns the paths. */
async function writeTiles(
  directory: string,
  sheet: StyleProbeSheet,
): Promise<{ ok: true; value: readonly string[] } | { ok: false; error: ValidationError }> {
  const paths: string[] = [];
  for (const tile of sheet.tiles) {
    const path = join(
      directory,
      `probe-${sheet.styleChecksum.slice(0, 12)}-${tile.subject.key}.png`,
    );
    const written = await writeBytes(path, tile.image.data);
    if (isErr(written)) {
      return {
        ok: false,
        error: new ValidationError({ message: written.error.message, cause: written.error }),
      };
    }
    paths.push(path);
  }
  return { ok: true, value: paths };
}

/** Presets, as slugs, for the help text and for `run` to validate against. */
export function presetSlugs(): readonly Slug[] {
  return STYLE_PRESETS.map((preset) => preset.id);
}
