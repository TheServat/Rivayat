/**
 * `rv render`, `rv render resume <runId>` and `rv deliver` - the M4 demo block.
 *
 * The interesting claim of the milestone is "a killed render resumes to a byte-identical
 * result", and it is `RunRenderJobUseCase` that earns it, not this file: the frame index
 * is the only state, so resume is `target \ completed` and the already-written frames
 * are reused rather than redrawn. What the CLI supplies is the two stores that make the
 * frames survive a process death - `FileFrameStore` and `FileCheckpointStore`, both from
 * `@rv/render-engine` - and the run id that lets the second process claim the first
 * one's work. A CLI that minted a fresh job id per invocation would look resumable in a
 * demo and redraw everything in practice.
 *
 * `deliver` re-cuts one master into every platform format and **probes the result**.
 * Step four of `DeliverEpisodeUseCase` is the one that earns its keep: everything before
 * it reasons about intent, and only a probe of the finished bytes catches a file that
 * came out 1920x1080 when the profile says 1080x1920.
 */

import { join, resolve } from 'node:path';

import {
  AnimationIR,
  FORMAT_PRESETS,
  type FormatProfileId,
  type NormRect,
  type RenderCheckpoint,
} from '@rv/contracts';
import {
  DeliverEpisodeUseCase,
  FfmpegEncoder,
  FfprobeReader,
  FileArtifactStore,
  FileCheckpointStore,
  FileFrameStore,
  NodeProcessRunner,
  RunRenderJobUseCase,
  createNapiCanvasBackend,
  deliverySettings,
  masterSettings,
  sampleFocusTrack,
  staticFocusTrack,
  type FocusSample,
  type FrameBackendId,
  type FrameRenderer,
} from '@rv/render-engine';
import { NotFoundError, ValidationError, isErr, toIso } from '@rv/shared-kernel';

import { flag, option, optionList, positional, type ParsedArgs } from '../cli/args';
import type { Command } from '../cli/command';
import type { CliContext } from '../cli/context';
import { EXIT, type ExitCode } from '../cli/exit';
import { emitJson, fail, usageError } from '../cli/report';
import { keyValues, table } from '../cli/text';
import { DOCUMENT_VERSION, RenderDocument } from '../store/documents';
import { readJson, readJsonOrNull, writeJson } from '../store/json-file';
import { animationPath, masterPath, runPaths, sanitise } from '../store/layout';
import { resolveProject, type LoadedProject } from '../store/project';
import { findEpisode, loadStory } from './story';

/** The whole composition, as a normalised rect. Nothing is excluded from a master. */
const FULL_FRAME: NormRect = { x: 0, y: 0, width: 1, height: 1 };

/** Frames the checkpoint has already recorded. Used only for the "complete" flag. */
function countCompleted(checkpoint: RenderCheckpoint): number {
  return checkpoint.completedRanges.reduce(
    (total, range) => total + (range.to - range.from + 1),
    0,
  );
}

/**
 * Where the crop should look.
 *
 * The camera's `focusNodeId` is the one piece of framing intent the IR carries, and
 * following it is the difference between "the 9:16 crop is centred" and "the 9:16 crop
 * follows the bird". Absent, the whole frame is the subject and every format letterboxes
 * or pillarboxes rather than guessing.
 */
function focusTrack(ir: AnimationIR): readonly FocusSample[] {
  const nodeId = ir.camera?.focusNodeId;
  if (nodeId === undefined) return staticFocusTrack(FULL_FRAME);
  return sampleFocusTrack(
    ir,
    nodeId,
    { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    {
      startMs: 0,
      durationMs: ir.durationMs,
    },
  );
}

/** The render document lives beside the run so `resume` can find it from the run id. */
function renderDocPath(project: LoadedProject, runId: string): string {
  return join(runPaths(project.paths, runId).root, 'render.json');
}

function backends(): ReadonlyMap<FrameBackendId, FrameRenderer> {
  // Only the Skia backend is wired here. The Playwright backend needs a browser and a
  // harness page, which is a dev-server concern rather than a headless-driver one; the
  // selector routes to `napi-canvas` for every feature a 2D composition uses.
  return new Map<FrameBackendId, FrameRenderer>([['napi-canvas', createNapiCanvasBackend()]]);
}

interface RenderSetup {
  readonly project: LoadedProject;
  readonly episodeKey: string;
  readonly ir: AnimationIR;
  readonly runId: string;
  readonly width: number;
  readonly height: number;
  readonly master: string;
}

async function setup(
  context: CliContext,
  args: ParsedArgs,
  runIdOverride: string | undefined,
): Promise<
  | { readonly ok: true; readonly value: RenderSetup }
  | { readonly ok: false; readonly error: NotFoundError | ValidationError }
> {
  const project = await resolveProject({
    workspaceRoot: context.workspaceRoot,
    explicit: option(args, 'project'),
    env: context.env,
  });
  if (isErr(project)) {
    return { ok: false, error: new ValidationError({ message: project.error.message }) };
  }

  const irOption = option(args, 'ir');
  const episodeOption = option(args, 'episode');

  let episodeKey = episodeOption ?? 'episode';
  if (episodeOption !== undefined) {
    const story = await loadStory(project.value.paths.story);
    if (story.ok) episodeKey = findEpisode(story.value, episodeOption)?.code ?? episodeOption;
  }

  const irPath =
    irOption === undefined ? animationPath(project.value.paths, episodeKey) : resolve(irOption);
  const ir = await readJson(irPath, AnimationIR, 'animation IR');
  if (isErr(ir)) {
    return {
      ok: false,
      error:
        ir.error.kind === 'not-found'
          ? new NotFoundError('animation IR', irPath, {
              context: { hint: 'S8 writes this; pass one explicitly with --ir <file>' },
            })
          : new ValidationError({ message: ir.error.message, context: ir.error.context }),
    };
  }

  const width = Number(option(args, 'width') ?? ir.value.sceneSpace.width);
  const height = Number(option(args, 'height') ?? ir.value.sceneSpace.height);

  return {
    ok: true,
    value: {
      project: project.value,
      episodeKey,
      ir: ir.value,
      runId: runIdOverride ?? context.ids.run(),
      width,
      height,
      master: option(args, 'out') ?? masterPath(project.value.paths, episodeKey),
    },
  };
}

async function renderWith(
  context: CliContext,
  args: ParsedArgs,
  prepared: RenderSetup,
  json: boolean,
): Promise<ExitCode> {
  const paths = runPaths(prepared.project.paths, prepared.runId);
  const encoder = new FfmpegEncoder(new NodeProcessRunner(), {
    ffmpeg: context.env.RV_FFMPEG_PATH ?? 'ffmpeg',
    ffprobe: context.env.RV_FFPROBE_PATH ?? 'ffprobe',
  });

  const available = await encoder.probeAvailable();
  if (isErr(available)) return fail(context.io, available.error, { json });

  const job = new RunRenderJobUseCase({
    renderers: backends(),
    frames: new FileFrameStore(paths.framesDir),
    checkpoints: new FileCheckpointStore(paths.checkpoints),
    encoder,
    clock: context.clock,
  });

  context.io.err(
    `  rendering ${prepared.ir.name} at ${String(prepared.width)}x${String(prepared.height)} ` +
      `into run ${prepared.runId}`,
  );

  const outcome = await job.execute({
    // The job id *is* the run id: the checkpoint is keyed on it, so a resume that minted
    // a new one would find no checkpoint and silently redraw every frame.
    jobId: prepared.runId,
    ir: prepared.ir,
    size: { width: prepared.width, height: prepared.height },
    backend: 'auto',
    frames: null,
    master: {
      outputPath: resolve(prepared.master),
      settings: masterSettings({ fps: prepared.ir.fps, codec: 'h264' }),
    },
    // Kept, because `render resume` reuses them rather than redrawing, and because the
    // byte-identity claim is only checkable if the second run consumed the same bytes.
    keepFrames: true,
    checkpointEvery: 1,
  });
  if (isErr(outcome)) return fail(context.io, outcome.error, { json });

  const document = await writeJson(
    renderDocPath(prepared.project, prepared.runId),
    RenderDocument,
    {
      version: DOCUMENT_VERSION,
      runId: prepared.runId,
      projectId: prepared.project.record.id,
      episodeId: prepared.episodeKey,
      animationId: prepared.ir.id,
      width: prepared.width,
      height: prepared.height,
      framesTotal: outcome.value.framesTotal,
      framesRendered: outcome.value.framesRendered,
      frameStreamHash: outcome.value.frameStreamHash,
      masterPath: outcome.value.masterPath,
      complete: countCompleted(outcome.value.checkpoint) >= outcome.value.framesTotal,
      updatedAt: toIso(context.clock.now()),
    },
  );
  if (isErr(document)) return fail(context.io, document.error, { json });

  if (json) {
    emitJson(context.io, { render: document.value, backend: outcome.value.backend });
    return EXIT.ok;
  }

  context.io.out();
  for (const line of keyValues([
    ['run', prepared.runId],
    ['backend', outcome.value.backend],
    ['frames drawn', String(outcome.value.framesRendered)],
    ['frames total', String(outcome.value.framesTotal)],
    ['frame stream hash', outcome.value.frameStreamHash],
    ['master', outcome.value.masterPath ?? '(frames only)'],
  ])) {
    context.io.out(line);
  }
  context.io.out();
  context.io.out(`  Resume this run with: rv render resume ${prepared.runId}`);
  context.io.out();
  return EXIT.ok;
}

export const renderCommand: Command = {
  path: ['render'],
  summary: 'draw every frame of an episode and encode the master',
  usage: [
    'rv render [--episode <E01>] [--ir <file.rvanim.json>] [--width <px>] [--height <px>]',
    '          [--out <file.mp4>] [--project <id>] [--json]',
    '  Frames are kept, so a killed render resumes rather than restarts.',
  ],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    // `render resume` is a separate command; without this guard `rv render resume x`
    // would fall through to a full render with `resume` as a stray positional.
    if (positional(args, 0) !== undefined) {
      return usageError(
        context.io,
        `rv render takes no positional arguments; did you mean "rv render resume ${positional(args, 0) ?? ''}"?`,
        json,
      );
    }
    const prepared = await setup(context, args, undefined);
    if (!prepared.ok) return fail(context.io, prepared.error, { json });
    return renderWith(context, args, prepared.value, json);
  },
};

export const renderResumeCommand: Command = {
  path: ['render', 'resume'],
  summary: 'finish a killed render from its checkpoint; the output hash must match',
  usage: ['rv render resume <runId> [--project <id>] [--json]'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const runId = positional(args, 0);
    if (runId === undefined) {
      return usageError(context.io, 'Which run? e.g. rv render resume run_01J…', json);
    }

    const prepared = await setup(context, args, runId);
    if (!prepared.ok) return fail(context.io, prepared.error, { json });

    // The previous attempt's record, so the resume can report whether the frame stream
    // came out identical - which is the whole point of the milestone's kill test.
    const before = await readJsonOrNull(
      renderDocPath(prepared.value.project, runId),
      RenderDocument,
      'render',
    );
    const previousHash = before.ok && before.value !== null ? before.value.frameStreamHash : null;

    const code = await renderWith(context, args, prepared.value, json);
    if (code !== EXIT.ok || json) return code;

    const after = await readJsonOrNull(
      renderDocPath(prepared.value.project, runId),
      RenderDocument,
      'render',
    );
    if (after.ok && after.value !== null && previousHash !== null) {
      context.io.out(
        after.value.frameStreamHash === previousHash
          ? `  frame stream hash unchanged: ${previousHash}`
          : `  frame stream hash CHANGED: ${previousHash} -> ${after.value.frameStreamHash}`,
      );
      context.io.out();
      if (after.value.frameStreamHash !== previousHash) return EXIT.findings;
    }
    return EXIT.ok;
  },
};

export const deliverCommand: Command = {
  path: ['deliver'],
  summary: 'cut one master into every platform format, then probe each against its spec',
  usage: [
    'rv deliver --episode <E01> [--all | --format <id> ...] [--master <file>] [--out <dir>]',
    '           [--project <id>] [--json]',
    `  formats: ${Object.keys(FORMAT_PRESETS).join(', ')}`,
  ],
  booleans: ['all'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const episode = option(args, 'episode');
    if (episode === undefined) {
      return usageError(context.io, 'Which episode? e.g. rv deliver --episode E01 --all', json);
    }

    const project = await resolveProject({
      workspaceRoot: context.workspaceRoot,
      explicit: option(args, 'project'),
      env: context.env,
    });
    if (isErr(project)) return fail(context.io, project.error, { json });

    const story = await loadStory(project.value.paths.story);
    const episodeKey = story.ok ? (findEpisode(story.value, episode)?.code ?? episode) : episode;

    const requested = flag(args, 'all')
      ? (Object.keys(FORMAT_PRESETS) as FormatProfileId[])
      : (optionList(args, 'format') as FormatProfileId[]);
    if (requested.length === 0) {
      return usageError(
        context.io,
        `Pick formats with --all or --format <id>. Available: ${Object.keys(FORMAT_PRESETS).join(', ')}`,
        json,
      );
    }
    const unknown = requested.filter((id) => !(id in FORMAT_PRESETS));
    if (unknown.length > 0) {
      return usageError(context.io, `unknown format(s): ${unknown.join(', ')}`, json);
    }

    const irPath = option(args, 'ir') ?? animationPath(project.value.paths, episodeKey);
    const ir = await readJson(irPath, AnimationIR, 'animation IR');
    if (isErr(ir)) return fail(context.io, ir.error, { json });

    const master = option(args, 'master') ?? masterPath(project.value.paths, episodeKey);
    const outDir =
      option(args, 'out') ?? join(project.value.paths.deliverDir, sanitise(episodeKey));

    // The artefact store is rooted at the workspace and every path it is handed is
    // relative to that root, which is what stops a delivery writing into the repository.
    const artifacts = new FileArtifactStore(context.workspaceRoot);
    const encoder = new FfmpegEncoder(new NodeProcessRunner(), {
      ffmpeg: context.env.RV_FFMPEG_PATH ?? 'ffmpeg',
      ffprobe: context.env.RV_FFPROBE_PATH ?? 'ffprobe',
    });
    const available = await encoder.probeAvailable();
    if (isErr(available)) return fail(context.io, available.error, { json });

    const frameCount = Math.max(1, Math.round((ir.value.durationMs / 1000) * ir.value.fps));
    const delivered = await new DeliverEpisodeUseCase({
      encoder,
      prober: new FfprobeReader(new NodeProcessRunner(), {
        ffmpeg: context.env.RV_FFMPEG_PATH ?? 'ffmpeg',
        ffprobe: context.env.RV_FFPROBE_PATH ?? 'ffprobe',
      }),
      artifacts,
      clock: context.clock,
    }).execute({
      masterPath: relativeToWorkspace(context.workspaceRoot, master),
      masterSize: ir.value.sceneSpace,
      animationId: ir.value.id,
      frameCount,
      outputDir: relativeToWorkspace(context.workspaceRoot, outDir),
      formats: requested,
      // One shot spanning the whole timeline. S7 cuts a real shot list; until the CLI
      // runs S7 the honest framing of a single composition is "all of it", and the
      // focus track still follows the camera's own focus node so the 9:16 crop moves.
      reframe: {
        composition: ir.value.sceneSpace,
        shots: [
          {
            shotId: 'whole',
            startMs: 0,
            durationMs: ir.value.durationMs,
            safeArea: FULL_FRAME,
            focus: focusTrack(ir.value),
            priority: 'must-keep',
          },
        ],
      },
      timings: [{ shotId: 'whole', startMs: 0, durationMs: ir.value.durationMs }],
      encodeOverrides: Object.fromEntries(
        requested.map((id) => [id, deliverySettings(FORMAT_PRESETS[id], { gopSeconds: 2 })]),
      ),
    });
    if (isErr(delivered)) return fail(context.io, delivered.error, { json });

    const withIssues = delivered.value.manifest.entries.filter((entry) => entry.issues.length > 0);

    if (json) {
      emitJson(context.io, {
        manifest: delivered.value.manifest,
        manifestPath: delivered.value.manifestPath,
        inSpec: delivered.value.manifest.entries.length - withIssues.length,
        outOfSpec: withIssues.length,
      });
      return withIssues.length > 0 ? EXIT.findings : EXIT.ok;
    }

    context.io.out();
    for (const line of table({
      columns: [
        { header: 'format' },
        { header: 'size' },
        { header: 'file' },
        { header: 'issues', align: 'right' },
      ],
      indent: '  ',
      rows: delivered.value.manifest.entries.map((entry) => [
        entry.format,
        `${String(entry.artifact.size.width)}x${String(entry.artifact.size.height)}`,
        entry.artifact.path,
        String(entry.issues.length),
      ]),
    })) {
      context.io.out(line);
    }
    context.io.out();
    context.io.out(`  manifest: ${delivered.value.manifestPath}`);
    for (const entry of withIssues) {
      for (const issue of entry.issues) {
        context.io.err(
          `  ${entry.format}: ${issue.code} (${issue.severity}) - ${issue.message}` +
            ` [expected ${String(issue.expected)}, got ${String(issue.actual)}]`,
        );
      }
    }
    context.io.out();
    return withIssues.length > 0 ? EXIT.findings : EXIT.ok;
  },
};

/** The artefact store addresses everything relative to the workspace root. */
function relativeToWorkspace(root: string, path: string): string {
  const absolute = resolve(path);
  const base = resolve(root);
  return absolute.startsWith(base)
    ? absolute.slice(base.length).replaceAll('\\', '/').replace(/^\/+/, '')
    : absolute.replaceAll('\\', '/');
}
