/**
 * `node:child_process` behind {@link ProcessPort} - the package's process adapter.
 *
 * One file may know that subprocesses exist. Everything above it - the encoder, the
 * prober, the deliverer - takes the port, which is what lets the entire encode path be
 * tested without FFmpeg while the genuine end-to-end test swaps this back in.
 *
 * `spawn` with an argv array and `shell: false` (the default, restated for the reader).
 * A project path containing a space, a quote, or a Persian episode title is not a
 * quoting problem here because there is no shell to quote for.
 */

import { spawn } from 'node:child_process';

import {
  ProviderError,
  TimeoutError,
  err,
  ok,
  type AppError,
  type Result,
  type Unit,
} from '@rv/shared-kernel';

import type { PipedProcess, ProcessPort, ProcessResult, ProcessSpec } from '../ports/process';

/** Output cap per stream. FFmpeg on a bad input can emit megabytes of identical lines. */
const MAX_CAPTURE_BYTES = 256 * 1024;

export class NodeProcessRunner implements ProcessPort {
  run(spec: ProcessSpec): Promise<Result<ProcessResult, AppError>> {
    return new Promise((resolve) => {
      const child = spawn(spec.command, [...spec.args], {
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });

      const timer =
        spec.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              child.kill('SIGKILL');
            }, spec.timeoutMs);

      let settled = false;
      const finish = (result: Result<ProcessResult, AppError>): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };

      child.on('error', (caught: Error) => {
        finish(err(spawnFailure(spec, caught)));
      });
      child.on('close', (code: number | null, signal: string | null) => {
        if (signal === 'SIGKILL' && spec.timeoutMs !== undefined) {
          finish(err(new TimeoutError(spec.command, spec.timeoutMs)));
          return;
        }
        finish(ok({ exitCode: code ?? -1, stdout, stderr }));
      });
    });
  }

  spawnPiped(spec: ProcessSpec): Result<PipedProcess, AppError> {
    let child;
    try {
      child = spawn(spec.command, [...spec.args], {
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (caught: unknown) {
      /* c8 ignore next -- `spawn` reports ENOENT asynchronously; this covers the
         synchronous argument-validation failures only. */
      return err(spawnFailure(spec, caught));
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    let spawnError: AppError | undefined;
    child.on('error', (caught: Error) => {
      spawnError = spawnFailure(spec, caught);
    });
    // A dead encoder makes every subsequent `write` raise EPIPE. Absorbing it here
    // keeps the failure reported once, from `end`, with the stderr that explains it.
    child.stdin.on('error', () => undefined);

    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('close', (code, signal) => {
        resolve({ code, signal });
      });
    });

    return ok({
      write(chunk: Uint8Array): Promise<Result<Unit, AppError>> {
        if (spawnError !== undefined) return Promise.resolve(err(spawnError));
        return new Promise((resolve) => {
          // The callback form is the back-pressure: it fires once the chunk has been
          // handed to the OS, so a slow encoder throttles the frame loop instead of
          // letting 8 MB frames pile up in the heap.
          child.stdin.write(chunk, (caught) => {
            resolve(
              caught == null
                ? ok()
                : err(
                    new ProviderError({
                      message: `writing to ${spec.command} failed: ${caught.message}`,
                      provider: spec.command,
                      retryable: false,
                      cause: caught,
                    }),
                  ),
            );
          });
        });
      },

      async end(): Promise<Result<ProcessResult, AppError>> {
        child.stdin.end();
        const { code } = await exited;
        if (spawnError !== undefined) return err(spawnError);
        return ok({ exitCode: code ?? -1, stdout, stderr });
      },

      async abort(): Promise<void> {
        child.stdin.destroy();
        child.kill('SIGKILL');
        await exited;
      },
    });
  }
}

function append(current: string, chunk: Buffer): string {
  if (current.length >= MAX_CAPTURE_BYTES) return current;
  return current + chunk.toString('utf8');
}

/**
 * A binary that will not start.
 *
 * Names the command **and** the environment variable that configures it, because
 * "spawn ffmpeg ENOENT" tells a user nothing about how to fix it (RV-163).
 */
function spawnFailure(spec: ProcessSpec, caught: unknown): AppError {
  return new ProviderError({
    message: `could not start "${spec.command}". Set RV_FFMPEG_PATH to the FFmpeg 8.1.2 binary, or put it on PATH.`,
    provider: spec.command,
    retryable: false,
    cause: caught,
    context: { command: spec.command, envVar: 'RV_FFMPEG_PATH' },
  });
}
