/**
 * Frames done, frames total, and an ETA that is not a lie.
 *
 * `RenderProgress` insists on counts rather than a percentage because "the denominator
 * is known before the first frame - the timeline has a length - and an honest ETA needs
 * a real denominator". This tracker is the other half of that: it measures throughput
 * from a `Clock` it was handed, so a test can advance time by exactly 500 ms and assert
 * the ETA rather than sleep and hope.
 *
 * Two behaviours worth stating:
 *
 *  - **No estimate until there is evidence.** `etaMs` stays `null` for the first few
 *    frames. The first frame of a browser render includes the browser starting up, and
 *    extrapolating from it predicts four hours for a ninety-second clip.
 *  - **Throughput is a moving average.** A render whose ETA is computed from the total
 *    average never reflects the machine waking up or the encoder falling behind, and
 *    the number stops being useful precisely when someone starts watching it.
 */

import type { Clock } from '@rv/shared-kernel';
import type { FormatProfileId, JobId, RenderPhase, RenderProgress } from '@rv/contracts';

import type { ProgressPort } from '../ports/progress';

export interface ProgressTrackerOptions {
  readonly jobId: JobId;
  readonly framesTotal: number;
  readonly clock: Clock;
  readonly sink: ProgressPort;
  /**
   * Minimum gap between ticks. RV-168 wants at least one per second; emitting one per
   * frame at 60 fps would flood an SSE stream with 60 messages a second saying almost
   * nothing.
   */
  readonly minIntervalMs?: number;
  /** Frames to average throughput over. */
  readonly windowSize?: number;
  /** Frames that must land before an ETA is offered at all. */
  readonly minSamples?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 250;
const DEFAULT_WINDOW = 30;
const DEFAULT_MIN_SAMPLES = 3;

/**
 * How much of the job the frame loop is.
 *
 * `RenderProgress.fraction` is explicitly not `framesDone / framesTotal`: "encoding and
 * reframing take real time after the last frame is drawn". Splitting the bar so the
 * frame loop owns 80 % of it means the bar does not sit at 100 % through the transcode.
 */
const PHASE_WEIGHTS: Record<RenderPhase, { readonly base: number; readonly span: number }> = {
  preparing: { base: 0, span: 0.02 },
  rendering: { base: 0.02, span: 0.78 },
  reframing: { base: 0.8, span: 0.03 },
  encoding: { base: 0.83, span: 0.12 },
  muxing: { base: 0.95, span: 0.04 },
  finalising: { base: 0.99, span: 0.01 },
};

export class ProgressTracker {
  readonly #options: Required<
    Pick<ProgressTrackerOptions, 'minIntervalMs' | 'windowSize' | 'minSamples'>
  > &
    ProgressTrackerOptions;
  readonly #completions: number[] = [];
  #framesDone = 0;
  #lastEmitAt: number | null = null;

  constructor(options: ProgressTrackerOptions) {
    this.#options = {
      ...options,
      minIntervalMs: options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      windowSize: options.windowSize ?? DEFAULT_WINDOW,
      minSamples: options.minSamples ?? DEFAULT_MIN_SAMPLES,
    };
  }

  get framesDone(): number {
    return this.#framesDone;
  }

  /** Records a completed frame. Emits only when the interval has elapsed. */
  frameDone(phase: RenderPhase = 'rendering'): void {
    this.#framesDone += 1;
    this.#completions.push(this.#options.clock.now());
    if (this.#completions.length > this.#options.windowSize) this.#completions.shift();

    const now = this.#options.clock.now();
    if (this.#lastEmitAt !== null && now - this.#lastEmitAt < this.#options.minIntervalMs) return;
    this.emit(phase);
  }

  /** Emits unconditionally. Used at phase boundaries and at the end. */
  emit(phase: RenderPhase, currentFormat: FormatProfileId | null = null, message?: string): void {
    this.#lastEmitAt = this.#options.clock.now();
    this.#options.sink.emit(this.snapshot(phase, currentFormat, message));
  }

  snapshot(
    phase: RenderPhase,
    currentFormat: FormatProfileId | null = null,
    message?: string,
  ): RenderProgress {
    const fps = this.#framesPerSecond();
    const remaining = Math.max(0, this.#options.framesTotal - this.#framesDone);
    const weight = PHASE_WEIGHTS[phase];
    const withinPhase =
      this.#options.framesTotal === 0 ? 1 : this.#framesDone / this.#options.framesTotal;

    const base: RenderProgress = {
      jobId: this.#options.jobId,
      phase,
      framesDone: Math.min(this.#framesDone, this.#options.framesTotal),
      framesTotal: this.#options.framesTotal,
      fraction: Math.min(1, weight.base + weight.span * Math.min(1, withinPhase)),
      etaMs: fps === null ? null : Math.round((remaining / fps) * 1000),
      framesPerSecond: fps ?? 0,
      currentFormat,
    };
    return message === undefined ? base : { ...base, message };
  }

  /** `null` until enough frames have landed for a number that is not noise. */
  #framesPerSecond(): number | null {
    if (this.#completions.length < this.#options.minSamples) return null;
    const first = this.#completions[0];
    const last = this.#completions[this.#completions.length - 1];
    /* c8 ignore next -- both indices exist once the length check above has passed. */
    if (first === undefined || last === undefined) return null;
    const elapsedMs = last - first;
    // Frames that all landed inside the same clock tick give no rate at all. Reporting
    // "infinity frames per second" would produce an ETA of zero for a render that has
    // barely started.
    if (elapsedMs <= 0) return null;
    return ((this.#completions.length - 1) / elapsedMs) * 1000;
  }
}
