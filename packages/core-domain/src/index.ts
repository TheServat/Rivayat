/**
 * `@rv/core-domain` - the pure heart.
 *
 * No IO, no SDKs, no clock reads, no randomness. Everything here is a function of its
 * arguments, which is why it is held to 100% coverage: there is nothing to mock and
 * therefore no excuse.
 */

export {
  DAWN,
  HORIZON,
  ALWAYS,
  storyTime,
  compareStoryTime,
  isBefore,
  isAtOrBefore,
  earliest,
  latest,
  interval,
  isWellFormed,
  contains,
  overlaps,
  intersect,
  encloses,
  closeAt,
  coalesce,
  span,
} from './story-time';

export type {
  TemporalStandpoint,
  RelationFilter,
  Neighbourhood,
  Contradiction,
} from './temporal-index';
export { BiTemporalIndex } from './temporal-index';

export {
  TERMINAL_STATUSES,
  isTerminal,
  canTransition,
  transition,
  pathBetween,
  isCanonFrozen,
  invalidatedBy,
} from './episode-lifecycle';

export {
  computeStyleChecksum,
  isLocked,
  isChecksumValid,
  lock,
  fork,
  assertUsableForGeneration,
} from './style-lock';
