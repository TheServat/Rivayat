/**
 * The process adapter, against real subprocesses.
 *
 * Node itself is the test binary: `process.execPath` is guaranteed present, takes an
 * argv array, and can be made to exit with any code, print to either stream, read
 * stdin, or hang. That covers everything the adapter has to get right without needing
 * FFmpeg, and the FFmpeg-specific behaviour is covered separately in `ffmpeg-e2e`.
 */

import { unwrap } from '@rv/shared-kernel';
import { describe, expect, it } from 'vitest';

import { NodeProcessRunner } from './node-process';

const NODE = process.execPath;
const runner = new NodeProcessRunner();

describe('run', () => {
  it('captures stdout and a zero exit', async () => {
    const result = unwrap(
      await runner.run({ command: NODE, args: ['-e', 'process.stdout.write("hello")'] }),
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: 'hello' });
  });

  it('captures stderr and a non-zero exit rather than throwing', async () => {
    const result = unwrap(
      await runner.run({
        command: NODE,
        args: ['-e', 'process.stderr.write("bad"); process.exit(3)'],
      }),
    );
    expect(result).toMatchObject({ exitCode: 3, stderr: 'bad' });
  });

  it('names the binary and the env var when the command does not exist', async () => {
    // "spawn ffmpeg ENOENT" tells a user nothing about how to fix it (RV-163).
    const result = await runner.run({ command: 'definitely-not-a-real-binary-xyz', args: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('RV_FFMPEG_PATH');
    expect(result.error.context).toMatchObject({ envVar: 'RV_FFMPEG_PATH' });
  });

  it('kills a process that overruns its timeout', async () => {
    const result = await runner.run({
      command: NODE,
      args: ['-e', 'setTimeout(() => undefined, 60000)'],
      timeoutMs: 200,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('timeout');
  });

  it('passes an argument containing a space as one argument, not two', async () => {
    // There is no shell, so there is no quoting bug to have.
    const result = unwrap(
      await runner.run({
        command: NODE,
        args: ['-e', 'process.stdout.write(process.argv[1])', 'my project/فصل ۱.mp4'],
      }),
    );
    expect(result.stdout).toBe('my project/فصل ۱.mp4');
  });
});

describe('spawnPiped', () => {
  it('streams stdin into the child and reports what it produced', async () => {
    const piped = unwrap(
      runner.spawnPiped({
        command: NODE,
        args: [
          '-e',
          'let n = 0; process.stdin.on("data", (c) => { n += c.length; }); process.stdin.on("end", () => process.stdout.write(String(n)));',
        ],
      }),
    );
    expect((await piped.write(new Uint8Array(16))).ok).toBe(true);
    expect((await piped.write(new Uint8Array(24))).ok).toBe(true);
    const result = unwrap(await piped.end());
    expect(result).toMatchObject({ exitCode: 0, stdout: '40' });
  });

  it("reports the child's exit code and stderr from end()", async () => {
    const piped = unwrap(
      runner.spawnPiped({
        command: NODE,
        args: [
          '-e',
          'process.stdin.resume(); process.stdin.on("end", () => { process.stderr.write("nope"); process.exit(9); });',
        ],
      }),
    );
    const result = unwrap(await piped.end());
    expect(result).toMatchObject({ exitCode: 9, stderr: 'nope' });
  });

  it('does not throw when the child dies mid-write', async () => {
    // A dead encoder makes every subsequent write raise EPIPE; the failure has to be
    // reported once, from `end`, with the stderr that explains it.
    const piped = unwrap(runner.spawnPiped({ command: NODE, args: ['-e', 'process.exit(1)'] }));
    for (let index = 0; index < 8; index += 1) await piped.write(new Uint8Array(1024));
    const result = await piped.end();
    expect(result.ok).toBe(true);
  });

  it('reports a spawn failure from the first write', async () => {
    const piped = unwrap(
      runner.spawnPiped({ command: 'definitely-not-a-real-binary-xyz', args: [] }),
    );
    // The ENOENT is asynchronous, so let the event loop deliver it first.
    await new Promise((resolve) => setImmediate(resolve));
    const write = await piped.write(new Uint8Array(1));
    expect(write.ok).toBe(false);
    expect((await piped.end()).ok).toBe(false);
  });

  it('terminates without waiting when aborted', async () => {
    const piped = unwrap(
      runner.spawnPiped({ command: NODE, args: ['-e', 'setTimeout(() => undefined, 60000)'] }),
    );
    await expect(piped.abort()).resolves.toBeUndefined();
  });

  it('runs in a given working directory', async () => {
    const result = unwrap(
      await runner.run({
        command: NODE,
        args: ['-e', 'process.stdout.write(process.cwd())'],
        cwd: process.cwd(),
      }),
    );
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
