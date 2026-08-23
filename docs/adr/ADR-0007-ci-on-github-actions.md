# ADR-0007: CI on GitHub Actions, matrixed on Windows, with per-package coverage floors

**Status:** Accepted — 2026-08-23.

## Context

`pnpm verify` is the gate (CLAUDE.md §5), but until now nothing ran it except a human on
one machine. Three specific risks made that untenable:

1. **Windows.** This project is developed on Windows and two defects found so far were
   Windows-only: a command-line length limit when a script expanded a file list, and
   PowerShell mangling a quoted string. Neither is reachable from a Linux runner.
2. **Drift.** A gate that CI approximates is not a gate. The usual failure is a step added
   to one side and not the other, after which "green locally" and "green in CI" quietly
   stop meaning the same thing.
3. **Averages.** Coverage was enforced as one workspace-wide number. Measured on
   2026-08-23 the workspace was at 89.54 % branches against an 85 % floor, and inside that
   average `apps/api` sat at 78.32 % — thirteen packages above 90 % were paying for it.
   The three pure layers (`contracts`, `core-domain`, `anim-engine`) owe 100 % and could
   have decayed to 90 % without the build noticing, had they not carried their own globs.

Two invariants that CI must hold and could not hold before: **non-negotiable #1**
(determinism) had no automated check at all, and **non-negotiable #3** (cost is metered
before it is spent) had no CI-side statement that the metered budget is zero.

## Decision

**GitHub Actions**, one workflow (`.github/workflows/ci.yml`, named `verify`) on push to
`main`, on every pull request, and on demand.

**A two-OS matrix, `fail-fast: false`.** `ubuntu-latest` and `windows-latest` run the same
steps. Fail-fast off, because cancelling the Linux leg when Windows goes red hides which
of the two broke — the one question the matrix exists to answer. Every `run:` is a single
command so it works under each runner's default shell: bash on Linux, **pwsh on Windows**.
Shell-specific logic lives in `.mjs` scripts invoked by `node`, never in inline YAML.

**No drift, proved rather than promised.** The workflow runs the steps of `pnpm verify`
individually, so a failure names itself instead of being reported as "the script failed",
and `tools/scripts/verify-drift-check.mjs` asserts that the ordered list of
`pnpm run <script>` steps between the `verify:steps:begin` / `verify:steps:end` markers in
the workflow is exactly the ordered list in `package.json`'s `verify`. It runs before
`pnpm install`, so drift is reported in ten seconds rather than after a four-minute
install. The same script asserts `.nvmrc` satisfies `engines.node`, that the workflow pins
no Node or pnpm version of its own, and — only when `CI=true` — that no paid-provider
credential is visible to the job.

**Coverage floors per package, generated from the filesystem.** `vitest.config.ts` emits
one threshold glob per `packages/*` and `apps/*` that has a `src/`: 100 % for the three
pure layers, 90 % lines / 85 % branches for everything else. Generating rather than
hand-listing means a new package is enforced from its first commit instead of silently
inheriting the average. Two packages below the floor today are pinned by a `RATCHET` map
at the number they actually achieve, so they can only go up.

**Determinism is a build failure.** `tools/scripts/determinism-scan.mjs` walks every
`packages/*/src` and `apps/*/src` with the TypeScript compiler API and fails on
`Date.now()`, `Math.random()`, zero-argument `new Date()`, `performance.now()`,
`process.hrtime()` and the `node:crypto` entropy functions. Three boundary files are
allowlisted per symbol, with reasons. It is a step in `pnpm verify`, so it blocks.

**CI spends $0.** No provider credential is set in the workflow, and the guard above fails
the build if one appears. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, because nothing in
`verify` launches a browser. `REDIS_URL` is empty, which selects the in-process queue
(ADR-0006).

**A second, deliberately separate job runs `pnpm -r --no-bail test`.** The root `pnpm test`
is one Vitest process over every project; it is faster but it cannot see a package whose
own `vitest.config.ts` is broken or missing. `--no-bail` is what makes the job readable:
without it the first red package ends the run and the green ones are simply absent.

## Consequences

- Two Windows minutes are billed for every Linux minute on a private repo. Accepted: the
  defect class it catches has already cost more than that twice.
- `pnpm verify` now runs `test:cov` rather than `test`, so it is slower locally by the cost
  of v8 instrumentation. In exchange a coverage failure can never be CI-only, and CI does
  not run the suite twice.
- `pnpm verify` gained a sixth step, `determinism:check`. **CLAUDE.md §4 still lists five**
  ("format + lint + typecheck + arch + test"); that line needs updating and this ADR
  cannot do it.
- The `RATCHET` map is a standing admission of two gaps. It is designed to be deleted.
- The `package-scripts` job is red today on `apps/cli`, which has no tests yet
  (docs/05-remaining-work.md W2). That is the intended signal, not a broken job.

## Alternatives considered

| Option                                                           | Why not                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Linux only**                                                   | Cheaper and faster, and it would have caught neither Windows-only defect. The primary development machine is the one platform CI would not test.                                                                                                                             |
| **`shell: bash` on the Windows runner**                          | Makes the YAML uniform, and throws away the reason for having a Windows runner: Git Bash on Windows does not reproduce PowerShell's quoting, which is what broke.                                                                                                            |
| **One step: `run: pnpm verify`**                                 | Zero drift by construction, but every failure is reported as "the script failed" with the cause buried in a 3,000-line log. Individual steps plus a machine-checked equality gives both.                                                                                     |
| **A `pnpm verify` composite action**                             | Same benefit as the drift check with more machinery, and the mirror problem returns the moment the action takes an input.                                                                                                                                                    |
| **One global coverage threshold**                                | The status quo, and the reason `apps/api` at 78 % branches went unnoticed for as long as it did.                                                                                                                                                                             |
| **Per-package thresholds in each package's `vitest.config.ts`**  | The natural home, and unavailable: thresholds are evaluated by the run that produces the report, which is the root run. It would also let a package lower its own floor in the same commit that breaks it.                                                                   |
| **Codecov / Coveralls**                                          | Good reporting, an external dependency and an account for a repo whose CI budget is $0. `json-summary` plus an uploaded artifact answers the same question offline.                                                                                                          |
| **Waivers instead of ratchets** for the two packages below floor | A waiver says "this package is exempt" and never expires. A ratchet pinned to the measured number fails on any regression and reads as an accusation, which is what it is.                                                                                                   |
| **ESLint `no-restricted-syntax` for determinism**                | No new script, but `pnpm lint` is type-aware and takes minutes, so it cannot run on a pre-commit hook, and the rule would be silently disabled whenever the ESLint config is mid-edit. The scan is also more precise — it distinguishes `new Date()` from `new Date(iso)`.   |
| **`grep`/`ripgrep` for `Date.now`**                              | Most occurrences of `Date.now()` in this repo are in TSDoc explaining why it is banned. A checker that cries wolf on its own documentation gets switched off.                                                                                                                |
| **`passWithNoTests` so `apps/cli` goes green**                   | Turns a real gap into a green tick. The CLI's `test` script is red on purpose until its tests exist.                                                                                                                                                                         |
| **`continue-on-error` on the per-package job**                   | Observation, not enforcement. If a failing package should not block, the honest form is to fix the package.                                                                                                                                                                  |
| **Corepack to install pnpm**                                     | What the previous workflow did. Corepack is deprecated as of Node 25 and its shim resolution is order-sensitive around `setup-node`. `pnpm/action-setup` with no `version:` reads `packageManager` from `package.json`, which keeps the single source of truth.              |
| **`pnpm/setup@v2`**                                              | pnpm's own successor action, and it advertises pnpm 11+ — but checked on 2026-08-23 it is 17 commits and 94 stars, it reads the runtime from `devEngines.runtime` with no `.nvmrc` support, and its store cache is off by default. Revisit when it can pin Node from a file. |
