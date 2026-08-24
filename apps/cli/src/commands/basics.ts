/**
 * The four commands that existed before the registry, given a registry entry each.
 *
 * `doctor`, `character`, `animate` and `assets produce` were dispatched by a chain of
 * `if`s in `main.ts`. Wrapping them as `Command`s rather than leaving the chain in
 * place buys three things at once: `--json` on all of them, an exit code that comes
 * from the same table as everything else, and a spec that can drive them through a
 * `BufferIo` instead of capturing the process's stdout.
 *
 * The implementations underneath are unchanged, with one exception this file is
 * responsible for: `assets produce` now claims a **persistent run id** through
 * `resolveRunId`. Produce checkpoints live in SQLite behind
 * `DrizzleProduceCheckpointRepository` and are keyed on `(runId, assetKey, step,
 * attempt)`, so a command that minted a fresh id per invocation would store checkpoints
 * nothing would ever read again - resumable on paper, regenerating in practice.
 */

import { relative, resolve } from 'node:path';

import { Ids } from '@rv/contracts';
import { OllamaAdapter } from '@rv/providers';
import { MemoryLogger, isErr } from '@rv/shared-kernel';

import { flag, option, positional, type ParsedArgs } from '../cli/args';
import type { Command } from '../cli/command';
import type { CliContext } from '../cli/context';
import { EXIT, type ExitCode } from '../cli/exit';
import { emitJson, emitJsonFailure, usageError } from '../cli/report';
import { buildGroveScene, renderScene } from './animate';
import { generateCharacter, renderTrace } from './character';
import { doctor, renderChecks } from './doctor';
import {
  assertWorkflowsPresent,
  defaultOptions,
  produceDemo,
  renderProduceReport,
  resolveRunId,
} from './produce';

export const doctorCommand: Command = {
  path: ['doctor'],
  summary: 'what is available on this machine, and which lane that opens',
  usage: ['rv doctor [--json]'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const checks = await doctor(context.env);
    // Ollama and FFmpeg are the two the free lane cannot open without. ComfyUI is
    // optional - the cloud image lane works without it - and the keys are optional by
    // definition on a machine that only ever runs free.
    const blocking = checks.filter(
      (check) => !check.ok && ['Ollama', 'FFmpeg'].includes(check.name),
    );

    if (json) {
      emitJson(context.io, { checks, blocking: blocking.map((check) => check.name) });
      return blocking.length > 0 ? EXIT.failed : EXIT.ok;
    }

    context.io.out();
    context.io.out(renderChecks(checks));
    context.io.out();
    if (blocking.length > 0) {
      context.io.err(
        `  Missing something the local lane needs: ${blocking.map((check) => check.name).join(', ')}`,
      );
      return EXIT.failed;
    }
    return EXIT.ok;
  },
};

export const characterCommand: Command = {
  path: ['character'],
  summary: 'a validated character sheet from the local model',
  usage: [
    'rv character "<premise>" [--full] [--model <id>] [--json]',
    '  --full    ask for the whole CharacterPayload, not the CHIRON core',
    '  --model   default: $RV_OLLAMA_TEXT_MODEL or qwen3.5:latest',
  ],
  booleans: ['full'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const idea = positional(args, 0);
    if (idea === undefined) {
      return usageError(
        context.io,
        'Give me a premise, e.g. rv character "a lighthouse keeper who never sleeps"',
        json,
      );
    }

    const model = option(args, 'model') ?? context.env.RV_OLLAMA_TEXT_MODEL ?? 'qwen3.5:latest';
    const backend = new OllamaAdapter({
      model,
      ...(context.env.OLLAMA_HOST === undefined ? {} : { baseUrl: context.env.OLLAMA_HOST }),
      timeoutMs: 300_000,
    });

    context.io.err(`  Asking ${model} for a character. Local, free, no network beyond localhost.`);
    const outcome = await generateCharacter({
      idea,
      backends: [backend],
      full: flag(args, 'full'),
      logger: new MemoryLogger(),
    });

    if (!outcome.ok) {
      if (json) emitJsonFailure(context.io, new Error(outcome.error), { trace: outcome.trace });
      else {
        context.io.err(`  Could not produce a valid character sheet: ${outcome.error}`);
        context.io.err(`  ${renderTrace(outcome.trace)}`);
      }
      return EXIT.failed;
    }

    if (json) {
      emitJson(context.io, { character: outcome.result.value, trace: outcome.result.trace });
      return EXIT.ok;
    }

    context.io.out(JSON.stringify(outcome.result.value, null, 2));
    context.io.out();
    context.io.out('  --- how it went ---');
    context.io.out(`  ${renderTrace(outcome.result.trace)}`);
    context.io.out();
    return EXIT.ok;
  },
};

export const animateCommand: Command = {
  path: ['animate'],
  summary: 'render the grove scene to MP4 in 16:9 and 9:16 from one composition',
  usage: ['rv animate [--out <dir>] [--json]'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const outDir = resolve(option(args, 'out') ?? 'workspace/demo');
    const ffmpegPath = context.env.RV_FFMPEG_PATH ?? 'ffmpeg';
    const { ir, focusNodeName } = buildGroveScene();

    const targets = [
      { label: 'youtube 16:9', file: 'grove-16x9.mp4', width: 1280, height: 720 },
      { label: 'shorts 9:16', file: 'grove-9x16.mp4', width: 720, height: 1280 },
    ];

    context.io.err(
      `  One authored scene, ${String(ir.nodes.length)} nodes, ` +
        `${String(ir.behaviours.length)} procedural behaviours, no generated frames.`,
    );

    const rendered: { label: string; path: string; frames: number; elapsedMs: number }[] = [];
    for (const target of targets) {
      const outPath = resolve(outDir, target.file);
      const stats = await renderScene(ir, focusNodeName, {
        outPath,
        target: { width: target.width, height: target.height },
        ffmpegPath,
        clock: context.clock,
      });
      rendered.push({
        label: target.label,
        path: outPath,
        frames: stats.frames,
        elapsedMs: stats.elapsedMs,
      });
    }

    if (json) {
      emitJson(context.io, { outputs: rendered });
      return EXIT.ok;
    }

    context.io.out();
    for (const output of rendered) {
      context.io.out(
        `  ${output.label.padEnd(14)} ${String(output.frames)} frames in ` +
          `${String(output.elapsedMs)} ms -> ${relative(context.cwd, output.path)}`,
      );
    }
    context.io.out();
    context.io.out('  Both files come from the same IR. The 9:16 crop follows the bird.');
    context.io.out();
    return EXIT.ok;
  },
};

export const assetsProduceCommand: Command = {
  path: ['assets', 'produce'],
  summary:
    'S6 for real: resolve, generate on the local GPU, matte, split, rig, clip, bake, register',
  usage: [
    'rv assets produce [--out <dir>] [--steps <n>] [--concurrency <n>] [--frames <n>]',
    '                  [--host <url>] [--run <runId>] [--fresh] [--json]',
    '  --run     resume a specific run; defaults to the last one this workspace started',
    '  --fresh   claim a new run id, so every step re-runs instead of resuming',
  ],
  booleans: ['fresh'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const ids = new Ids();
    const base = defaultOptions(context.env, context.clock, ids.run());
    const fresh = flag(args, 'fresh');

    // The run id has to survive the process, or nothing resumes. Produce checkpoints are
    // keyed on `(runId, assetKey, step, attempt)` now that `DrizzleProduceCheckpointRepository`
    // stores them, so a command that minted a fresh id every invocation would look
    // resumable and regenerate everything. `--fresh` is the deliberate opt-out and works
    // by claiming a *new* run rather than by ignoring the store.
    const options = {
      ...base,
      runId: await resolveRunId(base.workspaceDir, {
        fresh,
        explicit: option(args, 'run'),
        ids,
      }),
      outDir: resolve(option(args, 'out') ?? base.outDir),
      comfyHost: option(args, 'host') ?? base.comfyHost,
      steps: Number(option(args, 'steps') ?? base.steps),
      concurrency: Number(option(args, 'concurrency') ?? base.concurrency),
      bakeFrames: Number(option(args, 'frames') ?? base.bakeFrames),
      fresh,
    };

    const workflows = await assertWorkflowsPresent(options.workflowDir);
    if (isErr(workflows)) {
      if (json) emitJsonFailure(context.io, workflows.error);
      else context.io.err(`  ${workflows.error.message}`);
      return EXIT.failed;
    }

    context.io.err(
      `  S6 Produce on the local lane: ${options.comfyHost}, ${String(options.steps)} steps, ` +
        `concurrency ${String(options.concurrency)}, run ${options.runId}.`,
    );

    const startedAt = context.clock.now();
    const report = await produceDemo({
      ...options,
      onProgress: (event) => {
        context.io.err(
          `  ${((context.clock.now() - startedAt) / 1000).toFixed(1).padStart(6)}s  ` +
            `${event.semanticKey.padEnd(26)} ${event.step.padEnd(9)} ${event.phase.padEnd(7)} ` +
            `${String(event.durationMs).padStart(6)} ms${event.detail === undefined ? '' : `  ${event.detail}`}`,
        );
      },
    });

    if (isErr(report)) {
      if (json) emitJsonFailure(context.io, report.error);
      else context.io.err(`  produce failed: ${report.error.code} ${report.error.message}`);
      return EXIT.failed;
    }

    if (json) {
      emitJson(context.io, report.value);
      return report.value.failed.length > 0 ? EXIT.failed : EXIT.ok;
    }

    context.io.out(renderProduceReport(report.value, options.outDir));
    return report.value.failed.length > 0 ? EXIT.failed : EXIT.ok;
  },
};
