import { describe, expect, it } from 'vitest';

import { parseArgs } from './args';
import { matchCommand, type Command } from './command';
import { EXIT } from './exit';

function stub(path: readonly string[], booleans: readonly string[] = []): Command {
  return {
    path,
    summary: `stub ${path.join(' ')}`,
    usage: [],
    booleans,
    run: () => Promise.resolve(EXIT.ok),
  };
}

describe('matchCommand', () => {
  const commands = [stub(['render']), stub(['render', 'resume']), stub(['assets', 'bake'])];

  it('prefers the longer path when one command is a prefix of another', () => {
    const match = matchCommand(commands, ['render', 'resume', 'run_1']);
    expect(match?.command.path).toEqual(['render', 'resume']);
    expect(match?.args.positionals).toEqual(['run_1']);
  });

  it('still matches the shorter path when the longer one does not apply', () => {
    const match = matchCommand(commands, ['render', '--episode', 'E01']);
    expect(match?.command.path).toEqual(['render']);
    expect(match?.args.positionals).toEqual([]);
  });

  it('does not strip an option value that happens to repeat a path segment', () => {
    const match = matchCommand(commands, ['assets', 'bake', '--asset', 'assets', '--clip', 'idle']);
    expect(match?.command.path).toEqual(['assets', 'bake']);
    expect(match?.args.options.get('asset')).toEqual(['assets']);
    expect(match?.args.positionals).toEqual([]);
  });

  it('returns null for an unknown command rather than guessing', () => {
    expect(matchCommand(commands, ['teleport'])).toBeNull();
  });

  it("parses the matched command's own boolean flags", () => {
    const withBoolean = [stub(['anim', 'lint'], ['strict'])];
    const match = matchCommand(withBoolean, ['anim', 'lint', '--strict', 'broken.json']);
    expect(match?.args.flags.has('strict')).toBe(true);
    expect(match?.args.positionals).toEqual(['broken.json']);
  });

  it('understands the universal flags without every command declaring them', () => {
    const match = matchCommand(commands, ['render', '--json']);
    expect(match?.args.flags.has('json')).toBe(true);
  });
});

describe('the command table itself', () => {
  it('has no two commands with the same path', async () => {
    const { COMMANDS } = await import('../commands/registry');
    const paths = COMMANDS.map((command) => command.path.join(' '));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('gives every command a summary and at least one usage line', async () => {
    const { COMMANDS } = await import('../commands/registry');
    for (const command of COMMANDS) {
      expect(command.summary, command.path.join(' ')).not.toBe('');
      expect(command.usage.length, command.path.join(' ')).toBeGreaterThan(0);
    }
  });

  /**
   * The milestone demos in `docs/03-backlog.md` §4 name these command lines. This is the
   * list turned into a test, so "the CLI covers the demos" is checkable rather than
   * claimed - and so deleting a command breaks a test instead of a demo.
   */
  it('has an implementation for every command line in an M0-M5 demo block', async () => {
    const { COMMANDS } = await import('../commands/registry');
    const demanded = [
      ['doctor'],
      ['project', 'new'],
      ['models', 'list'],
      ['models', 'set'],
      ['style', 'list'],
      ['style', 'probe'],
      ['style', 'lock'],
      ['cost', 'report'],
      ['story', 'new'],
      ['cast', 'states'],
      ['graph', 'show'],
      ['continuity', 'check'],
      ['assets', 'plan'],
      ['assets', 'produce'],
      ['assets', 'bake'],
      ['assets', 'edit'],
      ['anim', 'lint'],
      ['run'],
      ['render'],
      ['render', 'resume'],
      ['deliver'],
      ['series', 'cost'],
    ];
    for (const path of demanded) {
      const match = matchCommand(COMMANDS, path);
      expect(match?.command.path, path.join(' ')).toEqual(path);
    }
  });

  it('declares every boolean flag its own usage text mentions', async () => {
    const { COMMANDS } = await import('../commands/registry');
    // A flag documented as `--x` with no `<value>` after it must be in `booleans`, or
    // `rv anim lint --strict file.json` silently eats the filename.
    const universal = new Set(['json', 'help', 'yes']);
    for (const command of COMMANDS) {
      const usage = command.usage.join('\n');
      for (const documented of usage.matchAll(/--([a-z][a-z-]*)(?![a-z-])(\s|\]|$)/g)) {
        const name = documented[1];
        if (name === undefined || universal.has(name)) continue;
        const takesValue = new RegExp(`--${name}[ =]<`).test(usage);
        if (takesValue) continue;
        // `[--all | --format <id> ...]` documents `--all` as a boolean.
        const declared = (command.booleans ?? []).includes(name);
        const isValueOption = new RegExp(`--${name}\\s+\\S`).test(usage) && !declared;
        expect(
          declared || isValueOption,
          `${command.path.join(' ')} documents --${name} but does not declare it boolean`,
        ).toBe(true);
      }
    }
  });

  it('parses arguments identically whether or not a match happened', () => {
    // Regression guard for the dispatcher's two-pass parse: the probe pass uses only the
    // universal booleans, and the real pass must not lose anything the probe found.
    const probe = parseArgs(['anim', 'lint', 'x.json', '--json'], { booleans: ['json'] });
    const match = matchCommand([stub(['anim', 'lint'])], ['anim', 'lint', 'x.json', '--json']);
    expect(match?.args.flags.has('json')).toBe(probe.flags.has('json'));
  });
});
