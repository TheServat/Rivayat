/**
 * A `ReframePlan` as an FFmpeg filter graph.
 *
 * The master is rendered once and every delivery is cut from it, so the crop has to be
 * applied by the encoder rather than by re-rendering seven times. That is what makes
 * "re-framing to another aspect ratio costs $0" (research §2) literally true: seven
 * transcodes of one master, no evaluation, no drawing, no generation.
 *
 * The graph is `trim → crop → scale → concat`, one branch per shot:
 *
 * ```
 * [0:v]trim=start=0:end=2,setpts=PTS-STARTPTS,crop=608:1080:656:0,scale=1080:1920,setsar=1[v0];
 * [0:v]trim=start=2:end=5,setpts=PTS-STARTPTS,crop=w=608:h=1080:x=…:y=…,scale=…[v1];
 * [v0][v1]concat=n=2:v=1:a=0[vout]
 * ```
 *
 * Two things make this work where the obvious alternative does not. A single `crop`
 * filter with a piecewise `if(between(t,…))` expression would have to change the crop
 * *size* mid-stream, which reconfigures the filter graph; splitting into per-shot
 * branches keeps the size constant within each branch, which is exactly the invariant
 * the solver already guarantees (`panTo` is always the same size as `sourceCrop` - a
 * pan translates, it does not zoom).
 *
 * And the pan expression contains **no commas**. FFmpeg's filter syntax uses commas to
 * chain filters, so an expression containing one has to be escaped, and the escaping
 * differs between the command line, a filter-script file and `-filter_complex`. Because
 * `trim` + `setpts=PTS-STARTPTS` already makes `t` run from 0 to the shot's duration,
 * the smoothstep needs no clamping and therefore no `min`/`max`, and the whole class of
 * escaping bug disappears.
 *
 * ## The syntax is version-dependent: written for FFmpeg 8.1.2
 *
 * A filter string is a compatibility surface with another program, and that program
 * changes. **FFmpeg 8 removed `crop`'s `eval` option**: `ffmpeg -h filter=crop` no
 * longer lists it, and passing `eval=frame` now fails the whole transcode with
 * `Error applying option 'eval' to filter 'crop': Option not found`. What used to need
 * `eval=frame` is now the default - `crop` re-evaluates `x` and `y` per frame, and an
 * expression that references neither `t` nor `n` is what `eval=init` used to mean. This
 * was verified against the real binary, not assumed: `ffmpeg-e2e.spec.ts` pans a crop
 * across a *static* source and asserts that two extracted frames differ.
 *
 * A hard error like that one is the lucky case. The dangerous version is a silent
 * behaviour change, so `reframe-filter.spec.ts` pins the emitted string against a golden
 * value: a future syntax change then shows up as a diff in review rather than as a
 * surprise at render time.
 *
 * ## What the plan does not carry
 *
 * `ShotReframe` has no timing - the plan says how to crop each shot and not when each
 * shot is - so the timings are passed in alongside. Worth closing upstream; recorded
 * here rather than worked around silently.
 */

import {
  ValidationError,
  assertNever,
  err,
  ok,
  type AppError,
  type Result,
} from '@rv/shared-kernel';
import type { NormRect, ReframePlan, Size } from '@rv/contracts';

export interface ShotTiming {
  readonly shotId: string;
  readonly startMs: number;
  readonly durationMs: number;
}

export interface ReframeFilter {
  readonly graph: string;
  /** The output label to `-map`. */
  readonly map: string;
}

/**
 * Even, because 4:2:0 chroma subsampling halves both dimensions.
 *
 * An odd crop width is not a rounding nuisance - `libx264` refuses `yuv420p` at an odd
 * width outright, and the encode fails after the whole graph has been built.
 */
function evenFloor(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export function buildReframeFilter(
  plan: ReframePlan,
  master: Size,
  timings: readonly ShotTiming[],
): Result<ReframeFilter, AppError> {
  const byId = new Map(timings.map((timing) => [timing.shotId, timing]));
  const branches: string[] = [];
  const labels: string[] = [];

  for (const [index, shot] of plan.shots.entries()) {
    const timing = byId.get(shot.shotId);
    if (timing === undefined) {
      return err(
        new ValidationError({
          message: `no timing for shot ${shot.shotId} in the reframe plan for ${plan.format}`,
          context: { format: plan.format, shotId: shot.shotId },
        }),
      );
    }

    const label = `v${String(index)}`;
    labels.push(`[${label}]`);
    branches.push(
      `[0:v]${trimClause(timing)},setpts=PTS-STARTPTS,${geometryClause(shot, plan, master, timing)},setsar=1[${label}]`,
    );
  }

  const graph = [
    ...branches,
    `${labels.join('')}concat=n=${String(labels.length)}:v=1:a=0[vout]`,
  ].join(';');

  return ok({ graph, map: '[vout]' });
}

function trimClause(timing: ShotTiming): string {
  const start = timing.startMs / 1000;
  const end = (timing.startMs + timing.durationMs) / 1000;
  return `trim=start=${start.toFixed(6)}:end=${end.toFixed(6)}`;
}

function geometryClause(
  shot: ReframePlan['shots'][number],
  plan: ReframePlan,
  master: Size,
  timing: ShotTiming,
): string {
  const target = plan.targetSize;

  switch (shot.strategy) {
    case 'letterbox':
    case 'pillarbox':
      // Keep everything the author composed and pay for it in bars. `decrease` fits the
      // long edge; `pad` centres what is left.
      return (
        `scale=${String(target.width)}:${String(target.height)}:force_original_aspect_ratio=decrease` +
        `,pad=${String(target.width)}:${String(target.height)}:(ow-iw)/2:(oh-ih)/2:color=black`
      );

    case 'crop':
    case 'pan-scan':
    case 'reflow': {
      // `reflow` has no encoder-side meaning: it repositions layout nodes, which is a
      // render-time decision. Falling back to its crop is the honest degradation - the
      // overrides are applied upstream or not at all, and the frame is still correct.
      const crop = cropClause(shot.sourceCrop, shot.panTo, master, timing);
      return `${crop},scale=${String(target.width)}:${String(target.height)}`;
    }

    default:
      return assertNever(shot.strategy, 'reframe strategy');
  }
}

function cropClause(from: NormRect, to: NormRect | null, master: Size, timing: ShotTiming): string {
  const width = evenFloor(from.width * master.width);
  const height = evenFloor(from.height * master.height);
  const maxX = master.width - width;
  const maxY = master.height - height;

  const x0 = Math.round(Math.min(Math.max(from.x * master.width, 0), maxX));
  const y0 = Math.round(Math.min(Math.max(from.y * master.height, 0), maxY));

  if (to === null) {
    return `crop=${String(width)}:${String(height)}:${String(x0)}:${String(y0)}`;
  }

  const x1 = Math.round(Math.min(Math.max(to.x * master.width, 0), maxX));
  const y1 = Math.round(Math.min(Math.max(to.y * master.height, 0), maxY));
  const seconds = Math.max(timing.durationMs, 1) / 1000;

  // No `eval=frame`: FFmpeg 8 removed the option and marks `crop`'s w/h/x/y as
  // runtime-tunable, so an expression in `x` is re-evaluated every frame by default.
  // Passing the old flag is not merely redundant - `Error applying option 'eval' to
  // filter 'crop': Option not found` fails the whole transcode.
  return (
    `crop=w=${String(width)}:h=${String(height)}` +
    `:x=${smoothstep(x0, x1, seconds)}:y=${smoothstep(y0, y1, seconds)}`
  );
}

/**
 * `from + (to - from) · u² · (3 - 2u)` with `u = t/duration`, written without a comma.
 *
 * The same easing `geometry.ts#lerpRect` applies, so a preview drawn from the plan and
 * the encoded file agree frame for frame. Two implementations of one curve is how they
 * stop agreeing.
 */
export function smoothstep(from: number, to: number, durationSeconds: number): string {
  if (from === to) return String(from);
  const d = durationSeconds.toFixed(6);
  const u = `(t/${d})`;
  return `${String(from)}+(${String(to - from)})*${u}*${u}*(3-2*${u})`;
}
