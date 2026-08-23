/**
 * Logging as a port.
 *
 * `shared-kernel` defines the shape and two test doubles. The real implementation
 * (pino) lives in infrastructure - the domain and application layers must be
 * loggable without being coupled to a logging library.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export function isLevelEnabled(configured: LogLevel, candidate: LogLevel): boolean {
  return LEVEL_ORDER[candidate] >= LEVEL_ORDER[configured];
}

/** Structured fields. Keep them flat and serialisable; never put secrets here. */
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that carries `fields` on every subsequent record. */
  child(fields: LogFields): Logger;
}

export class NoopLogger implements Logger {
  trace(_message: string, _fields?: LogFields): void {
    // Intentionally empty: this logger exists to be discarded.
  }
  debug(_message: string, _fields?: LogFields): void {
    // Intentionally empty: this logger exists to be discarded.
  }
  info(_message: string, _fields?: LogFields): void {
    // Intentionally empty: this logger exists to be discarded.
  }
  warn(_message: string, _fields?: LogFields): void {
    // Intentionally empty: this logger exists to be discarded.
  }
  error(_message: string, _fields?: LogFields): void {
    // Intentionally empty: this logger exists to be discarded.
  }
  /** Returns itself: there is no state to carry. */
  child(_fields?: LogFields): Logger {
    return this;
  }
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * Collects records in memory so tests can assert on them.
 *
 * Assert on the structured fields, not on message text - message wording is
 * cosmetic and should be free to change without breaking a test.
 */
export class MemoryLogger implements Logger {
  readonly records: LogRecord[] = [];
  readonly #bound: LogFields;

  constructor(bound: LogFields = {}) {
    this.#bound = bound;
  }

  #write(level: LogLevel, message: string, fields?: LogFields): void {
    this.records.push({ level, message, fields: { ...this.#bound, ...fields } });
  }

  trace(message: string, fields?: LogFields): void {
    this.#write('trace', message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.#write('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.#write('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.#write('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.#write('error', message, fields);
  }

  /** Children share the parent's record array, so one assertion sees everything. */
  child(fields: LogFields): Logger {
    const child = new MemoryLogger({ ...this.#bound, ...fields });
    Object.defineProperty(child, 'records', { value: this.records });
    return child;
  }

  at(level: LogLevel): readonly LogRecord[] {
    return this.records.filter((record) => record.level === level);
  }

  clear(): void {
    this.records.length = 0;
  }
}
