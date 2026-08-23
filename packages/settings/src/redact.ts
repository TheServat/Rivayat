/**
 * What the client is allowed to see.
 *
 * Architecture 7b: "Secrets live only in the machine layer; the UI can report that a
 * key is *present*, never what it is." That is a one-way door, so it is enforced by the
 * *type* and not only by the code: the secret branch of `ClientSetting` has no `value`
 * property at all. A future edit that tries to pass one through does not slip past
 * review - it fails to compile.
 *
 * The redaction keys off `descriptor.secret`, never off the key's name or the value's
 * shape. Heuristics ("does the key contain `token`") are how the one secret that was
 * named `authorization` gets published.
 */

import { SETTINGS_REGISTRY, type SettingOrigin, settingFor, isSettingKey } from '@rv/contracts';

import type { ResolvedSetting, ResolvedSettings } from './resolve';

/**
 * One setting as the client receives it.
 *
 * A discriminated union rather than an optional `value`, so "a secret's value" is not a
 * thing that can be spelled.
 */
export type ClientSetting =
  | {
      readonly key: string;
      readonly secret: false;
      readonly origin: SettingOrigin;
      readonly value: unknown;
    }
  | {
      readonly key: string;
      readonly secret: true;
      readonly origin: SettingOrigin;
      /**
       * Whether a value exists at all.
       *
       * The only bit of information a secret is allowed to emit, and the only one the
       * UI needs: "Gemini key: set" versus "Gemini key: not set" is the whole question a
       * settings screen asks about a credential.
       */
      readonly set: boolean;
    };

/**
 * Whether a resolved secret counts as configured.
 *
 * An empty string is *not* set. Every credential in `.env.example` ships as
 * `GEMINI_API_KEY=` with nothing after it, and reporting that as "set" would tell the
 * operator the lane is configured when the very next provider call will fail
 * unauthenticated.
 */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/** Redacts one resolved setting. */
export function redactSetting(resolved: ResolvedSetting): ClientSetting {
  const secret = isSettingKey(resolved.key) && settingFor(resolved.key).secret;
  if (secret) {
    return {
      key: resolved.key,
      secret: true,
      origin: resolved.origin,
      set: isPresent(resolved.value),
    };
  }
  return { key: resolved.key, secret: false, origin: resolved.origin, value: resolved.value };
}

/**
 * The whole settings screen, safe to send.
 *
 * Registry order, and every declared setting present: a client that has to merge a
 * partial payload against its own idea of the registry is a client with its own idea of
 * the registry.
 */
export function redactForClient(resolvedSettings: ResolvedSettings): readonly ClientSetting[] {
  return SETTINGS_REGISTRY.flatMap((descriptor) => {
    const resolved = resolvedSettings.get(descriptor.key);
    return resolved === undefined ? [] : [redactSetting(resolved)];
  });
}
