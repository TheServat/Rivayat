/**
 * `@rv/shared-kernel` - the bottom of the dependency graph.
 *
 * Everything here is pure, dependency-free, and deterministic-by-construction. If
 * something needs the network, the filesystem, or a vendor SDK, it does not belong
 * in this package.
 */

export type { Brand, Unbrand, BrandedFactory } from './brand';
export { defineBrand } from './brand';

export type { Result, Ok, Err, Unit } from './result';
export {
  UNIT,
  ok,
  err,
  isOk,
  isErr,
  map,
  mapErr,
  andThen,
  orElse,
  tap,
  tapErr,
  unwrapOr,
  unwrapOrElse,
  unwrap,
  all,
  partition,
  fromThrowable,
  fromPromise,
} from './result';

export type { ErrorKind, AppErrorOptions, SerialisedError } from './errors';
export {
  AppError,
  isAppError,
  isRetryable,
  toAppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  UnsupportedCapabilityError,
  ProviderError,
  TimeoutError,
  RateLimitError,
  BudgetExceededError,
  CancelledError,
  InternalError,
} from './errors';

export { invariant, require_, isDefined, assertDefined, assertNever, at, must } from './guard';

export type { Instant, Millis, Clock } from './clock';
export {
  instant,
  millis,
  toIso,
  fromIso,
  addMillis,
  since,
  SystemClock,
  FixedClock,
} from './clock';

export type { Ulid, PrefixedId } from './id';
export { IdGenerator, isPrefixedId, prefixOf, timestampOf } from './id';

export type { Sha256, JsonValue, JsonPrimitive } from './hash';
export { sha256, shortHash, shardPath, stableStringify, contentHash, compositeHash } from './hash';

export type { Seed, Rng } from './rng';
export { createRng, hashSeed } from './rng';

export type { NanoUsd } from './money';
export {
  ZERO_USD,
  nanoUsd,
  fromUsd,
  toUsd,
  addUsd,
  subUsd,
  sumUsd,
  scaleUsd,
  compareUsd,
  maxUsd,
  priceFor,
  formatUsd,
} from './money';

export type { LogLevel, LogFields, Logger, LogRecord } from './logger';
export { LOG_LEVELS, isLevelEnabled, NoopLogger, MemoryLogger } from './logger';
