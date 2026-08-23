/**
 * Deterministic request bodies the e2e suites share.
 *
 * Fixed seeds, fixed ids, no clock reads. A fixture that varied per run would make a
 * flaky assertion look like a real failure once a month, which is the worst possible
 * signal-to-noise ratio.
 */

import type { Brief } from '@rv/contracts';

/** The smallest brief `Brief` will accept, with every optional field left out. */
export const IDEA_BRIEF: Brief = {
  kind: 'idea',
  language: 'fa',
  targetAudience: 'Persian-speaking adults who grew up on 90s fantasy anime',
  toneWords: ['melancholy', 'wry'],
  targetEpisodeDurationMs: 480_000,
  episodes: { seasons: 1, episodesPerSeason: 6, openEnded: false },
  constraints: { mustNotAppear: [], ratingCeiling: 'teen' },
  references: [],
  idea: 'A fox learns the city has been quietly rearranging itself to avoid her.',
};

export const CREATE_PROJECT = {
  name: 'The Rearranging City',
  description: 'A six-episode folk-mystery about a fox and a town that will not stay still.',
} as const;

export const CREATE_SERIES = {
  title: 'The Rearranging City',
  premise:
    'Every night the streets move. Only the fox notices, and only she is not believed, ' +
    'because she is the one thing in town that never moved at all.',
} as const;

/** An id that is well-formed and belongs to nothing. For the 404 path. */
export const ABSENT_PROJECT_ID = 'prj_01J0000000000000000000000Z';
export const ABSENT_RUN_ID = 'run_01J0000000000000000000000Z';
