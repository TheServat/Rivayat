/**
 * `rv project new` and `rv project list` - the M0 demo, and the thing every later
 * command needs to exist.
 *
 * The M0 demo line is `pnpm rv project new "دهکده" --lang fa`, so the name is a
 * positional and it is Persian. Two consequences shape this file: the record's `locale`
 * is a real field rather than a display preference, and the confirmation line prints
 * the name unquoted so a mangled terminal is visible rather than hidden behind a shell
 * escape.
 */

import { Locale, type ProjectId } from '@rv/contracts';
import { isErr } from '@rv/shared-kernel';

import { flag, option, positional, type ParsedArgs } from '../cli/args';
import type { Command } from '../cli/command';
import type { CliContext } from '../cli/context';
import { EXIT, type ExitCode } from '../cli/exit';
import { emitJson, fail, usageError } from '../cli/report';
import { keyValues, table } from '../cli/text';
import { createProject, listProjects } from '../store/project';

export const projectNewCommand: Command = {
  path: ['project', 'new'],
  summary: 'create a project on disk, validated',
  usage: [
    'rv project new "<name>" [--lang fa|en] [--about "<description>"] [--json]',
    '  --lang        fa (default) or en. Stored on the record, not a display setting.',
    '  --about       one-paragraph description. Defaults to the name.',
  ],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const name = positional(args, 0);
    if (name === undefined || name.trim() === '') {
      return usageError(
        context.io,
        'Give the project a name, e.g. rv project new "دهکده" --lang fa',
        json,
      );
    }

    const locale = Locale.safeParse(option(args, 'lang') ?? 'fa');
    if (!locale.success) {
      return usageError(
        context.io,
        `--lang must be fa or en, got "${option(args, 'lang') ?? ''}"`,
        json,
      );
    }

    const created = await createProject({
      workspaceRoot: context.workspaceRoot,
      id: context.ids.project(),
      name: name.trim(),
      description: (option(args, 'about') ?? name).trim(),
      locale: locale.data,
      clock: context.clock,
    });
    if (isErr(created)) return fail(context.io, created.error, { json });

    if (json) {
      emitJson(context.io, { project: created.value.record, path: created.value.paths.root });
      return EXIT.ok;
    }

    context.io.out();
    for (const line of keyValues([
      ['id', created.value.record.id],
      ['name', created.value.record.name],
      ['language', created.value.record.locale],
      ['path', created.value.paths.root],
    ])) {
      context.io.out(line);
    }
    context.io.out();
    return EXIT.ok;
  },
};

export const projectListCommand: Command = {
  path: ['project', 'list'],
  summary: 'every project in the workspace',
  usage: ['rv project list [--json]'],
  async run(context: CliContext, args: ParsedArgs): Promise<ExitCode> {
    const json = flag(args, 'json');
    const projects = await listProjects(context.workspaceRoot);
    if (isErr(projects)) return fail(context.io, projects.error, { json });

    if (json) {
      emitJson(context.io, { projects: projects.value.map((project) => project.record) });
      return EXIT.ok;
    }

    if (projects.value.length === 0) {
      context.io.out();
      context.io.out('  No projects yet. Create one: rv project new "<name>"');
      context.io.out();
      return EXIT.ok;
    }

    context.io.out();
    for (const line of table({
      columns: [{ header: 'id' }, { header: 'name' }, { header: 'lang' }, { header: 'style' }],
      indent: '  ',
      rows: projects.value.map((project) => [
        project.record.id,
        project.record.name,
        project.record.locale,
        project.record.styleBibleId ?? '-',
      ]),
    })) {
      context.io.out(line);
    }
    context.io.out();
    return EXIT.ok;
  },
};

/** Reads `--project`. Shared by every project command that scopes itself to one. */
export function projectOption(args: ParsedArgs): ProjectId | undefined {
  return option(args, 'project');
}
