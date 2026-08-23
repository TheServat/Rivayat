import { describe, expect, it } from 'vitest';

import { EPISODE_STATUSES, EPISODE_STATUS_TRANSITIONS, type EpisodeStatus } from '@rv/contracts';

import {
  TERMINAL_STATUSES,
  canTransition,
  invalidatedBy,
  isCanonFrozen,
  isTerminal,
  pathBetween,
  transition,
} from './episode-lifecycle';

describe('the transition table itself', () => {
  it('has an entry for every status', () => {
    for (const status of EPISODE_STATUSES) {
      expect(EPISODE_STATUS_TRANSITIONS).toHaveProperty(status);
    }
  });

  it('has exactly one terminal status, and it is `aired`', () => {
    expect(TERMINAL_STATUSES).toEqual(['aired']);
    expect(isTerminal('aired')).toBe(true);
    expect(isTerminal('draft')).toBe(false);
  });

  it('reaches every status from draft', () => {
    for (const status of EPISODE_STATUSES) {
      expect(pathBetween('draft', status), `no path to ${status}`).toBeDefined();
    }
  });

  it('never names a status that does not exist', () => {
    for (const targets of Object.values(EPISODE_STATUS_TRANSITIONS)) {
      for (const target of targets) {
        expect(EPISODE_STATUSES).toContain(target);
      }
    }
  });
});

describe('transition', () => {
  it('allows the forward step', () => {
    const result = transition('draft', 'outlined');
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value : null).toBe('outlined');
  });

  it('allows one step back, which is the edit signal', () => {
    // Going boarded -> scripted is what invalidates the board.
    expect(transition('boarded', 'scripted').ok).toBe(true);
  });

  it('refuses a jump over an intermediate state', () => {
    const result = transition('draft', 'rendered');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.message).toMatch(/Legal next states/);
  });

  it('refuses a no-op and says why', () => {
    const result = transition('draft', 'draft');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.message).toMatch(/already "draft"/);
  });

  it('refuses to move an aired episode anywhere', () => {
    // Non-negotiable #7: aired canon is immutable.
    for (const status of EPISODE_STATUSES) {
      const result = transition('aired', status);
      expect(result.ok, `aired -> ${status} must be refused`).toBe(false);
    }
    expect(transition('aired', 'rendered').ok ? '' : 'x').toBe('x');
    const refused = transition('aired', 'rendered');
    expect(refused.ok ? '' : refused.error.message).toMatch(/terminal/);
  });

  it('carries the legal alternatives in the error context, for the UI to render', () => {
    const result = transition('draft', 'aired');
    expect(result.ok).toBe(false);
    expect(result.ok ? {} : result.error.context).toMatchObject({ from: 'draft', to: 'aired' });
  });

  it('agrees with canTransition', () => {
    for (const from of EPISODE_STATUSES) {
      for (const to of EPISODE_STATUSES) {
        if (from === to) continue;
        expect(transition(from, to).ok).toBe(canTransition(from, to));
      }
    }
  });
});

describe('pathBetween', () => {
  it('returns the single-element path for a self-target', () => {
    expect(pathBetween('draft', 'draft')).toEqual(['draft']);
  });

  it('finds the shortest forward route', () => {
    expect(pathBetween('draft', 'boarded')).toEqual(['draft', 'outlined', 'scripted', 'boarded']);
  });

  it('finds a backward route, because each step back is legal', () => {
    expect(pathBetween('boarded', 'outlined')).toEqual(['boarded', 'scripted', 'outlined']);
  });

  it('answers "what must happen before this can air"', () => {
    const path = pathBetween('scripted', 'aired');
    expect(path).toEqual([
      'scripted',
      'boarded',
      'asset-resolved',
      'choreographed',
      'rendered',
      'aired',
    ]);
  });

  it('returns undefined when the target is unreachable', () => {
    expect(pathBetween('aired', 'draft')).toBeUndefined();
  });
});

describe('canon freeze', () => {
  it('freezes only on aired', () => {
    for (const status of EPISODE_STATUSES) {
      expect(isCanonFrozen(status)).toBe(status === 'aired');
    }
  });
});

describe('invalidation', () => {
  it('invalidates every downstream stage and nothing upstream', () => {
    // Editing the script does not require re-deriving the style, but it does
    // invalidate the board and everything after it.
    expect(invalidatedBy('scripted')).toEqual([
      'boarded',
      'asset-resolved',
      'choreographed',
      'rendered',
      'aired',
    ]);
  });

  it('invalidates nothing past the end', () => {
    expect(invalidatedBy('aired')).toEqual([]);
  });

  it('invalidates everything from the start', () => {
    expect(invalidatedBy('draft')).toHaveLength(EPISODE_STATUSES.length - 1);
  });

  it('returns nothing for a status that is not in the table', () => {
    expect(invalidatedBy('not-a-status' as EpisodeStatus)).toEqual([]);
  });
});
