import { describe, expect, it } from 'vitest';

import { LOG_LEVELS, MemoryLogger, NoopLogger, isLevelEnabled } from './logger';

describe('level ordering', () => {
  it('lists the levels from most to least verbose', () => {
    expect(LOG_LEVELS).toEqual(['trace', 'debug', 'info', 'warn', 'error']);
  });

  it('enables a level at or above the configured threshold', () => {
    expect(isLevelEnabled('info', 'info')).toBe(true);
    expect(isLevelEnabled('info', 'error')).toBe(true);
    expect(isLevelEnabled('info', 'debug')).toBe(false);
    expect(isLevelEnabled('trace', 'trace')).toBe(true);
    expect(isLevelEnabled('error', 'warn')).toBe(false);
  });
});

describe('NoopLogger', () => {
  it('accepts every call and returns itself as its own child', () => {
    const logger = new NoopLogger();
    expect(() => {
      logger.trace('t');
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
    }).not.toThrow();
    expect(logger.child()).toBe(logger);
  });
});

describe('MemoryLogger', () => {
  it('records level, message and fields', () => {
    const logger = new MemoryLogger();
    logger.info('generated', { assetId: 'a_1', costUsd: 0.03 });

    expect(logger.records).toEqual([
      { level: 'info', message: 'generated', fields: { assetId: 'a_1', costUsd: 0.03 } },
    ]);
  });

  it('records every level', () => {
    const logger = new MemoryLogger();
    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(logger.records.map((r) => r.level)).toEqual(LOG_LEVELS);
  });

  it('defaults fields to the bound context', () => {
    const logger = new MemoryLogger({ run: 'r_1' });
    logger.warn('slow');
    expect(logger.records[0]?.fields).toEqual({ run: 'r_1' });
  });

  it('merges bound fields with per-call fields, per-call winning', () => {
    const logger = new MemoryLogger({ stage: 'story', run: 'r_1' });
    logger.info('m', { stage: 'assets' });
    expect(logger.records[0]?.fields).toEqual({ stage: 'assets', run: 'r_1' });
  });

  it('child inherits and extends the bound fields', () => {
    const parent = new MemoryLogger({ run: 'r_1' });
    parent.child({ stage: 'render' }).info('frame');
    expect(parent.records[0]?.fields).toEqual({ run: 'r_1', stage: 'render' });
  });

  it('child writes into the parent record array so one assertion sees everything', () => {
    const parent = new MemoryLogger();
    const child = parent.child({ a: 1 });
    parent.info('from parent');
    child.info('from child');
    expect(parent.records).toHaveLength(2);
  });

  it('filters by level', () => {
    const logger = new MemoryLogger();
    logger.info('a');
    logger.error('b');
    logger.error('c');
    expect(logger.at('error').map((r) => r.message)).toEqual(['b', 'c']);
    expect(logger.at('debug')).toEqual([]);
  });

  it('clears', () => {
    const logger = new MemoryLogger();
    logger.info('a');
    logger.clear();
    expect(logger.records).toEqual([]);
  });
});
