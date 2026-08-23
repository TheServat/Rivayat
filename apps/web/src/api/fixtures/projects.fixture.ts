import type { ProjectSummary } from '../schemas/pending-contracts';

/**
 * Two projects, in the shape the API will return.
 *
 * Deliberately small and deliberately different: one has a locked style bible and real
 * spend, the other has neither. A list that only ever shows the happy row hides every
 * empty-state bug in it.
 */
export const PROJECT_FIXTURES: readonly ProjectSummary[] = [
  {
    id: 'prj_01JQZK3M7X8YB4N2VTC6WPHRDE',
    name: 'شب‌های برفی کوهسار',
    logline: 'یک نامه‌رسان کوهستانی زمستان را با رازی می‌گذراند که نباید به دست کسی برسد.',
    locale: 'fa',
    styleBibleId: 'sty_01JQZK4A1B2C3D4E5F6G7H8J9K',
    styleLocked: true,
    episodeCount: 6,
    spentNanoUsd: 1_842_000_000,
    updatedAt: '2026-08-19T14:32:00+03:30',
  },
  {
    id: 'prj_01JQZM5P9R7S2T4V6W8X0Y1Z3A',
    name: 'The Cartographer’s Apprentice',
    locale: 'en',
    styleBibleId: null,
    styleLocked: false,
    episodeCount: 0,
    spentNanoUsd: 0,
    updatedAt: '2026-08-22T09:05:00Z',
  },
];
