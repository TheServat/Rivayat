/**
 * The machine layer: `.env`, turned into settings.
 *
 * Two decisions carry the value of this file.
 *
 * **The environment is injected, never read.** `loadMachineLayer` takes a
 * `process.env`-shaped object. Reading `process.env` here would make the loader
 * untestable without mutating global state, and would put a hidden dependency on the
 * host inside a package the domain layer can see.
 *
 * **An unrecognised `RV_*` variable is a warning, not silence.** A typo'd env var that
 * does nothing is the exact failure the registry exists to prevent: the operator sets
 * `RV_BUDGET_USD_PER_RUN` as `RV_BUDGET_PER_RUN_USD`, nothing complains, and the budget
 * guard runs on the default. Only the `RV_` namespace is policed, because
 * `OLLAMA_HOST`, `GEMINI_API_KEY` and `HF_TOKEN` are third-party conventions we share a
 * process with and did not name.
 */

import { SETTINGS_REGISTRY, type SettingEnvFormat, type SettingEnvBinding } from '@rv/contracts';

import { type SettingsLayer, layer } from './layers';

/** The namespace this application owns. Anything else in the environment is not ours. */
export const RV_ENV_PREFIX = 'RV_';

/** A `process.env`-shaped input. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Something that was in the environment and should not have been, or could not be read. */
export interface EnvWarning {
  readonly variable: string;
  readonly reason: 'unknown' | 'unparseable';
  readonly message: string;
}

export interface MachineLayerLoad {
  readonly layer: SettingsLayer;
  /** Everything the operator should be told about. Never throws; always reports. */
  readonly warnings: readonly EnvWarning[];
}

/** Every `RV_*` variable the registry claims, in declaration order. */
export const REGISTERED_RV_ENV_VARS: readonly string[] = SETTINGS_REGISTRY.flatMap((descriptor) =>
  descriptor.env?.name.startsWith(RV_ENV_PREFIX) === true ? [descriptor.env.name] : [],
);

/** Every environment variable the registry reads, `RV_*` or otherwise. */
export const REGISTERED_ENV_VARS: readonly string[] = SETTINGS_REGISTRY.flatMap((descriptor) =>
  descriptor.env === undefined ? [] : [descriptor.env.name],
);

/**
 * Reads the machine layer out of an environment.
 *
 * Coerces per the descriptor's declared `format`, skips anything blank, and reports
 * rather than throws: a single malformed variable must not stop the process from
 * starting, or an operator with a typo has no working UI to fix the typo in.
 */
export function loadMachineLayer(env: EnvSource): MachineLayerLoad {
  const values: Record<string, unknown> = {};
  const warnings: EnvWarning[] = [];

  for (const descriptor of SETTINGS_REGISTRY) {
    const binding = descriptor.env;
    if (binding === undefined) continue;

    const raw = env[binding.name];
    // A blank value is the documented way `.env.example` spells "not configured"
    // (`GEMINI_API_KEY=`). Treating it as an empty string would override the default
    // with nothing and report the credential as present.
    if (raw === undefined || raw.trim().length === 0) continue;

    const coerced = coerce(raw.trim(), binding.format);
    if (coerced === UNPARSEABLE) {
      warnings.push({
        variable: binding.name,
        reason: 'unparseable',
        message: `Expected ${describeFormat(binding.format)}, got "${raw}". Falling back to the default.`,
      });
      continue;
    }

    const parsed = descriptor.schema.safeParse(coerced);
    if (!parsed.success) {
      warnings.push({
        variable: binding.name,
        reason: 'unparseable',
        message: `${parsed.error.issues.map((issue) => issue.message).join('; ')}. Falling back to the default.`,
      });
      continue;
    }

    values[descriptor.key] = parsed.data;
  }

  for (const variable of unknownRvVars(env)) {
    warnings.push({
      variable,
      reason: 'unknown',
      message: 'No setting reads this variable. Check it against the settings registry.',
    });
  }

  return { layer: layer('machine', values), warnings };
}

/**
 * `RV_*` variables present in the environment that no descriptor claims.
 *
 * Exported so a startup banner and the `.env.example` drift test can ask the same
 * question of two different inputs.
 */
export function unknownRvVars(env: EnvSource): readonly string[] {
  const claimed = new Set(REGISTERED_RV_ENV_VARS);
  return Object.keys(env)
    .filter((name) => name.startsWith(RV_ENV_PREFIX) && !claimed.has(name))
    .sort();
}

// ── coercion ────────────────────────────────────────────────────────────────

/**
 * A sentinel, because `null` and `undefined` are both legitimate coerced values.
 *
 * `RV_BUDGET_USD_PER_RUN=` is a real "no ceiling", and a coercion failure reported as
 * `null` would silently become one.
 */
const UNPARSEABLE = Symbol('unparseable');

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/** Nano-dollars per dollar. The one place the `.env` unit meets the ledger unit. */
const NANOS_PER_USD = 1_000_000_000;

function coerce(raw: string, format: SettingEnvFormat): unknown {
  switch (format) {
    case 'string':
      return raw;

    case 'integer': {
      // `Number.parseInt` would read "3abc" as 3 and "1e5" as 1. An env var that is
      // *nearly* a number is a mistake, not an approximation.
      if (!/^-?\d+$/.test(raw)) return UNPARSEABLE;
      return Number(raw);
    }

    case 'boolean': {
      const lower = raw.toLowerCase();
      if (TRUE_WORDS.has(lower)) return true;
      if (FALSE_WORDS.has(lower)) return false;
      return UNPARSEABLE;
    }

    case 'usd-dollars': {
      if (!/^\d+(?:\.\d+)?$/.test(raw)) return UNPARSEABLE;
      // Round after multiplying: 0.07 * 1e9 is 70000000.00000001 in binary floating
      // point, and an un-rounded nano amount fails `NanoUsdAmount`'s integer check.
      return Math.round(Number(raw) * NANOS_PER_USD);
    }
  }
}

function describeFormat(format: SettingEnvFormat): string {
  switch (format) {
    case 'string':
      return 'any text';
    case 'integer':
      return 'a whole number';
    case 'boolean':
      return 'true or false';
    case 'usd-dollars':
      return 'an amount in dollars, e.g. 5.00';
  }
}

/** The declared binding for a key, for a startup banner that wants to name the source. */
export function envBindingFor(key: string): SettingEnvBinding | null {
  return SETTINGS_REGISTRY.find((descriptor) => descriptor.key === key)?.env ?? null;
}
