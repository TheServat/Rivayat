# Remaining work

The state of the project as measured on 2026-08-23, and everything between here and a
complete, runnable studio. Not a wish list — every item is either a gap someone found,
a backlog story with no code behind it, or a defect with a reproduction.

Status keys: `[ ]` not started · `[~]` in progress · `[x]` done and verified.

## Where the project actually stands

The **engine layer is essentially finished**: fifteen packages, 3,782 passing tests,
100 % coverage on `contracts`, `core-domain` and `anim-engine`. The **application layer
is where the hole is**: six of eight studio screens are placeholders, the CLI covers
four of about twenty commands the backlog demands, and no series has been produced end
to end.

That shape is deliberate — engines were built first so the application has something
correct to sit on — but it means "how much is left" is not proportional to lines of
code. What remains is mostly assembly.

---

## W1 — Studio UI, the six placeholder screens (Epic K)

The largest single block. `apps/web/src/router/index.ts` routes six paths to
`PlaceholderView`. Each becomes a real screen on the redesigned design system.

- [~] **RV-200..203** Shell, navigation, i18n catalogues, RTL — redesign in flight
- [ ] **RV-204** Style Lab — preset gallery, the motion block editor, probe, lock
- [ ] **RV-205** Story — the outline tree, beat editing, per-stage model picker
- [ ] **RV-206/207** Characters — the entity graph view, and the expression/pose grid
      with an editable prompt behind every cell
- [ ] **RV-208/209/210** Assets — library, version history, the variant editor
- [ ] **RV-211/212** Timeline — the PixiJS player, scrubbing, keyframe drag
- [ ] **RV-213/214/215** Render — format previews with safe zones, the cost estimate,
      the deliverable list
- [ ] **RV-216** Full-journey e2e in `fa` and `en`, with visual references for both

## W2 — CLI, the headless driver (Epic J)

Four commands exist: `doctor`, `character`, `animate`, `produce`. The backlog's
milestone demos name roughly twenty.

- [x] `vitest.config.ts` — the package had none, so `vitest run` resolved the root
      workspace, matched no project, and failed at startup. A recursive `pnpm test`
      stopped there and never reached `apps/api`.
- [~] **Tests.** The CLI is the only package with zero. Its `test` script is red on
  purpose until they exist, rather than green by way of `passWithNoTests`.
- [~] `project new` · `models list|set` · `style list|probe|lock` · `cost report`
- [~] `story new` · `cast states` · `graph show` · `continuity check`
- [~] `assets plan|bake|edit` · `anim lint`
- [ ] `run` · `render|render resume` · `deliver` · `series cost`

## W3 — Asset production chain (Epic G)

- [x] `ProduceAssetsUseCase`: plan, budget, then per asset generate -> matte -> split ->
      score -> rig -> clips -> bake -> register. Ran live: three assets, 8.5 s, $0.0000
      actually spent against a $0.0180 estimate
- [x] Resolve first, spend second - the budget guard sees the batch total before the
      first image is requested, and an unapproved batch returns the estimate with zero
      provider calls
- [x] Resumable per `(runId, assetKey, step, attempt)`; a stale input hash is ignored,
      and a checkpoint whose record has vanished re-runs rather than half-resuming
- [x] Partial success, cancellation and per-step metering are first-class outcomes
- [x] Second run over the same episode: two cache hits and one resumed generate, 5 ms
      instead of 5.7 s, zero provider calls
- [x] The composed prompt was diluting its own layout instruction. SD 1.5 conditions on
      CLIP-L at 77 tokens and ComfyUI concatenates about six windows, so ~1000
      characters of style preamble ahead of the layout clause did not truncate it, it
      buried it. Declared per lane now
- [~] **BiRefNet is built and unwired.** One asset fails at matte every run: SD 1.5
  draws it on a graded, vignetted backdrop and threshold keying cannot cut a
  gradient. Both engines refuse it correctly. In flight
- [~] **The best graph in the repo is unreachable.** `txt2img-lcm-parts-sheet.json`
  carries the separability scaffold _and_ its negatives, and standalone it produced
  a clean six-component sheet - but `ComfyWorkflowSet` has no slot that can route to
  it. In flight
- [~] **The quality gate is correct and unusable on this card.** It caught a 2x2 contact
  sheet of photographs that the splitter, assigner and rigger had all happily turned
  into four bones - at 44 s and 21 s per image under VRAM contention, while the
  18 GB default OOMs outright beside ComfyUI. In flight
- [ ] Regeneration requires explicit intent and appends a version
- [ ] Edit-by-instruction produces a variant with the original intact

## W4 — Orchestration and the API (Epic J)

All twelve stages report as implemented. What is not proven:

- [~] Checkpoint and **resume a killed render to a byte-identical result**
- [~] Run cancellation distinguishable from failure — see the `runs.state` gap below
- [~] SSE run events consumed by the UI, not just emitted
- [~] Cost ledger per run, per stage, per provider, surfaced in the UI

## W5 — Known contract and storage gaps

Reported by the agents that hit them, deferred at the time, still open.

- [~] No `Project` schema in `contracts` — the API's most-used resource is the one
  resource with no shared type
- [~] `runs.state` has five states; the pipeline has six. Cancelled and failed
  collapse into one, which is exactly the distinction W4 needs
- [~] `persistence` calls its table `facts` but stores beliefs. Rename to `beliefs`
  and add a real `facts` table
- [~] Pixel arithmetic is duplicated between `asset-engine` and `export-kit`
- [ ] `export-kit` has no backlog story (parked as P-03)
- [~] The settings wire envelope is maintained by hand in two places, `apps/api` and
  `apps/web` - the same drift that produced the original mismatch
- [~] No `projects`, `series`, checkpoint or render-artifact table; JSON files and a
  `jobs` row are standing in
- [~] `PipelineRun.checkpoints` holds one entry per stage, right for twelve stages and
  useless for 40 assets x 8 steps

## W6 — Cross-engine seams (QA)

- [~] Audit in flight over the five engines each written in isolation: IR feature
  agreement, scene-space origin, easing agreement, story shots feeding the reframer

## W7 — Test and build health

- [x] Flaky provider test: an abort-latency assertion budgeted 100 ms of wall clock and
      lost under four-way workspace concurrency. Rebudgeted to 400 ms — still below the
      500 ms `initialBackoffMs` floor it exists to catch, so the property is intact
- [x] CI: `.github/workflows/ci.yml`, the `verify` workflow, on push and PR, matrixed
      over `ubuntu-latest` and `windows-latest` with `fail-fast: false`. It runs the six
      `pnpm verify` steps individually, then `pnpm build`, then a second job running
      `pnpm -r --no-bail test`. `tools/scripts/verify-drift-check.mjs` fails the build if
      that list ever stops matching `package.json`. Reasoning and rejected options:
      [ADR-0007](adr/ADR-0007-ci-on-github-actions.md)
- [x] Coverage thresholds enforced rather than observed, and **per package** rather than
      one workspace average. `vitest.config.ts` generates one threshold glob per package
      from the filesystem, so a new package is enforced from its first commit instead of
      inheriting the average. Verified to fail: raising `shared-kernel` to the 100 % tier
      produced three `does not meet threshold` errors and exit 1
- [x] Determinism scan (`pnpm determinism:check`): an AST walk over every
      `packages/*/src` and `apps/*/src` that fails on `Date.now()`, `Math.random()`,
      zero-argument `new Date()`, `performance.now()`, `process.hrtime()` and the
      `node:crypto` entropy calls. Three boundary files are allowlisted per symbol, with
      reasons. Verified to fail: a planted probe produced three violations and exit 1,
      while the same file's `new Date(iso)`, its prose comment naming both calls, and its
      `// determinism-allow:` line were correctly not flagged
- [x] `pnpm typecheck` now passes `--continue=dependencies-successful`. It reported one
      failing package before and reports three now — the other two were hidden behind it
- [ ] **`CLAUDE.md` §4 is now out of date.** It describes `pnpm verify` as
      "format + lint + typecheck + arch + test"; it is
      `format:check → lint → typecheck → arch:check → determinism:check → test:cov`.
      Only the project owner edits `CLAUDE.md`

### What the new CI catches today

Found by running the workflow's exact step sequence locally on 2026-08-23. None of these
is caused by the CI work; all are in code being written right now.

- [ ] **`packages/export-kit/src/registry.spec.ts:239`** calls `walk('src')`, a path
      relative to `process.cwd()`. It passes under `cd packages/export-kit && npx vitest run`
      and fails under the root `pnpm test`, where cwd is the repo root:
      `ENOENT: scandir 'D:\me\story\src'`. Resolve it from `import.meta.url` instead. This
      is the only test failing in the root run — 1 of 5,073
- [ ] **`pnpm typecheck`** fails in `@rv/api`: `pipeline-runner.service.ts` and
      `repositories.spec.ts` build checkpoint rows that no longer match the persistence
      row type, which gained fields
- [ ] **`pnpm lint`** fails with 18 errors and 1 warning across twelve files — nine in
      `apps/cli` (unsafe `any` flow in `commands/models.ts`, redundant type assertions, a
      duplicated union constituent), one in `apps/api`, two in `persistence` specs
- [ ] **`pnpm format:check`** fails on 24 files. `pnpm format` fixes all of them
- [ ] `apps/cli/vitest.config.ts` has no `name`, so it is the one project whose failures
      are not labelled in the root run (CLAUDE.md §3 requires one)
- [ ] `playwright.config.ts` at the repo root is a zero-byte file. Either it is a
      leftover — `apps/web/playwright.config.ts` is the real one — or it is unfinished
- [ ] Coverage counts only files a test loaded; there is no `coverage.include`. A source
      file that no test imports is invisible rather than 0 %, which is why `apps/cli` has
      no row at all. Setting `include` would make the floors honest and would put
      `apps/cli` at 0 % on the same day — worth doing together with its first tests

## W9 — Animation: providers, representations, projection (ADR-0008)

From the owner's `universal_ai_animation_system.md`, scoped by
[ADR-0008](adr/ADR-0008-motion-providers-and-representations.md). Most of the document
was already true; these are the parts that were not.

- [~] **`MotionProvider` port**, with the IR as the determinism boundary — providers
  author, the IR is the authored motion, `evaluate(ir, t)` calls nothing. Keyframes
  and procedural behaviours re-expressed as the first two providers, byte-identical
- [~] **Anchors** — named points on an asset that retargeting aligns to and props attach
  to, so a character can hold a sword without any code naming a bone
- [~] **Clip library and retargeting** — a walk cycle authored once applies to every
  compatible biped. Existing per-asset clips must keep resolving and the dedup key
  must not change under them
- [~] **`AssetRepresentation`** — `flat`, `cutout`, `layered-2.5d`, `video`, with
  `isometric` and `mesh` reserved. **Lives on the pinned asset ref**, not the asset
  record: a render resolves nothing at render time, and a representation looked up
  from a mutable record at export time means two exports of one IR can differ
- [~] **`layered-2.5d`** — the `parallax` behaviour exists and has nothing to consume,
  which is what makes this worth doing now
- [~] **Camera projection** — `isometric` as a value, not an engine. Applied by
  consumers so `worldTransform.position` stays scene space; depth folded into
  position before the matrix so `Matrix2D` survives. `orthographic` must stay
  byte-identical to today, and there are frame-hash goldens to prove it on
- [ ] Depth estimation pass on ComfyUI, feeding `layered-2.5d`

### W9a — Extract the scene geometry, before projection lands

- [ ] **Four independent implementations of scene→screen geometry**, plus three
      independent paint-order sorts: `render-engine/src/frames/matrix.ts`,
      `export-kit/src/scene-space.ts`, `apps/web/.../timeline/player/scene-space.ts`,
      and the implicit one inside `reframe/focus-track.ts`.

      The home is `@rv/anim-engine` — pure, no IO, browser-safe, already at the 100 %
          tier, and already the shared home of the bezier solver *for exactly this stated
          reason*. `apps/web` cannot import `@rv/render-engine` and should not: the
          dependency rule is right, the geometry is just in the wrong package.

          Do this before isometric, not after. One wrong constant in the shared export-kit
          module fails 18 tests across two formats; the same constant wrong in one of four
          unshared copies fails nothing until somebody watches the output.

- [x] **The reframer solved the crop against the wrong rectangle.** `sampleFocusTrack`
      located the subject with `worldToNorm(position, sceneSpace)`, ignoring the camera —
      but the crop is applied to a master with the camera baked in. On the repo's own
      camera fixture the error reached 25 % of frame width, against a 9:16 crop that is
      about 32 % of a 16:9 master, so the subject leaves the frame. Live on the shipping
      path. The test that should have caught it asserted
      `sampleFocusTrack(...) === sampleFocusTrack(...)` — determinism only, never
      _where_, and it would have passed with the function gutted to return a constant

## W8 — The proof

- [ ] Produce a complete sample series end to end, on the free lane, at `$0`
- [ ] Deliver all seven platform formats and probe each against its spec
- [ ] Walk the full journey in the browser in Persian, then in English
- [ ] Fix whatever that surfaces, and repeat until it is clean
