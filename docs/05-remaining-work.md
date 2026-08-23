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
- [ ] **Tests.** The CLI is the only package with zero. Its `test` script is red on
      purpose until they exist, rather than green by way of `passWithNoTests`.
- [ ] `project new` · `models list|set` · `style list|probe|lock` · `cost report`
- [ ] `story new` · `cast states` · `graph show` · `continuity check`
- [ ] `assets plan|bake|edit` · `anim lint`
- [ ] `run` · `render|render resume` · `deliver` · `series cost`

## W3 — Asset production chain (Epic G)

- [~] `ProduceAssetsUseCase`: generate → matte → split parts → rig → clips → sheet →
  register, run live against ComfyUI — in flight
- [ ] Second run over the same episode costs exactly `$0` (the cache-hit proof)
- [ ] Regeneration requires explicit intent and appends a version
- [ ] Edit-by-instruction produces a variant with the original intact

## W4 — Orchestration and the API (Epic J)

All twelve stages report as implemented. What is not proven:

- [ ] Checkpoint and **resume a killed render to a byte-identical result**
- [ ] Run cancellation distinguishable from failure — see the `runs.state` gap below
- [ ] SSE run events consumed by the UI, not just emitted
- [ ] Cost ledger per run, per stage, per provider, surfaced in the UI

## W5 — Known contract and storage gaps

Reported by the agents that hit them, deferred at the time, still open.

- [ ] No `Project` schema in `contracts` — the API's most-used resource is the one
      resource with no shared type
- [ ] `runs.state` has five states; the pipeline has six. Cancelled and failed
      collapse into one, which is exactly the distinction W4 needs
- [ ] `persistence` calls its table `facts` but stores beliefs. Rename to `beliefs`
      and add a real `facts` table
- [ ] Pixel arithmetic is duplicated between `asset-engine` and `export-kit`
- [ ] `export-kit` has no backlog story (parked as P-03)

## W6 — Cross-engine seams (QA)

- [~] Audit in flight over the five engines each written in isolation: IR feature
  agreement, scene-space origin, easing agreement, story shots feeding the reframer

## W7 — Test and build health

- [x] Flaky provider test: an abort-latency assertion budgeted 100 ms of wall clock and
      lost under four-way workspace concurrency. Rebudgeted to 400 ms — still below the
      500 ms `initialBackoffMs` floor it exists to catch, so the property is intact
- [ ] CI: GitHub Actions running `pnpm verify`, `arch:check`, coverage floors and the
      determinism scan
- [ ] Coverage thresholds enforced rather than observed

## W8 — The proof

- [ ] Produce a complete sample series end to end, on the free lane, at `$0`
- [ ] Deliver all seven platform formats and probe each against its spec
- [ ] Walk the full journey in the browser in Persian, then in English
- [ ] Fix whatever that surfaces, and repeat until it is clean
