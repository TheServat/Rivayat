/**
 * The only thing that turns request bytes into a domain value.
 *
 * A schema from `@rv/contracts` goes in, the parsed value comes out, and a bad body
 * comes back as a `ValidationError` carrying every failing path - not the first one.
 * A caller fixing a 12-field payload one 400 at a time is a caller we made twelve
 * round trips for.
 *
 * **Why the schema is passed at the parameter rather than inferred from the DTO type.**
 * The usual Nest pattern reads `ArgumentMetadata.metatype`, which only exists when the
 * compiler emitted `design:paramtypes`. Vitest transforms with esbuild, which does not
 * emit decorator metadata at all, so a pipe that depended on the metatype would be a
 * silent no-op in exactly the suite that is supposed to prove it works. Passing the
 * schema is explicit, costs one expression, and behaves identically under `tsc`,
 * esbuild and swc.
 *
 * The globally-registered instance ({@link ZodValidationPipe.passthrough}) still exists
 * and still runs on every argument: it is what enforces that a metatype-carrying DTO -
 * the shape a future `nest build` pipeline may introduce - cannot slip past unvalidated.
 */

import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ValidationError } from '@rv/shared-kernel';
import type { z } from 'zod';

/** A class that carries its own schema, for the metatype path. */
interface SchemaCarrier {
  readonly zodSchema: z.ZodType;
}

function carriesSchema(value: unknown): value is SchemaCarrier {
  return (
    typeof value === 'function' &&
    'zodSchema' in value &&
    typeof (value as { zodSchema?: unknown }).zodSchema === 'object'
  );
}

/** `['run', 'stages', 0]` → `"run.stages.0"`; `[]` → `""` for a root-level failure. */
function formatPath(path: readonly PropertyKey[]): string {
  return path.map((segment) => String(segment)).join('.');
}

/**
 * Turns a `ZodError` into the field-level list the error envelope publishes.
 *
 * Exported because the SSE and queue paths validate too, and a second formatter would
 * mean two different error shapes for the same class of mistake.
 */
export function toValidationError(error: z.ZodError, where: string): ValidationError {
  const issues = error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
    code: issue.code,
  }));

  return new ValidationError({
    message: `${where} failed validation`,
    context: { where, issues },
    issues: issues.map((issue) => `${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`),
  });
}

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  readonly #schema: z.ZodType | null;

  constructor(schema?: z.ZodType) {
    this.#schema = schema ?? null;
  }

  /**
   * The globally-registered form.
   *
   * Validates anything whose declared type carries a `zodSchema` and gets out of the
   * way otherwise, so that binding it via `APP_PIPE` is safe for every argument in the
   * app including path parameters the controller has already narrowed.
   */
  static passthrough(): ZodValidationPipe {
    return new ZodValidationPipe();
  }

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema =
      this.#schema ?? (carriesSchema(metadata.metatype) ? metadata.metatype.zodSchema : null);
    if (schema === null) return value;

    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;

    throw toValidationError(
      parsed.error,
      `${metadata.type}${metadata.data === undefined ? '' : `.${metadata.data}`}`,
    );
  }
}
