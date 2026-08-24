/**
 * `rv` - the headless driver.
 *
 * Every milestone demo in `docs/03-backlog.md` is a command in `commands/registry.ts`,
 * so "does it work" has an answer you can run rather than a paragraph you have to trust.
 *
 * This file is deliberately thin. It builds the one `CliContext` - the clock, the id
 * generator, the seed and the workspace root that every command is a function of - hands
 * argv to {@link dispatch}, and turns the returned code into `process.exitCode`. The
 * split matters: `dispatch` is a pure-ish function of `(argv, context)` that returns an
 * exit code, so the spec exercises the real dispatcher with a `BufferIo` and never
 * touches the process.
 */

import { matchCommand, type Command } from './cli/command';
import { buildContext, type CliContext } from './cli/context';
import { EXIT, type ExitCode } from './cli/exit';
import { ProcessIo, type CliIo } from './cli/io';
import { flag } from './cli/args';
import { parseArgs } from './cli/args';
import { emitJson } from './cli/report';
import { COMMANDS } from './commands/registry';
import { table } from './cli/text';

/** Renders `rv help`. Lines, not printing, so a test can assert on the shape. */
export function helpLines(commands: readonly Command[]): readonly string[] {
  return [
    '',
    'rv - Rivayat, the headless driver',
    '',
    ...table({
      columns: [{ header: 'command' }, { header: 'what it does' }],
      indent: '  ',
      rows: [...commands]
        .sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' ')))
        .map((command) => [command.path.join(' '), command.summary]),
    }),
    '',
    '  Add --help to any command for its flags, and --json to anything a script consumes.',
    '',
    '  Exit codes: 0 ok · 1 failed · 2 bad usage · 3 findings · 4 spend not approved',
    '',
  ];
}

/**
 * Runs one command line and returns its exit code.
 *
 * Exported and injected with everything it touches, because the exit code *is* the
 * contract: `exit.spec.ts` asserts the code of every failure mode by calling this, and
 * a dispatcher that only existed inside `main()` could not be asserted at all.
 */
export async function dispatch(
  argv: readonly string[],
  context: CliContext,
  commands: readonly Command[] = COMMANDS,
): Promise<ExitCode> {
  const first = argv[0];
  const bare = parseArgs(argv, { booleans: ['help', 'json'] });

  if (first === undefined || first === 'help') {
    for (const line of helpLines(commands)) context.io.out(line);
    return EXIT.ok;
  }

  const match = matchCommand(commands, argv);
  if (match === null) {
    // Only complain about `--help` with no command *after* failing to match, so
    // `rv style probe --help` reaches the command and prints its own usage.
    if (flag(bare, 'help')) {
      for (const line of helpLines(commands)) context.io.out(line);
      return EXIT.ok;
    }
    context.io.err(`  Unknown command: ${argv.join(' ')}`);
    context.io.err('  Run `rv help` for the list.');
    return EXIT.usage;
  }

  if (flag(match.args, 'help')) {
    if (flag(match.args, 'json')) {
      emitJson(context.io, {
        command: match.command.path.join(' '),
        summary: match.command.summary,
        usage: match.command.usage,
      });
      return EXIT.ok;
    }
    context.io.out('');
    context.io.out(`  ${match.command.path.join(' ')} - ${match.command.summary}`);
    context.io.out('');
    for (const line of match.command.usage) context.io.out(`  ${line}`);
    context.io.out('');
    return EXIT.ok;
  }

  return match.command.run(context, match.args);
}

function main(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  return dispatch(argv, buildContext({ io }));
}

// `import.meta.main` is Node 24's own answer to "was this file executed or imported",
// and it is what keeps the spec from launching the CLI when it imports `dispatch`.
if (import.meta.main === true) {
  const io = new ProcessIo();
  main(process.argv.slice(2), io)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((caught: unknown) => {
      // Anything reaching here is programmer error: every expected failure is a
      // `Result` that a command turned into an exit code.
      io.err(caught instanceof Error ? (caught.stack ?? caught.message) : String(caught));
      process.exitCode = EXIT.failed;
    });
}
