/**
 * `rv models list` and `rv models set` - the M1 demo line "every stage, its binding,
 * its alternatives", and the M2 line that swaps a brain mid-series.
 *
 * Everything here is a read or a write of the settings stack. The CLI does not own a
 * second notion of "which model runs S2": `model.stage.<stage>` is declared once in
 * `SETTINGS_REGISTRY`, resolved by `@rv/settings` with provenance, and written back
 * through `applyPatch` so a bad `provider:model` string is rejected by the same schema
 * the API and the studio use. A CLI that validated its own way would be the fourth
 * opinion on a question the registry answers.
 *
 * The provenance column is the point of `list` rather than a decoration. Once machine,
 * project and run layers can each pin a stage, "why is this model being used" is
 * unanswerable without it - which is the sentence architecture 7b uses to justify the
 * resolver returning a record instead of a value.
 */

import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_CODES,
  ModelRef,
  SETTINGS_REGISTRY,
  type PipelineStage,
} from '@rv/contracts';
import { applyPatch, layer, loadMachineLayer, resolveAll, type SettingsLayer } from '@rv/settings';
import { ValidationError, isErr, toIso } from '@rv/shared-kernel';

import { flag, option, type ParsedArgs } from '../cli/args';
import type { Command } from '../cli/command';
import type { CliContext } from '../cli/context';
import { EXIT, type ExitCode } from '../cli/exit';
import { emitJson, fail, usageError } from '../cli/report';
import { table } from '../cli/text';
import { DOCUMENT_VERSION, SettingsDocument } from '../store/documents';
import { readJsonOrNull, writeJson } from '../store/json-file';
import { resolveProject, type LoadedProject } from '../store/project';

/** `model.stage.story` for `story`. The one place the key is spelled. */
export function stageSettingKey(stage: PipelineStage): string {
  return `model.stage.${stage}`;
}

/**
 * Accepts either spelling of a stage.
 *
 * `S2` is what the docs and the demo lines use; `story` is what the enum uses. Both are
 * published identifiers - `PIPELINE_STAGE_CODES` exists precisely because the numbering
 * appears in the architecture doc - so refusing one of them would be refusing half the
 * documentation.
 */
export function parseStage(value: string): PipelineStage | undefined {
  const normalised = value.trim().toLowerCase();
  const byKey = PIPELINE_STAGES.find((stage) => stage === normalised);
  if (byKey !== undefined) return byKey;
  return PIPELINE_STAGES.find((stage) => PIPELINE_STAGE_CODES[stage].toLowerCase() === normalised);
}

/**
 * The stack a project resolves through.
 *
 * Machine from the environment and project from disk. The global layer lives in SQLite
 * behind `DrizzleSettingsRepository` and the run layer only exists while a run is in
 * flight, so neither is part of a CLI read - which is worth saying out loud, because a
 * value set in the studio's global settings will *not* show up here.
 */
export async function loadStack(
  context: CliContext,
  project: LoadedProject | null,
): Promise<readonly SettingsLayer[]> {
  const machine = loadMachineLayer(context.env);
  if (project === null) return [machine.layer];

  const stored = await readJsonOrNull(project.paths.settings, SettingsDocument, 'settings');
  const values = stored.ok && stored.value !== null ? stored.value.values : {};
  return [machine.layer, layer('project', values, project.record.id)];
}

export const modelsListCommand: Command = {
  path: ['models', 'list'],
  summary: 'every stage, its model binding, where the binding came from',
  usage: [
    'rv models list [--project <id>] [--alternatives] [--json]',
    '  --alternatives  also print every catalogue model that could serve each stage',
  ],
  booleans: ['alternatives'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');

    // A project is optional here: `rv models list` before any project exists should
    // still show the machine layer rather than refuse.
    const project = await resolveProject({
      workspaceRoot: context.workspaceRoot,
      explicit: option(args, 'project'),
      env: context.env,
    });
    const loaded = project.ok ? project.value : null;
    const stack = await loadStack(context, loaded);
    const resolved = resolveAll(stack);

    const rows = PIPELINE_STAGES.map((stage) => {
      const key = stageSettingKey(stage);
      const entry = resolved.get(key);
      const descriptor = SETTINGS_REGISTRY.find((candidate) => candidate.key === key);
      const binding = entry?.value;
      return {
        stage,
        code: PIPELINE_STAGE_CODES[stage],
        key,
        binding: typeof binding === 'string' ? binding : null,
        origin: entry?.origin ?? 'default',
        shadowed: entry?.shadowed ?? [],
        alternatives: (descriptor?.options ?? []).map((choice) => String(choice.value)),
      };
    });

    if (json) {
      emitJson(context.io, {
        projectId: loaded?.record.id ?? null,
        stages: rows,
      });
      return EXIT.ok;
    }

    context.io.out();
    for (const line of table({
      columns: [{ header: 'stage' }, { header: 'key' }, { header: 'model' }, { header: 'from' }],
      indent: '  ',
      rows: rows.map((row) => [row.code, row.stage, row.binding ?? '(router decides)', row.origin]),
    })) {
      context.io.out(line);
    }

    if (flag(args, 'alternatives')) {
      context.io.out();
      for (const row of rows) {
        context.io.out(`  ${row.code} ${row.stage}`);
        for (const alternative of row.alternatives) context.io.out(`      ${alternative}`);
      }
    }

    context.io.out();
    context.io.err(
      loaded === null
        ? '  machine layer only - no project resolved, so no project overrides are shown'
        : `  layers: machine, project ${loaded.record.id}`,
    );
    return EXIT.ok;
  },
};

export const modelsSetCommand: Command = {
  path: ['models', 'set'],
  summary: 'pin one stage to one model, at project scope',
  usage: [
    'rv models set --stage <S2|story> --binding <provider:model> [--project <id>] [--json]',
    '  --binding     "none" clears the pin and lets the router decide again',
  ],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const stageArg = option(args, 'stage');
    const bindingArg = option(args, 'binding');

    if (stageArg === undefined || bindingArg === undefined) {
      return usageError(
        context.io,
        'Both --stage and --binding are required, e.g. rv models set --stage S2 --binding gemini:gemini-3-flash',
        json,
      );
    }

    const stage = parseStage(stageArg);
    if (stage === undefined) {
      return usageError(
        context.io,
        `--stage "${stageArg}" is not a pipeline stage. Try one of: ${PIPELINE_STAGES.map((s) => `${PIPELINE_STAGE_CODES[s]}/${s}`).join(', ')}`,
        json,
      );
    }

    const cleared = bindingArg === 'none' || bindingArg === 'null';
    if (!cleared) {
      const parsed = ModelRef.safeParse(bindingArg);
      if (!parsed.success) {
        return usageError(
          context.io,
          `--binding must be "provider:model" (e.g. ollama:qwen3.5), got "${bindingArg}"`,
          json,
        );
      }
    }

    const project = await resolveProject({
      workspaceRoot: context.workspaceRoot,
      explicit: option(args, 'project'),
      env: context.env,
    });
    if (isErr(project)) return fail(context.io, project.error, { json });

    const key = stageSettingKey(stage);
    const patch = applyPatch({
      scope: 'project',
      scopeId: project.value.record.id,
      values: { [key]: cleared ? null : bindingArg },
    });
    if (isErr(patch)) {
      return fail(
        context.io,
        new ValidationError({
          message: patch.error.message,
          context: { issues: patch.error.issues },
        }),
        { json },
      );
    }

    const stored = await readJsonOrNull(project.value.paths.settings, SettingsDocument, 'settings');
    if (isErr(stored)) return fail(context.io, stored.error, { json });

    // A merge, not a replace - the same invariant `SettingsRepository.save` documents.
    // Writing the whole layer would delete every other pin the moment one is changed.
    const merged = { ...(stored.value?.values ?? {}), ...patch.value.values };
    const written = await writeJson(project.value.paths.settings, SettingsDocument, {
      version: DOCUMENT_VERSION,
      values: merged,
      updatedAt: toIso(context.clock.now()),
    });
    if (isErr(written)) return fail(context.io, written.error, { json });

    const stack = await loadStack(context, project.value);
    const entry = resolveAll(stack).get(key);

    if (json) {
      emitJson(context.io, {
        projectId: project.value.record.id,
        stage,
        code: PIPELINE_STAGE_CODES[stage],
        key,
        value: entry?.value ?? null,
        origin: entry?.origin ?? 'default',
      });
      return EXIT.ok;
    }

    context.io.out();
    context.io.out(
      `  ${PIPELINE_STAGE_CODES[stage]} ${stage} -> ${cleared ? '(router decides)' : bindingArg}` +
        `  [${entry?.origin ?? 'default'}]`,
    );
    context.io.out();
    return EXIT.ok;
  },
};
