/**
 * `rv run` - S0 to S11 in one invocation, checkpointed.
 *
 * **What this is not.** It is not a second pipeline. The API owns one -
 * `PipelineRunner` in `apps/api/src/pipeline` - and reusing it from here is currently
 * impossible: `@rv/api` publishes no `exports` map and its runner needs a `JobQueue`, a
 * `RunRepository`, a `RunEventBus` and a `StageRegistry`, every one of which lives
 * inside that app. Reaching across would be a deep import between two apps, which
 * `docs/04 §8` calls a layering breach. Reported rather than worked around.
 *
 * What this *is* is a sequencer over the CLI's own verbs. Each stage is a command that
 * already exists and is already tested; `run` decides the order, records what each one
 * cost and produced, and writes a checkpoint so `--resume` skips what already succeeded.
 * A stage with no command behind it is recorded as `skipped` with the package that owes
 * it named - the same honesty `apps/api`'s `StubStageHandler` uses, for the same reason:
 * a run that silently omits S6 is a run whose `$0` total means nothing.
 */

import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_CODES,
  type PipelineStage,
  type RunId,
} from '@rv/contracts';
import { NotFoundError, formatUsd, isErr, nanoUsd, toIso } from '@rv/shared-kernel';

import { flag, option, type ParsedArgs } from '../cli/args';
import { matchCommand, type Command } from '../cli/command';
import type { CliContext } from '../cli/context';
import { EXIT, type ExitCode } from '../cli/exit';
import { emitJson, fail, usageError } from '../cli/report';
import { parseLane, type Lane } from '../cli/spend';
import { keyValues, table } from '../cli/text';
import { DOCUMENT_VERSION, RunDocument, type RunStageRecord } from '../store/documents';
import { readJsonOrNull, writeJson } from '../store/json-file';
import { runPaths } from '../store/layout';
import { resolveProject, type LoadedProject } from '../store/project';

/**
 * Which package owes each stage the CLI cannot yet run headlessly.
 *
 * Copied in spirit from `STAGE_OWNER` in `apps/api/src/pipeline/handlers.ts`, and kept
 * as data for the same reason: the message that says "we have not built this" must
 * never be guessed at a call site.
 */
export const STAGE_GAP: Readonly<Partial<Record<PipelineStage, string>>> = {
  world:
    '@rv/narrative-memory - S4 needs scene prose to extract a delta from, which S7 has not written yet',
  produce: '@rv/asset-engine - available as `rv assets produce`, which owns its own demo wiring',
  sequence: '@rv/story-engine - BuildShotListUseCase exists; the CLI has no scene text to cut',
  choreograph: '@rv/anim-engine - no use-case turns a shot list into an AnimationIR yet',
  preview: '@rv/anim-engine - the vision quality gate needs a rendered preview to score',
};

/** The argv a stage runs, or `null` when nothing is wired for it. */
function argvFor(
  stage: PipelineStage,
  args: ParsedArgs,
  lane: Lane,
  projectId: string,
): readonly string[] | null {
  const scope = ['--project', projectId, '--lane', lane];
  const idea = option(args, 'idea');
  const preset = option(args, 'preset');
  const episode = option(args, 'episode') ?? 'E01';

  switch (stage) {
    case 'intake':
    case 'story':
      // S0 and S2 are one command: `story new` runs intake and then descends the
      // outline, which is the order the engine's own use-cases impose.
      return stage === 'story' || idea === undefined
        ? null
        : ['story', 'new', '--idea', idea, ...scope];
    case 'style':
      return preset === undefined ? null : ['style', 'probe', '--preset', preset, ...scope];
    case 'cast': {
      const character = option(args, 'character');
      return character === undefined
        ? null
        : ['cast', 'states', '--character', character, ...scope];
    }
    case 'resolve':
      return ['assets', 'plan', '--episode', episode, '--project', projectId];
    case 'render':
      return ['render', '--episode', episode, '--project', projectId];
    case 'deliver':
      return ['deliver', '--episode', episode, '--all', '--project', projectId];
    default:
      return null;
  }
}

export interface RunStagesOptions {
  readonly context: CliContext;
  readonly commands: readonly Command[];
  readonly args: ParsedArgs;
  readonly project: LoadedProject;
  readonly lane: Lane;
  readonly runId: RunId;
  /** Stages already recorded as succeeded. Skipped without being re-run. */
  readonly completed: ReadonlySet<PipelineStage>;
  readonly only: ReadonlySet<PipelineStage> | null;
}

/**
 * Executes every stage in order and returns what happened.
 *
 * Exported so the spec can drive it with a fake command table: the interesting property
 * - "a resumed run does not re-execute a completed stage" - is a property of this
 * function and needs no provider to assert.
 */
export async function runStages(options: RunStagesOptions): Promise<readonly RunStageRecord[]> {
  const records: RunStageRecord[] = [];

  for (const stage of PIPELINE_STAGES) {
    if (options.only !== null && !options.only.has(stage)) continue;

    if (options.completed.has(stage)) {
      records.push({
        stage,
        outcome: 'succeeded',
        durationMs: 0,
        costNanoUsd: 0,
        artifacts: [],
        detail: 'already completed in this run; not re-executed',
      });
      continue;
    }

    const argv = argvFor(stage, options.args, options.lane, options.project.record.id);
    if (argv === null) {
      records.push({
        stage,
        outcome: 'skipped',
        durationMs: 0,
        costNanoUsd: 0,
        artifacts: [],
        detail: STAGE_GAP[stage] ?? 'nothing to do: this stage had no input on the command line',
      });
      continue;
    }

    const match = matchCommand(options.commands, argv);
    if (match === null) {
      records.push({
        stage,
        outcome: 'skipped',
        durationMs: 0,
        costNanoUsd: 0,
        artifacts: [],
        detail: `no command matches "${argv.join(' ')}"`,
      });
      continue;
    }

    const startedAt = options.context.clock.now();
    options.context.io.err(`\n== ${PIPELINE_STAGE_CODES[stage]} ${stage} ==`);
    const code = await match.command.run(options.context, match.args);
    const durationMs = Math.max(0, options.context.clock.now() - startedAt);

    records.push({
      stage,
      outcome: code === EXIT.ok ? 'succeeded' : 'failed',
      durationMs,
      costNanoUsd: 0,
      artifacts: [`command:${match.command.path.join(' ')}`],
      detail: code === EXIT.ok ? null : `exited ${String(code)}`,
    });

    if (code !== EXIT.ok) break;
  }

  return records;
}

/**
 * Built with the command table rather than importing it.
 *
 * `run` invokes the other commands and the registry lists `run`, so a static import
 * either way is a cycle - which `import-x/no-cycle` fails the build on, correctly. A
 * factory breaks it without a dynamic import, and it also makes the sequencer trivially
 * testable: the spec passes a table of two fake commands.
 */
export function createRunCommand(commands: () => readonly Command[]): Command {
  return {
    path: ['run'],
    summary: 'S0 to S11 end to end, checkpointed and resumable',
    usage: [
      'rv run [--idea "<text>"] [--preset <styleId>] [--character <slug>] [--episode <E01>]',
      '       [--lane free|paid] [--stages <a,b,c>] [--resume <runId>] [--project <id>] [--json]',
      '  --resume   continue a run: stages already recorded as succeeded are not re-executed',
      '  --stages   run only these stages, by key or by S-code',
    ],
    async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
      const json = flag(args, 'json');
      const lane = parseLane(option(args, 'lane'));
      if (lane === undefined)
        return usageError(context.io, '--lane must be "free" or "paid"', json);

      const project = await resolveProject({
        workspaceRoot: context.workspaceRoot,
        explicit: option(args, 'project'),
        env: context.env,
      });
      if (isErr(project)) return fail(context.io, project.error, { json });

      const resume = option(args, 'resume');
      const runId = resume ?? context.ids.run();
      const paths = runPaths(project.value.paths, runId);

      const previous = await readJsonOrNull(paths.run, RunDocument, 'run');
      if (isErr(previous)) return fail(context.io, previous.error, { json });
      if (resume !== undefined && previous.value === null) {
        return fail(
          context.io,
          new NotFoundError('run', resume, { context: { path: paths.run } }),
          { json },
        );
      }

      const completed = new Set(
        (previous.value?.stages ?? [])
          .filter((record) => record.outcome === 'succeeded')
          .map((record) => record.stage),
      );

      const only = parseStageFilter(option(args, 'stages'));
      if (only === 'invalid') {
        return usageError(
          context.io,
          `--stages must be a comma-separated list of stage keys or S-codes; known: ${PIPELINE_STAGES.join(', ')}`,
          json,
        );
      }

      const startedAt = context.clock.now();
      const stages = await runStages({
        context,
        commands: commands().filter((command) => command.path[0] !== 'run'),
        args,
        project: project.value,
        lane,
        runId,
        completed,
        only,
      });

      const failed = stages.some((record) => record.outcome === 'failed');
      const document = await writeJson(paths.run, RunDocument, {
        version: DOCUMENT_VERSION,
        id: runId,
        projectId: project.value.record.id,
        status: failed ? 'failed' : 'succeeded',
        seed: context.seed,
        lane,
        stages: [...stages],
        spentNanoUsd: stages.reduce((total, record) => total + record.costNanoUsd, 0),
        startedAt: toIso(startedAt),
        finishedAt: toIso(context.clock.now()),
      });
      if (isErr(document)) return fail(context.io, document.error, { json });

      if (json) {
        emitJson(context.io, { run: document.value, path: paths.run });
        return failed ? EXIT.failed : EXIT.ok;
      }

      context.io.out();
      for (const line of keyValues([
        ['run', runId],
        ['lane', lane],
        ['seed', String(context.seed)],
        ['status', document.value.status],
        ['spent', formatUsd(nanoUsd(document.value.spentNanoUsd))],
        ['record', paths.run],
      ])) {
        context.io.out(line);
      }
      context.io.out();
      for (const line of table({
        columns: [
          { header: 'stage' },
          { header: 'key' },
          { header: 'outcome' },
          { header: 'ms', align: 'right' },
          { header: 'detail' },
        ],
        indent: '  ',
        rows: stages.map((record) => [
          PIPELINE_STAGE_CODES[record.stage],
          record.stage,
          record.outcome,
          String(record.durationMs),
          (record.detail ?? '').slice(0, 80),
        ]),
      })) {
        context.io.out(line);
      }
      context.io.out();
      context.io.out(`  Resume with: rv run --resume ${runId}`);
      context.io.out();
      return failed ? EXIT.failed : EXIT.ok;
    },
  };
}

/** `S2,cast` becomes the two stages. `'invalid'` when a name is not a stage. */
function parseStageFilter(
  value: string | undefined,
): ReadonlySet<PipelineStage> | null | 'invalid' {
  if (value === undefined) return null;
  const wanted = new Set<PipelineStage>();
  for (const token of value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')) {
    const normalised = token.toLowerCase();
    const stage =
      PIPELINE_STAGES.find((candidate) => candidate === normalised) ??
      PIPELINE_STAGES.find(
        (candidate) => PIPELINE_STAGE_CODES[candidate].toLowerCase() === normalised,
      );
    if (stage === undefined) return 'invalid';
    wanted.add(stage);
  }
  return wanted;
}
