/**
 * Writing settings: validate everything, reject as a whole, report every fault.
 *
 * The requirement that shapes this file is that a settings form must be able to mark
 * **every** bad field at once. A validator that returns the first error turns fixing
 * three mistakes into three round trips, and the third one is where the user gives up.
 * So `applyPatch` collects, never short-circuits, and the failure carries a list.
 *
 * It is also all-or-nothing. A patch is one form submission; applying the half that
 * parsed would leave the machine in a state the user never chose and cannot see,
 * because the form would re-render showing exactly what they typed.
 */

import { ValidationError, type Result, err, ok } from '@rv/shared-kernel';
import {
  type SettingScope,
  isSettingKey,
  isWritableAt,
  settingFor,
  writableScopes,
} from '@rv/contracts';

import { type SettingValues, type SettingsLayer, layer } from './layers';

/** Why one key in a patch was refused. */
export const SETTING_ISSUE_CODES = [
  /** No descriptor declares this key. */
  'unknown-key',
  /** The key exists but may not be written at the patch's scope. */
  'scope-violation',
  /** A secret was offered anywhere but the machine layer. */
  'secret-scope',
  /** The value does not satisfy the setting's own schema. */
  'invalid-value',
] as const;
export type SettingIssueCode = (typeof SETTING_ISSUE_CODES)[number];

/** One refused key. */
export interface SettingIssue {
  readonly key: string;
  readonly code: SettingIssueCode;
  readonly message: string;
  /**
   * Dotted paths inside the value, for a structured setting.
   *
   * Empty for a scalar. Present so a form editing `delivery.formats` can highlight the
   * third entry rather than the whole field.
   */
  readonly paths: readonly string[];
}

/** A patch, as it arrives from the API. */
export interface SettingsPatch {
  /** The layer being written. */
  readonly scope: SettingScope;
  /** The project or run being written. `null` for machine and global. */
  readonly scopeId: string | null;
  /** Raw values, straight off the wire. */
  readonly values: SettingValues;
}

/**
 * A rejected patch, carrying every fault.
 *
 * A subclass rather than a bare list so it flows through the same `Result<T, AppError>`
 * every other failure in the codebase uses, while `issues` stays a typed field instead
 * of an untyped blob inside `context`. The API renders `issues`; the log renders the
 * error.
 */
export class SettingsPatchError extends ValidationError {
  readonly issues: readonly SettingIssue[];

  constructor(issues: readonly SettingIssue[]) {
    super({
      message: `Settings patch rejected: ${String(issues.length)} invalid ${
        issues.length === 1 ? 'entry' : 'entries'
      }.`,
      context: { keys: issues.map((issue) => issue.key) },
    });
    this.issues = issues;
  }
}

/**
 * Validates and coerces a patch into a layer ready to store.
 *
 * The returned layer holds **parsed** values, not the raw input: coercion is part of
 * validation, and handing back the input would mean the value that gets stored is not
 * the value that was checked.
 */
export function applyPatch(patch: SettingsPatch): Result<SettingsLayer, SettingsPatchError> {
  const issues: SettingIssue[] = [];
  const accepted: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(patch.values)) {
    if (!isSettingKey(key)) {
      issues.push({
        key,
        code: 'unknown-key',
        message: 'No setting is declared under this key.',
        paths: [],
      });
      continue;
    }

    const descriptor = settingFor(key);

    if (!isWritableAt(descriptor, patch.scope)) {
      issues.push({
        key,
        // A secret refused above the machine layer gets its own code, because the fix
        // is different: "move it to .env", not "write it at a broader scope".
        code: descriptor.secret ? 'secret-scope' : 'scope-violation',
        message: descriptor.secret
          ? 'A secret can only be set on the machine layer.'
          : `This setting can only be set at: ${writableScopes(descriptor).join(', ')}.`,
        paths: [],
      });
      continue;
    }

    const parsed = descriptor.schema.safeParse(raw);
    if (!parsed.success) {
      issues.push({
        key,
        code: 'invalid-value',
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
        // Paths, not wording: a path says which field is wrong, which is what a form
        // can act on.
        paths: parsed.error.issues.map((issue) => issue.path.join('.')).filter((p) => p.length > 0),
      });
      continue;
    }

    accepted[key] = parsed.data;
  }

  if (issues.length > 0) return err(new SettingsPatchError(issues));
  return ok(layer(patch.scope, accepted, patch.scopeId));
}
