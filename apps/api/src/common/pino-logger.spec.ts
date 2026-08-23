/**
 * The logger adapter, and the one thing it must never do.
 *
 * Redaction is the reason this file has tests at all. `AppErrorOptions.context` says
 * "must not contain secrets", and that is a rule people break by accident - an adapter
 * logging the options object it was constructed with, say. The redact list is the
 * backstop, and a backstop nobody exercises is a comment.
 *
 * The argument order is the other reason: the port is `(message, fields)` and pino is
 * `(fields, message)`. Getting that backwards produces logs that look almost right,
 * with the message in a field called `msg` that says `[object Object]`.
 */

import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { PinoLoggerAdapter, createPinoLogger } from './pino-logger';

/** Collects NDJSON lines as parsed objects. */
function capture(): { readonly stream: Writable; readonly lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function build(level: 'trace' | 'info' = 'trace'): {
  readonly logger: PinoLoggerAdapter;
  readonly lines: () => Record<string, unknown>[];
} {
  const sink = capture();
  return {
    logger: new PinoLoggerAdapter(createPinoLogger({ level, destination: sink.stream })),
    lines: sink.lines,
  };
}

describe('PinoLoggerAdapter', () => {
  it('writes the message under `msg` and the fields beside it', () => {
    const { logger, lines } = build();
    logger.info('providers registered', { registered: 2 });

    const [record] = lines();
    expect(record?.msg).toBe('providers registered');
    expect(record?.registered).toBe(2);
  });

  it('accepts a call with no fields at all', () => {
    const { logger, lines } = build();
    for (const level of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
      logger[level](`${level} with nothing`);
    }
    expect(lines()).toHaveLength(5);
  });

  it('emits every level at or above the configured one, and none below', () => {
    const { logger, lines } = build('info');
    logger.trace('invisible');
    logger.debug('invisible');
    logger.info('visible');
    logger.warn('visible');
    logger.error('visible');

    expect(lines().map((record) => record.msg)).toEqual(['visible', 'visible', 'visible']);
  });

  it('carries a child logger’s fields onto every subsequent record', () => {
    const { logger, lines } = build();
    logger.child({ component: 'queue' }).warn('job failed', { jobId: 'job_1' });

    const [record] = lines();
    expect(record).toMatchObject({ component: 'queue', jobId: 'job_1', msg: 'job failed' });
  });

  it('redacts a secret wherever it appears, including one level down', () => {
    const { logger, lines } = build();
    logger.info('wiring', {
      apiKey: 'sk-should-never-appear',
      gemini: { apiKey: 'sk-nor-this' },
      authToken: 'tok-nor-this',
    });

    const serialised = JSON.stringify(lines());
    expect(serialised).not.toContain('sk-should-never-appear');
    expect(serialised).not.toContain('sk-nor-this');
    expect(serialised).not.toContain('tok-nor-this');
    expect(serialised).toContain('[redacted]');
  });

  it('omits pid and hostname, which are noise in a single-process tool', () => {
    const { logger, lines } = build();
    logger.info('hello');

    const [record] = lines();
    expect(record).not.toHaveProperty('pid');
    expect(record).not.toHaveProperty('hostname');
  });

  it('builds without a destination, which is what production does', () => {
    // Exercised rather than asserted on: the point is that the default branch of the
    // factory constructs at all, since `main.ts` takes it and nothing else would catch
    // a bad option object until the first log line in production.
    expect(() => createPinoLogger({ level: 'error' })).not.toThrow();
  });
});
