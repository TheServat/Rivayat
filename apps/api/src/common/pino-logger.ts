/**
 * The `Logger` port from `@rv/shared-kernel`, over pino.
 *
 * The port exists so that domain and application code can be loggable without being
 * coupled to a logging library; this file is the one place the library is named, which
 * is the same reason `@rv/providers` is the only place a vendor SDK is named.
 *
 * Argument order is deliberately the port's (`message`, `fields`) and not pino's
 * (`fields`, `message`). Flipping it here rather than at three hundred call sites is
 * the entire value of having a port.
 */

import type { LogFields, LogLevel, Logger } from '@rv/shared-kernel';
import { pino, type Logger as PinoLogger } from 'pino';

/** Keys whose value is replaced with `[redacted]` wherever they appear. */
const REDACTED_PATHS = [
  'apiKey',
  'authToken',
  'token',
  '*.apiKey',
  '*.authToken',
  'req.headers.authorization',
];

export interface PinoAdapterOptions {
  readonly level: LogLevel;
  /**
   * Pretty single-line output instead of NDJSON.
   *
   * Off by default and off in tests: a test that fails should print an assertion, not
   * four hundred lines of request log.
   */
  readonly pretty?: boolean;
  readonly destination?: NodeJS.WritableStream;
}

/** Builds the underlying pino instance the Nest HTTP logger and this adapter share. */
export function createPinoLogger(options: PinoAdapterOptions): PinoLogger {
  const base = {
    level: options.level,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    // `null`, not `undefined`: pino reads `base: null` as "emit no pid and no
    // hostname", and omitting the key means "emit both". This is a local-first
    // single-process tool, so both are noise in a terminal.
    base: null,
  };
  return options.destination === undefined ? pino(base) : pino(base, options.destination);
}

export class PinoLoggerAdapter implements Logger {
  readonly #pino: PinoLogger;

  constructor(instance: PinoLogger) {
    this.#pino = instance;
  }

  trace(message: string, fields?: LogFields): void {
    this.#pino.trace(fields ?? {}, message);
  }

  debug(message: string, fields?: LogFields): void {
    this.#pino.debug(fields ?? {}, message);
  }

  info(message: string, fields?: LogFields): void {
    this.#pino.info(fields ?? {}, message);
  }

  warn(message: string, fields?: LogFields): void {
    this.#pino.warn(fields ?? {}, message);
  }

  error(message: string, fields?: LogFields): void {
    this.#pino.error(fields ?? {}, message);
  }

  child(fields: LogFields): Logger {
    return new PinoLoggerAdapter(this.#pino.child(fields));
  }
}
