/**
 * Milliseconds, rendered for a person.
 *
 * Two shapes, because they answer two questions. A platform's length limit is prose -
 * "up to 3 minutes" - and an elapsed timer is a clock - `2:14` - and running one
 * through the other's formatter gives either "up to 180 seconds" or a limit that reads
 * as a countdown.
 *
 * Both go through `Intl` so Persian gets Persian digits. Nothing here ever parses a
 * formatted string back: `۱۲۳` is not `123` to `Number()`, and the first place that
 * shows up is a budget ceiling silently cleared.
 */

import type { Locale } from '@rv/contracts';

import { LOCALE_TAG } from '../../i18n/index';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/** Which of the two duration messages to use, and with what count. */
export interface DurationChoice {
  readonly unit: 'seconds' | 'minutes';
  readonly count: number;
}

/**
 * A platform limit as a whole number of the largest unit that divides it exactly.
 *
 * 90 s stays 90 seconds and 180 s becomes 3 minutes, because that is how the two
 * platforms state them: Reels says "90 seconds" and Shorts says "3 minutes", and
 * rewriting either into the other's unit makes the table stop matching its source.
 */
export function durationChoice(ms: number): DurationChoice {
  if (ms >= MS_PER_MINUTE && ms % MS_PER_MINUTE === 0) {
    return { unit: 'minutes', count: ms / MS_PER_MINUTE };
  }
  return { unit: 'seconds', count: Math.round(ms / MS_PER_SECOND) };
}

const clockFormats = new Map<string, Intl.NumberFormat>();

function pad2(value: number, locale: Locale): string {
  const key = `${locale}:pad2`;
  let formatter = clockFormats.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(LOCALE_TAG[locale], {
      minimumIntegerDigits: 2,
      useGrouping: false,
    });
    clockFormats.set(key, formatter);
  }
  return formatter.format(value);
}

function plain(value: number, locale: Locale): string {
  const key = `${locale}:plain`;
  let formatter = clockFormats.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(LOCALE_TAG[locale], { useGrouping: false });
    clockFormats.set(key, formatter);
  }
  return formatter.format(value);
}

/**
 * `m:ss`, or `h:mm:ss` once there is an hour to show.
 *
 * The hours field only appears when it is non-zero: a four-minute render displayed as
 * `0:04:12` reads as a stopwatch someone forgot to start. Rendered inside a `<bdi>` by
 * its callers, so a right-to-left paragraph does not reorder the digit groups around
 * the colons.
 */
export function formatClock(ms: number, locale: Locale): string {
  const total = Math.max(0, Math.floor(ms));
  const hours = Math.floor(total / MS_PER_HOUR);
  const minutes = Math.floor((total % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((total % MS_PER_MINUTE) / MS_PER_SECOND);
  const tail = `${pad2(minutes, locale)}:${pad2(seconds, locale)}`;
  return hours === 0
    ? `${plain(minutes, locale)}:${pad2(seconds, locale)}`
    : `${plain(hours, locale)}:${tail}`;
}

/**
 * Milliseconds between two ISO instants, or `null` when either is unreadable.
 *
 * `null` rather than `0`: "this run took no time" and "this run's timestamps are
 * broken" are different facts, and only one of them belongs on a screen as a duration.
 */
export function elapsedBetween(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}
