/**
 * Where progress ticks go.
 *
 * One method, deliberately fire-and-forget and synchronous: the API turns these into
 * SSE frames, and a progress sink that can fail, block or apply back-pressure would
 * make the frame loop's timing depend on whether anyone is watching. A subscriber that
 * has gone away is the sink's problem, not the renderer's.
 */

import type { RenderProgress } from '@rv/contracts';

export interface ProgressPort {
  emit(progress: RenderProgress): void;
}

/** The default when nobody is listening. Cheaper than an optional at every call site. */
export const NULL_PROGRESS: ProgressPort = { emit: () => undefined };

/** Keeps every tick. The assertion surface for "at least once per second". */
export class RecordingProgress implements ProgressPort {
  readonly ticks: RenderProgress[] = [];

  emit(progress: RenderProgress): void {
    this.ticks.push(progress);
  }
}
