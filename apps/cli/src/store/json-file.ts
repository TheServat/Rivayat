/**
 * Reading and writing validated JSON documents, as `Result`s.
 *
 * Every file the CLI persists is a schema instance, and every read validates. That is
 * the same rule the settings resolver follows and for the same reason: a document
 * written by an older build must fail loudly at the boundary, not three stages later
 * with a shape error nobody can trace back. `fs` throws; this converts exactly once,
 * here, which is the adapter contract in CLAUDE.md §2.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  NotFoundError,
  ValidationError,
  UNIT,
  type AppError,
  type Result,
  type Unit,
  err,
  ok,
} from '@rv/shared-kernel';
import type { z } from 'zod';

/** True when the failure was "there is no such file", rather than anything else. */
function isMissing(caught: unknown): boolean {
  return (
    typeof caught === 'object' &&
    caught !== null &&
    'code' in caught &&
    (caught as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Reads and validates one document.
 *
 * A missing file is a `NotFoundError` and a malformed one is a `ValidationError`,
 * because the caller's reaction differs: the first means "create it", the second means
 * "someone edited it by hand".
 */
export async function readJson<T>(
  path: string,
  schema: z.ZodType<T>,
  resource: string,
): Promise<Result<T, AppError>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (caught: unknown) {
    if (isMissing(caught)) return err(new NotFoundError(resource, path));
    return err(new ValidationError({ message: `cannot read ${path}`, cause: caught }));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (caught: unknown) {
    return err(
      new ValidationError({
        message: `${path} is not valid JSON: ${caught instanceof Error ? caught.message : String(caught)}`,
        context: { path },
      }),
    );
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return err(
      new ValidationError({
        message: `${path} does not match the ${resource} schema`,
        context: {
          path,
          issues: validated.error.issues.map(
            (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          ),
        },
      }),
    );
  }
  return ok(validated.data);
}

/** Reads a document, or `null` when the file does not exist. */
export async function readJsonOrNull<T>(
  path: string,
  schema: z.ZodType<T>,
  resource: string,
): Promise<Result<T | null, AppError>> {
  const outcome = await readJson(path, schema, resource);
  if (outcome.ok) return outcome;
  return outcome.error.kind === 'not-found' ? ok(null) : outcome;
}

/**
 * Validates, then writes, creating parent directories.
 *
 * Validating on the way out as well as on the way in is deliberate: a bug that writes a
 * malformed document is caught by the process that has the stack trace, not by the next
 * command to read it.
 */
export async function writeJson<T>(
  path: string,
  schema: z.ZodType<T>,
  value: T,
): Promise<Result<T, AppError>> {
  const validated = schema.safeParse(value);
  if (!validated.success) {
    return err(
      new ValidationError({
        message: `refusing to write a malformed document to ${path}`,
        context: {
          path,
          issues: validated.error.issues.map(
            (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          ),
        },
      }),
    );
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(validated.data, null, 2)}\n`, 'utf8');
  } catch (caught: unknown) {
    return err(new ValidationError({ message: `cannot write ${path}`, cause: caught }));
  }
  return ok(validated.data);
}

/** Raw bytes, for artefacts that are not documents. */
export async function writeBytes(path: string, bytes: Uint8Array): Promise<Result<Unit, AppError>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  } catch (caught: unknown) {
    return err(new ValidationError({ message: `cannot write ${path}`, cause: caught }));
  }
  return ok(UNIT);
}

/** Directory names under `path`. Empty when the directory does not exist. */
export async function listDirectories(path: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
