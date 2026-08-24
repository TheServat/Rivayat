/**
 * What a command is, and how argv finds one.
 *
 * A table keyed by path rather than a chain of `if (command === ...)` in `main`.
 * CLAUDE.md §2 forbids a `switch` on a name in core for the same reason it is wrong
 * here: the list of commands is data that `rv help` renders, that the dispatcher walks,
 * and that a test enumerates to assert every milestone demo has an implementation.
 * A chain of `if`s can do none of those three.
 *
 * Paths are arrays because the surface is two levels deep - `style probe`, `render
 * resume`, `assets bake` - and matching the longest path first is what lets `render`
 * and `render resume` coexist without either one parsing the other's arguments.
 */

import { parseArgs, type ParsedArgs } from './args';
import type { CliContext } from './context';
import type { ExitCode } from './exit';

export interface Command {
  /** e.g. `['style', 'probe']`. Matched against the leading positionals. */
  readonly path: readonly string[];
  /** One line, for `rv help`. */
  readonly summary: string;
  /** Argument documentation, one line per flag. Printed by `rv <command> --help`. */
  readonly usage: readonly string[];
  /** Names that take no value, so `--json out.txt` cannot swallow a positional. */
  readonly booleans?: readonly string[];
  run(context: CliContext, args: ParsedArgs): Promise<ExitCode>;
}

export interface Match {
  readonly command: Command;
  /** argv with the command path removed and the rest parsed. */
  readonly args: ParsedArgs;
}

/** Flags every command understands. Declared once so no command forgets one. */
export const UNIVERSAL_BOOLEANS = ['json', 'help', 'yes'] as const;

/**
 * Finds the command whose path is the longest prefix of the argv positionals.
 *
 * Returns `null` for an unknown command, which the caller turns into a usage error -
 * dispatch does not print, because a function that both decides and reports cannot be
 * reused by `rv help`.
 */
export function matchCommand(commands: readonly Command[], argv: readonly string[]): Match | null {
  // A first pass with no boolean declarations, purely to read the leading positionals.
  // The real parse happens once the command - and therefore its boolean list - is known.
  const probe = parseArgs(argv, { booleans: [...UNIVERSAL_BOOLEANS] });
  const ordered = [...commands].sort((a, b) => b.path.length - a.path.length);

  for (const command of ordered) {
    if (!isPrefix(command.path, probe.positionals)) continue;
    const parsed = parseArgs(argv, {
      booleans: [...UNIVERSAL_BOOLEANS, ...(command.booleans ?? [])],
    });
    return { command, args: dropLeadingPositionals(parsed, command.path.length) };
  }
  return null;
}

function isPrefix(path: readonly string[], positionals: readonly string[]): boolean {
  return path.every((segment, index) => positionals[index] === segment);
}

/**
 * Removes the command path from the positional list.
 *
 * Done on the parsed result rather than on raw argv, because a textual strip would
 * remove the wrong token for `rv assets bake --asset assets` - the second `assets` is
 * an option value, and only the parser knows that.
 */
function dropLeadingPositionals(args: ParsedArgs, count: number): ParsedArgs {
  return { ...args, positionals: args.positionals.slice(count) };
}
