import { describe, expect, it } from 'vitest';

import {
  OUTLINE_LEVELS,
  checkSingleLevelDescent,
  childLevelOf,
  levelDistance,
  parentLevelOf,
} from './levels';

describe('outline levels', () => {
  it('matches the seven-level hierarchy in docs/02 §1', () => {
    expect(OUTLINE_LEVELS).toEqual([
      'series',
      'season',
      'episode',
      'act',
      'sequence',
      'scene',
      'beat',
    ]);
  });

  it('walks down and back up again', () => {
    for (const level of OUTLINE_LEVELS) {
      const child = childLevelOf(level);
      if (child !== undefined) expect(parentLevelOf(child)).toBe(level);
    }
    expect(childLevelOf('beat')).toBeUndefined();
    expect(parentLevelOf('series')).toBeUndefined();
  });

  it('measures the gap in both directions', () => {
    expect(levelDistance('season', 'episode')).toBe(1);
    expect(levelDistance('season', 'scene')).toBe(4);
    expect(levelDistance('scene', 'season')).toBe(-4);
  });
});

describe('checkSingleLevelDescent', () => {
  it('permits exactly one level down', () => {
    expect(checkSingleLevelDescent('episode', 'act')).toBeUndefined();
  });

  it('refuses a jump, and says how far the caller tried to go', () => {
    const error = checkSingleLevelDescent('season', 'scene');
    expect(error?.context).toMatchObject({ reason: 'outline-level-skip', distance: 4 });
    expect(error?.message).toContain('one level at a time');
  });

  it('refuses a sideways or upward target', () => {
    expect(checkSingleLevelDescent('act', 'season')?.context).toMatchObject({
      reason: 'outline-level-skip',
    });
    expect(checkSingleLevelDescent('act', 'act')?.context).toMatchObject({
      reason: 'outline-level-skip',
    });
  });

  it('refuses to expand the leaf', () => {
    expect(checkSingleLevelDescent('beat', 'beat')?.context).toMatchObject({
      reason: 'no-child-level',
    });
  });
});
