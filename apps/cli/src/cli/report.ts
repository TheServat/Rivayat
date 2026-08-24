/**
 * The two ways a command answers: for a person, or for a script.
 *
 * `--json` is on everything a pipeline would consume, and it is one envelope rather
 * than per-command shapes, because the caller of `rv ... --json` writes the same three
 * lines of error handling every time or it writes none. `ok` is the discriminant,
 * `code` is the machine-stable reason, `data` is the payload.
 *
 * Human output is *not* a serialisation of the same object. A table with a right-
 * aligned cost column and a JSON document are different products, and pretending one
 * is a formatting of the other is how CLIs end up printing `{"ok":true}` to a person.
 */

import { ValidationError, isAppError } from '@rv/shared-kernel';

import { EXIT, type ExitCode } from './exit';
import type { CliIo } from './io';

export interface JsonEnvelope {
  readonly ok: boolean;
  /** Machine-stable. An `AppError.code` on failure, `null` on success. */
  readonly code: string | null;
  readonly message?: string;
  readonly data?: unknown;
  /** Present on failure when the error carried structured context. */
  readonly context?: Record<string, unknown>;
}

/** Writes a success envelope to stdout. */
export function emitJson(io: CliIo, data: unknown): void {
  const envelope: JsonEnvelope = { ok: true, code: null, data };
  io.out(JSON.stringify(envelope, null, 2));
}

/** Writes a failure envelope to stdout, so `| jq` still parses on the error path. */
export function emitJsonFailure(io: CliIo, error: unknown, data?: unknown): void {
  const envelope: JsonEnvelope = {
    ok: false,
    code: codeOf(error),
    message: messageOf(error),
    ...(isAppError(error) && Object.keys(error.context).length > 0
      ? { context: error.context }
      : {}),
    ...(data === undefined ? {} : { data }),
  };
  io.out(JSON.stringify(envelope, null, 2));
}

/**
 * Reports a failure on whichever channel the caller asked for and returns the code.
 *
 * Returning the exit code rather than setting it keeps every command's control flow a
 * single `return fail(...)`, which is the shape that makes the exit-code tests
 * readable.
 */
export function fail(
  io: CliIo,
  error: unknown,
  options: { readonly json: boolean; readonly exit?: ExitCode; readonly data?: unknown } = {
    json: false,
  },
): ExitCode {
  if (options.json) emitJsonFailure(io, error, options.data);
  else io.err(`  ${codeOf(error)}: ${messageOf(error)}`);
  return options.exit ?? EXIT.failed;
}

/** A usage complaint: the command line was wrong, not the world. */
export function usageError(io: CliIo, message: string, json: boolean): ExitCode {
  if (json) emitJsonFailure(io, new ValidationError({ message }));
  else io.err(`  ${message}`);
  return EXIT.usage;
}

export function codeOf(error: unknown): string {
  if (isAppError(error)) return error.code;
  return 'internal';
}

export function messageOf(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
