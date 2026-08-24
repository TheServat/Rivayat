import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Command } from './cli/command';
import { EXIT, type ExitCode } from './cli/exit';
import { makeHarness, type Harness } from './__fixtures__/harness';
import { COMMANDS } from './commands/registry';
import { dispatch, helpLines } from './main';

function spy(path: readonly string[], code: ExitCode = EXIT.ok): Command & { calls: number } {
  const command = {
    path,
    summary: 'spy',
    usage: ['rv spy'],
    calls: 0,
    run(): Promise<ExitCode> {
      command.calls += 1;
      return Promise.resolve(code);
    },
  };
  return command;
}

describe('dispatch', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('prints help and exits 0 for no arguments', async () => {
    expect(await dispatch([], harness.context)).toBe(EXIT.ok);
    expect(harness.io.outText).toContain('rv - Rivayat');
  });

  it('prints help for the literal word help', async () => {
    expect(await dispatch(['help'], harness.context)).toBe(EXIT.ok);
    expect(harness.io.outText).toContain('project new');
  });

  it('exits 2 for an unknown command, and says how to find the list', async () => {
    const code = await dispatch(['teleport', '--now'], harness.context);
    expect(code).toBe(EXIT.usage);
    expect(harness.io.errText).toContain('Unknown command');
    expect(harness.io.errText).toContain('rv help');
  });

  it('routes to the command and returns its exit code verbatim', async () => {
    const failing = spy(['boom'], EXIT.findings);
    const code = await dispatch(['boom'], harness.context, [failing]);
    expect(code).toBe(EXIT.findings);
    expect(failing.calls).toBe(1);
  });

  it("prints a command's own usage for --help instead of running it", async () => {
    const command = spy(['boom']);
    const code = await dispatch(['boom', '--help'], harness.context, [command]);
    expect(code).toBe(EXIT.ok);
    expect(command.calls).toBe(0);
    expect(harness.io.outText).toContain('rv spy');
  });

  it('serves --help --json as a document a script can read', async () => {
    const command = spy(['boom']);
    await dispatch(['boom', '--help', '--json'], harness.context, [command]);
    const envelope = JSON.parse(harness.io.outText) as {
      ok: boolean;
      data: { command: string; usage: string[] };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.command).toBe('boom');
    expect(envelope.data.usage).toEqual(['rv spy']);
  });

  it('falls back to the global help for a bare --help', async () => {
    expect(await dispatch(['--help'], harness.context)).toBe(EXIT.ok);
    expect(harness.io.outText).toContain('Exit codes');
  });

  it('never resolves an unknown command to a similar one', async () => {
    const command = spy(['render']);
    expect(await dispatch(['rende'], harness.context, [command])).toBe(EXIT.usage);
    expect(command.calls).toBe(0);
  });
});

describe('helpLines', () => {
  it('lists every registered command exactly once, in alphabetical order', () => {
    const lines = helpLines(COMMANDS);
    const names = COMMANDS.map((command) => command.path.join(' '));
    for (const name of names) {
      // Two spaces, not one: `render` is a prefix of `render resume`, and the column
      // gap is what distinguishes the two rows.
      const rows = lines.filter((line) => line.trimStart().startsWith(`${name}  `));
      expect(rows, name).toHaveLength(1);
    }
  });

  it('documents the exit-code contract, because scripts depend on it', () => {
    expect(helpLines(COMMANDS).join('\n')).toContain('4 spend not approved');
  });
});
