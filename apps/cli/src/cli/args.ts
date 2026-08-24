/**
 * Argument parsing, as a pure function of the argv array.
 *
 * Hand-rolled rather than pulled from npm for one reason that is not "no dependencies":
 * every other parser decides `--strict file.json` by guessing, and the guess is wrong
 * exactly when a boolean flag precedes a positional. Here the caller declares which
 * names are boolean, so `anim lint --strict broken.json` and `style probe --lane free`
 * are both unambiguous, and the declaration is data a test can read.
 *
 * Repeated options accumulate instead of overwriting, because `--format reels-9x16
 * --format tiktok-9x16` is a list and silently keeping the last one is the kind of bug
 * that only shows up in the delivery manifest.
 */

export interface ParsedArgs {
  /** Everything that was not a flag or an option value, in order. */
  readonly positionals: readonly string[];
  /** Names given without a value, e.g. `--json`. */
  readonly flags: ReadonlySet<string>;
  /** Names given with one or more values, in the order they appeared. */
  readonly options: ReadonlyMap<string, readonly string[]>;
  /** Names that appeared with `--name` but no value where one was expected. */
  readonly danglingOptions: readonly string[];
}

export interface ParseOptions {
  /**
   * Names that never take a value.
   *
   * Without this list `--json` followed by a positional would swallow it.
   */
  readonly booleans?: readonly string[];
}

const EMPTY: readonly string[] = [];

/** Splits argv into positionals, boolean flags and valued options. */
export function parseArgs(argv: readonly string[], options: ParseOptions = {}): ParsedArgs {
  const booleans = new Set(options.booleans ?? []);
  const positionals: string[] = [];
  const flags = new Set<string>();
  const collected = new Map<string, string[]>();
  const dangling: string[] = [];

  let index = 0;
  let literal = false;

  while (index < argv.length) {
    const token = argv[index];
    index += 1;
    if (token === undefined) continue;

    if (literal) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      push(collected, body.slice(0, equals), body.slice(equals + 1));
      continue;
    }

    if (booleans.has(body)) {
      flags.add(body);
      continue;
    }

    const next = argv[index];
    if (next === undefined || next.startsWith('--')) {
      // Ambiguous: an undeclared boolean, or an option whose value is missing. Recorded
      // as both so a command can accept it as a flag *and* diagnose it as a typo.
      flags.add(body);
      dangling.push(body);
      continue;
    }

    push(collected, body, next);
    index += 1;
  }

  return {
    positionals,
    flags,
    options: collected,
    danglingOptions: dangling,
  };
}

function push(into: Map<string, string[]>, key: string, value: string): void {
  const existing = into.get(key);
  if (existing === undefined) into.set(key, [value]);
  else existing.push(value);
}

/** The first value given for `name`, or `undefined`. */
export function option(args: ParsedArgs, name: string): string | undefined {
  return args.options.get(name)?.[0];
}

/** Every value given for `name`, in order. Empty when the option was not used. */
export function optionList(args: ParsedArgs, name: string): readonly string[] {
  return args.options.get(name) ?? EMPTY;
}

/** Whether a boolean flag was present. A `--name=true` spelling counts. */
export function flag(args: ParsedArgs, name: string): boolean {
  if (args.flags.has(name)) return true;
  const value = option(args, name);
  return value === 'true' || value === '1';
}

/** The positional at `index`, counting after the command path has been stripped. */
export function positional(args: ParsedArgs, index: number): string | undefined {
  return args.positionals[index];
}
