# ADR-0003: Render with Playwright + FFmpeg, with a `@napi-rs/canvas` offscreen backend

**Status:** Accepted — 2026-08-23. Depends on ADR-0001 (the IR is the render input).

## Context

`@rv/render-engine` turns an `AnimationIR` into video files. The IR evaluates to a
`SceneSnapshot` at any `t` (ADR-0001), so rendering is a loop over frame indices, a draw, a
capture, and an encode. The open questions were _what draws the frame_ and _whether we adopt an
existing programmatic-video framework instead of writing the loop ourselves_.

Constraints that decided it:

- **Licence.** This is an open project. A per-company commercial licence in the render path is a
  hard block.
- **Determinism.** Output must be bit-reproducible, renders resumable after a crash, and frames
  shardable across workers. That rules out anything that plays a timeline against a wall clock.
- **The IR already exists.** We do not need a framework's authoring model — we need a rasteriser.
  A framework that insists on being the source of truth is a liability, not a feature (ADR-0001).
- **The LLM must not have to write render code.** Motion is data (`.rvanim.json`). Any framework
  whose composition API is imperative code the model has to emit re-opens a problem we already
  closed.

## Decision

**Playwright 1.62.1 driving headless Chromium over a PixiJS 8 scene, frames piped to FFmpeg
8.1.2**, with **`@napi-rs/canvas` 1.0.7** as a second, browser-free backend.

```
AnimationIR → evaluate(ir, f/fps) → SceneSnapshot → Backend → frame → FFmpeg → master.mov
                                                     ├── PixiJS in Playwright  (WebGL: filters, shaders, particles, blend modes)
                                                     └── @napi-rs/canvas       (pure 2D: no browser, no GPU, no Chromium download)
```

Rules that make it deterministic:

- The render loop is `for f in 0..N: evaluate(ir, f/fps) → draw → capture`. **We seek; we never
  play.** No `requestAnimationFrame` timing, no wall-clock reads, no CSS animations or transitions
  in the render page.
- Every frame is a pure function of `(ir, f)`, so a crashed render resumes at frame `f`, and a
  long render shards across workers with no coordination beyond frame ranges.
- Frame hashes are the golden-test fixture (`01-architecture.md` §9), so an evaluator or renderer
  regression fails CI rather than surfacing as "the video looks slightly different".

**Backend selection** (`RV_RENDER_BACKEND=auto|browser|canvas`) is a capability decision, not a
preference: a composition that uses shaders, WebGL filters, particle systems or non-trivial blend
modes routes to the browser backend; a pure-2D composition (transforms, paths, images, text,
alpha) routes to `@napi-rs/canvas`. `auto` inspects the IR's declared feature set and picks.

Why the second backend earns its keep: headless Chrome costs roughly **8–15 s per 150 frames at
1080p** on a CI-class box ([`00-research.md` §6](../00-research.md)). Most of that is browser
overhead, not drawing. For the large fraction of shots that are flat 2D cutout animation — which
is the house style — an offscreen Skia canvas in-process is materially faster, uses no GPU, and
removes the ~150 MB Chromium download from environments that only need pure-2D output.

FFmpeg is invoked as a subprocess (`RV_FFMPEG_PATH`), not through a WASM build or an npm
re-distribution: it is already on PATH on the target machine at 8.1.2-full, it is the only
encoder that covers H.264 / HEVC / ProRes plus EBU R128 loudness normalisation, and keeping it
external keeps a multi-hundred-megabyte binary out of the dependency tree.

## Consequences

**Positive.** No licence cost and no licence question. Full control of the frame loop, which is
what buys determinism, resumability and sharding. Two backends behind one port, so the fast path
exists without a second authoring model. Anything Chromium can draw is available in the browser
backend, which keeps the visual ceiling high without committing us to it for every shot.

**Negative.** We own the frame loop, the seek harness, the Chromium page lifecycle, the pixel
readback, the frame-to-FFmpeg piping and the encoder profiles. Two backends means every visual
feature must either work in both or be explicitly declared browser-only — and a shot that
silently renders differently on the two backends is a real, and nasty, class of bug. The guard is
a golden-file test that renders the same fixture IRs through both backends and compares frame
hashes within a tolerance; a divergence is a build failure, not a judgement call. Playwright's
browser download is an extra CI step (`playwright install --with-deps chromium`), which is why
`pnpm test` must never require it — browser-backed render tests are opt-in.

## Alternatives considered

**[Remotion](https://www.remotion.dev) 4.0.515.** The mature answer: React components as
compositions, headless Chromium rendering, a good editor, Lambda distribution. Rejected on
**licence** — the published package declares `"license": "SEE LICENSE IN LICENSE.md"` rather than
an OSI identifier, and the Remotion Company Licence requires a paid seat/company licence beyond a
small-team threshold. A commercial obligation sitting in the render path of an open project is
not acceptable at any price we would have to explain to a contributor. Secondary reasons even if
the licence were free: compositions are React code, so the LLM would emit _code_ rather than
data, and Remotion wants to own the timeline that ADR-0001 assigns to the IR.

**[Motion Canvas](https://motioncanvas.io) / [Revideo](https://re.video).** Open source (MIT) and
technically strong. Rejected on the **authoring model**: both use a generator-based imperative
API (`yield* tween(...)`, `yield* waitFor(...)`) where the animation _is_ the control flow of a
TypeScript generator function. That is hard for an LLM to emit correctly — a misplaced `yield*`
is a silent timing bug, not a schema error — and it is close to impossible to round-trip into a
visual editor, because there is no declarative structure to show the user. It fails
LLM-generatable and editable-in-our-UI simultaneously. (Revideo additionally publishes its
umbrella package at version `0.0.0`, which is not a foundation to build a render path on.)

**FFmpeg alone, driven by filter graphs.** Rejected: expressive enough for cuts, crops, overlays
and text, nowhere near enough for rigged mesh deformation, per-part transforms or shader effects.
It remains exactly what it is good at — the encoder and the mixer — at the end of the pipeline.

**A native/GPU renderer (Skia bindings, `node-canvas`, a Rust pipeline).** Rejected as the
_primary_ path: it trades the browser's mature, universally-understood 2D/WebGL stack for
platform-specific build pain on the Windows dev machine and in CI. `@napi-rs/canvas` gives us the
useful half of this — prebuilt Skia binaries, no node-gyp — as the _secondary_ backend, which is
the right amount of native surface to own.

**Recording real-time playback (screen capture / `MediaRecorder`).** Rejected outright: it is
wall-clock dependent, therefore non-deterministic, drops frames under load, cannot be resumed,
cannot be sharded, and produces a different file every run. It violates non-negotiable #1 in the
most direct way available.
