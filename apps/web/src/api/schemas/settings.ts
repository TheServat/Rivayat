/**
 * The settings wire shapes, composed from the real registry in `@rv/contracts`.
 *
 * This file replaces the settings half of `pending-contracts.ts`. Everything that used
 * to be guessed here is now imported: `SettingDescriptorMeta` is the serialisable half
 * of the declaration architecture 7b describes, `SettingControl` is its discriminated
 * union of controls with their render hints, `SettingGroup` and `SettingScope` and
 * `SettingOrigin` are the real enums. The studio no longer has an opinion about what a
 * setting *is* - only about how to draw one.
 *
 * What remains local is the **envelope**: the `{scope, target, descriptors, values,
 * models, warnings}` document `GET /api/settings` answers with, and the patch it
 * accepts. That is a delivery-layer DTO, and it lives in two places today -
 * `apps/api/src/modules/settings/settings.contracts.ts` is the other, and it is the
 * authority. Both are built from the same `@rv/contracts` pieces, and both parse every
 * payload that crosses them, so a drift is a loud failure rather than a silent one.
 *
 * **Report:** this envelope belongs in `@rv/contracts/src/settings/`, next to the
 * registry it carries, so there is one copy instead of two. It is duplicated because
 * the work that produced it may not edit `packages/**`.
 */

import {
  Capability,
  Label,
  ModelRef,
  ProjectId,
  ProviderKind,
  ProviderModelId,
  RunId,
  SettingDescriptorMeta,
  type SettingGroup,
  SettingKeyPath,
  SettingOrigin,
  SettingScope,
} from '@rv/contracts';
import { z } from 'zod';

export {
  SETTINGS_REGISTRY,
  SETTING_KEYS,
  SettingControl,
  SettingDescriptorMeta,
  SettingGroup,
  SettingOrigin,
  SettingScope,
  isSettingKey,
  isWritableAt,
  originRank,
  settingFor,
  settingsInGroup,
  writableScopes,
} from '@rv/contracts';
export type { AnySettingDescriptor, SettingDependency, SettingOption } from '@rv/contracts';

/**
 * Every panel, in the order the settings screen renders them.
 *
 * A literal tuple rather than `SettingGroup.options`, and checked against the upstream
 * enum two ways: `satisfies` proves every member is a real group, and `MissingGroups`
 * below fails to compile if the registry gains one this list has not heard of. Either
 * error is better than a group that quietly renders no panel.
 */
export const SETTING_GROUPS = [
  'providers',
  'models',
  'image',
  'budget',
  'render',
  'delivery',
  'interface',
  'runtime',
] as const satisfies readonly SettingGroupName[];

type SettingGroupName = z.infer<typeof SettingGroup>;
type MissingGroups = Exclude<SettingGroupName, (typeof SETTING_GROUPS)[number]>;
const _groupsAreExhaustive: MissingGroups extends never ? true : never = true;
void _groupsAreExhaustive;

/** Any JSON value. The descriptor - not this - says which JSON a given key accepts. */
export const SettingJsonValue = z.json();
export type SettingJsonValue = z.infer<typeof SettingJsonValue>;

/** Which project or run the values were resolved for. Both `null` is the global view. */
export const SettingsScopeRef = z.strictObject({
  projectId: ProjectId.nullable().default(null),
  runId: RunId.nullable().default(null),
});
export type SettingsScopeRef = z.infer<typeof SettingsScopeRef>;

/** A stored value the resolver refused, reported rather than hidden. */
export const SettingIgnoredValue = z.strictObject({
  scope: SettingScope,
  issuePaths: z.array(z.string()),
  message: z.string(),
});
export type SettingIgnoredValue = z.infer<typeof SettingIgnoredValue>;

const provenance = {
  key: SettingKeyPath,
  origin: SettingOrigin,
  /** Layers that held a value for this key and lost to a more specific one. */
  shadowed: z.array(SettingScope),
  /** Layers whose stored value failed the schema and was skipped. */
  ignored: z.array(SettingIgnoredValue),
};

/**
 * One setting as the client receives it: the value, and the receipt for it.
 *
 * A discriminated union on `secret`, both halves strict, so "a secret's value" is not a
 * thing that can be spelled *or* parsed. A payload that carried one would fail here, at
 * the boundary, before any component saw it - which is the only place that guarantee is
 * worth anything.
 */
export const SettingValue = z.discriminatedUnion('secret', [
  z.strictObject({ ...provenance, secret: z.literal(false), value: SettingJsonValue }),
  z.strictObject({ ...provenance, secret: z.literal(true), set: z.boolean() }),
]);
export type SettingValue = z.infer<typeof SettingValue>;

/** One model a `model-picker` may offer, as the API's catalogue reports it. */
export const SettingModelChoice = z.strictObject({
  ref: ModelRef,
  provider: ProviderKind,
  model: ProviderModelId,
  label: Label,
  capabilities: z.array(Capability).min(1),
  free: z.boolean(),
  /** One-line price summary. Language-neutral: a price is not a translation. */
  pricing: z.string(),
});
export type SettingModelChoice = z.infer<typeof SettingModelChoice>;

/** Something in `.env` the operator should be told about. */
export const SettingEnvWarning = z.strictObject({
  variable: z.string(),
  reason: z.enum(['unknown', 'unparseable']),
  message: z.string(),
});
export type SettingEnvWarning = z.infer<typeof SettingEnvWarning>;

/** Everything the settings screen renders, in one response. */
export const SettingsSnapshot = z.strictObject({
  scope: SettingsScopeRef,
  /** The layer a write from this view lands on. Derived by the API, never chosen here. */
  target: SettingScope,
  descriptors: z.array(SettingDescriptorMeta),
  values: z.array(SettingValue),
  models: z.array(SettingModelChoice),
  warnings: z.array(SettingEnvWarning),
});
export type SettingsSnapshot = z.infer<typeof SettingsSnapshot>;

/**
 * A batch of edits.
 *
 * Set and clear are separate lists rather than one list with a nullable value, because
 * `null` is a legitimate setting value - `budget.perRunNanoUsd: null` means "no ceiling"
 * - and "clear the override" is not the same request as "store null here".
 */
export const SettingsPatch = z.strictObject({
  scope: SettingsScopeRef,
  set: z.array(z.strictObject({ key: SettingKeyPath, value: SettingJsonValue })).default([]),
  clear: z.array(SettingKeyPath).default([]),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/**
 * The layer a write addresses.
 *
 * `machine` is absent by construction: it is `.env`, the API refuses to store it, and a
 * form that offered to write it would be offering something nothing can honour.
 */
export const WritableSettingsScope = z.enum(['global', 'project', 'run']);
export type WritableSettingsScope = z.infer<typeof WritableSettingsScope>;

/** Whether this layer can be written at all. `machine` is `.env` and never is. */
export function isWritableScope(scope: SettingScope): scope is WritableSettingsScope {
  return scope !== 'machine';
}
