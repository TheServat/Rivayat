/**
 * `@rv/settings` - the resolver behind architecture 7b.
 *
 * `@rv/contracts` declares *what* can be configured; this package answers *what it
 * currently is*, and - because four layers make "why is this model being used"
 * unanswerable otherwise - *which layer said so*.
 *
 * Four things live here and nothing else does:
 *
 *  - **resolution** with provenance (`resolve`, `resolveAll`, `diff`),
 *  - **redaction**, so a secret never reaches a client (`redactForClient`),
 *  - **validation** of an incoming patch, reporting every fault at once (`applyPatch`),
 *  - **the machine layer**, read from an injected environment (`loadMachineLayer`).
 *
 * The storage port is declared in `ports/` and implemented in `@rv/persistence`.
 */

export type { SettingValues, SettingsLayer } from './layers';
export { DEFAULT_ORIGIN, layer, orderedLayers } from './layers';

export type {
  IgnoredLayerValue,
  ResolvedSetting,
  ResolvedSettings,
  SettingOverride,
} from './resolve';
export { diff, resolve, resolveAll, resolveUnknown, visibleSettings } from './resolve';

export type { ClientSetting } from './redact';
export { redactForClient, redactSetting } from './redact';

export type { SettingIssue, SettingIssueCode, SettingsPatch } from './patch';
export { SETTING_ISSUE_CODES, SettingsPatchError, applyPatch } from './patch';

export type { EnvSource, EnvWarning, MachineLayerLoad } from './env';
export {
  REGISTERED_ENV_VARS,
  REGISTERED_RV_ENV_VARS,
  RV_ENV_PREFIX,
  envBindingFor,
  loadMachineLayer,
  unknownRvVars,
} from './env';

export type * from './ports/index';
