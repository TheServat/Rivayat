/**
 * The layer stack, and what it means for one layer to hold a value.
 *
 * Architecture 7b: `built-in default -> machine (.env) -> global (DB) -> project ->
 * run override`, later winning. Four writable layers plus the default, which nothing
 * writes and everything falls back to.
 *
 * A layer is a bag of raw values, not of validated ones. That is deliberate: the global
 * and project layers are database rows written by an older version of the app, and a
 * settings screen that throws because one stored value no longer parses is worse than
 * useless - it is unopenable, which is also unfixable. Validation happens during
 * resolution, per key, and a value that fails is *skipped and reported* rather than
 * propagated.
 */

import type { SettingOrigin, SettingScope } from '@rv/contracts';

/**
 * The values authored at one layer, keyed by setting key.
 *
 * `unknown`, not a typed map: this is what came out of `.env` or a JSON column, and
 * pretending otherwise at the boundary is how an unvalidated value reaches a caller
 * that trusted the type.
 */
export type SettingValues = Readonly<Record<string, unknown>>;

/** One layer's contribution to the stack. */
export interface SettingsLayer {
  /** Which layer this is. Reported as the provenance of anything it supplies. */
  readonly scope: SettingScope;
  /**
   * Which project or run these values belong to. `null` for machine and global.
   *
   * Carried on the layer rather than left implicit so a stack assembled from four
   * database reads can be checked, logged and cached by what it is actually about.
   */
  readonly scopeId: string | null;
  readonly values: SettingValues;
}

/** Builds a layer. A convenience, and the one place the empty-values default lives. */
export function layer(
  scope: SettingScope,
  values: SettingValues = {},
  scopeId: string | null = null,
): SettingsLayer {
  return { scope, scopeId, values };
}

const SCOPE_RANK: Readonly<Record<SettingScope, number>> = {
  machine: 1,
  global: 2,
  project: 3,
  run: 4,
};

/**
 * Layers in resolution order, least specific first.
 *
 * Sorting rather than trusting the caller's array order, because a stack is assembled
 * from four independent reads and "the run layer happened to be fetched first" must not
 * change which value wins. `sort` is stable, so two layers of the same scope keep the
 * order they were given and the later one wins - which is the useful reading of a
 * caller that deliberately supplied two.
 */
export function orderedLayers(layers: readonly SettingsLayer[]): readonly SettingsLayer[] {
  return [...layers].sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]);
}

/**
 * The origin to report for a value that no layer supplied.
 *
 * Typed as the literal rather than as `SettingOrigin`, so `origin !== DEFAULT_ORIGIN`
 * narrows the remainder to the four writable scopes. Widening it here would push that
 * narrowing onto every caller, and the usual way of doing it is an assertion.
 */
export const DEFAULT_ORIGIN = 'default' as const satisfies SettingOrigin;
