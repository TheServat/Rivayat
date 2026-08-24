/**
 * The fixture transport's routes for the render and delivery screen.
 *
 * In its own file for the reason `studio-routes.ts` states: several people build
 * several screens, and a single if-chain is the file they all have to edit at once.
 *
 * Note what `formats` does *not* do. It has no fixture. `FORMAT_PRESETS` is the
 * contract's own table and this hands it back verbatim, so the seven cards on screen
 * are drawn from the same safe areas and exclusion zones the reframer solves against
 * and the platform validator checks. A hand-written copy here would be a second source
 * of truth for the one thing on that screen a viewer is meant to trust - and it would
 * drift silently, because nothing renders a fixture and a preset side by side.
 */

import { FORMAT_PRESETS, type IsoInstant, type ProjectId } from '@rv/contracts';

import type {
  CostReport,
  FormatProfileList,
  RunSummaryList,
} from '../../features/render/render-wire';

interface RouteRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

interface RouteResult {
  readonly payload: unknown;
}

/** The instant every fixture row is stamped with. Fixed, because fixtures are data. */
const FIXTURE_NOW = '2026-08-24T09:00:00.000Z' as IsoInstant;

function emptyBucket() {
  return { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, images: 0, costNanoUsd: 0 };
}

/**
 * No runs, deliberately.
 *
 * A fixture full of finished renders would show the screen at its most flattering and
 * hide the state a new project is actually in. The monitor's empty state is the one a
 * first-time user meets, so it is the one worth being able to look at.
 */
function runs(): RunSummaryList {
  return [];
}

/**
 * A cost report over no runs.
 *
 * `nanoUsdPerDeliveredMinute` is `null` rather than `0`, which is the distinction the
 * schema's own comment insists on: a project that has delivered nothing has no cost
 * per minute, and that is not the same fact as costing nothing per minute.
 */
function cost(projectId: ProjectId): CostReport {
  return {
    projectId,
    seriesId: null,
    runs: [],
    summary: {
      total: emptyBucket(),
      byProvider: {},
      byModel: {},
      byTask: {},
      byStage: {},
    },
    deliveredMs: 0,
    nanoUsdPerDeliveredMinute: null,
    updatedAt: FIXTURE_NOW,
  };
}

function formats(): FormatProfileList {
  return Object.values(FORMAT_PRESETS);
}

/** Returns `undefined` when no route here matches, so the caller can keep looking. */
export function renderRoutes(request: RouteRequest): RouteResult | undefined {
  if (request.method === 'GET' && request.path === '/render/formats') {
    return { payload: formats() };
  }

  const projectMatch = /^\/projects\/([^/]+)\/(runs|cost)$/u.exec(request.path);
  if (request.method === 'GET' && projectMatch !== null) {
    const [, id, leaf] = projectMatch;
    if (leaf === 'runs') return { payload: runs() };
    return { payload: cost(id ?? '') };
  }

  return undefined;
}
