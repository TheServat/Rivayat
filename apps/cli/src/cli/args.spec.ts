import { describe, expect, it } from 'vitest';

import { flag, option, optionList, parseArgs, positional } from './args';

describe('parseArgs', () => {
  it('separates positionals from options', () => {
    const args = parseArgs(['new', 'دهکده', '--lang', 'fa']);
    expect(args.positionals).toEqual(['new', 'دهکده']);
    expect(option(args, 'lang')).toBe('fa');
  });

  it('accepts the --name=value spelling', () => {
    const args = parseArgs(['--preset=ink-comic', '--lane=free']);
    expect(option(args, 'preset')).toBe('ink-comic');
    expect(option(args, 'lane')).toBe('free');
  });

  it('accumulates a repeated option instead of keeping only the last', () => {
    const args = parseArgs(['--format', 'reels-9x16', '--format', 'tiktok-9x16']);
    expect(optionList(args, 'format')).toEqual(['reels-9x16', 'tiktok-9x16']);
  });

  it('does not let a declared boolean swallow the positional after it', () => {
    const args = parseArgs(['--strict', 'broken.rvanim.json'], { booleans: ['strict'] });
    expect(flag(args, 'strict')).toBe(true);
    expect(positional(args, 0)).toBe('broken.rvanim.json');
  });

  it('treats an undeclared name with no value as a flag and records it as dangling', () => {
    const args = parseArgs(['--verbose']);
    expect(flag(args, 'verbose')).toBe(true);
    expect(args.danglingOptions).toEqual(['verbose']);
  });

  it('stops interpreting flags after a bare --', () => {
    const args = parseArgs(['run', '--', '--not-a-flag']);
    expect(args.positionals).toEqual(['run', '--not-a-flag']);
    expect(flag(args, 'not-a-flag')).toBe(false);
  });

  it('reads --name=true as the flag being set', () => {
    expect(flag(parseArgs(['--json=true']), 'json')).toBe(true);
    expect(flag(parseArgs(['--json=false']), 'json')).toBe(false);
  });

  it('is total on an empty argv', () => {
    const args = parseArgs([]);
    expect(args.positionals).toEqual([]);
    expect(args.flags.size).toBe(0);
    expect(option(args, 'anything')).toBeUndefined();
    expect(optionList(args, 'anything')).toEqual([]);
  });
});
