/**
 * Enum member to message key, as literal maps.
 *
 * An interpolated `render.stage.${stage}` types as `string`, which slips a typo past
 * `vue-tsc` *and* past `i18n.spec.ts`'s scan of literal `t()` arguments - and the
 * runtime `missing` handler then throws in front of a user. A literal map is checkable
 * on both sides: `satisfies Record<PipelineStageKey, ...>` fails to compile the day a
 * thirteenth stage is added, and each value is a literal the scan can resolve.
 *
 * The same trick `src/api/error-messages.ts` uses, for the same reason.
 */

import type { FormatProfileId, PipelineStageKey, ReframeStrategy } from '@rv/contracts';

import type { RunStatus } from './render-wire';
import type { RunStreamState } from '../../api/run-stream';

export const STAGE_KEYS = {
  intake: 'render.stage.intake',
  style: 'render.stage.style',
  story: 'render.stage.story',
  cast: 'render.stage.cast',
  world: 'render.stage.world',
  resolve: 'render.stage.resolve',
  produce: 'render.stage.produce',
  sequence: 'render.stage.sequence',
  choreograph: 'render.stage.choreograph',
  preview: 'render.stage.preview',
  render: 'render.stage.render',
  deliver: 'render.stage.deliver',
} as const satisfies Record<PipelineStageKey, string>;

export const STATUS_KEYS = {
  queued: 'render.status.queued',
  running: 'render.status.running',
  paused: 'render.status.paused',
  succeeded: 'render.status.succeeded',
  failed: 'render.status.failed',
  cancelled: 'render.status.cancelled',
} as const satisfies Record<RunStatus, string>;

export const STREAM_KEYS = {
  idle: 'render.run.live.idle',
  connecting: 'render.run.live.connecting',
  open: 'render.run.live.open',
  reconnecting: 'render.run.live.reconnecting',
  failed: 'render.run.live.failed',
} as const satisfies Record<RunStreamState, string>;

export const STRATEGY_KEYS = {
  crop: 'render.reframe.strategy.crop',
  'pan-scan': 'render.reframe.strategy.panScan',
  letterbox: 'render.reframe.strategy.letterbox',
  pillarbox: 'render.reframe.strategy.pillarbox',
  reflow: 'render.reframe.strategy.reflow',
} as const satisfies Record<ReframeStrategy, string>;

export const STRATEGY_EXPLAIN_KEYS = {
  crop: 'render.reframe.explain.crop',
  'pan-scan': 'render.reframe.explain.panScan',
  letterbox: 'render.reframe.explain.letterbox',
  pillarbox: 'render.reframe.explain.pillarbox',
  reflow: 'render.reframe.explain.reflow',
} as const satisfies Record<ReframeStrategy, string>;

/**
 * The exclusion zone names `FORMAT_PRESETS` ships, translated.
 *
 * The names are *data* from the contract - `top chrome`, `bottom caption rail`,
 * `right action rail` - and data is not translated by a catalogue lookup that has to
 * be total. So the three known names have keys, and anything a future preset adds
 * falls back to the contract's own name rather than throwing or rendering blank. A
 * missing translation for a zone TikTok adds next year is a small, visible gap; a
 * crash on a screen someone is publishing from is not.
 */
const ZONE_KEYS = {
  'top chrome': 'render.chrome.zones.top',
  'bottom caption rail': 'render.chrome.zones.captions',
  'right action rail': 'render.chrome.zones.actions',
} as const;

export type ZoneMessageKey = (typeof ZONE_KEYS)[keyof typeof ZONE_KEYS];

export function zoneMessageKey(name: string): ZoneMessageKey | null {
  return Object.hasOwn(ZONE_KEYS, name) ? ZONE_KEYS[name as keyof typeof ZONE_KEYS] : null;
}

/**
 * Display order for the gallery: landscape, then vertical, then the square feed pair.
 *
 * Not the record's insertion order and not alphabetical. The seven targets are three
 * shapes, and putting the three 9:16 ones together is what lets a reader compare the
 * one interesting difference between them - only TikTok carves chrome out of the same
 * frame Shorts and Reels leave whole.
 */
export const FORMAT_ORDER: readonly FormatProfileId[] = [
  'yt-1080p',
  'yt-2160p',
  'shorts-9x16',
  'reels-9x16',
  'tiktok-9x16',
  'ig-4x5',
  'ig-1x1',
];

export function formatSortIndex(id: FormatProfileId): number {
  const at = FORMAT_ORDER.indexOf(id);
  return at === -1 ? FORMAT_ORDER.length : at;
}
