import type { ErrorKind } from '@rv/shared-kernel';

import type { ApiError } from './errors';

/**
 * Server error to message-catalogue key.
 *
 * A key rather than a rendered string, because an error may be constructed long before
 * it is displayed and the user may switch language in between. The server's own
 * `message` is never the headline: it is English prose written for a log, and the
 * person reading this screen works in Persian. It still appears, as a detail line -
 * dropping it would make a provider failure undiagnosable.
 *
 * A literal map rather than string interpolation, so that `vue-i18n` can check every
 * key against the catalogue: an interpolated `errors.kind.${kind}` would type as
 * `string` and slip a typo past the compiler, which is the failure the typed catalogue
 * exists to catch.
 */
const KIND_KEYS = {
  validation: 'errors.kind.validation',
  'not-found': 'errors.kind.not-found',
  conflict: 'errors.kind.conflict',
  unsupported: 'errors.kind.unsupported',
  provider: 'errors.kind.provider',
  timeout: 'errors.kind.timeout',
  'rate-limit': 'errors.kind.rate-limit',
  budget: 'errors.kind.budget',
  cancelled: 'errors.kind.cancelled',
  internal: 'errors.kind.internal',
} as const satisfies Record<ErrorKind, string>;

export type ErrorMessageKey =
  (typeof KIND_KEYS)[ErrorKind] | 'errors.network' | 'errors.schemaMismatch' | 'errors.unexpected';

export function errorMessageKey(error: ApiError): ErrorMessageKey {
  if (error.failure === 'network') return 'errors.network';
  if (error.failure === 'schema') return 'errors.schemaMismatch';
  if (error.kind === null) return 'errors.unexpected';
  return KIND_KEYS[error.kind];
}
