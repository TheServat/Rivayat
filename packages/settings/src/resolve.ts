/**
 * Layered resolution, with provenance.
 *
 * Architecture 7b: "The UI shows **which layer a value came from**, because 'why is
 * this model being used' is otherwise unanswerable once four layers exist." That
 * sentence is the whole reason `resolve` returns a record rather than a value. A
 * resolver that returned only the winner would be half a feature: correct, and unable
 * to explain itself at the exact moment someone is asking it to.
 *
 * A layer value that fails its schema is **skipped, not fatal**. The global and project
 * layers are database rows that an older version of the app wrote; a settings screen
 * that refuses to open because one stored value no longer parses cannot be used to fix
 * that value. The rejected value is reported on `ignored` instead, so the UI can show
 * "this project stores an invalid value for X, currently falling back to Y".
 */

import {
  type AnySettingDescriptor,
  SETTINGS_REGISTRY,
  type SettingKey,
  type SettingOrigin,
  type SettingScope,
  type SettingValueOf,
  isVisible,
  settingFor,
} from '@rv/contracts';

import { DEFAULT_ORIGIN, type SettingsLayer, orderedLayers } from './layers';

/** A value a layer held and the resolver refused. */
export interface IgnoredLayerValue {
  readonly scope: SettingScope;
  /** Dotted paths of the schema issues, not their wording. Wording is not actionable. */
  readonly issuePaths: readonly string[];
  readonly message: string;
}

/** One setting, resolved, with the evidence for how it got that way. */
export interface ResolvedSetting<TValue = unknown> {
  readonly key: string;
  readonly value: TValue;
  /** Which layer supplied `value`. `'default'` when no layer did. */
  readonly origin: SettingOrigin;
  /** Layers that held a value for this key and were overruled by a later one. */
  readonly shadowed: readonly SettingScope[];
  /** Layers whose stored value failed the schema and was skipped. */
  readonly ignored: readonly IgnoredLayerValue[];
}

/** Every setting, resolved. Keyed by setting key, in registry order. */
export type ResolvedSettings = ReadonlyMap<string, ResolvedSetting>;

/**
 * Resolves one setting through the stack.
 *
 * Total for a known key, which is why it returns a value rather than a `Result`:
 * `SettingKey` is the key set of the registry, so "no such setting" is a compile error
 * and not a runtime outcome. Genuinely dynamic keys go through {@link resolveUnknown}.
 */
export function resolve<K extends SettingKey>(
  key: K,
  layers: readonly SettingsLayer[],
): ResolvedSetting<SettingValueOf<K>> {
  const resolved = resolveDescriptor(settingFor(key), layers);
  // The descriptor for `K` carries `SettingValueOf<K>`, and every value that reaches
  // `resolved.value` has been through that descriptor's own schema.
  return resolved as ResolvedSetting<SettingValueOf<K>>;
}

/**
 * Resolves a key that arrived as a string - from a URL, a patch body, a log filter.
 *
 * `null` for a key the registry does not declare. Separate from {@link resolve} so the
 * typed path stays total and only the genuinely dynamic caller pays for the check.
 */
export function resolveUnknown(
  key: string,
  layers: readonly SettingsLayer[],
): ResolvedSetting | null {
  const descriptor = SETTINGS_REGISTRY.find((candidate) => candidate.key === key);
  return descriptor === undefined ? null : resolveDescriptor(descriptor, layers);
}

/**
 * Resolves everything, once, sharing a single ordered pass over the stack.
 *
 * The settings screen needs all of it and the visibility rules need most of it, so the
 * per-key path would re-sort the stack sixty times for one render.
 */
export function resolveAll(layers: readonly SettingsLayer[]): ResolvedSettings {
  const ordered = orderedLayers(layers);
  const resolved = new Map<string, ResolvedSetting>();
  for (const descriptor of SETTINGS_REGISTRY) {
    resolved.set(descriptor.key, resolveOrdered(descriptor, ordered));
  }
  return resolved;
}

/**
 * The settings a user would actually see, with the hidden ones dropped.
 *
 * Visibility is computed against resolved values, so it has to happen after resolution
 * and not during it - `image.comfyui.authToken` is hidden by what `image.lane` resolves
 * to, which the resolver does not know while it is resolving the token.
 */
export function visibleSettings(resolvedSettings: ResolvedSettings): readonly ResolvedSetting[] {
  const valueOf = (key: string): unknown => resolvedSettings.get(key)?.value;
  return SETTINGS_REGISTRY.filter((descriptor) => isVisible(descriptor, valueOf)).flatMap(
    (descriptor) => {
      const entry = resolvedSettings.get(descriptor.key);
      return entry === undefined ? [] : [entry];
    },
  );
}

// ── what one layer changes ──────────────────────────────────────────────────

/** One key a layer overrides, and what it would have been without it. */
export interface SettingOverride {
  readonly key: string;
  /** The value this layer stores. */
  readonly value: unknown;
  /** What the key would resolve to if this layer were removed. */
  readonly inherited: unknown;
  /** Where `inherited` would come from. */
  readonly inheritedFrom: SettingOrigin;
  /**
   * Whether this layer's value is the one in effect.
   *
   * `false` when a more specific layer overrides it - a project setting shadowed by a
   * run override. Worth surfacing: "I changed it and nothing happened" is otherwise
   * indistinguishable from "the change did not save".
   */
  readonly effective: boolean;
}

/**
 * What one layer actually changes, so a project can show only its own overrides.
 *
 * The alternative - showing sixty rows of inherited values with four of them subtly
 * marked - is how a project's real configuration becomes invisible.
 */
export function diff(layers: readonly SettingsLayer[], scope: SettingScope): SettingOverride[] {
  const ordered = orderedLayers(layers);
  const without = ordered.filter((candidate) => candidate.scope !== scope);
  const mine = ordered.filter((candidate) => candidate.scope === scope);

  const overrides: SettingOverride[] = [];
  for (const descriptor of SETTINGS_REGISTRY) {
    if (!mine.some((candidate) => hasOwn(candidate.values, descriptor.key))) continue;

    const withLayer = resolveOrdered(descriptor, ordered);
    // Either this layer's value won, or it won and was then shadowed by a more specific
    // one. Neither means the value was rejected by the schema - and a layer storing a
    // value the schema refuses is not overriding anything, it is storing rubbish, which
    // `ResolvedSetting.ignored` already reports.
    const accepted = withLayer.origin === scope || withLayer.shadowed.includes(scope);
    if (!accepted) continue;

    const withoutLayer = resolveOrdered(descriptor, without);
    overrides.push({
      key: descriptor.key,
      value: lastValue(mine, descriptor.key),
      inherited: withoutLayer.value,
      inheritedFrom: withoutLayer.origin,
      effective: withLayer.origin === scope,
    });
  }
  return overrides;
}

// ── the single pass ─────────────────────────────────────────────────────────

function resolveDescriptor(
  descriptor: AnySettingDescriptor,
  layers: readonly SettingsLayer[],
): ResolvedSetting {
  return resolveOrdered(descriptor, orderedLayers(layers));
}

/**
 * The actual resolution, over an already-ordered stack.
 *
 * Walks least-specific to most-specific and keeps overwriting, rather than walking
 * backwards and stopping at the first hit, because the shadowed list is part of the
 * answer: knowing that a project value exists and lost to a run override is exactly the
 * question "why is this model being used" turns into.
 */
function resolveOrdered(
  descriptor: AnySettingDescriptor,
  ordered: readonly SettingsLayer[],
): ResolvedSetting {
  let value: unknown = descriptor.default;
  let origin: SettingOrigin = DEFAULT_ORIGIN;
  const shadowed: SettingScope[] = [];
  const ignored: IgnoredLayerValue[] = [];

  for (const candidate of ordered) {
    if (!hasOwn(candidate.values, descriptor.key)) continue;

    const parsed = descriptor.schema.safeParse(candidate.values[descriptor.key]);
    if (!parsed.success) {
      ignored.push({
        scope: candidate.scope,
        issuePaths: parsed.error.issues.map((issue) => issue.path.join('.')),
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
      });
      continue;
    }

    if (origin !== DEFAULT_ORIGIN) shadowed.push(origin);
    value = parsed.data;
    origin = candidate.scope;
  }

  return { key: descriptor.key, value, origin, shadowed, ignored };
}

/**
 * Own-property check, not `!== undefined`.
 *
 * A layer that explicitly stores `null` for `budget.perRunNanoUsd` means "no ceiling",
 * which is a different answer from "this layer says nothing" - and `undefined` from a
 * missing key would silently become the second.
 */
function hasOwn(values: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(values, key);
}

/** The value the last layer of a given scope holds for a key. */
function lastValue(layers: readonly SettingsLayer[], key: string): unknown {
  let found: unknown;
  for (const candidate of layers) {
    if (hasOwn(candidate.values, key)) found = candidate.values[key];
  }
  return found;
}
