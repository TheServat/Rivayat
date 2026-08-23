# 03 — Backlog

**Single source of truth for what gets built and in what order.** Owned by the Product Owner.
Update in place; do not create parallel backlog files.

Reading order before this doc: [`CLAUDE.md`](../CLAUDE.md) ·
[`00-research.md`](./00-research.md) · [`00b-prior-art.md`](./00b-prior-art.md) ·
[`01-architecture.md`](./01-architecture.md) · [`02-domain-model.md`](./02-domain-model.md).

---

## خلاصهٔ فارسی

**ریوایت (Rivayat)** یک استودیوی محلی است که از یک «ایده» به یک **سریال انیمیشنی چندقسمتی** می‌رسد.
ترتیب کار ثابت است: اول **سبک هنری قفل می‌شود** (هم ظاهر، هم _نحوهٔ حرکت_)، بعد **داستان و شخصیت‌ها**
با روان‌شناسی عمیق ساخته می‌شوند و برای هر شخصیت **پرامپت‌های آماده در حالت‌های مختلف** (حالت چهره،
ژست، لباس) تولید می‌شود، سپس هر چیزی — درخت، پرنده، وسیله، شخصیت — به‌عنوان یک **asset** یک‌بار ساخته
می‌شود و **هرگز دوباره ساخته نمی‌شود** مگر با درخواست صریح؛ هر asset **نسخه‌ها (versions)** و
**چند انیمیشن** دارد. انیمیشن **procedural** است: روی rig محاسبه می‌شود، پس هزینه به تعداد asset یکتا
وابسته است نه به تعداد فریم. خروجی از یک ترکیب واحد برای **یوتیوب، اینستاگرام و تیک‌تاک** با
safe zone های تأییدشده گرفته می‌شود. مدل زبانی برای **هر مرحله جداگانه قابل انتخاب** است
(Ollama محلی، Gemini، OpenRouter) و مسیرهای رایگان در اولویت‌اند؛ هزینه **قبل از خرج شدن** تخمین زده و
سقف‌گذاری می‌شود. حافظهٔ روایت **دو-زمانه** است تا سریال چندقسمتی، گراف شخصیت‌ها و بررسی تداوم
(continuity) واقعاً کار کند. رابط کاربری **دوزبانه فارسی/انگلیسی، پیش‌فرض فارسی و RTL** است.
این سند کل کار را به ۱۲ حماسه (epic)، ۱۳۹ داستان کاربری با معیار پذیرش **قابل اجرا و قابل تست**،
و شش نقطهٔ عطف M0 تا M5 تقسیم می‌کند که هر کدام به یک **نمایش قابل اجرا** ختم می‌شود.

---

## 1. Product vision & success criteria

### Vision (5 lines)

1. One idea becomes a multi-episode animated series, locally, on one 6 GB-VRAM laptop.
2. Art style — look **and** motion — is locked before any pixel exists, and its checksum governs
   every asset that follows.
3. Every visible thing is a versioned, rigged, reusable asset; nothing is ever generated twice.
4. Animation is procedural and editable, so seconds of screen time are free and cost tracks only
   unique assets.
5. One composition delivers YouTube, Instagram and TikTok masters, driven from a Persian-first RTL
   studio.

### Success criteria for v1

The owner can say "this works" when **all** of the following are demonstrable:

| #     | Criterion                                                                                                                                                                                 | Measured by             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| SC-1  | An idea typed in Persian produces a locked `StyleBible`, a `StoryBible`, a cast with per-character expression/pose/wardrobe prompts, and a rendered episode — without leaving the studio. | Web e2e run, RV-216     |
| SC-2  | Episode 2 of the same series spends **$0** on assets that episode 1 already made.                                                                                                         | Ledger diff, RV-231     |
| SC-3  | The exact cost of a run is shown **before** any money is spent, and a run aborts rather than exceed the budget.                                                                           | RV-029, RV-104          |
| SC-4  | A 60-second short costs **≤ $5** in image spend at final quality, and **$0** to re-render, re-time or re-frame.                                                                           | RV-104 ledger assertion |
| SC-5  | Every LLM stage can be pinned independently to Ollama / Gemini / OpenRouter and the run still completes.                                                                                  | RV-090, RV-187          |
| SC-6  | The same `AnimationIR` renders to a bit-identical frame hash on two runs and on both backends.                                                                                            | Golden tests, RV-144    |
| SC-7  | Six delivery files (yt-16x9, shorts, reels, ig-4x5, ig-1x1, tiktok) come out of one render, each passing its platform spec validator.                                                     | RV-164, RV-167          |
| SC-8  | Every asset has ≥1 rig, ≥2 clips and a baked sheet; regenerating one requires an explicit intent and never destroys the previous version.                                                 | RV-102, RV-129          |
| SC-9  | Airing an episode is blocked by a continuity error and the error names the conflicting facts.                                                                                             | RV-069, RV-070          |
| SC-10 | The UI is fully usable in Persian RTL with no clipped or mirrored-wrong layout, and switches to English without reload.                                                                   | RV-202, RV-216          |
| SC-11 | `pnpm verify` is green: format, lint, typecheck, `arch:check`, and coverage at 90/85 globally, 100 % in `core-domain`, `contracts`, `anim-engine`.                                        | CI, RV-010              |

### Non-goals for v1

Generative video (rejected, ADR-0002), cloud/multi-user deployment, mobile apps, direct publishing
to platforms, real-time collaboration, audio production. Anything the owner did not ask for is in
§6 _Proposed (not requested)_ so it can be rejected cheaply.

### Decisions taken while writing this backlog

Two gaps in the architecture doc had to be resolved to write executable stories. Both are flagged
here rather than buried:

- **`packages/persistence` (`@rv/persistence`) is added to the package map.** The architecture
  diagram places Drizzle in the infrastructure layer but the package map omits it, and both
  `apps/api` and `apps/cli` need it — `apps → apps` is forbidden. RV-008 creates it.
- **`docs/02-folder-structure.md` and `docs/adr/` are referenced by existing docs but do not
  exist.** RV-011 backfills them; the ADR numbers cited in `CLAUDE.md` (0002, 0003, 0005) are
  binding once written.

---

## 2. Epics

| Epic                                       | Goal (one line)                                                                                       | Packages                                                            | Exit criterion                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Foundation & Contracts**             | Zod-first schemas, pure domain, persistence and CI so every later package has a floor to stand on.    | `contracts`, `core-domain`, `persistence`, `shared-kernel`, tooling | `pnpm verify` green; `contracts` + `core-domain` at 100 %; `pnpm rv doctor` and `pnpm schema:emit` both run.                                                                  |
| **B — Provider Layer & Cost Control**      | Every model call goes through a narrow port, a router, a meter and a budget guard — offline-testable. | `providers`, `prompt-kit`, `contracts`                              | All five adapters pass the shared contract suite from fixtures with zero network; a metered run prints an exact ledger; the guard aborts an over-budget run pre-call.         |
| **C — Style Engine**                       | Obtain, probe and **lock** a `StyleBible` covering look _and_ motion, before any pixel.               | `style-engine`, `contracts`, `providers`                            | A style can be reached by preset, derivation or wizard; the probe sheet renders; locking freezes a checksum that every asset key consumes.                                    |
| **D — Narrative Memory & Character Graph** | A bi-temporal, queryable world model that makes multi-episode continuity mechanical.                  | `narrative-memory`, `core-domain`, `persistence`                    | As-of queries answer story-time _and_ authoring-time; the epistemic view returns a character's knowledge only; the rule pass blocks airing on a seeded contradiction.         |
| **E — Story Engine**                       | Idea → `StoryBible` → cast with multi-state prompts → shot list, with per-stage model choice.         | `story-engine`, `prompt-kit`, `narrative-memory`                    | `rv story new` produces a validated bible, cast sheets carrying expression/pose/wardrobe prompts, and a shot list — on any of the three providers.                            |
| **F — Asset Registry**                     | Content-addressed identity, dedup, versions, variants and semantic lookup so nothing is made twice.   | `asset-registry`, `persistence`, `shared-kernel`                    | A repeat resolve is a cache hit at $0; regeneration requires an explicit intent and appends a version; semantic search finds an existing asset before generation is proposed. |
| **G — Asset Engine**                       | `AssetSpec` → generate → matte → parts → rig → clips → sheet → register, with a quality gate.         | `asset-engine`, `providers`, `asset-registry`                       | A tree and a character both come out with transparent parts, a fitted rig, ≥2 clips and a baked atlas; the quality gate rejects and repairs a deliberately bad render.        |
| **H — Animation Engine & IR**              | A deterministic, LLM-generatable, editable animation IR and a pure evaluator.                         | `anim-engine`, `contracts`                                          | `evaluate(ir,t)` is a pure function at 100 % branch coverage; golden frame hashes are stable; an IR can be both generated from a shot and patched by an edit op.              |
| **I — Render & Delivery**                  | IR → frames → ffmpeg → platform-correct masters and re-framed variants from one composition.          | `render-engine`, `anim-engine`                                      | One render yields six format files, each passing its spec validator; re-running produces identical hashes; a render resumes after a kill.                                     |
| **J — Orchestration, API & CLI**           | Run the eleven pipeline stages headlessly and over HTTP/SSE, checkpointed and resumable.              | `apps/api`, `apps/cli`, all engines                                 | `rv run` completes the pipeline against fake providers in CI; a killed run resumes; editing an upstream artefact re-runs only downstream stages.                              |
| **K — Studio UI**                          | A Persian-first RTL studio where every artefact of every stage is inspectable and editable.           | `apps/web`                                                          | Playwright e2e drives idea → render in `fa` and `en` with visual regression in both directions.                                                                               |
| **L — Series & Episode Management**        | Seasons, episodes, canon freeze, shared library and change propagation across a series.               | `core-domain`, `narrative-memory`, `asset-registry`, `apps/api`     | Episode 2 renders reusing episode 1's assets at $0 asset spend; a season restyle forks assets without breaking season 1.                                                      |

---

## 3. User stories

Every story: `RV-nnn`, an `As a … I want … so that …`, Given/When/Then acceptance criteria that a
QA engineer can automate without asking a question, a verification command, a size and its
dependencies. Sizes: **S** ≤ 1 day, **M** 2–4 days, **L** ≥ 1 week.

---

### Epic A — Foundation & Contracts

#### RV-001 — Core Zod schemas for the four core models

**As a** platform engineer **I want** `Brief`, `StyleBible`, `StoryBible`, `CharacterSheet`,
`AssetSpec`, `Shot` and `AnimationIR` defined once as Zod schemas **so that** types, LLM JSON
Schema and API DTOs all derive from one place and cannot drift.

- **Given** `packages/contracts/src/`, **when** `pnpm --filter @rv/contracts typecheck` runs,
  **then** every exported domain type is `z.infer<typeof X>`, asserted by a source-scan test that
  fails on any hand-written `interface`/`type` describing a domain shape.
- **Given** the schema registry, **when** `schemaRegistry` is enumerated, **then** it contains an
  entry for each of the seven models under a stable string key, and a test asserts the exact key set.
- **Given** any schema, **when** it parses an object carrying an unknown key, **then** it fails
  (`.strict()`), proving LLM output cannot smuggle fields in.
- **Verify:** `cd packages/contracts && npx vitest run src/index.spec.ts src/registry.spec.ts`
- **Size:** L · **Depends on:** —

#### RV-002 — JSON Schema emitter for LLM structured output

**As a** provider adapter **I want** `toLlmJsonSchema(schema)` **so that** Ollama's `format` field
and Gemini's `responseSchema` receive a dialect they actually accept.

- **Given** a Zod schema using `.optional()`, `.union()`, `.discriminatedUnion()` and `.brand()`,
  **when** `toLlmJsonSchema` runs, **then** the output contains no `$ref` and no `allOf`, and every
  object node carries `additionalProperties: false`.
- **Given** the same schema twice, **when** emitted, **then** the two JSON strings are byte-identical
  (deterministic key ordering).
- **Given** all registry schemas, **when** `pnpm schema:emit` runs, **then**
  `docs/generated/schemas/<key>.json` exists for every key and a golden snapshot test fails on any
  unreviewed change.
- **Verify:** `pnpm schema:emit && cd packages/contracts && npx vitest run src/emit/llm-json-schema.spec.ts`
- **Size:** M · **Depends on:** RV-001

#### RV-003 — OpenAPI emitter from the same schemas

**As an** API consumer **I want** the OpenAPI document generated from `@rv/contracts` **so that**
the HTTP surface can never disagree with the domain.

- **Given** the registry, **when** `pnpm schema:emit` runs, **then** `docs/generated/openapi.json`
  is written and validates against the OpenAPI 3.1 meta-schema.
- **Given** a field renamed in `contracts`, **when** the emitter re-runs, **then** the golden
  snapshot diff shows exactly that field and no unrelated churn.
- **Verify:** `pnpm schema:emit && cd packages/contracts && npx vitest run src/emit/openapi.spec.ts`
- **Size:** S · **Depends on:** RV-001

#### RV-004 — `core-domain` entities, value objects and invariants

**As a** domain owner **I want** pure entities for the work hierarchy and the asset tree **so that**
business rules live where no SDK can reach them.

- **Given** `packages/core-domain/src`, **when** `pnpm arch:check` runs, **then** the
  `core-domain-is-pure` rule reports zero violations.
- **Given** `Series/Season/Episode/Act/Sequence/Scene/Shot/Beat` and
  `Asset/AssetVersion/Part/Rig/Clip/Variant`, **when** an entity is constructed with a violating
  value (empty `canonicalName`, negative `durationMs`, a `Part` with no z-index), **then**
  construction returns `err(ValidationError)` and never throws.
- **Given** the coverage run, **when** it completes, **then** `packages/core-domain/src/**` reports
  100 % lines, branches, functions and statements.
- **Verify:** `cd packages/core-domain && npx vitest run --coverage`
- **Size:** L · **Depends on:** RV-001

#### RV-005 — Episode lifecycle state machine and domain events

**As a** showrunner **I want** `draft → outlined → scripted → boarded → asset-resolved →
choreographed → rendered → AIRED` enforced in the domain **so that** canon can be frozen safely.

- **Given** an episode in `draft`, **when** `transition('rendered')` is called, **then** it returns
  `err(ConflictError)` naming both states; a table-driven test covers every illegal pair.
- **Given** an episode in `AIRED`, **when** any mutating command is applied, **then** it returns
  `err(ConflictError)` with kind `canon-frozen`.
- **Given** a legal transition, **when** it succeeds, **then** exactly one `EpisodeTransitioned`
  event is emitted carrying `{ from, to, at }`, with `at` supplied by the injected `Clock`.
- **Verify:** `cd packages/core-domain && npx vitest run src/series/episode-lifecycle.spec.ts`
- **Size:** M · **Depends on:** RV-004

#### RV-006 — Asset dedup key and `RegenerateIntent`

**As a** cost owner **I want** `assetKey(semanticKey, styleChecksum, variantKey, specHash)` in the
domain **so that** "no asset is generated twice" is a function, not a habit.

- **Given** identical inputs in any property order, **when** `assetKey` runs, **then** the sha256 is
  identical; with any single input changed by one character, the key differs.
- **Given** a `RegenerateIntent` constructed without a `reason` in
  `'new-take' | 'style-changed' | 'quality-reject'`, **when** validated, **then** it fails.
- **Given** a regenerate flow, **when** applied, **then** `keepPrevious` is forced to `true` and a
  test asserts no exported function can remove an `AssetVersion`.
- **Verify:** `cd packages/core-domain && npx vitest run src/asset/asset-key.spec.ts src/asset/regenerate-intent.spec.ts`
- **Size:** S · **Depends on:** RV-004

#### RV-007 — Pipeline stage graph (S0–S11) as pure domain

**As an** orchestrator **I want** the eleven stages, their inputs/outputs and their dependency edges
expressed as data **so that** an edit invalidates exactly the downstream stages and nothing else.

- **Given** the stage graph, **when** `downstreamOf('S1')` is called, **then** it returns `S2..S11`,
  and `downstreamOf('S9')` returns `[S10, S11]`, asserted against a fixture.
- **Given** a run where S0–S7 are complete and S1's output changes, **when** `invalidate('S1')`
  runs, **then** S2–S11 become `stale` and S0 stays `complete`.
- **Given** a cycle introduced in a test, **when** the graph is constructed, **then** it returns
  `err(ValidationError)`.
- **Verify:** `cd packages/core-domain && npx vitest run src/pipeline/stage-graph.spec.ts`
- **Size:** M · **Depends on:** RV-004

#### RV-008 — `@rv/persistence`: SQLite + Drizzle, migrations, repositories

**As an** application layer **I want** repository interfaces with a SQLite/Drizzle implementation
**so that** metadata persists locally with zero ops and Postgres stays a drop-in swap.

- **Given** a clean `workspace/`, **when** `pnpm rv db migrate` runs, **then** `rivayat.db` exists
  and `PRAGMA user_version` equals the migration count.
- **Given** every repository interface, **when** the shared repository contract suite runs against
  both the SQLite adapter and an in-memory adapter, **then** both pass identically.
- **Given** a use-case writing two aggregates where the second write fails, **when** it runs,
  **then** neither is persisted.
- **Given** `pnpm arch:check`, **when** it runs, **then** no engine package imports `drizzle-orm` or
  `better-sqlite3` directly.
- **Verify:** `cd packages/persistence && npx vitest run && pnpm arch:check`
- **Size:** L · **Depends on:** RV-004

#### RV-009 — Content-addressed binary store (`fs-cas`)

**As an** asset registry **I want** an immutable sha256-sharded file store **so that** binaries are
deduplicated across every project and never overwritten.

- **Given** a buffer, **when** `put(buf)` runs twice, **then** both calls return the same `Sha256`,
  the file is written once, and the second call performs no write (spy assertion).
- **Given** a stored object, **when** any write API targets its path, **then** it returns
  `err(ConflictError)` — the store is append-only.
- **Given** `get(sha)` for a missing object, **when** called, **then** it returns
  `err(NotFoundError)`, not a throw.
- **Given** a stored object, **when** `verify(sha)` runs, **then** the recomputed digest matches the
  path shard `<sha[0:2]>/<sha>`.
- **Verify:** `cd packages/persistence && npx vitest run src/cas/fs-cas.spec.ts`
- **Size:** M · **Depends on:** RV-008

#### RV-010 — CI: `pnpm verify` gate with coverage and architecture enforcement

**As a** maintainer **I want** CI to run the full verify chain **so that** a broken invariant cannot
merge.

- **Given** a pull request, **when** CI runs, **then** `format:check`, `lint`, `typecheck`,
  `arch:check` and `test --coverage` all execute and any failure fails the job.
- **Given** a deliberate dependency-rule violation on a scratch branch, **when** CI runs, **then**
  the `arch:check` step fails with the rule name in the log.
- **Given** coverage below 90/85 globally, or below 100 % in `core-domain`, `contracts` or
  `anim-engine`, **when** CI runs, **then** the job fails.
- **Verify:** `pnpm verify`
- **Size:** S · **Depends on:** RV-001, RV-004

#### RV-011 — Backfill the documents `CLAUDE.md` already cites

**As a** contributor **I want** the ADRs and folder-structure doc that existing docs link to
**so that** decisions are not relitigated from memory.

- **Given** `docs/adr/`, **when** listed, **then** `ADR-0001` (monorepo & toolchain),
  `ADR-0002` (no generative video), `ADR-0003` (own animation IR; Rive/Spine/DragonBones as export
  targets only), `ADR-0004` (Ollama native `/api/chat`, never the OpenAI shim) and `ADR-0005`
  (TypeScript 6.0.3, not 7) all exist, each with Context / Decision / Consequences.
- **Given** `docs/02-folder-structure.md`, **when** opened, **then** it lists every package in the
  architecture package map plus `packages/persistence`.
- **Given** the repo, **when** a link checker runs over `docs/**` and `CLAUDE.md`, **then** zero
  relative links are broken.
- **Verify:** `npx markdown-link-check -q CLAUDE.md docs/*.md docs/adr/*.md`
- **Size:** S · **Depends on:** —

#### RV-012 — Typed, validated configuration

**As an** operator **I want** `.env` parsed through a Zod schema at boot **so that** a missing key
fails immediately with a readable message instead of at the first provider call.

- **Given** an `.env` missing `RV_WORKSPACE_DIR`, **when** the app boots, **then** it exits non-zero
  and stderr names the offending key.
- **Given** `RV_BUDGET_USD_PER_RUN=abc`, **when** config loads, **then** it fails with a
  `ValidationError` naming the field and expected type.
- **Given** a valid `.env`, **when** config loads, **then** a test asserts the key set of
  `.env.example` matches the schema's key set exactly, so the example file cannot rot.
- **Verify:** `cd packages/persistence && npx vitest run src/config/app-config.spec.ts`
- **Size:** S · **Depends on:** RV-001

#### RV-013 — Determinism fitness function

**As a** render owner **I want** lint rules banning wall-clock and unseeded randomness in domain and
application code **so that** "renders are bit-reproducible" is enforced, not hoped for.

- **Given** a file in `core-domain`, `contracts`, any `*-engine`, `narrative-memory` or
  `asset-registry` containing `Date.now()`, `new Date()`, `Math.random()` or `process.hrtime`,
  **when** `pnpm lint` runs, **then** ESLint reports `rv/no-nondeterminism` as an error.
- **Given** the same rule applied to `packages/providers` or `apps/**`, **when** lint runs, **then**
  it does not fire — adapters may read the clock at the boundary.
- **Given** one fixture file per banned construct, **when** the rule's own suite runs, **then** each
  is flagged.
- **Verify:** `pnpm lint && cd tools/eslint-plugin-rv && npx vitest run`
- **Size:** M · **Depends on:** RV-010

#### RV-014 — CLI skeleton (`pnpm rv`) and workspace/project management

**As a** headless user **I want** an `rv` command that creates and opens projects **so that** every
later milestone has something to demonstrate.

- **Given** the repo, **when** `pnpm rv --help` runs, **then** it exits 0 and lists the stage
  commands registered so far.
- **Given** an empty directory, **when** `pnpm rv project new "دهکده" --lang fa` runs, **then**
  `workspace/projects/<slug>/project.json` exists, validates against the contract schema, and stores
  the locale.
- **Given** `pnpm rv doctor`, **when** it runs, **then** it prints a table of Node, pnpm, FFmpeg,
  Ollama and ComfyUI availability and exits non-zero only if a **required** tool is missing.
- **Given** any CLI command, **when** it fails, **then** it prints the typed error kind and exits
  with a stable non-zero code (table-driven test).
- **Verify:** `pnpm rv doctor && cd apps/cli && npx vitest run src/commands/project.spec.ts`
- **Size:** M · **Depends on:** RV-008, RV-012

---

### Epic B — Provider Layer & Cost Control

#### RV-020 — Narrow ports and a typed capability matrix

**As an** engine **I want** six separate ports plus a declared capability matrix **so that** the
router never asks an adapter for something it cannot do.

- **Given** `TextGenerationPort`, `StructuredGenerationPort`, `ImageGenerationPort`,
  `ImageEditPort`, `VisionScoringPort` and `EmbeddingPort`, **when** the source is inspected,
  **then** each declares at most two methods and none references a vendor type.
- **Given** an adapter that does not implement `ImageEditPort`, **when** the router is asked to route
  an `image-edit` task to it, **then** it returns `err(UnsupportedCapabilityError)` **before** any
  network call (spy asserts zero requests).
- **Given** an adapter registered without declaring capabilities, **when** registration runs,
  **then** it fails at construction time.
- **Verify:** `cd packages/providers && npx vitest run src/ports/capability-matrix.spec.ts`
- **Size:** M · **Depends on:** RV-001

#### RV-021 — `StructuredCall`: parse → validate → repair → escalate

**As** every part of the app **I want** one sanctioned way to ask a model for JSON **so that**
Ollama's non-enforcement of schemas on `qwen3.5`/`gemma4` cannot corrupt the pipeline.

- **Given** a response wrapped in a fenced code block with trailing prose, **when** `StructuredCall`
  runs, **then** it returns `ok(parsed)`; the fence-stripping is asserted against the raw fixture.
- **Given** a schema-violating response, **when** the wrapper runs, **then** it issues exactly one
  repair turn whose prompt contains the Zod issue paths, and that attempt appears in `attempts[]`.
- **Given** two consecutive violations, **when** the wrapper runs, **then** it escalates to the next
  binding and the result records `escalatedFrom`.
- **Given** all attempts failing, **when** it gives up, **then** it returns `err(ProviderError)` with
  `kind: 'structured-output-failed'` and never a partially-parsed object.
- **Given** any attempt, **when** it completes, **then** the `CostMeter` holds one ledger row per
  attempt, including failed ones.
- **Verify:** `cd packages/prompt-kit && npx vitest run src/structured-call.spec.ts`
- **Size:** L · **Depends on:** RV-002, RV-020, RV-028

#### RV-022 — `OllamaAdapter` (Text, Structured, Embedding, Vision)

**As a** cost-conscious user **I want** the local free lane wired through Ollama's native API
**so that** iteration costs nothing and structured output uses `format`, not the broken shim.

- **Given** any structured request, **when** issued, **then** the recorded fixture shows
  `POST /api/chat` carrying a `format` object, and a source-scan test asserts the string
  `/v1/chat/completions` appears nowhere in the package.
- **Given** an extraction task, **when** options are built, **then** `temperature` is `0` and
  `think` is `false`.
- **Given** Ollama unreachable, **when** a call is made, **then** it returns `err(ProviderError)`
  with `retryable: true`; no exception escapes the adapter.
- **Given** `embed(["a","b"])`, **when** it runs, **then** two vectors of equal, non-zero length are
  returned.
- **Verify:** `cd packages/providers && npx vitest run src/ollama`
- **Size:** M · **Depends on:** RV-020, RV-033

#### RV-023 — `GeminiAdapter` (Text, Structured, Image, ImageEdit, Vision)

**As a** producer **I want** Gemini's free text tier and paid image/edit models **so that** the
strong creative stages and the final image lane are both available.

- **Given** a structured request, **when** issued, **then** `responseSchema` is populated from
  `toLlmJsonSchema` and `responseMimeType` is `application/json`.
- **Given** an edit request with a base image and two reference images, **when** issued, **then** the
  recorded request carries three inline image parts plus the instruction text.
- **Given** a free-tier text call, **when** it completes, **then** the ledger row records
  `nanoUsd === 0`; **given** an image call, **then** `nanoUsd > 0` and equals the research §2 price
  for that model.
- **Given** a 429 response, **when** received, **then** the adapter returns `err(RateLimitError)`
  carrying `retryAfterMs`.
- **Verify:** `cd packages/providers && npx vitest run src/gemini`
- **Size:** M · **Depends on:** RV-020, RV-028, RV-033

#### RV-024 — `OpenRouterAdapter` with live model-catalogue sync

**As a** user **I want** one key across many models with the `:free` set discoverable **so that**
free lanes are used automatically where they exist.

- **Given** a recorded `/api/v1/models` payload, **when** the catalogue syncs, **then** models are
  indexed by id with `{ contextLength, modalities, pricing }` and the free subset is exactly those
  ids ending in `:free`.
- **Given** the catalogue, **when** `listImageCapable({ free: true })` is called, **then** it returns
  an empty list — codifying research §2 so a regression is caught.
- **Given** a snapshot older than the configured TTL, **when** a route is requested, **then** the
  adapter refreshes once and falls back to the cached snapshot if the refresh fails.
- **Verify:** `cd packages/providers && npx vitest run src/openrouter`
- **Size:** M · **Depends on:** RV-020, RV-033

#### RV-025 — `ComfyUiAdapter`: the local free image lane

**As a** user on a 6 GB GPU **I want** local SDXL-Turbo / LCM generation and inpainting **so that**
composition and blocking cost nothing.

- **Given** a workflow template in `tools/comfy-workflows/`, **when** an image request runs, **then**
  the adapter substitutes prompt, seed, width and height, returns a PNG buffer, and the ledger row
  records `nanoUsd === 0`.
- **Given** a fixed seed and prompt, **when** generation runs twice against the recorded fixture,
  **then** the returned bytes are identical.
- **Given** a request above 1024 px on either axis, **when** submitted, **then** the adapter declines
  with `err(UnsupportedCapabilityError)` naming the VRAM ceiling rather than OOM-ing the GPU.
- **Given** ComfyUI not running, **when** a call is made, **then** `err(ProviderError)` with
  `retryable: true` is returned and the router fails over.
- **Verify:** `cd packages/providers && npx vitest run src/comfyui`
- **Size:** L · **Depends on:** RV-020, RV-033

#### RV-026 — `PollinationsAdapter` keyless fallback

**As a** user with no keys configured **I want** a last-resort image source **so that** the pipeline
can still be demonstrated end to end.

- **Given** no API keys and ComfyUI down, **when** the router resolves an image task at tier `draft`,
  **then** Pollinations is selected and returns a PNG.
- **Given** the adapter, **when** its capability matrix is read, **then** it declares `image` only —
  no edit, no vision.
- **Verify:** `cd packages/providers && npx vitest run src/pollinations`
- **Size:** S · **Depends on:** RV-020, RV-033

#### RV-027 — Shared provider contract suite (LSP guard)

**As a** maintainer **I want** one suite executed against every adapter **so that** a new provider
cannot behave differently from the others.

- **Given** `packages/providers/src/__contract__/`, **when** the suite runs, **then** it executes
  once per registered adapter and the test names include the adapter name.
- **Given** any adapter, **when** the suite runs, **then** it asserts: errors are returned as
  `Result`, never thrown; unsupported capabilities return `UnsupportedCapabilityError`; every call
  writes exactly one ledger row; an `AbortSignal` yields `err(CancelledError)` within 100 ms; and
  identical inputs yield identical outputs from fixtures.
- **Given** CI, **when** the suite runs, **then** the network is stubbed and any real socket attempt
  fails the test.
- **Verify:** `cd packages/providers && npx vitest run src/__contract__`
- **Size:** L · **Depends on:** RV-022, RV-023, RV-024, RV-025, RV-026

#### RV-028 — `CostMeter` and the per-project ledger

**As an** owner **I want** every call metered in `nanoUsd` **so that** I can see exactly where money
went.

- **Given** any provider call, **when** it completes or fails, **then** a ledger row is persisted
  with `{ runId, stage, provider, model, inTokens, outTokens, images, nanoUsd, cacheHit, ts }`.
- **Given** the price table, **when** `priceFor(model, usage)` is evaluated for every model listed in
  research §2, **then** the computed cost matches the documented per-image figure (table-driven).
- **Given** a finished run, **when** `pnpm rv cost report --run <id>` executes, **then** it prints a
  per-stage and per-provider breakdown whose total equals the sum of the rows.
- **Verify:** `cd packages/providers && npx vitest run src/cost/cost-meter.spec.ts`
- **Size:** M · **Depends on:** RV-008

#### RV-029 — Budget guard: estimate, confirm, abort

**As an** owner **I want** spending capped before the call **so that** a runaway loop cannot empty my
account.

- **Given** `RV_BUDGET_USD_PER_RUN=5.00` and a run that has spent $4.98, **when** a call estimated at
  $0.04 is attempted, **then** the guard returns `err(BudgetExceededError)` and the provider is never
  invoked (spy asserts zero requests).
- **Given** `RV_CONFIRM_SPEND_ABOVE_USD=1.00` and a plan estimated at $1.40, **when** the run starts
  non-interactively without `--yes`, **then** it exits non-zero with the estimate printed.
- **Given** the daily cap reached, **when** a new run starts, **then** it aborts with the same typed
  error and the ledger gains no rows.
- **Verify:** `cd packages/providers && npx vitest run src/cost/budget-guard.spec.ts`
- **Size:** M · **Depends on:** RV-028

#### RV-030 — `ModelRouter`: tiers, policies, per-stage overrides, failover

**As a** user **I want** to pin any stage to any model, with sensible defaults and automatic failover
**so that** "the story model is selectable" holds for every LLM stage.

- **Given** `route('story.beats', 'final', 'best')`, **when** resolved, **then** it returns a binding
  whose provider declares `structured` and whose tier matches.
- **Given** a per-stage override pinning S2 to `ollama:qwen3.5`, **when** a full fake-provider run
  executes, **then** every S2 ledger row names that provider.
- **Given** the primary returning `RateLimitError` twice, **when** the router retries, **then** it
  backs off by the returned `retryAfterMs`, routes to the next binding, and the result records the
  failover chain.
- **Given** policy `cheapest` and two capable bindings, **when** routing, **then** the lower
  estimated `nanoUsd` wins (stub price table).
- **Given** `packages/providers/src/router`, **when** the source is scanned, **then** it contains no
  `switch` on a provider name — a registry map plus `assertNever` instead.
- **Verify:** `cd packages/providers && npx vitest run src/router`
- **Size:** L · **Depends on:** RV-020, RV-028, RV-029

#### RV-031 — `ResponseCache`: never pay twice for identical bytes

**As an** owner **I want** byte-identical requests served from cache **so that** re-runs and retries
are free.

- **Given** a request issued twice with identical
  `sha256(model ‖ params ‖ prompt ‖ refHashes)`, **when** the second runs, **then** it returns from
  cache, the ledger records `nanoUsd === 0` with `cacheHit: true`, and the provider spy shows one
  call.
- **Given** the same prompt with a different seed, **when** issued, **then** it is a miss.
- **Given** `--no-cache`, **when** a run executes, **then** every call is a miss.
- **Verify:** `cd packages/providers && npx vitest run src/cache/response-cache.spec.ts`
- **Size:** M · **Depends on:** RV-009, RV-028

#### RV-032 — `prompt-kit`: typed templates, few-shot banks and named agent roles

**As a** prompt author **I want** Screenwriter, Director, Producer, Actor, Continuity Editor and Art
Director as first-class typed objects **so that** each has its own system prompt, model binding and
rubric, and prompts stay diffable.

- **Given** a template rendered with a typed variable bag, **when** a variable is missing, **then**
  it is a compile error; a runtime test asserts no unresolved placeholder remains in the output.
- **Given** the six roles enumerated, **when** inspected, **then** each declares
  `{ systemPrompt, defaultBinding, rubric, outputSchemaKey }` and a test asserts all six exist.
- **Given** the same inputs, **when** a prompt is rendered twice, **then** the strings are identical —
  no timestamps, and few-shot ordering only varies under an explicit seed.
- **Verify:** `cd packages/prompt-kit && npx vitest run src/roles src/template.spec.ts`
- **Size:** M · **Depends on:** RV-001

#### RV-033 — HTTP fixture recorder for offline provider tests

**As** CI **I want** recorded provider traffic **so that** the contract suite runs with no network and
no cost.

- **Given** `RV_RECORD_FIXTURES=1` and real credentials, **when** a provider test runs, **then**
  request/response pairs are written to `src/<provider>/__fixtures__/*.json` with credentials
  redacted — a test asserts no key-shaped string survives.
- **Given** CI without credentials, **when** the suite runs, **then** every call replays from
  fixtures and an unmatched request fails the test with the request signature printed.
- **Verify:** `cd packages/providers && npx vitest run src/testing/fixture-recorder.spec.ts`
- **Size:** M · **Depends on:** RV-020

---

### Epic C — Style Engine

#### RV-040 — `StyleBible` schema, checksum and immutability of the locked form

**As an** art director **I want** the style — look _and_ motion — captured in one schema with a
content checksum **so that** changing it forks the asset library instead of silently mismatching.

- **Given** a `StyleBible`, **when** `checksum(bible)` runs, **then** it is
  `sha256(stableStringify(visual ‖ motion ‖ render ‖ promptFragments ‖ seed))` and is stable across
  key reordering.
- **Given** a bible, **when** any single field in `visual`, `motion`, `render` or `promptFragments`
  changes, **then** the checksum changes — a property test iterates every leaf path.
- **Given** the schema, **when** validated, **then** `motion` requires `fps`, `stepMode`,
  `easingSet`, `principles`, `boil`, `ambient` and `camera`; omitting any one fails validation.
- **Given** a locked bible, **when** a mutation is attempted, **then** it returns
  `err(ConflictError, 'style-locked')`.
- **Verify:** `cd packages/style-engine && npx vitest run src/style-bible.spec.ts`
- **Size:** M · **Depends on:** RV-001, RV-004

#### RV-041 — Preset library

**As a** user **I want** curated ready-made styles **so that** I can start without designing one.

- **Given** `packages/style-engine/src/presets/`, **when** enumerated, **then** there is at least one
  preset per `medium` value (`flat-vector`, `painterly`, `paper-cutout`, `pixel`, `ink-comic`,
  `watercolor`, `claymation`, `gouache`, `woodblock`) and each parses against the schema.
- **Given** each preset, **when** validated, **then** its `motion` block differs from every other
  preset's on at least `stepMode` or `easingSet` — presets differ in movement, not just colour.
- **Given** `pnpm rv style list`, **when** run, **then** it prints each preset id, name and medium.
- **Verify:** `pnpm rv style list && cd packages/style-engine && npx vitest run src/presets/presets.spec.ts`
- **Size:** M · **Depends on:** RV-040

#### RV-042 — Derive a style from reference images

**As a** user **I want** to upload references and have a bible proposed **so that** I can match a
look I already have.

- **Given** three reference images, **when** `DeriveStyleUseCase.execute()` runs against the fake
  vision provider, **then** it returns a `StyleBible` that parses, with `origin: 'derived'` and every
  reference registered as an `anchor` with its CAS sha.
- **Given** the vision provider returning prose instead of JSON, **when** derivation runs, **then**
  `StructuredCall` repairs or escalates and the use-case still returns `ok` or a typed error — never
  a partial bible.
- **Given** the same references and seed, **when** derivation runs twice, **then** the proposed
  bibles are byte-identical.
- **Verify:** `cd packages/style-engine && npx vitest run src/derive/derive-style.spec.ts`
- **Size:** M · **Depends on:** RV-021, RV-040

#### RV-043 — Style wizard

**As a** user without references **I want** guided questions and sliders composed into a bible
**so that** I can define a custom style from scratch.

- **Given** the wizard schema, **when** answered with the minimum required set, **then** it produces
  a valid `StyleBible` with `origin: 'wizard'` and no field left at a placeholder.
- **Given** a slider-only answer set (no free text), **when** composed, **then** composition succeeds
  without any LLM call (deterministic mapping) — the LLM is used only to write
  `promptFragments`.
- **Given** an answer set that is internally contradictory (e.g. `line.colorMode: 'none'` with
  `line.weight > 0`), **when** composed, **then** it returns `err(ValidationError)` naming both
  fields.
- **Verify:** `cd packages/style-engine && npx vitest run src/wizard/wizard.spec.ts`
- **Size:** M · **Depends on:** RV-040

#### RV-044 — Probe sheet

**As a** user **I want** a candidate style rendered on a fixed subject set **so that** I can judge it
before locking.

- **Given** a candidate bible, **when** `GenerateProbeSheetUseCase.execute()` runs on the free lane,
  **then** four images (character, tree, prop, sky) are generated and composited by `sharp` into
  `workspace/projects/<id>/style/probe-<checksum>.png`.
- **Given** the probe sheet, **when** inspected, **then** its filename contains the candidate
  checksum and its metadata sidecar records prompt, model, seed and cost per tile.
- **Given** the same candidate and seed, **when** the probe is regenerated, **then** the cache serves
  it and the ledger adds `nanoUsd === 0`.
- **Verify:** `pnpm rv style probe --preset ink-comic --lane free && cd packages/style-engine && npx vitest run src/probe/probe-sheet.spec.ts`
- **Size:** M · **Depends on:** RV-025, RV-031, RV-040

#### RV-045 — Lock the style

**As a** producer **I want** an explicit lock **so that** no pixel is generated against a moving
target.

- **Given** an unlocked bible, **when** `LockStyleUseCase.execute()` runs, **then** the bible becomes
  `locked: true`, its checksum is frozen and persisted, and an `StyleLocked` domain event is emitted.
- **Given** an unlocked style, **when** an asset generation is attempted, **then** it returns
  `err(ConflictError, 'style-not-locked')` and no provider call occurs.
- **Given** a locked style, **when** `unlock` is called, **then** it creates version `n+1` in
  `draft` and leaves version `n` intact and referenced by existing assets.
- **Verify:** `cd packages/style-engine && npx vitest run src/lock/lock-style.spec.ts`
- **Size:** S · **Depends on:** RV-040

#### RV-046 — Motion profile → animation parameter mapping

**As an** animator **I want** `StyleBible.motion` to actually drive the IR **so that** "the style
includes how things animate" is real and not decorative.

- **Given** two bibles differing only in `motion.stepMode` (`smooth` vs `on-2s`), **when** the same
  shot is choreographed, **then** the produced IRs differ and the `on-2s` IR holds each sampled value
  for two frames — asserted on evaluated output, not on the IR text.
- **Given** `motion.boil.enabled: true`, **when** an IR is produced, **then** a `boil` behaviour with
  the bible's amplitude and hz is attached to every drawn node.
- **Given** `motion.easingSet.out`, **when** a clip is generated, **then** its outgoing keyframes
  carry exactly that cubic-bezier — a table test covers all four named easings.
- **Given** `motion.principles.anticipation: 0`, **when** a walk clip is generated, **then** no
  anticipation keyframe is emitted.
- **Verify:** `cd packages/style-engine && npx vitest run src/motion/motion-profile.spec.ts`
- **Size:** L · **Depends on:** RV-040, RV-143

#### RV-047 — Style prompt-fragment composer

**As a** generator **I want** every image prompt to carry the style's positive, negative and
per-subject fragments **so that** no asset can be generated off-style.

- **Given** an `AssetSpec` of subject `foliage`, **when** the prompt is composed, **then** the final
  string contains `promptFragments.positive`, `promptFragments.bySubject.foliage`, and the negative
  list is passed in the negative field.
- **Given** any code path that reaches `ImageGenerationPort`, **when** the integration test runs,
  **then** a guard asserts the request carries a `styleChecksum` matching the locked bible;
  a request without one is rejected with `err(ValidationError)`.
- **Given** `visual.negative`, **when** composed, **then** every entry appears in the negative prompt
  exactly once (deduplicated, order stable).
- **Verify:** `cd packages/style-engine && npx vitest run src/prompt/fragment-composer.spec.ts`
- **Size:** M · **Depends on:** RV-040, RV-032

#### RV-048 — Style versioning and fork-impact report

**As a** producer **I want** to see what a style change would cost before I make it **so that**
restyling is a decision, not an accident.

- **Given** a locked style v1 with 60 registered assets and a proposed v2, **when**
  `StyleDiffUseCase.execute()` runs, **then** it returns the changed field paths, the count of assets
  whose key would fork, and the estimated regeneration cost in `nanoUsd`.
- **Given** the report, **when** the fields changed are confined to `render` (post-grade only),
  **then** the fork count is 0 — grading is applied at render time, not baked into assets.
- **Verify:** `cd packages/style-engine && npx vitest run src/version/style-diff.spec.ts`
- **Size:** M · **Depends on:** RV-045, RV-101

---

### Epic D — Narrative Memory & Character Graph

#### RV-060 — Entity model and typed payloads

**As a** world builder **I want** every node in the world model to be a typed `Entity` **so that**
characters, places, props and concepts share one envelope and one retrieval path.

- **Given** the nine `EntityKind` values, **when** an entity of each kind is created, **then** each
  parses against its payload schema and an unknown kind fails at compile time via `assertNever`.
- **Given** a `CharacterPayload`, **when** validated, **then** `psych` (want, need, wound, lie,
  ghost), `voice`, `arc`, `visual` and `motionSignature` are all required — a character with only
  appearance fails validation.
- **Given** an entity, **when** persisted and reloaded, **then** it round-trips byte-identically
  including its embedding vector.
- **Verify:** `cd packages/narrative-memory && npx vitest run src/entity/entity.spec.ts`
- **Size:** L · **Depends on:** RV-001, RV-008

#### RV-061 — Bi-temporal relation store

**As a** continuity editor **I want** every fact to carry story time _and_ authoring time **so that**
retro-fitted backstory does not corrupt earlier episodes.

- **Given** a `Relation`, **when** persisted, **then** `validFrom`, `validUntil`, `assertedAt`,
  `retractedAt`, `sourceRef`, `confidence` and `visibility` are all stored and indexed.
- **Given** the taxonomy, **when** enumerated, **then** all seven groups and every listed
  `RelationType` (kinship, affinity, social, spatial, possession, epistemic, narrative) are present,
  asserted against an exact fixture list.
- **Given** a relation retracted at authoring time, **when** queried with `retracted: false`,
  **then** it is absent; **when** queried with `retracted: true`, **then** it is present with its
  `retractedAt`.
- **Verify:** `cd packages/narrative-memory && npx vitest run src/graph/relation-store.spec.ts`
- **Size:** L · **Depends on:** RV-060

#### RV-062 — As-of queries on both clocks

**As a** writer **I want** to ask "what was true in the fiction at T, as we understood it at A"
**so that** I can revise the past without breaking it.

- **Given** a fact about episode 2 asserted while writing episode 7, **when** queried at
  `storyTime = E02, authoringTime = now`, **then** it is returned; **when** queried at
  `storyTime = E02, authoringTime = <before E07 was written>`, **then** it is not.
- **Given** a fact with `validUntil = E08`, **when** queried at `storyTime = E09`, **then** it is
  absent.
- **Given** a graph of 10 000 relations, **when** an as-of query runs, **then** it completes in under
  50 ms (benchmark assertion) — proving the index is used.
- **Verify:** `cd packages/narrative-memory && npx vitest run src/graph/as-of-query.spec.ts`
- **Size:** M · **Depends on:** RV-061

#### RV-063 — Epistemic view: what _this_ character knows

**As a** scene writer **I want** the POV character's view of the world **so that** a character cannot
act on information they do not have.

- **Given** the fixture where Aria is secretly Kael's mother and Kael believes his parents died in a
  fire, **when** `viewFor('kael', 'E05')` runs, **then** the returned facts include the false belief
  and exclude the secret parentage.
- **Given** the reveal at E08 (`belief.validUntil = E08`, new `knows` edge from E08), **when**
  `viewFor('kael', 'E09')` runs, **then** the parentage fact is present and the false belief is
  absent.
- **Given** an omniscient narrator scope, **when** the view is requested, **then** all
  non-`retracted` facts valid at that story time are returned.
- **Verify:** `cd packages/narrative-memory && npx vitest run src/graph/epistemic-view.spec.ts`
- **Size:** L · **Depends on:** RV-062

#### RV-064 — Hybrid, budgeted, deterministic retrieval

**As a** scene writer **I want** context assembled by a scored, budgeted query **so that** generation
is reproducible and does not blow the context window.

- **Given** the scoring function `w1·graphProximity + w2·semanticSimilarity + w3·storyRecency +
w4·importance + w5·isOpenLoop`, **when** run twice on the same graph state, **then** the selected
  fact list is identical in content and order.
- **Given** a token budget of N, **when** context is assembled, **then** the serialised context is
  ≤ N tokens and always includes the series premise, the current episode outline, the sheets of
  characters present, and the POV epistemic view — asserted as a hard floor even at the smallest
  budget.
- **Given** two facts with equal score, **when** ranked, **then** the tie is broken by a stable key
  (entity id) so ordering never depends on map iteration.
- **Verify:** `cd packages/narrative-memory && npx vitest run src/retrieval/retrieval.spec.ts`
- **Size:** L · **Depends on:** RV-061, RV-022

#### RV-065 — Scene `StateDelta` extraction and world-state fold

**As a** memory system **I want** each scene to emit a state delta folded into the world state
**so that** memory is a state machine, not a transcript.

- **Given** a scene mentioning a death, a journey and an object handover, **when** extraction runs
  against the fake provider, **then** the delta contains the corresponding relation
  additions/invalidations with `sourceRef` pointing at the scene.
- **Given** a sequence of deltas, **when** folded, **then** `worldStateAt(T)` reports who is alive,
  where each character is, what they hold and what they know — asserted against a fixture timeline.
- **Given** the same deltas replayed in the same order, **when** folded twice, **then** the resulting
  world states are deep-equal.
- **Verify:** `cd packages/narrative-memory && npx vitest run src/memory/state-delta.spec.ts`
- **Size:** L · **Depends on:** RV-061, RV-021

#### RV-066 — Rolling compaction: scene → episode → season → series

**As a** long-range planner **I want** hierarchical summaries **so that** episode 20 can be planned
without re-reading episodes 1–19.

- **Given** ten scenes, **when** compaction runs, **then** an episode summary exists whose token
  count is below the configured ceiling and which names every lead present.
- **Given** a scene edited after compaction, **when** compaction re-runs, **then** only the affected
  summary chain is recomputed (spy asserts the untouched episodes are not re-summarised).
- **Verify:** `cd packages/narrative-memory && npx vitest run src/memory/compaction.spec.ts`
- **Size:** M · **Depends on:** RV-065

#### RV-067 — Open loops: planted setups and unpaid promises

**As a** showrunner **I want** foreshadowing tracked **so that** the series does not leave promises
unpaid.

- **Given** a `foreshadows` relation with no matching `pays-off`, **when** `openLoops(seriesId)`
  runs, **then** it is listed with the episode it was planted in and its age in episodes.
- **Given** a `pays-off` relation added later, **when** the query re-runs, **then** the loop is
  closed and absent from the list.
- **Given** an episode moving to `AIRED` with an open loop older than the configured threshold,
  **when** the check runs, **then** a `warning`-severity `ContinuityIssue` is raised (not an error).
- **Verify:** `cd packages/narrative-memory && npx vitest run src/memory/open-loops.spec.ts`
- **Size:** M · **Depends on:** RV-061

#### RV-068 — Community detection and cluster summaries

**As a** retrieval system **I want** auto-clustered entity groups with rolling summaries **so that**
retrieval stays cheap on a large graph.

- **Given** a graph with two densely connected households, **when** community detection runs,
  **then** two `CommunityNode`s are produced, each listing its members, and the partition is
  deterministic for a fixed graph.
- **Given** a community, **when** summarised, **then** the summary is stored with the graph revision
  it was computed from and is invalidated when a member edge changes.
- **Verify:** `cd packages/narrative-memory && npx vitest run src/graph/community.spec.ts`
- **Size:** M · **Depends on:** RV-061

#### RV-069 — Continuity rule pass (cheap, exact, no LLM)

**As a** continuity editor **I want** free exact checks first **so that** the LLM only sees what
rules cannot decide.

- **Given** a fixture episode containing a dead character speaking, **when** the rule pass runs,
  **then** it emits `ContinuityIssue { severity: 'error', rule: 'dead-character-acts' }` naming the
  entity and the conflicting facts.
- **Given** fixtures for each rule — object in two places, timeline inversion, knowledge without a
  `knows` edge, wardrobe/prop mismatch against the previous scene, and age arithmetic — **when** the
  pass runs, **then** each produces its own typed issue and a clean fixture produces none.
- **Given** the pass, **when** executed, **then** zero provider calls occur (spy assertion).
- **Verify:** `cd packages/narrative-memory && npx vitest run src/continuity/rules.spec.ts`
- **Size:** L · **Depends on:** RV-062, RV-063, RV-065

#### RV-070 — Continuity LLM pass and issue model

**As a** continuity editor **I want** a semantic pass over what the rules could not decide **so that**
tone drift and motivation contradictions are caught.

- **Given** the rule pass output, **when** the LLM pass runs, **then** it receives only the
  undecided items (asserted on the prompt payload) and returns `ContinuityIssue[]` validated by
  `StructuredCall`.
- **Given** an issue of severity `error`, **when** `AirEpisodeUseCase` runs, **then** it returns
  `err(ConflictError)` and the episode stays in `rendered`.
- **Given** only `warning` issues, **when** airing runs, **then** it succeeds and the warnings are
  attached to the episode record.
- **Verify:** `cd packages/narrative-memory && npx vitest run src/continuity/llm-pass.spec.ts`
- **Size:** M · **Depends on:** RV-069, RV-021

#### RV-071 — Aired canon is immutable

**As a** series owner **I want** aired facts protected **so that** later episodes can extend but not
contradict them.

- **Given** an aired episode asserting `(Kael) —located-in→ (Vale)` valid from E03, **when** a later
  edit tries to set `validFrom` earlier or contradict it within E03, **then** the write returns
  `err(ConflictError, 'canon-frozen')` naming both relations.
- **Given** the same aired fact, **when** a later episode _reveals_ additional detail (a new relation
  with `validFrom ≥ E03` and no overlap conflict), **then** the write succeeds.
- **Given** any attempt to delete a relation sourced from an aired episode, **when** executed,
  **then** it is refused; retraction is the only legal operation and it preserves the row.
- **Verify:** `cd packages/narrative-memory && npx vitest run src/continuity/canon-guard.spec.ts`
- **Size:** M · **Depends on:** RV-005, RV-061

#### RV-072 — Derived views: timeline and relationship matrix

**As a** user **I want** the chronology and the relationship strengths over time as data **so that**
the UI can show the character graph and flag flat arcs.

- **Given** a series graph, **when** `timeline(seriesId)` runs, **then** relations are returned
  ordered by `validFrom` with ties broken deterministically.
- **Given** two leads, **when** `relationshipMatrix(seriesId)` runs, **then** it returns their signed
  `strength` sampled per episode.
- **Given** a lead whose strength never changes across the series, **when** the arc check runs,
  **then** a `warning` issue `flat-arc` is emitted naming the character.
- **Verify:** `cd packages/narrative-memory && npx vitest run src/views/derived-views.spec.ts`
- **Size:** M · **Depends on:** RV-061

---

### Epic E — Story Engine

#### RV-080 — Polymorphic intake (S0)

**As a** user **I want** to start from an idea, a logline, a script, prose or an existing series
bible **so that** the tool fits what I already have.

- **Given** each of the five intake kinds, **when** `IntakeUseCase.execute()` runs, **then** it
  produces a `Brief` that parses, and a test covers all five with fixture inputs.
- **Given** a Persian-language idea, **when** intake runs, **then** the `Brief.language` is `fa` and
  the original text is preserved verbatim alongside any translation.
- **Given** a 40 000-word prose input, **when** intake runs, **then** narrative compression produces
  a `Brief` under the configured token ceiling and the extracted character list is non-empty.
- **Verify:** `pnpm rv story intake --idea "یک روباه در شهر" && cd packages/story-engine && npx vitest run src/intake`
- **Size:** L · **Depends on:** RV-021, RV-032

#### RV-081 — `StoryBible` as a tree, expanded one level at a time (S2)

**As a** screenwriter **I want** DOC-style top-down expansion **so that** long-form structure holds
together instead of drifting.

- **Given** a `Brief` and a locked `StyleBible`, **when** `GenerateStoryBibleUseCase.execute()` runs,
  **then** it produces logline, theme, tone, acts and beats, and the result parses against the
  schema.
- **Given** the expander, **when** it generates a level, **then** its prompt contains the parent node
  and only the parent node's siblings' summaries — asserted on the payload — and it never emits a
  node two levels below the current one.
- **Given** the tree, **when** validated, **then** every `Beat` resolves to exactly one parent
  `Scene`, every `Scene` to a `Sequence`, and so on up to `Series`; an orphan fails validation.
- **Verify:** `cd packages/story-engine && npx vitest run src/bible/story-bible.spec.ts`
- **Size:** L · **Depends on:** RV-080, RV-045

#### RV-082 — Cast: psychology-first `CharacterSheet` (S3)

**As a** writer **I want** characters defined by want/need/wound/lie/ghost with voice and motion
signature **so that** they are strong, distinct and drivable by downstream stages.

- **Given** a `StoryBible`, **when** `GenerateCastUseCase.execute()` runs, **then** each returned
  `CharacterSheet` has non-empty `psych.want`, `psych.need`, `psych.wound`, `psych.lie`,
  `psych.ghost`, a `voice` block and a `motionSignature`; a sheet missing any of these fails
  acceptance.
- **Given** two characters in the same cast, **when** their `voice` blocks are compared, **then**
  they differ on at least two of `register`, `verbosity`, `idiolect`, `sentenceRhythm`,
  `humourMode` — enforced by a distinctness check that triggers a regeneration turn if violated.
- **Given** `visual`, **when** produced, **then** it is derived from `psych` and the `StyleBible`,
  and the derivation records which psych traits drove `silhouetteNote` and `palette`.
- **Verify:** `cd packages/story-engine && npx vitest run src/cast/generate-cast.spec.ts`
- **Size:** L · **Depends on:** RV-081, RV-060

#### RV-083 — Per-character multi-state prompt generation

**As a** user **I want** every character to arrive with ready generation prompts for each expression,
pose and wardrobe **so that** the asset pipeline has exactly what it needs and I can edit any prompt.

- **Given** a `CharacterSheet`, **when** `GenerateCharacterStatesUseCase.execute()` runs, **then** it
  produces at least 8 expressions, 6 poses and 2 wardrobe sets, each with a unique `variantKey` and a
  fully composed image prompt containing the style fragments and the character's visual descriptor.
- **Given** the produced states, **when** the cartesian demand is computed, **then** every
  `(wardrobe × expression)` and `(wardrobe × pose)` combination resolves to a deterministic
  `variantKey` — the same combination always yields the same key.
- **Given** a part-decomposition plan, **when** validated, **then** it names the parts the rig
  expects for the character's archetype (head, torso, arm_L, arm_R, leg_L, leg_R at minimum) with
  z-order and join hints.
- **Given** any state prompt edited by the user, **when** saved, **then** the edit persists, the
  `specHash` changes, and re-resolving yields a miss for that state only.
- **Verify:** `pnpm rv cast states --character kael --print && cd packages/story-engine && npx vitest run src/cast/character-states.spec.ts`
- **Size:** L · **Depends on:** RV-082, RV-047

#### RV-084 — Auto-casting and canonical reference turnaround

**As a** producer **I want** recurring characters identified and a canonical reference minted before
any scene is rendered **so that** identity is anchored from the start.

- **Given** a `StoryBible`, **when** auto-casting runs, **then** every character appearing in ≥2
  scenes is promoted to `recurring` or above and receives a canonical turnaround asset spec
  (front / three-quarter / side / back).
- **Given** the turnaround, **when** it is produced, **then** it is registered as the character's
  identity anchor and its sha is attached to the entity — later generations pass it as a reference.
- **Given** a scene render attempted before the anchor exists, **when** executed, **then** it returns
  `err(ConflictError, 'no-identity-anchor')`.
- **Verify:** `cd packages/story-engine && npx vitest run src/cast/auto-cast.spec.ts`
- **Size:** M · **Depends on:** RV-082, RV-101

#### RV-085 — World pass → `AssetSpec[]` (S4)

**As a** producer **I want** locations, props, flora, fauna and sky derived from the story **so that**
asset demand is computed rather than guessed.

- **Given** a `StoryBible` with 12 scenes, **when** the world pass runs, **then** it emits
  `AssetSpec[]` covering every location, named prop, flora/fauna and sky state referenced, each with
  a `semanticKey` in `<category>/<name>/<qualifier>` form.
- **Given** two scenes referencing the same forest, **when** the pass runs, **then** exactly one
  `AssetSpec` is emitted for it (deduplicated by semantic key).
- **Given** the specs, **when** compared against a hand-labelled fixture, **then** recall of
  referenced entities is 100 % — no referenced entity is missing a spec.
- **Verify:** `cd packages/story-engine && npx vitest run src/world/world-pass.spec.ts`
- **Size:** M · **Depends on:** RV-081, RV-060

#### RV-086 — Actor/Director dialogue writing

**As a** writer **I want** each character's lines written by an actor call bound to that character's
voice, then reconciled by a director pass **so that** characters stop sounding identical.

- **Given** a scene with three speakers, **when** dialogue generation runs, **then** three separate
  actor calls are made, each prompt containing only that character's `voice` block and their
  epistemic view — asserted on the payloads.
- **Given** the actor outputs, **when** the director pass reconciles them, **then** the final scene
  preserves each speaker's `verbalTics` (a lexical check against the tic list) and the reconciliation
  diff is recorded.
- **Given** a character with `knowledgeScope: 'limited'`, **when** their line references a fact
  outside `viewFor(character, storyTime)`, **then** the continuity rule pass flags it as an error.
- **Verify:** `cd packages/story-engine && npx vitest run src/dialogue/actor-director.spec.ts`
- **Size:** L · **Depends on:** RV-063, RV-082, RV-032

#### RV-087 — Sequence: `StoryBible` → `Shot[]` (S7)

**As a** director **I want** a shot list with camera, duration, layout, blocking, dialogue, safe area
and focus target **so that** choreography and re-framing have everything they need.

- **Given** a scene, **when** the sequencer runs, **then** each `Shot` parses and carries
  `durationMs > 0`, a `framing` from the enum, a `focusTarget` resolving to a node in its `layout`,
  and a `safeArea`.
- **Given** a scene's total beat duration, **when** shots are emitted, **then** the summed shot
  durations equal the scene duration within ±1 frame at the style's fps.
- **Given** every `blocking` action, **when** validated, **then** its `clipName` exists in the clip
  vocabulary declared by the referenced `AssetSpec`'s archetype, otherwise validation fails naming
  the missing clip.
- **Verify:** `cd packages/story-engine && npx vitest run src/sequence/sequencer.spec.ts`
- **Size:** L · **Depends on:** RV-081, RV-085

#### RV-088 — Critique pass before a draft is accepted

**As a** showrunner **I want** an automated rubric critique **so that** weak drafts are caught before
they cost money downstream.

- **Given** a generated `StoryBible`, **when** the critique pass runs, **then** it returns scores for
  each rubric dimension (premise clarity, stakes, arc movement, scene causality, style fit) in
  `0..1` and a list of concrete revision notes.
- **Given** a score below the configured threshold on any dimension, **when** the pipeline continues,
  **then** it performs one bounded revision turn and re-scores; a second failure surfaces to the user
  rather than silently proceeding.
- **Given** a deliberately incoherent fixture bible, **when** critiqued, **then** at least one
  dimension scores below threshold — the critic is not a rubber stamp.
- **Verify:** `cd packages/story-engine && npx vitest run src/critique/critique.spec.ts`
- **Size:** M · **Depends on:** RV-081, RV-032

#### RV-089 — Dynamic re-outlining of unaired episodes

**As a** showrunner **I want** the plan for future episodes revised as memory accumulates **so that**
the series can develop without contradicting what has aired.

- **Given** a series with E01–E03 aired and E04–E08 outlined, **when** re-planning runs, **then**
  only E04–E08 outlines change and a test asserts E01–E03 rows are untouched.
- **Given** an open loop planted in E02, **when** re-planning runs, **then** the revised outline
  schedules a pay-off and the loop's `plannedPayoff` field points at an episode.
- **Verify:** `cd packages/story-engine && npx vitest run src/plan/replan.spec.ts`
- **Size:** M · **Depends on:** RV-067, RV-071, RV-081

#### RV-090 — Per-stage model selection for every LLM stage

**As a** user **I want** to choose Ollama, Gemini or OpenRouter independently per stage **so that**
I can put a strong model on the creative beats and a free local one on bulk extraction.

- **Given** a project config pinning S0/S4/S8 to Ollama and S2/S3/S7 to Gemini, **when** a full
  fake-provider run executes, **then** the ledger shows exactly that provider per stage.
- **Given** `pnpm rv models list`, **when** run, **then** it prints every pipeline stage with its
  current binding and the alternatives available given the configured keys.
- **Given** `pnpm rv models set --stage S2 --binding openrouter:z-ai/glm-5.2:free`, **when** run,
  **then** the project config is updated, validated, and the next run uses it.
- **Given** a binding pinned to a provider lacking the required capability, **when** the run starts,
  **then** it fails fast with `UnsupportedCapabilityError` naming the stage.
- **Verify:** `pnpm rv models list && cd packages/story-engine && npx vitest run src/config/stage-bindings.spec.ts`
- **Size:** M · **Depends on:** RV-030

#### RV-091 — Edit any story artefact and re-run only what depends on it

**As a** user **I want** to hand-edit a beat, a character sheet or a shot **so that** the machine
serves my judgement rather than overwriting it.

- **Given** an edited `Beat`, **when** the edit is saved, **then** the stage graph marks S7–S11 stale
  and leaves S0–S6 complete.
- **Given** an edited `CharacterSheet.visual`, **when** saved, **then** only that character's asset
  specs change `specHash`, and unaffected assets remain cache hits.
- **Given** any edit, **when** persisted, **then** the previous version is retained and
  `rv story history <nodeId>` lists both with their authoring timestamps.
- **Verify:** `cd packages/story-engine && npx vitest run src/edit/edit-artefact.spec.ts`
- **Size:** M · **Depends on:** RV-007, RV-081

---

### Epic F — Asset Registry

#### RV-100 — Registry index: Asset, AssetVersion, Part, Rig, Variant, Clip

**As a** pipeline **I want** the asset tree indexed in the database with binaries in the CAS
**so that** identity, versions and derivatives are queryable and the bytes are shared.

- **Given** a registered asset, **when** loaded, **then** it returns its versions, and each version
  its parts (named, z-ordered), rig, variants and clips, with every binary referenced by `Sha256`.
- **Given** two projects registering byte-identical part images, **when** both are stored, **then**
  the CAS holds one copy and both index rows reference the same sha.
- **Given** the schema, **when** migrations run, **then** a unique index exists on the dedup key so a
  duplicate insert fails at the database level, not only in application code.
- **Verify:** `cd packages/asset-registry && npx vitest run src/index/registry.spec.ts`
- **Size:** L · **Depends on:** RV-006, RV-008, RV-009

#### RV-101 — Resolve: hit/miss planning at zero cost

**As a** producer **I want** `resolve(AssetSpec[])` to report exactly what already exists **so that**
I only ever pay for what is genuinely missing.

- **Given** 40 specs of which 31 are already registered, **when** resolve runs, **then** it returns
  31 hits and 9 misses and performs zero provider calls (spy assertion).
- **Given** a spec whose `styleChecksum` differs from the registered asset's, **when** resolved,
  **then** it is a miss — style forks the key.
- **Given** a hit, **when** returned, **then** the ledger records `nanoUsd === 0` for that spec.
- **Verify:** `cd packages/asset-registry && npx vitest run src/resolve/resolve.spec.ts`
- **Size:** M · **Depends on:** RV-100

#### RV-102 — Regeneration only on explicit intent, never destructive

**As an** owner **I want** a second take to require an explicit request **so that** my asset library
is stable.

- **Given** an existing asset and a produce request without a `RegenerateIntent`, **when** it runs,
  **then** the cached asset is returned and no provider call occurs.
- **Given** the same request with `RegenerateIntent { reason: 'new-take', keepPrevious: true }`,
  **when** it runs, **then** a new `AssetVersion` is appended, the previous version's row and
  binaries are unchanged (sha comparison before/after), and the new version is marked current.
- **Given** any code path in the repo, **when** scanned, **then** there is no `DELETE FROM
asset_versions` and no CAS unlink — enforced by a source-scan test.
- **Given** a rollback request, **when** `setCurrentVersion(v1)` runs, **then** v1 becomes current
  again and v2 remains retrievable.
- **Verify:** `cd packages/asset-registry && npx vitest run src/regenerate/regenerate.spec.ts`
- **Size:** M · **Depends on:** RV-100

#### RV-103 — Semantic search before generation

**As a** producer **I want** "a gnarled old tree" to find `flora/oak-tree/mature` **so that** the
library is reused instead of re-grown.

- **Given** a registry containing `flora/oak-tree/mature`, **when** `search('a gnarled old tree')`
  runs with the Ollama embedding provider, **then** that asset ranks first with a similarity above
  the configured floor.
- **Given** a query with no plausible match, **when** searched, **then** results below the floor are
  omitted and the caller receives an empty list rather than a bad suggestion.
- **Given** the same query and index revision, **when** searched twice, **then** the ranking is
  identical.
- **Verify:** `cd packages/asset-registry && npx vitest run src/search/semantic-search.spec.ts`
- **Size:** M · **Depends on:** RV-022, RV-100

#### RV-104 — Cost estimate shown before spending (S5)

**As an** owner **I want** an itemised estimate before production starts **so that** I decide, not
discover.

- **Given** a miss plan of 9 specs at tier `final` on `gemini-3.1-flash-lite-image`, **when**
  `EstimateUseCase.execute()` runs, **then** it returns per-spec and total `nanoUsd` computed from
  the price table, plus the count of hits saved and the money those hits represent.
- **Given** `pnpm rv assets plan --episode E01`, **when** run, **then** it prints the table and exits
  0 **without** generating anything.
- **Given** the estimate and the subsequent real run on fixtures, **when** compared, **then** the
  actual total is within 10 % of the estimate (fixtures make this exact for images).
- **Verify:** `pnpm rv assets plan --episode E01 && cd packages/asset-registry && npx vitest run src/estimate/estimate.spec.ts`
- **Size:** M · **Depends on:** RV-028, RV-101

#### RV-105 — Provenance and reproducibility

**As an** auditor **I want** every artefact to record how it was made **so that** any asset can be
reproduced and its cost explained.

- **Given** any registered artefact, **when** loaded, **then** it carries
  `{ prompt, model, seed, params, parentIds, nanoUsd, ts }` and none of these is null.
- **Given** an asset's provenance, **when** `rv assets reproduce <assetId>` runs against the
  recorded fixtures, **then** the regenerated bytes hash to the stored sha.
- **Given** an asset derived from another (a variant, a matte, a baked sheet), **when** loaded,
  **then** `parentIds` forms a chain back to the original generation.
- **Verify:** `cd packages/asset-registry && npx vitest run src/provenance/provenance.spec.ts`
- **Size:** M · **Depends on:** RV-100

#### RV-106 — Cross-project and cross-episode reuse

**As a** series owner **I want** projects to reference assets rather than own them **so that**
episode N+1 and even a second series in the same style are nearly free.

- **Given** project A holding an asset and project B requesting the same
  `semanticKey + styleChecksum + variantKey + specHash`, **when** B resolves, **then** it is a hit
  and B's ledger records `nanoUsd === 0`.
- **Given** project A deleted, **when** B loads the asset, **then** it still resolves — ownership is
  by reference, and a test asserts no cascade delete exists.
- **Verify:** `cd packages/asset-registry && npx vitest run src/reuse/cross-project.spec.ts`
- **Size:** M · **Depends on:** RV-100

#### RV-107 — Variants as cheap edits, not regenerations

**As a** producer **I want** colourway, season, damage, night-lighting and age handled as variants
**so that** a small change does not cost a full generation.

- **Given** a registered base version and a variant request `night-lit`, **when** it runs, **then**
  the pipeline uses `ImageEditPort` with the base as input, and the ledger cost is strictly less
  than the recorded cost of a fresh generation of the same subject.
- **Given** the variant, **when** registered, **then** it attaches to the same `AssetVersion` and
  shares its rig and clips — a test asserts the rig row is not duplicated.
- **Given** a variant request on an asset whose provider lacks `ImageEditPort`, **when** routed,
  **then** the router selects a capable provider or returns `UnsupportedCapabilityError` — it never
  silently falls back to a full regeneration.
- **Verify:** `cd packages/asset-registry && npx vitest run src/variant/variant.spec.ts`
- **Size:** M · **Depends on:** RV-100, RV-122

---

### Epic G — Asset Engine

#### RV-120 — `AssetSpec` → composed generation request

**As a** generator **I want** the spec, the style fragments and the reference set assembled into one
request **so that** every generation is on-style and identity-anchored.

- **Given** an `AssetSpec` for a character state, **when** the request is composed, **then** it
  carries the style positive/negative fragments, the subject fragment, the character's visual
  descriptor, the identity anchor sha, and the seed derived from `hashSeed(specHash)`.
- **Given** the same spec, **when** composed twice, **then** the requests are byte-identical.
- **Given** a spec with no locked style, **when** composed, **then** it returns
  `err(ConflictError, 'style-not-locked')`.
- **Verify:** `cd packages/asset-engine && npx vitest run src/compose/request-composer.spec.ts`
- **Size:** M · **Depends on:** RV-047, RV-083

#### RV-121 — Image generation with multi-reference conditioning

**As a** producer **I want** style anchors and the character turnaround passed as references on every
call **so that** consistency does not depend on prompt luck.

- **Given** a character state generation, **when** issued, **then** the request contains the style
  anchors and the identity turnaround as reference images, asserted on the recorded payload.
- **Given** a provider without multi-reference support, **when** routed, **then** the router selects
  one that has it, or the run reports the degraded mode explicitly in the result metadata.
- **Given** a fixed seed and spec, **when** generation replays from fixtures, **then** the returned
  bytes hash identically.
- **Verify:** `cd packages/asset-engine && npx vitest run src/generate/generate-image.spec.ts`
- **Size:** L · **Depends on:** RV-023, RV-084, RV-120

#### RV-122 — Image editing: masked inpaint and instruction edit

**As a** user **I want** to edit any generated image **so that** I can fix a hand, change a colour or
alter a detail without regenerating the asset.

- **Given** a base image, a mask PNG and an instruction, **when** `EditImageUseCase.execute()` runs,
  **then** it returns an edited image and registers it as a new variant with `parentIds` pointing at
  the base.
- **Given** an edit with no mask (instruction only), **when** it runs, **then** it still succeeds via
  the provider's instruction-edit path.
- **Given** an edit, **when** registered, **then** the original bytes are untouched (sha comparison)
  and both versions are retrievable.
- **Given** an edit whose result fails the quality gate, **when** it completes, **then** it is
  surfaced for approval rather than auto-accepted.
- **Verify:** `pnpm rv assets edit --asset <id> --instruction "make the lantern brighter" && cd packages/asset-engine && npx vitest run src/edit/edit-image.spec.ts`
- **Size:** L · **Depends on:** RV-023, RV-107

#### RV-123 — Matting: transparent RGBA cutouts

**As a** rigger **I want** clean alpha on every part **so that** assets composite correctly at any
depth.

- **Given** a generated PNG on a neutral field, **when** matting runs with BiRefNet via
  `@huggingface/transformers`, **then** the output has an alpha channel and the background corner
  pixels are fully transparent.
- **Given** the primary matting model unavailable, **when** matting runs, **then** it falls back to
  `@imgly/background-removal-node` and records which engine was used.
- **Given** the alpha, **when** the cleanliness metric runs, **then** the fraction of pixels with
  `0 < alpha < 255` outside a 2 px edge band is below the configured threshold; above it, the asset
  fails the quality gate.
- **Given** the same input, **when** matted twice, **then** the output bytes are identical.
- **Verify:** `cd packages/asset-engine && npx vitest run src/matte/matte.spec.ts`
- **Size:** L · **Depends on:** RV-121

#### RV-124 — Parts-sheet prompting: ask for parts by design

**As a** rigger **I want** the image model to produce isolated, named, depth-ordered parts **so that**
decomposition is a read, not a fight.

- **Given** a character's `partDecompositionPlan`, **when** the parts-sheet prompt is composed,
  **then** it requests each named part isolated on a neutral field in a labelled grid with a declared
  cell order.
- **Given** a returned parts sheet, **when** it is sliced, **then** each cell maps to a named part in
  plan order, and a sheet whose cell count differs from the plan fails with
  `err(ValidationError, 'parts-count-mismatch')`.
- **Given** the sliced parts, **when** registered, **then** each carries its name, z-index and the
  join hints from the plan.
- **Verify:** `cd packages/asset-engine && npx vitest run src/parts/parts-sheet.spec.ts`
- **Size:** L · **Depends on:** RV-083, RV-121

#### RV-125 — Decomposition fallback chain

**As a** pipeline **I want** parts-sheet → segmentation → single-layer fallbacks **so that** a hard
subject still yields an animatable asset.

- **Given** a parts sheet that fails validation, **when** the fallback runs, **then** segmentation
  (BiRefNet/SAM-family) splits the finished render into the planned parts and records
  `decomposition: 'segmented'`.
- **Given** segmentation also failing the part-completeness check, **when** the last fallback runs,
  **then** a single-layer asset is registered with `decomposition: 'single-layer'` and a mesh-deform
  rig, and the asset is still animatable — proven by generating and evaluating a `sway` clip.
- **Given** any fallback taken, **when** the asset is loaded, **then** the chosen strategy and the
  reason are readable from its provenance.
- **Verify:** `cd packages/asset-engine && npx vitest run src/parts/fallback-chain.spec.ts`
- **Size:** L · **Depends on:** RV-123, RV-124

#### RV-126 — Auto-rig from archetype templates

**As an** animator **I want** a rig fitted automatically from the declared archetype **so that** every
asset arrives riggable without manual work.

- **Given** an `AssetSpec` declaring archetype `bird`, **when** auto-rig runs, **then** the bird
  template's bone graph is instantiated and every bone is anchored to a part by alpha centroid plus
  the declared join hints.
- **Given** each of the nine archetypes (`biped`, `quadruped`, `bird`, `tree`, `cloud`, `water`,
  `prop`, `crowd`, `fx`), **when** rigged from a fixture asset, **then** the resulting rig validates:
  no orphan bones, no cycles, every IK chain resolvable, and mesh grids generated for parts marked
  deformable.
- **Given** a part named in the template but missing from the asset, **when** rigging runs, **then**
  it returns `err(ValidationError)` naming the missing part rather than producing a broken rig.
- **Given** the archetype, **when** determined, **then** it comes from the `AssetSpec` — a
  source-scan test asserts no pixel-based guessing.
- **Verify:** `cd packages/asset-engine && npx vitest run src/rig/auto-rig.spec.ts`
- **Size:** L · **Depends on:** RV-124, RV-125

#### RV-127 — Clip generation from the motion preset library

**As an** animator **I want** each rigged asset to arrive with clips parameterised by the style's
motion block **so that** every asset carries multiple animations out of the box.

- **Given** a rigged `tree`, **when** clip generation runs, **then** at least `idle`, `sway` and
  `wind-gust` clips exist; for `biped`, at least `idle`, `walk`, `talk` and one expression-driven
  clip.
- **Given** the same archetype and clip rendered under two different `StyleBible.motion` blocks,
  **when** both are evaluated at the same `t`, **then** the resulting snapshots differ — proving the
  style genuinely parameterises movement.
- **Given** a character with a `motionSignature`, **when** its `walk` clip is generated, **then**
  gait, posture, gesture frequency and energy from the signature appear as clip parameters, and two
  characters with different signatures produce measurably different walk snapshots.
- **Verify:** `cd packages/asset-engine && npx vitest run src/clips/clip-generation.spec.ts`
- **Size:** L · **Depends on:** RV-046, RV-126, RV-143

#### RV-128 — Quality gate with bounded repair

**As a** producer **I want** every generated image scored against a style-derived rubric **so that**
"high quality" is measured, not assumed.

- **Given** a generated image, **when** the gate runs, **then** `VisionScoringPort` returns scores in
  `0..1` for style match, alpha cleanliness, silhouette readability, identity match against the
  anchor, and part completeness.
- **Given** a score below threshold, **when** the gate fires, **then** it performs at most N bounded
  prompt-repair retries (N from config, default 2) and each retry is metered.
- **Given** the retries exhausted, **when** the gate finishes, **then** the asset is marked
  `needs-review` and surfaced to the user — a test asserts it is never silently registered as
  accepted.
- **Given** a deliberately off-style fixture image, **when** scored, **then** the style-match score
  is below threshold — the gate is not a rubber stamp.
- **Verify:** `cd packages/asset-engine && npx vitest run src/quality/quality-gate.spec.ts`
- **Size:** L · **Depends on:** RV-020, RV-121

#### RV-129 — Sprite-sheet baking (animation sheets)

**As a** runtime **I want** clips baked to trimmed atlases **so that** playback is cheap and assets
ship with animation sheets.

- **Given** `bakeSheet(assetVersion, 'sway', { fps: 24, frames: 48, maxSize: 2048, padding: 2, trim: true })`,
  **when** it runs, **then** `atlas.png` and `atlas.json` are produced, every frame rect is inside the
  atlas bounds, and no two rects overlap.
- **Given** the atlas JSON, **when** validated, **then** it lists frame index, source rect, trimmed
  offset and pivot for each frame, and the frame count equals the requested count.
- **Given** the sheet deleted from disk, **when** it is requested again, **then** it is rebuilt from
  the rig and clip and the bytes hash identically — sheets are derived, never source of truth.
- **Given** a clip exceeding `maxSize`, **when** baked, **then** it spills to a second atlas page
  rather than failing.
- **Verify:** `pnpm rv assets bake --asset <id> --clip sway && cd packages/asset-engine && npx vitest run src/bake/bake-sheet.spec.ts`
- **Size:** L · **Depends on:** RV-126, RV-141

#### RV-130 — Register: the produce pipeline's terminal step

**As a** pipeline **I want** generate → matte → parts → rig → clips → sheet → register as one
idempotent use-case **so that** re-running S6 is safe.

- **Given** a miss plan, **when** `ProduceAssetsUseCase.execute()` runs, **then** every produced
  asset is registered with its dedup key, provenance and cost.
- **Given** the identical plan re-run, **when** it executes, **then** every spec is a hit, zero
  provider calls occur, and the total added cost is `0`.
- **Given** a crash after matting but before rigging, **when** the stage is resumed, **then** the
  already-generated image is reused from the CAS and only the remaining steps run.
- **Verify:** `pnpm rv assets produce --episode E01 --lane free && cd packages/asset-engine && npx vitest run src/produce/produce-assets.spec.ts`
- **Size:** L · **Depends on:** RV-101, RV-123, RV-126, RV-127, RV-129

#### RV-131 — Draft lane → final lane promotion

**As an** owner **I want** to block with free local drafts and pay only for locked assets **so that**
quality is bought where it matters.

- **Given** `--lane free`, **when** production runs, **then** every image comes from ComfyUI or
  Pollinations and the run's total cost is `0`.
- **Given** a draft asset approved, **when** `rv assets promote --asset <id> --lane final` runs,
  **then** a new `AssetVersion` is generated on the paid provider with the same seed and prompt, the
  draft is retained, and the promotion is recorded in provenance.
- **Given** a promotion attempt above the budget, **when** it runs, **then** it aborts pre-call with
  `BudgetExceededError`.
- **Verify:** `cd packages/asset-engine && npx vitest run src/lane/promote.spec.ts`
- **Size:** M · **Depends on:** RV-025, RV-029, RV-102

#### RV-132 — Character-consistency drift check

**As a** producer **I want** every character state scored against the identity anchor **so that**
drift is caught at generation, not in the finished video.

- **Given** a generated character state, **when** the identity check runs, **then** it returns a
  similarity score against the canonical turnaround and fails the gate below the configured floor.
- **Given** a full expression/pose/wardrobe set for one character, **when** scored, **then**
  `rv assets consistency --character kael` prints a table and exits non-zero if any state is below
  the floor.
- **Given** a deliberately swapped fixture (another character's render), **when** scored, **then**
  it falls below the floor — the check discriminates.
- **Verify:** `cd packages/asset-engine && npx vitest run src/quality/identity-drift.spec.ts`
- **Size:** M · **Depends on:** RV-084, RV-128

---

### Epic H — Animation Engine & IR

#### RV-140 — `AnimationIR` schema (`.rvanim.json`)

**As an** animator **I want** one deterministic, diffable, LLM-generatable animation format
**so that** playback, rendering, baking and editing all read the same source of truth.

- **Given** the schema, **when** validated, **then** it requires `meta` (fps, duration, sceneSpace,
  styleBibleRef), `nodes`, `tracks`, `behaviours`, `markers` and `camera`.
- **Given** an IR with a track referencing a missing `nodeId`, **when** parsed, **then** it fails with
  a path-precise error.
- **Given** an IR, **when** serialised twice, **then** the JSON is byte-identical and a semantic
  no-op edit produces a minimal textual diff (stable key ordering, no floating-point churn beyond
  the declared precision).
- **Verify:** `cd packages/anim-engine && npx vitest run src/ir/schema.spec.ts`
- **Size:** M · **Depends on:** RV-001

#### RV-141 — Pure evaluator `evaluate(ir, t) → SceneSnapshot`

**As a** renderer **I want** the animation state at time `t` to be a pure function **so that**
scrubbing, resuming, sharding and golden tests all work for free.

- **Given** any IR and any `t`, **when** `evaluate` is called twice, **then** the snapshots are
  deep-equal.
- **Given** a source scan of `packages/anim-engine/src`, **when** run, **then** it contains no
  `Date.now`, `new Date`, `Math.random` or mutable module-level state.
- **Given** the coverage run, **when** it completes, **then** `packages/anim-engine/src/**` reports
  100 % lines and branches.
- **Given** `t` outside `[0, duration]`, **when** evaluated, **then** it clamps and returns a valid
  snapshot rather than throwing.
- **Verify:** `cd packages/anim-engine && npx vitest run --coverage src/evaluator.spec.ts`
- **Size:** L · **Depends on:** RV-140

#### RV-142 — Interpolation, easing and step modes

**As an** animator **I want** named easings and `on-2s`/`on-3s` stepping **so that** the style's
motion feel is reproducible.

- **Given** each named easing in `StyleBible.motion.easingSet`, **when** sampled at 0, 0.5 and 1,
  **then** the values match the cubic-bezier reference within 1e-9 (table-driven).
- **Given** `stepMode: 'on-2s'` at 24 fps, **when** the evaluator samples frames 0–5, **then**
  frames 0/1 share a value, 2/3 share a value, 4/5 share a value.
- **Given** interpolation modes `linear`, `bezier`, `step` and `spline`, **when** each is evaluated
  against a fixture curve, **then** the sampled values match the golden series.
- **Verify:** `cd packages/anim-engine && npx vitest run src/interp`
- **Size:** M · **Depends on:** RV-141

#### RV-143 — Behaviour library, seeded and pure

**As an** animator **I want** declarative parameterised behaviours **so that** ambient life is free
and reproducible.

- **Given** each of `wind`, `breathe`, `blink`, `sway`, `walkCycle`, `flap`, `orbit`, `parallax`,
  `boil`, `lipSync` and `particles`, **when** evaluated at a fixed `t` with a fixed `seed`, **then**
  the output matches its golden fixture.
- **Given** the same behaviour with two different seeds, **when** evaluated, **then** the outputs
  differ — the seed is actually used.
- **Given** a behaviour evaluated at `t` reached by scrubbing backwards, **when** compared to forward
  evaluation, **then** the outputs are identical (no accumulated state).
- **Given** `lipSync` with a phoneme track, **when** evaluated, **then** the mouth part index matches
  the phoneme map at each cue time.
- **Verify:** `cd packages/anim-engine && npx vitest run src/behaviours`
- **Size:** L · **Depends on:** RV-141

#### RV-144 — Golden-file tests: IR → frame hash

**As a** maintainer **I want** frame hashes pinned **so that** any regression in the evaluator or
renderer is caught immediately.

- **Given** each fixture IR in `src/__golden__/`, **when** frames are evaluated and rasterised,
  **then** the per-frame sha256 matches the committed golden list exactly.
- **Given** an intentional change, **when** `RV_UPDATE_GOLDEN=1` is set, **then** goldens are
  rewritten and the diff is reviewable in the PR.
- **Given** the same fixtures rendered on both backends, **when** compared, **then** hashes match, or
  the fixture is explicitly marked backend-specific with a recorded reason.
- **Verify:** `cd packages/anim-engine && npx vitest run src/__golden__/golden.spec.ts`
- **Size:** M · **Depends on:** RV-141, RV-162

#### RV-145 — Choreograph: `Shot[]` → `AnimationIR` (S8)

**As a** director **I want** the shot list turned into an IR automatically **so that** animation is
generated, not hand-built.

- **Given** a `Shot` with layout, blocking, camera and dialogue, **when** choreography runs, **then**
  the produced IR contains one node per layout layer, one track set per blocking action, camera
  tracks matching the declared move, `lipSync` behaviours for each dialogue line, and markers at each
  beat and cut point.
- **Given** the style's `motion` block, **when** choreography runs, **then** ambient behaviours
  (`wind`, `breathe`, `blink`, `boil`) are attached according to the bible, with its amplitudes.
- **Given** the produced IR, **when** validated, **then** its duration equals the shot's
  `durationMs` and every referenced clip exists on the referenced asset.
- **Given** the same shot and seed, **when** choreographed twice, **then** the IRs are byte-identical.
- **Verify:** `pnpm rv anim choreograph --shot <id> && cd packages/anim-engine && npx vitest run src/choreograph/choreograph.spec.ts`
- **Size:** L · **Depends on:** RV-046, RV-087, RV-127, RV-143

#### RV-146 — IR edit operations: typed, reversible patches

**As a** user **I want** every animation editable through typed operations **so that** I can adjust
anything the generator produced and undo it.

- **Given** the op set (`addKeyframe`, `moveKeyframe`, `deleteKeyframe`, `setEasing`, `retimeTrack`,
  `setBehaviourParam`, `addBehaviour`, `removeBehaviour`, `rebindClip`, `reparentNode`,
  `setCameraKey`), **when** each is applied to a fixture IR, **then** the result validates and the
  op's declared inverse restores the original byte-for-byte.
- **Given** an invalid op (keyframe past the duration, unknown nodeId), **when** applied, **then** it
  returns `err(ValidationError)` and the IR is unchanged.
- **Given** a sequence of ops, **when** applied then undone in reverse, **then** the IR equals the
  original.
- **Given** an edited IR, **when** re-rendered, **then** only the affected frame range's hashes
  change.
- **Verify:** `cd packages/anim-engine && npx vitest run src/edit/ir-ops.spec.ts`
- **Size:** L · **Depends on:** RV-140, RV-141

#### RV-147 — Camera track and focus target

**As a** director **I want** camera position, zoom, rotation and a focus target in the IR **so that**
re-framing per platform is computed rather than re-authored.

- **Given** a camera track, **when** evaluated at `t`, **then** the snapshot exposes the camera
  transform and the resolved world-space focus point.
- **Given** a `focusTarget` bound to a moving node, **when** the node moves, **then** the focus point
  follows it without any additional keyframes.
- **Given** `camera.shakeAmp` from the style, **when** evaluated with a fixed seed, **then** the shake
  offsets match the golden series.
- **Verify:** `cd packages/anim-engine && npx vitest run src/camera/camera-track.spec.ts`
- **Size:** M · **Depends on:** RV-141

#### RV-148 — IR validation and lint

**As a** user **I want** a bad IR rejected with a precise message **so that** LLM-generated animation
fails loudly and early.

- **Given** an IR with a dangling nodeId, overlapping exclusive tracks on the same property,
  out-of-range times, or a duplicate marker id, **when** `lintIr` runs, **then** each produces a
  distinct typed diagnostic with a JSON path.
- **Given** a clean IR, **when** linted, **then** zero diagnostics are returned.
- **Given** `pnpm rv anim lint <file>`, **when** run on a broken fixture, **then** it exits non-zero
  and prints the diagnostics.
- **Verify:** `cd packages/anim-engine && npx vitest run src/validate/lint-ir.spec.ts`
- **Size:** M · **Depends on:** RV-140

#### RV-149 — Seek-safety property test

**As a** renderer **I want** proof that arrival order never affects state **so that** distributed and
resumed renders are safe.

- **Given** a fixture IR and 200 random times (from a seeded RNG), **when** each is evaluated in
  random order and again in ascending order, **then** every pair of snapshots is deep-equal.
- **Given** a render sharded across four workers by frame range, **when** the shards are concatenated,
  **then** the frame hashes equal a single-process render of the same IR.
- **Verify:** `cd packages/anim-engine && npx vitest run src/evaluator.seek.spec.ts`
- **Size:** M · **Depends on:** RV-141

#### RV-150 — Clip binding and baked-sheet fallback

**As a** runtime **I want** IR nodes to bind to asset clips with a baked-sheet fallback **so that**
playback works whether the rig or the atlas is available.

- **Given** an `AssetInstance` node bound to clip `walk`, **when** evaluated with the rig present,
  **then** the snapshot contains per-part transforms.
- **Given** the same node with the rig absent but a baked atlas present, **when** evaluated, **then**
  the snapshot contains the atlas frame index for `t` and rendering still succeeds.
- **Given** neither present, **when** evaluated, **then** it returns `err(NotFoundError)` naming the
  asset and clip.
- **Verify:** `cd packages/anim-engine && npx vitest run src/binding/clip-binding.spec.ts`
- **Size:** M · **Depends on:** RV-129, RV-141

---

### Epic I — Render & Delivery

#### RV-160 — Deterministic frame loop

**As a** renderer **I want** `for f in 0..N: evaluate(ir, f/fps) → draw → capture` with no real-time
playback **so that** output is bit-reproducible, resumable and shardable.

- **Given** an IR, **when** rendered twice, **then** every frame's sha256 is identical across runs.
- **Given** a render killed at frame 60 of 240, **when** restarted, **then** it resumes at frame 60
  (frames 0–59 not recomputed, asserted by timestamps) and the final output hashes identically to an
  uninterrupted render.
- **Given** `--shard 2/4`, **when** run, **then** only that frame range is produced and the four
  shards concatenate to the same output.
- **Verify:** `cd packages/render-engine && npx vitest run src/frames/frame-loop.spec.ts`
- **Size:** L · **Depends on:** RV-141

#### RV-161 — PixiJS-in-Playwright backend

**As a** renderer **I want** a browser backend **so that** filters, shaders and mesh deformation
render exactly as they do in the studio player.

- **Given** an IR using a filter and a mesh-deformed part, **when** rendered through Playwright,
  **then** frames are captured at the declared size and the golden hashes match.
- **Given** the page, **when** it renders, **then** it is driven by explicit `seek(t)` calls — a
  source scan asserts no `requestAnimationFrame`-driven timing in the render harness.
- **Given** a page error or a WebGL context loss, **when** it occurs, **then** the backend returns
  `err(ProviderError)` with the browser console captured, and does not hang.
- **Verify:** `cd packages/render-engine && npx vitest run src/backends/playwright.spec.ts`
- **Size:** L · **Depends on:** RV-160

#### RV-162 — `@napi-rs/canvas` offscreen backend and automatic selection

**As a** user on a laptop **I want** pure-2D compositions rendered with no browser **so that**
rendering is fast and cheap.

- **Given** an IR using only 2D primitives, transforms and alpha, **when** the backend selector runs
  with `RV_RENDER_BACKEND=auto`, **then** the canvas backend is chosen; **given** an IR using a
  shader filter, **then** the Playwright backend is chosen — both asserted on the decision record.
- **Given** the same pure-2D IR, **when** rendered on both backends, **then** the frame hashes match
  the shared golden set.
- **Given** a 150-frame 1080p pure-2D IR, **when** rendered on the canvas backend, **then** it
  completes in under half the wall time of the Playwright backend on the same machine (benchmark
  recorded, threshold asserted).
- **Verify:** `cd packages/render-engine && npx vitest run src/backends/canvas.spec.ts src/backends/selector.spec.ts`
- **Size:** L · **Depends on:** RV-160

#### RV-163 — FFmpeg muxing to master

**As a** producer **I want** frames muxed to a master file **so that** I have one high-quality source
for every delivery.

- **Given** a frame directory and an fps, **when** muxing runs, **then** `master.mov` (ProRes) or
  `master.mp4` (H.264/HEVC) is produced and `ffprobe` reports the expected codec, resolution, fps and
  frame count.
- **Given** the same frames, **when** muxed twice with the same settings, **then** the output files
  hash identically (deterministic flags: fixed `-fflags`, no timestamp metadata).
- **Given** FFmpeg missing from `RV_FFMPEG_PATH`, **when** a render starts, **then** it fails fast
  with a typed error naming the binary and the env var.
- **Verify:** `cd packages/render-engine && npx vitest run src/mux/ffmpeg.spec.ts`
- **Size:** M · **Depends on:** RV-160

#### RV-164 — Format profiles for YouTube, Instagram and TikTok

**As a** creator **I want** every target platform as a declared profile **so that** exports are
correct by construction.

- **Given** the profile registry, **when** enumerated, **then** it contains `yt-16x9-1080`,
  `yt-16x9-2160`, `shorts-9x16`, `reels-9x16`, `ig-4x5`, `ig-1x1` and `tiktok-9x16`, each declaring
  size, ratio, codec, bitrate range and max length exactly as verified in research §7.
- **Given** each profile, **when** an export runs, **then** `ffprobe` on the output reports the
  declared resolution and codec, and the measured bitrate falls in the declared range.
- **Given** the `reels-9x16` profile, **when** exported, **then** the codec is H.264 — a test asserts
  HEVC is refused for Instagram.
- **Given** a new profile added, **when** the registry is read, **then** no `switch` on format name
  exists in the engine (registry map + `assertNever`).
- **Verify:** `cd packages/render-engine && npx vitest run src/formats/profiles.spec.ts`
- **Size:** M · **Depends on:** RV-163

#### RV-165 — Subject-aware re-framing from one composition

**As a** creator **I want** one composition re-framed per platform **so that** I do not maintain three
parallel projects.

- **Given** a shot with a `focusTarget` and a 16:9 master, **when** re-framed to 9:16, **then** the
  crop window keeps the focus point inside the universal safe zone (900×1400 centred in 1080×1920)
  for every frame — asserted numerically per frame, not by eye.
- **Given** a moving focus target, **when** re-framed, **then** the pan is smoothed by the style's
  `camera.panEase` and never exceeds the declared maximum pan velocity.
- **Given** the TikTok profile, **when** re-framed, **then** the focus point avoids the top 15 %,
  bottom 20 % and right 15 % regions.
- **Given** the same input, **when** re-framed twice, **then** the crop windows are identical.
- **Verify:** `cd packages/render-engine && npx vitest run src/reframe/reframer.spec.ts`
- **Size:** L · **Depends on:** RV-147, RV-164

#### RV-166 — Safe-zone templates and pre-render validation

**As a** creator **I want** safe zones enforced before rendering **so that** I do not discover a
cropped face after a 20-minute render.

- **Given** a shot whose `focusTarget` cannot be kept inside a profile's safe zone, **when**
  `validateDelivery` runs, **then** it returns a typed issue naming the shot, the profile and the
  offending frame range — before any frame is rendered.
- **Given** each profile, **when** its overlay template is requested, **then** it returns the safe
  rect and the platform-specific exclusion rects as data the UI can draw.
- **Given** a clean composition, **when** validated, **then** zero issues are returned.
- **Verify:** `cd packages/render-engine && npx vitest run src/formats/safe-zones.spec.ts`
- **Size:** M · **Depends on:** RV-164

#### RV-167 — Platform spec compliance validator

**As a** creator **I want** length and spec violations caught **so that** an upload is never rejected.

- **Given** a 95-second composition, **when** validated against `reels-9x16` (90 s max), **then** it
  returns an `error` issue naming the limit and the overage.
- **Given** the same composition against `tiktok-9x16` (10 min) and `shorts-9x16` (3 min), **when**
  validated, **then** no issue is returned.
- **Given** `pnpm rv deliver check --episode E01`, **when** run, **then** it prints a per-profile
  pass/fail table and exits non-zero if any profile fails.
- **Verify:** `cd packages/render-engine && npx vitest run src/formats/compliance.spec.ts`
- **Size:** S · **Depends on:** RV-164

#### RV-168 — Render job checkpointing, resume and cancellation

**As a** user **I want** long renders to be interruptible **so that** a laptop can do the work.

- **Given** a running render, **when** cancelled, **then** it stops within 2 seconds, leaves a
  checkpoint, and returns `err(CancelledError)`.
- **Given** a checkpoint, **when** `pnpm rv render resume <runId>` runs, **then** it continues from
  the last completed frame and the final output matches an uninterrupted render.
- **Given** a render, **when** it progresses, **then** progress events carry
  `{ stage, framesDone, framesTotal, etaMs }` and are emitted at least once per second.
- **Verify:** `cd packages/render-engine && npx vitest run src/job/render-job.spec.ts`
- **Size:** M · **Depends on:** RV-160

#### RV-169 — Visual regression on rendered output

**As a** maintainer **I want** perceptual comparison of rendered frames **so that** a subtle
rendering regression is caught.

- **Given** a fixture composition, **when** rendered, **then** selected frames are compared to
  committed references by `sharp`-computed perceptual distance and the run fails above the configured
  threshold.
- **Given** an intentional visual change, **when** references are updated with an explicit flag,
  **then** the diff images are written to `coverage/visual/` for review.
- **Verify:** `cd packages/render-engine && npx vitest run src/visual/visual-regression.spec.ts`
- **Size:** M · **Depends on:** RV-163

#### RV-170 — Deliver: one command, all formats (S11)

**As a** creator **I want** a single command producing every platform file **so that** delivery is
one step.

- **Given** a choreographed episode, **when** `pnpm rv deliver --episode E01 --all` runs, **then**
  seven files appear under `workspace/projects/<id>/deliver/` — one per profile — plus a
  `manifest.json` listing each file's profile, size, duration, codec and sha256.
- **Given** the manifest, **when** each entry is probed, **then** it satisfies its profile's spec
  validator.
- **Given** the same episode delivered twice, **when** compared, **then** every output sha matches
  and the ledger shows `nanoUsd === 0` for the delivery run — re-framing and re-rendering cost
  nothing.
- **Verify:** `pnpm rv deliver --episode E01 --all && cd packages/render-engine && npx vitest run src/deliver/deliver.spec.ts`
- **Size:** M · **Depends on:** RV-163, RV-164, RV-165, RV-167

---

### Epic J — Orchestration, API & CLI

#### RV-180 — NestJS application skeleton with DI tokens for every port

**As an** API **I want** a Nest app wiring every port to an adapter by token **so that** the
dependency rule holds at runtime, not just on paper.

- **Given** the app module, **when** it boots, **then** every port token resolves and a test asserts
  the count of registered tokens equals the count of declared ports.
- **Given** `GET /api/health`, **when** called, **then** it returns 200 with provider availability
  and database status.
- **Given** `pnpm arch:check`, **when** run, **then** no controller or use-case imports a vendor SDK.
- **Verify:** `cd apps/api && npx vitest run src/app.spec.ts && pnpm arch:check`
- **Size:** M · **Depends on:** RV-012, RV-020

#### RV-181 — Pipeline runner: stages S0–S11, idempotent and checkpointed

**As a** user **I want** the whole pipeline runnable as one command **so that** an idea becomes an
episode without babysitting.

- **Given** `pnpm rv run --idea "..." --preset ink-comic --lane free`, **when** executed against fake
  providers, **then** every stage S0–S11 completes and the run record lists each stage with its
  duration, cost and output artefact ids.
- **Given** a run killed mid-stage, **when** `pnpm rv resume <runId>` executes, **then** completed
  stages are not re-run (spy assertion) and the run finishes.
- **Given** a run executed twice with identical inputs, **when** compared, **then** the second run's
  total cost is `0` and the produced artefact ids are identical.
- **Verify:** `pnpm rv run --idea "a fox in the city" --preset ink-comic --lane free --fake-providers && cd apps/cli && npx vitest run src/run.spec.ts`
- **Size:** L · **Depends on:** RV-007, RV-014, RV-130, RV-170

#### RV-182 — BullMQ workers with an in-process fallback

**As an** operator **I want** the pipeline to run with or without Redis **so that** local use needs
zero infrastructure.

- **Given** `REDIS_URL` empty, **when** a run starts, **then** stages execute in-process and the run
  completes.
- **Given** `REDIS_URL` set, **when** a run starts, **then** jobs are enqueued to BullMQ and
  processed by workers, with `RV_QUEUE_CONCURRENCY` respected (asserted by observing max concurrent
  jobs).
- **Given** a job failing with a retryable error, **when** it is retried, **then** the backoff follows
  the configured policy and the attempt count is bounded.
- **Given** a per-provider rate limiter, **when** parallel asset jobs run, **then** requests to one
  provider never exceed its configured rate.
- **Verify:** `cd apps/api && npx vitest run src/queue`
- **Size:** L · **Depends on:** RV-180, RV-181

#### RV-183 — SSE progress stream

**As a** studio user **I want** live progress **so that** a long run is legible.

- **Given** `GET /api/runs/:id/events`, **when** a run progresses, **then** the client receives typed
  events (`stage-started`, `stage-progress`, `stage-completed`, `cost-updated`, `issue-raised`,
  `run-completed`) validated against the contract schemas.
- **Given** a client reconnecting with `Last-Event-ID`, **when** it reconnects, **then** it receives
  the events it missed.
- **Given** a run that fails, **when** the stream ends, **then** the final event carries the typed
  error kind.
- **Verify:** `cd apps/api && npx vitest run src/sse/progress.e2e.spec.ts`
- **Size:** M · **Depends on:** RV-180, RV-182

#### RV-184 — REST surface generated from contracts

**As a** client **I want** DTOs and OpenAPI derived from `@rv/contracts` **so that** the API cannot
drift from the domain.

- **Given** every controller, **when** the app boots, **then** its request/response DTOs are the Zod
  schemas from `@rv/contracts` — a test asserts no hand-written DTO class exists.
- **Given** `GET /api/openapi.json`, **when** called, **then** it matches
  `docs/generated/openapi.json` byte for byte.
- **Given** a request violating a schema, **when** posted, **then** the API returns 422 with the Zod
  issue paths in a stable error envelope.
- **Verify:** `cd apps/api && npx vitest run src/http/contracts.e2e.spec.ts`
- **Size:** M · **Depends on:** RV-003, RV-180

#### RV-185 — Selective re-run on edit

**As a** user **I want** an edit to re-run only what depends on it **so that** iteration is fast and
cheap.

- **Given** a completed run and an edited `Shot`, **when** re-run is triggered, **then** only S8–S11
  execute; a spy asserts S0–S7 use-cases are not invoked.
- **Given** an edited `StyleBible` (unlocked to v2), **when** re-run is triggered, **then** the impact
  report from RV-048 is produced first and asset regeneration requires confirmation.
- **Given** an edited `AnimationIR`, **when** re-run is triggered, **then** only S10–S11 execute and
  the asset ledger gains no cost.
- **Verify:** `cd apps/api && npx vitest run src/pipeline/selective-rerun.spec.ts`
- **Size:** M · **Depends on:** RV-007, RV-091, RV-146

#### RV-186 — Stage model-binding API

**As a** studio user **I want** to set the model per stage over HTTP **so that** the UI can expose
"story model is selectable".

- **Given** `GET /api/projects/:id/bindings`, **when** called, **then** it returns every stage with
  its current binding and the available alternatives filtered by declared capability and configured
  keys.
- **Given** `PUT /api/projects/:id/bindings/S2` with an incapable provider, **when** called, **then**
  it returns 422 naming the missing capability.
- **Given** a valid change, **when** applied, **then** the next run's ledger shows the new provider
  for that stage.
- **Verify:** `cd apps/api && npx vitest run src/http/bindings.e2e.spec.ts`
- **Size:** S · **Depends on:** RV-090, RV-184

#### RV-187 — Cancellation and run lifecycle over HTTP

**As a** user **I want** to cancel a run from the UI **so that** I am never stuck watching money burn.

- **Given** a running pipeline, **when** `POST /api/runs/:id/cancel` is called, **then** the run
  reaches `cancelled` within 5 seconds, in-flight provider calls are aborted, and no further ledger
  rows are written.
- **Given** a cancelled run, **when** resumed, **then** it continues from the last checkpoint.
- **Verify:** `cd apps/api && npx vitest run src/http/run-lifecycle.e2e.spec.ts`
- **Size:** S · **Depends on:** RV-183

#### RV-188 — API e2e suite against fake providers

**As a** maintainer **I want** the whole API exercised in CI without network or cost **so that**
regressions surface before release.

- **Given** the Supertest suite, **when** it runs, **then** it drives project create → run → SSE →
  artefact fetch → deliver, entirely against fake providers and an in-memory queue.
- **Given** CI, **when** the suite runs, **then** total cost recorded is `0` and no real socket is
  opened.
- **Verify:** `cd apps/api && npx vitest run src/**/*.e2e.spec.ts`
- **Size:** M · **Depends on:** RV-181, RV-183, RV-184

---

### Epic K — Studio UI

#### RV-200 — Vue 3 studio shell

**As a** user **I want** a studio application shell **so that** every stage has a home.

- **Given** `pnpm --filter @rv/web dev`, **when** started, **then** the app serves on the configured
  port and routes exist for style, story, cast, graph, assets, rig, timeline, player, cost and
  deliver.
- **Given** the app, **when** typechecked, **then** `vue-tsc` passes with `strict`,
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **Given** any store, **when** inspected, **then** it uses Pinia and all API types come from
  `@rv/contracts` — a test asserts no locally declared response interfaces.
- **Verify:** `cd apps/web && npx vue-tsc --noEmit && npx vitest run src/app.spec.ts`
- **Size:** M · **Depends on:** RV-184

#### RV-201 — Bilingual fa/en with Persian as default

**As a** Persian-speaking owner **I want** the UI in Persian by default and switchable to English
**so that** I work in my own language.

- **Given** a fresh profile with no stored preference, **when** the app loads, **then** the active
  locale is `fa`.
- **Given** the message catalogues, **when** compared, **then** `fa` and `en` have identical key sets
  — a test fails on any missing or orphan key.
- **Given** the source, **when** scanned by lint, **then** no user-visible string literal exists
  outside the catalogues (`rv/no-hardcoded-ui-string`).
- **Given** the locale switcher, **when** toggled, **then** the UI changes language without a page
  reload and the choice persists across restarts.
- **Verify:** `cd apps/web && npx vitest run src/i18n/i18n.spec.ts && pnpm lint`
- **Size:** M · **Depends on:** RV-200

#### RV-202 — RTL layout correctness

**As a** Persian user **I want** a genuinely right-to-left studio **so that** nothing is mirrored
wrongly or clipped.

- **Given** locale `fa`, **when** the app renders, **then** `document.documentElement.dir === 'rtl'`
  and a CSS scan asserts no physical `margin-left`/`padding-right`/`left`/`right` properties in
  component styles — only logical properties.
- **Given** the timeline, the rig editor and the player, **when** rendered in `fa`, **then** the
  playhead, scrub direction and panel order mirror correctly while the video canvas itself does not
  mirror — asserted by Playwright screenshots against per-direction references.
- **Given** both locales, **when** the visual regression suite runs, **then** every key screen has a
  reference for `fa` and for `en` and both pass.
- **Given** any screen in `fa`, **when** measured, **then** no element overflows its container
  (automated overflow check across the route list).
- **Verify:** `cd apps/web && npx playwright test tests/rtl.spec.ts`
- **Size:** L · **Depends on:** RV-201

#### RV-203 — Persian typography, digits and pluralisation

**As a** Persian user **I want** correct Persian text rendering **so that** the studio does not look
foreign.

- **Given** locale `fa`, **when** numbers are displayed, **then** they render with Persian digits
  (۰–۹) via `Intl.NumberFormat('fa-IR')`, while numeric input fields still accept ASCII digits.
- **Given** the font stack, **when** the app loads, **then** a Persian-capable font is applied and
  a rendering test asserts correct joining on a sample string.
- **Given** a pluralised message, **when** rendered in `fa` and `en`, **then** each uses its own
  plural rules (table-driven over 0, 1, 2, 11, 100).
- **Verify:** `cd apps/web && npx vitest run src/i18n/format.spec.ts`
- **Size:** S · **Depends on:** RV-201

#### RV-204 — Style Lab

**As a** user **I want** to browse presets, run the wizard, upload references, view the probe sheet
and lock **so that** style-first is the real first step.

- **Given** the Style Lab, **when** opened, **then** presets are listed with thumbnails and the
  motion block is shown as editable controls (fps, step mode, easing curves, boil, ambient, camera).
- **Given** an edited motion parameter, **when** changed, **then** a live motion preview updates and
  the candidate checksum shown on screen changes.
- **Given** the probe button, **when** clicked, **then** the probe sheet renders in-page and the
  estimated cost is shown before generation starts.
- **Given** the lock button, **when** clicked and confirmed, **then** the bible becomes read-only in
  the UI and downstream screens unlock.
- **Verify:** `cd apps/web && npx playwright test tests/style-lab.spec.ts`
- **Size:** L · **Depends on:** RV-044, RV-045, RV-200

#### RV-205 — Story board

**As a** user **I want** the story tree editable node by node **so that** I can steer the narrative.

- **Given** the story tree, **when** rendered, **then** Series → Season → Episode → Act → Sequence →
  Scene → Beat is navigable and each node shows its text, its model binding and its cost.
- **Given** a node, **when** edited and saved, **then** the change persists, the stale downstream
  stages are highlighted, and the previous version is visible in a history drawer.
- **Given** a node, **when** "regenerate this node only" is clicked, **then** only that node's
  subtree is regenerated and the cost delta is shown.
- **Verify:** `cd apps/web && npx playwright test tests/story-board.spec.ts`
- **Size:** L · **Depends on:** RV-091, RV-200

#### RV-206 — Character sheet screen with expression / pose / wardrobe grids

**As a** user **I want** to see and edit every character state and its prompt **so that** strong
characters in multiple states are a first-class surface.

- **Given** a character, **when** opened, **then** the psychology, voice, arc, visual and motion
  signature are shown, and grids display every expression, pose and wardrobe with its thumbnail (or a
  "not generated" placeholder) and its editable prompt.
- **Given** an edited state prompt, **when** saved, **then** only that state becomes a cache miss and
  the UI marks it "will regenerate".
- **Given** a state, **when** "generate" is clicked, **then** the estimated cost is shown first and
  the result appears in place with its identity-match score.
- **Given** a state below the identity floor, **when** displayed, **then** it is flagged in the grid.
- **Verify:** `cd apps/web && npx playwright test tests/character-states.spec.ts`
- **Size:** L · **Depends on:** RV-083, RV-132, RV-200

#### RV-207 — Character / entity graph view

**As a** user **I want** to see the world model **so that** I can understand and correct continuity.

- **Given** the graph screen, **when** opened, **then** entities render as nodes and relations as
  edges, filterable by kind, by story time and by `visibility`.
- **Given** the story-time slider, **when** moved, **then** the graph shows only relations valid at
  that time, and the authoring-time toggle shows what was known at that point in writing.
- **Given** a character selected with "show only what they know", **when** applied, **then** the graph
  matches `viewFor(character, storyTime)` exactly (asserted against the API response).
- **Given** the timeline and relationship-matrix tabs, **when** opened, **then** each renders the
  derived view from RV-072.
- **Verify:** `cd apps/web && npx playwright test tests/graph-view.spec.ts`
- **Size:** L · **Depends on:** RV-063, RV-072, RV-200

#### RV-208 — Asset library

**As a** user **I want** to browse, search and manage assets **so that** reuse is visible and
regeneration is deliberate.

- **Given** the library, **when** opened, **then** assets list with semantic key, style checksum,
  version count, variant count, clip count and total spend.
- **Given** a semantic search query in Persian or English, **when** submitted, **then** matching
  assets rank by similarity.
- **Given** the regenerate button, **when** clicked, **then** a dialog requires an explicit reason
  from the `RegenerateIntent` enum and states that the previous version is kept; cancelling makes no
  call.
- **Given** an asset, **when** opened, **then** its versions, parts (with z-order), rig, variants and
  clips are all inspectable and its provenance is readable.
- **Verify:** `cd apps/web && npx playwright test tests/asset-library.spec.ts`
- **Size:** L · **Depends on:** RV-102, RV-103, RV-200

#### RV-209 — In-studio image editor

**As a** user **I want** to mask and instruct an edit on any generated image **so that** images are
editable, not take-it-or-leave-it.

- **Given** an asset image, **when** the editor opens, **then** a brush produces a mask and an
  instruction field accepts text in Persian or English.
- **Given** an edit submitted, **when** it completes, **then** a before/after comparison is shown with
  the cost, and "accept" registers it as a variant while "discard" leaves the registry unchanged
  (asserted via the API).
- **Given** an edit, **when** accepted, **then** the original remains listed and openable.
- **Verify:** `cd apps/web && npx playwright test tests/image-editor.spec.ts`
- **Size:** L · **Depends on:** RV-122, RV-208

#### RV-210 — Rig editor

**As a** user **I want** to adjust bones, anchors and mesh weights **so that** an imperfect auto-rig
is fixable.

- **Given** a rigged asset, **when** the rig editor opens, **then** bones render as a Konva overlay
  on the parts and can be dragged, with the change persisted as a rig patch.
- **Given** a mesh-deformed part, **when** grid density or a weight is changed, **then** the live
  preview updates and the rig validates before saving.
- **Given** an invalid edit (a cycle, an unanchored bone), **when** saved, **then** it is rejected
  with a message naming the bone.
- **Verify:** `cd apps/web && npx playwright test tests/rig-editor.spec.ts`
- **Size:** L · **Depends on:** RV-126, RV-200

#### RV-211 — Timeline and keyframe editor

**As a** user **I want** to edit any animation **so that** generated motion is a starting point, not a
verdict.

- **Given** an IR loaded, **when** the timeline renders, **then** tracks, keyframes, behaviours and
  markers are shown and each edit gesture maps to exactly one typed IR op from RV-146.
- **Given** a keyframe dragged, **when** released, **then** the player updates immediately and undo
  restores the previous IR byte-for-byte.
- **Given** a behaviour selected, **when** its parameters are changed, **then** the change is
  reflected in the preview and saved as a `setBehaviourParam` op.
- **Given** locale `fa`, **when** the timeline renders, **then** time flows in the direction defined
  by the RTL specification in RV-202 and the reference screenshot passes.
- **Verify:** `cd apps/web && npx playwright test tests/timeline-editor.spec.ts`
- **Size:** L · **Depends on:** RV-146, RV-212

#### RV-212 — PixiJS player with deterministic scrubbing

**As a** user **I want** to scrub and play the composition **so that** I can judge it before rendering.

- **Given** an IR, **when** the player scrubs to `t`, **then** the displayed frame corresponds to
  `evaluate(ir, t)` — asserted by comparing a captured canvas hash against the headless render of the
  same frame.
- **Given** playback, **when** it runs, **then** it is driven by the IR's fps and pausing at the same
  `t` yields the same frame every time.
- **Given** a composition of 60 seconds at 24 fps, **when** scrubbed rapidly, **then** the player
  keeps up without dropping the requested frame (last-frame-wins assertion).
- **Verify:** `cd apps/web && npx playwright test tests/player.spec.ts`
- **Size:** L · **Depends on:** RV-141, RV-200

#### RV-213 — Cost dashboard and budget controls

**As an** owner **I want** cost visible and controllable in the UI **so that** "low cost" is something
I can see.

- **Given** a planned run, **when** the estimate panel opens, **then** it shows per-stage estimated
  cost, the number of cache hits and the money they save, before anything is spent.
- **Given** a running pipeline, **when** costs accrue, **then** a live ledger and a budget bar update
  over SSE and the bar turns red at the confirm threshold.
- **Given** the per-stage model picker, **when** a stage is switched to a free binding, **then** the
  estimate updates immediately.
- **Given** a completed run, **when** the report is opened, **then** the total matches the API's
  ledger sum exactly.
- **Verify:** `cd apps/web && npx playwright test tests/cost-dashboard.spec.ts`
- **Size:** M · **Depends on:** RV-104, RV-183, RV-186

#### RV-214 — Delivery panel with format templates and safe-zone overlays

**As a** creator **I want** to preview each platform's framing **so that** I ship correct files.

- **Given** the delivery panel, **when** opened, **then** each format profile is listed with a live
  preview showing the safe-zone overlay and the platform exclusion regions.
- **Given** a shot whose focus falls outside a safe zone, **when** previewed, **then** it is flagged
  in the panel with the frame range before rendering is offered.
- **Given** the export button, **when** clicked, **then** the selected profiles are rendered and the
  resulting files are listed with size, duration and codec.
- **Verify:** `cd apps/web && npx playwright test tests/delivery-panel.spec.ts`
- **Size:** M · **Depends on:** RV-166, RV-170, RV-200

#### RV-215 — Run monitor with resume and cancel

**As a** user **I want** to watch, cancel and resume runs **so that** long jobs are under my control.

- **Given** a running pipeline, **when** the monitor is open, **then** each stage shows status,
  elapsed time, cost and any issues, updating over SSE.
- **Given** the cancel button, **when** clicked, **then** the run reaches `cancelled` in the UI within
  5 seconds.
- **Given** a cancelled or failed run, **when** resume is clicked, **then** it continues from its
  checkpoint.
- **Verify:** `cd apps/web && npx playwright test tests/run-monitor.spec.ts`
- **Size:** M · **Depends on:** RV-183, RV-187

#### RV-216 — Web e2e: idea → rendered episode, in both locales

**As an** owner **I want** the whole studio journey covered by an automated test **so that** "this
works" is provable.

- **Given** a fresh workspace and fake providers, **when** the e2e spec runs in `fa`, **then** it
  completes: create project → pick preset → probe → lock → enter an idea in Persian → generate story
  and cast → inspect a character's expression grid → resolve and produce assets on the free lane →
  choreograph → scrub the player → edit one keyframe → render → export all formats, and asserts the
  delivered file count and manifest.
- **Given** the same spec run in `en`, **when** it completes, **then** it passes with the
  English-direction reference screenshots.
- **Given** CI, **when** the suite runs, **then** total spend is `0`.
- **Verify:** `cd apps/web && npx playwright test tests/e2e-full-journey.spec.ts`
- **Size:** L · **Depends on:** RV-204, RV-205, RV-206, RV-208, RV-211, RV-212, RV-214

---

### Epic L — Series & Episode Management

#### RV-230 — Series, seasons and episodes

**As a** creator **I want** the work hierarchy persisted **so that** a series is the normal case and a
short is the degenerate one.

- **Given** `pnpm rv series new "نام" --seasons 1 --episodes 1`, **when** run, **then** a `Series`
  with one `Season` and one `Episode` is persisted and validates.
- **Given** a standalone short, **when** created, **then** it is stored through the same code path —
  a test asserts no separate single-episode branch exists in the source.
- **Given** a series, **when** `SeriesBible` is generated, **then** premise, themes, tone and
  rules-of-the-world are populated and shared by every episode.
- **Verify:** `cd packages/core-domain && npx vitest run src/series/series.spec.ts`
- **Size:** M · **Depends on:** RV-004, RV-008

#### RV-231 — Shared style and asset library across episodes

**As a** creator **I want** episode 2 to reuse episode 1's work **so that** later episodes are nearly
free.

- **Given** episode 1 produced with 48 assets, **when** episode 2 resolves and its cast/locations
  overlap by 40 assets, **then** the plan reports 40 hits and the ledger for those specs records
  `nanoUsd === 0`.
- **Given** the series, **when** `pnpm rv series cost` runs, **then** it prints per-episode spend and
  cumulative reuse savings, and episode 2's asset spend is strictly less than episode 1's.
- **Given** episode 2 requesting `char/kael/wardrobe-winter/angry` already made for episode 1,
  **when** resolved, **then** it is a hit with the same `AssetVersion` id.
- **Verify:** `pnpm rv series cost && cd packages/asset-registry && npx vitest run src/reuse/episode-reuse.spec.ts`
- **Size:** M · **Depends on:** RV-106, RV-230

#### RV-232 — Air an episode and freeze canon

**As a** showrunner **I want** airing to be an explicit, checked transition **so that** canon is
trustworthy.

- **Given** a rendered episode with a continuity `error`, **when** `AirEpisodeUseCase.execute()` runs,
  **then** it returns `err(ConflictError)` listing the issues and the episode stays `rendered`.
- **Given** a clean episode, **when** aired, **then** its asserted relations are marked canon, the
  episode state becomes `AIRED`, and a later contradicting write is refused (RV-071).
- **Given** an aired episode, **when** any of its scenes is edited, **then** the edit is refused with
  `canon-frozen`.
- **Verify:** `cd packages/narrative-memory && npx vitest run src/continuity/air-episode.spec.ts`
- **Size:** M · **Depends on:** RV-070, RV-071, RV-230

#### RV-233 — Series-bible intake for an existing world

**As a** creator with an existing series **I want** to import its bible **so that** the graph starts
populated.

- **Given** a series-bible document, **when** intake runs, **then** entities and relations are
  extracted into the graph with `sourceRef: 'author'`, and the extracted entity count matches a
  hand-labelled fixture within the configured recall floor.
- **Given** an ambiguous entity reference, **when** resolved, **then** it either merges into an
  existing entity above the similarity floor or creates a new one, and the decision is recorded.
- **Verify:** `cd packages/story-engine && npx vitest run src/intake/series-bible-intake.spec.ts`
- **Size:** M · **Depends on:** RV-060, RV-080

#### RV-234 — Pre-air continuity report across the series

**As a** showrunner **I want** a full report before airing **so that** I can fix problems in one pass.

- **Given** an episode ready to air, **when** `pnpm rv continuity check --episode E06` runs, **then**
  it prints every issue with severity, the entities involved, the conflicting facts and a suggested
  fix, and exits non-zero if any `error` exists.
- **Given** a seeded contradiction fixture, **when** the check runs, **then** the specific error is
  reported by rule name.
- **Verify:** `pnpm rv continuity check --episode E06 && cd packages/narrative-memory && npx vitest run src/continuity/report.spec.ts`
- **Size:** S · **Depends on:** RV-069, RV-070

#### RV-235 — Change propagation by story time

**As a** creator **I want** a mid-series change to resolve to the right asset variant per episode
**so that** I do not do manual bookkeeping.

- **Given** the relation "Kael loses an eye" with `validFrom = E06`, **when** episode 4 resolves
  Kael's assets, **then** it receives the pre-E06 variant; **when** episode 7 resolves, **then** it
  receives the post-E06 variant.
- **Given** the post-E06 variant not yet produced, **when** episode 7 plans, **then** it appears as a
  miss with an estimate rather than silently reusing the wrong variant.
- **Verify:** `cd packages/asset-registry && npx vitest run src/resolve/story-time-variant.spec.ts`
- **Size:** M · **Depends on:** RV-062, RV-107

#### RV-236 — Season restyle forks assets without breaking earlier seasons

**As a** creator **I want** a new style for season 2 **so that** the show can evolve while season 1
still renders.

- **Given** season 1 assets under style checksum A and a season 2 style with checksum B, **when**
  season 2 resolves, **then** every asset is a miss and the impact report from RV-048 states the
  count and cost.
- **Given** season 1, **when** re-rendered after the restyle, **then** it still resolves to checksum-A
  assets and its output hashes are unchanged.
- **Verify:** `cd packages/asset-registry && npx vitest run src/resolve/style-fork.spec.ts`
- **Size:** M · **Depends on:** RV-048, RV-101

#### RV-237 — Series-level cost report

**As an** owner **I want** cumulative spend and savings across the series **so that** I can prove the
economics.

- **Given** a series with three delivered episodes, **when** `pnpm rv series cost --json` runs,
  **then** it emits per-episode spend, cumulative spend, cache-hit savings and cost per delivered
  minute, and the totals equal the ledger sum.
- **Given** the report, **when** the first episode is a 60-second short produced at final quality,
  **then** its recorded image spend is `≤ $5.00` — the figure the architecture promises.
- **Verify:** `pnpm rv series cost --json && cd packages/providers && npx vitest run src/cost/series-report.spec.ts`
- **Size:** S · **Depends on:** RV-028, RV-231

---

## 4. Milestones

The owner chose **foundation first** over a thin vertical slice. Each milestone therefore builds a
layer completely — but each one still ends in something you can run and point at.

### M0 — Bedrock: contracts, domain, persistence, CI

- **Goal:** every later package has a typed, tested, architecturally enforced floor.
- **Stories:** RV-001, RV-002, RV-003, RV-004, RV-005, RV-006, RV-007, RV-008, RV-009, RV-010,
  RV-011, RV-012, RV-013, RV-014.
- **Demo:**
  ```
  pnpm verify                                   # green
  pnpm schema:emit                              # writes docs/generated/schemas/*.json + openapi.json
  pnpm rv doctor                                # Node / FFmpeg / Ollama / ComfyUI table
  pnpm rv project new "دهکده" --lang fa         # a project on disk, validated
  ```
- **Exit criterion:** `pnpm verify` green in CI; `contracts` and `core-domain` at 100 % coverage;
  `arch:check` enforcing the dependency rule; the ADRs and folder-structure doc exist; the
  determinism lint rule fails on a planted `Date.now()`.

### M1 — The model layer and the locked style

- **Goal:** every model call is portable, metered, capped and offline-testable; a style — look and
  motion — can be chosen, probed and locked.
- **Stories:** RV-020 … RV-033, RV-040, RV-041, RV-042, RV-043, RV-044, RV-045, RV-047.
- **Demo:**
  ```
  pnpm rv models list                                   # every stage, its binding, its alternatives
  pnpm rv style list                                    # the preset library
  pnpm rv style probe --preset ink-comic --lane free    # probe-<checksum>.png, $0.0000 in the ledger
  pnpm rv style lock --style <id>                       # checksum frozen
  pnpm rv cost report --run <id>                        # per-provider, per-stage breakdown
  ```
  Plus: a deliberately schema-violating Ollama fixture replayed through `StructuredCall` shows the
  repair turn and the escalation in the run log, and a run pinned $0.02 over budget aborts **before**
  the provider is called.
- **Exit criterion:** all five adapters pass the shared contract suite with zero network; the probe
  sheet PNG exists; a locked `StyleBible` checksum is persisted and every image request is rejected
  without one.

### M2 — Story, memory and the character graph

- **Goal:** an idea becomes a structured story with strong, distinct characters, and the world model
  can answer "what was true, and who knew it, when".
- **Stories:** RV-060 … RV-072, RV-080, RV-081, RV-082, RV-083, RV-085, RV-086, RV-087, RV-088,
  RV-089, RV-090, RV-091, RV-230, RV-232, RV-233, RV-234.
- **Demo:**
  ```
  pnpm rv story new --idea "روباهی که شهر را دزدید" --style <id>
  pnpm rv cast states --character kael --print     # 8 expressions, 6 poses, 2 wardrobes, each with its prompt
  pnpm rv graph show --character kael --at E05     # only what Kael knows at E05
  pnpm rv continuity check --episode E06           # exits non-zero on the seeded contradiction
  pnpm rv models set --stage S2 --binding gemini:gemini-3-flash && pnpm rv story new ...   # same run, different brain
  ```
- **Exit criterion:** a `StoryBible` and cast that validate; every character carries want/need/wound/
  lie/ghost, a distinct voice, a motion signature and a full multi-state prompt set; the epistemic
  view test passes on the reveal fixture; airing is blocked by a continuity error.

### M3 — Everything is an asset, and the IR that moves it

- **Goal:** assets are generated once, matted, split into parts, rigged, given clips and baked to
  sheets — and the deterministic animation IR that drives them exists and is editable.
- **Stories:** RV-046, RV-048, RV-084, RV-100 … RV-107, RV-120 … RV-132, RV-140, RV-141, RV-142,
  RV-143, RV-146, RV-147, RV-148, RV-149, RV-231, RV-235, RV-236.
- **Demo:**
  ```
  pnpm rv assets plan --episode E01                 # hits, misses, exact estimate — nothing spent yet
  pnpm rv assets produce --episode E01 --lane free  # parts + rig + clips, $0.0000
  pnpm rv assets bake --asset flora/oak-tree/mature --clip sway   # atlas.png you can open and look at
  pnpm rv assets produce --episode E01 --lane free  # second run: 100 % hits, cost 0
  pnpm rv assets edit --asset <id> --instruction "make the lantern brighter"   # a new variant, original intact
  pnpm rv anim lint fixtures/broken.rvanim.json     # precise diagnostics, non-zero exit
  ```
- **Exit criterion:** a tree and a character both have transparent named parts, a validated rig, ≥2
  clips and a baked atlas; a repeat produce costs `$0`; regeneration requires an explicit intent and
  appends a version; `evaluate(ir, t)` is pure at 100 % branch coverage and every edit op has a
  proven inverse.

### M4 — Render, deliver, orchestrate

- **Goal:** the IR becomes video, one composition yields every platform format, and the whole
  pipeline runs headlessly and over HTTP, checkpointed and resumable.
- **Stories:** RV-144, RV-145, RV-150, RV-160 … RV-170, RV-180 … RV-188, RV-237.
- **Demo:**
  ```
  pnpm rv run --idea "..." --preset ink-comic --lane free   # S0 → S11, end to end
  pnpm rv deliver --episode E01 --all                       # 7 files + manifest.json
  ffprobe workspace/projects/<id>/deliver/reels-9x16.mp4    # 1080x1920, H.264, in-spec
  pnpm rv render --episode E01 &  # kill it mid-render
  pnpm rv render resume <runId>                             # finishes; output hash identical
  pnpm rv series cost --json                                # cost per delivered minute
  ```
- **Exit criterion:** two renders of the same IR produce identical frame hashes on both backends; the
  seven delivery files each pass their platform spec validator; a killed render resumes to a
  byte-identical result; the API e2e suite is green against fake providers at `$0`.

### M5 — The studio

- **Goal:** every artefact of every stage is inspectable and editable in a Persian-first RTL
  interface.
- **Stories:** RV-200 … RV-216.
- **Demo:** In the browser, in Persian: create a project → pick a preset and tune its motion block →
  probe → lock → type an idea in Persian → read the story tree and edit one beat → open Kael's
  expression grid and edit one prompt → see the cost estimate → produce on the free lane → open the
  rig editor and move a bone → scrub the player → drag a keyframe → preview the TikTok safe zone →
  export all formats. Then switch to English and confirm the layout flips correctly.
- **Exit criterion:** `tests/e2e-full-journey.spec.ts` passes in both `fa` and `en` with visual
  regression references for both directions; no user-visible string exists outside the message
  catalogues; total spend in CI is `$0`.

### Milestone summary

| Milestone                       | Stories | Ends in                                                             |
| ------------------------------- | ------: | ------------------------------------------------------------------- |
| M0 Bedrock                      |      14 | `pnpm verify` green, schemas emitted, `rv doctor`                   |
| M1 Model layer & locked style   |      21 | a probe-sheet PNG generated free, style locked, budget guard proven |
| M2 Story, memory, graph         |      28 | a story bible, multi-state character prompts, a blocked airing      |
| M3 Assets & animation IR        |      35 | rigged asset with a baked atlas; second run costs $0                |
| M4 Render, deliver, orchestrate |      24 | seven platform files from one composition                           |
| M5 Studio                       |      17 | the full browser journey in Persian RTL                             |
| **Total**                       | **139** |                                                                     |

---

## 5. Risk register

| #    | Risk                                                                                                                                                                   | Likelihood | Impact | Mitigation already designed                                                                                                                                                                                                                                                                                                                               | Stories                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| R-01 | **Ollama does not enforce JSON Schema** on `qwen3.5`/`gemma4`; the OpenAI-compatible endpoint returns fenced or schema-violating JSON (research §1, ollama#15540).     | High       | High   | Native `/api/chat` with `format` only — a source-scan test forbids the shim; `StructuredCall` does fence-strip → parse → Zod → one bounded repair turn seeded with the Zod issue paths → escalation to a stronger binding; every attempt metered; failure is a typed error, never a partial object.                                                       | RV-021, RV-022, RV-030                  |
| R-02 | **6 GB VRAM ceiling** — FLUX-class local work is impossible; larger local renders OOM.                                                                                 | High       | Medium | Local is explicitly the _free draft lane_ only: SDXL-Turbo / SD1.5 / LCM at 512–1024 px, with the adapter refusing oversized requests by capability rather than crashing; final quality is promoted to a cloud provider on approval; matting runs on ONNX/CPU with a documented fallback.                                                                 | RV-025, RV-123, RV-131                  |
| R-03 | **There is no genuinely free image API** — Gemini image is paid, and zero OpenRouter `:free` models emit images (verified live). Cost is unavoidable at final quality. | Certain    | High   | Architecture removes per-frame cost: assets are generated once, content-addressed and reused; procedural animation means seconds are free; exact estimate before spend; hits cost `$0`; the free draft lane absorbs all iteration; the "no free image model" fact is pinned by a regression test so a future assumption cannot creep back.                | RV-024, RV-101, RV-104, RV-129, RV-131  |
| R-04 | **Character-consistency drift** across expressions, poses, wardrobes and episodes — the classic failure of every comparable pipeline.                                  | High       | High   | A canonical turnaround is minted before any scene (auto-casting) and passed as a reference on every call; multi-reference conditioning on `text+image→image` models; fixed seeds and locked prompt fragments; an identity-match score gates every state with a bounded repair loop and a hard floor; a CLI report lists every below-floor state.          | RV-084, RV-120, RV-121, RV-128, RV-132  |
| R-05 | **Headless render performance** — Chromium at 1080p is slow on a laptop; long runs may be impractical.                                                                 | Medium     | High   | A browser is used only when the composition needs it: `@napi-rs/canvas` offscreen handles pure-2D with a benchmarked speed floor; the frame loop is deterministic, resumable and shardable so work is never lost or repeated; baked sprite sheets remove per-frame rig evaluation for static clips.                                                       | RV-129, RV-160, RV-162, RV-168          |
| R-06 | **TypeScript 6 vs 7 toolchain split** — TS 7 has no compiler API, which breaks `nest build`, the Swagger plugin and type-aware ESLint.                                 | Medium     | High   | TS pinned to `6.0.3` in the pnpm catalog (one resolved version workspace-wide); the reasoning is recorded in ADR-0005; CI typechecks every package on that version; no upgrade until Nest, the Swagger plugin and typescript-eslint all support the successor.                                                                                            | RV-010, RV-011                          |
| R-07 | **Cost overrun** — a retry loop, a runaway agent, or an accidental `final` lane empties the budget.                                                                    | Medium     | High   | Metering is pre-call, not post-hoc: the budget guard evaluates the estimate and returns `BudgetExceededError` before the request; per-run and per-day caps; a confirmation threshold for anything above `$1`; a response cache so byte-identical requests never bill twice; a live budget bar and a per-run ledger.                                       | RV-028, RV-029, RV-031, RV-104, RV-213  |
| R-08 | **RTL / i18n regressions** — an RTL layout silently breaks when a component is added, and Persian is the default locale.                                               | High       | Medium | `fa` is the default and both catalogues are key-set-equal by test; a lint rule bans user-visible string literals outside the catalogues; component CSS is restricted to logical properties by a style scan; Playwright visual regression keeps a reference per screen **per direction**, and an automated overflow check runs across every route in `fa`. | RV-201, RV-202, RV-203, RV-216          |
| R-09 | **Part decomposition fails** on a complex subject, leaving an unriggable single image.                                                                                 | Medium     | Medium | Parts are requested _by design_ as a labelled sheet rather than reverse-engineered; a three-step fallback chain (parts sheet → segmentation → single layer with a mesh-deform rig) guarantees an animatable result; the chosen strategy is recorded in provenance so quality can be audited.                                                              | RV-124, RV-125, RV-126                  |
| R-10 | **Scope**: 139 stories on one machine, with the studio UI last. Foundation-first risks a long stretch with nothing visible.                                            | High       | Medium | Every milestone ends in a runnable artefact you can look at — a probe PNG at M1, a printed character-state set at M2, an atlas image at M3, seven video files at M4 — and the CLI is delivered in M0 precisely so that this is possible before any UI exists.                                                                                             | RV-014, and the demo of every milestone |

---

## 6. Proposed (not requested)

Everything below is **outside the owner's stated requirements**. It is listed separately so it can be
rejected cheaply. None of it is scheduled in M0–M5.

| #    | Proposal                                                                                                                                                | Why it might matter                                                                                              | Cost if accepted                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| P-01 | **Audio: TTS voice, music and SFX ports, EBU R128 loudness normalisation.** The architecture sketches audio ports, but the owner never asked for sound. | An animated series with no audio is half a product; `lipSync` already exists in the IR with nothing to drive it. | L — a new port family, a provider, and a mix stage in delivery.         |
| P-02 | **Bilingual captions/subtitles**, burned-in and as sidecar SRT/VTT, with RTL-correct Persian typesetting.                                               | Social video is largely watched muted; Persian captions are a differentiator.                                    | M — depends on P-01 for timing unless typed from the script.            |
| P-03 | **`export-kit`: Lottie, DragonBones and PSD exporters.** Present in the architecture package map, absent from the requirements.                         | Lets assets and animation leave the tool; useful for handoff to other artists.                                   | M — the IR is already the source of truth, so these are projections.    |
| P-04 | **Direct publishing** to YouTube / Instagram / TikTok APIs.                                                                                             | Closes the last manual step.                                                                                     | L — OAuth, quotas, per-platform review policies, and ongoing API churn. |
| P-05 | **CAS integrity and garbage collection** (`rv assets doctor`): verify every sha, find orphans, report reclaimable space.                                | The store is append-only by design and will grow forever.                                                        | S.                                                                      |
| P-06 | **Jalali calendar and Persian date formatting** in the studio.                                                                                          | Persian users expect Jalali dates; RV-203 covers digits and typography only.                                     | S.                                                                      |
| P-07 | **Character LoRA training lane** for consistency on a larger GPU.                                                                                       | The strongest known consistency technique, if hardware ever allows.                                              | L — and it contradicts the 6 GB constraint today.                       |
| P-08 | **Postgres deployment profile plus authentication and multi-user projects.**                                                                            | The repository interfaces already permit it; would allow collaboration.                                          | L — and it breaks the local-first, zero-ops premise.                    |
| P-09 | **Thumbnail / poster / title-card generator** using the locked style.                                                                                   | Every upload needs one, and the style bible already knows how to draw.                                           | M.                                                                      |
| P-10 | **Local run telemetry** — durations, cache-hit rates and cost per stage over time, stored locally only.                                                 | Would make performance and cost regressions visible across runs.                                                 | S.                                                                      |
| P-11 | **StyleBible import/export** as a shareable file.                                                                                                       | Lets a style be reused across installs or shared.                                                                | S.                                                                      |
| P-12 | **Storyboard PDF export** for offline review.                                                                                                           | Reviewing a board away from the machine.                                                                         | S.                                                                      |

---

## 7. Requirement coverage

Every requirement stated in `.claude/agents/po.md`, mapped to the stories that deliver it. **A
requirement with no story is a bug in this backlog.** There are none.

| ID       | Stated requirement                                                                                | Delivered by                                                                           |
| -------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **R1a**  | Idea/prompt in → story out                                                                        | RV-080, RV-081, RV-087, RV-088, RV-089, RV-091, RV-181, RV-205                         |
| **R1b**  | …with **strong characters**                                                                       | RV-032, RV-060, RV-082, RV-084, RV-086, RV-206, RV-207                                 |
| **R1c**  | …and generated prompts for those characters in **multiple states** (expressions, poses, wardrobe) | RV-083, RV-120, RV-124, RV-206, RV-208                                                 |
| **R2a**  | Art style defined **first**, then locked                                                          | RV-040, RV-044, RV-045, RV-047, RV-048, RV-120, RV-204                                 |
| **R2b**  | Known **presets**                                                                                 | RV-041, RV-044, RV-204                                                                 |
| **R2c**  | Or a **user-defined custom style** (from references, or by wizard)                                | RV-042, RV-043, RV-204                                                                 |
| **R2d**  | Style includes **how things animate**, not just how they look                                     | RV-040, RV-046, RV-127, RV-142, RV-143, RV-204                                         |
| **R3a**  | **Everything is an asset** — tree, bird, prop, character                                          | RV-085, RV-100, RV-126, RV-130                                                         |
| **R3b**  | Assets carry **animation sheets**                                                                 | RV-129, RV-150, RV-208                                                                 |
| **R3c**  | Assets are **never regenerated** unless explicitly asked                                          | RV-006, RV-031, RV-101, RV-102, RV-103, RV-106, RV-130, RV-208                         |
| **R3d**  | Each asset carries **versions**                                                                   | RV-100, RV-102, RV-105, RV-208                                                         |
| **R3e**  | Each asset carries **multiple animations**                                                        | RV-127, RV-143, RV-150, RV-208                                                         |
| **R4a**  | Images must be **generatable**                                                                    | RV-121, RV-125, RV-130, RV-131                                                         |
| **R4b**  | Images must be **editable**                                                                       | RV-107, RV-122, RV-209                                                                 |
| **R4c**  | Every animation must be **generated**                                                             | RV-127, RV-140, RV-141, RV-143, RV-145                                                 |
| **R4d**  | Every animation must be **edited**                                                                | RV-146, RV-148, RV-210, RV-211, RV-212                                                 |
| **R5**   | Story model is **selectable** — Ollama local, Gemini, OpenRouter (and per stage, not global)      | RV-021, RV-022, RV-023, RV-024, RV-030, RV-090, RV-186, RV-213                         |
| **R6a**  | **Free lanes** where they genuinely exist (local Ollama, local ComfyUI, free text tiers)          | RV-022, RV-024, RV-025, RV-026, RV-031, RV-131                                         |
| **R6b**  | **Low cost** — paid only where it buys something; metered, estimated, capped                      | RV-028, RV-029, RV-031, RV-104, RV-106, RV-185, RV-213, RV-231, RV-237                 |
| **R6c**  | **High quality** — measured, not assumed                                                          | RV-084, RV-088, RV-123, RV-128, RV-132, RV-169                                         |
| **R7a**  | Output formats for **YouTube / Instagram / TikTok**                                               | RV-160, RV-161, RV-162, RV-163, RV-164, RV-167, RV-168, RV-170                         |
| **R7b**  | **Templates and safe zones**                                                                      | RV-147, RV-165, RV-166, RV-214                                                         |
| **R8a**  | **Multi-episode series**                                                                          | RV-005, RV-230, RV-231, RV-232, RV-233, RV-236                                         |
| **R8b**  | **Character / entity graph**                                                                      | RV-060, RV-061, RV-062, RV-063, RV-068, RV-072, RV-207                                 |
| **R8c**  | **Narrative memory**                                                                              | RV-064, RV-065, RV-066, RV-067                                                         |
| **R8d**  | …with **continuity**                                                                              | RV-069, RV-070, RV-071, RV-232, RV-234, RV-235                                         |
| **R9a**  | **Vue 3**                                                                                         | RV-200 … RV-216                                                                        |
| **R9b**  | **TypeScript**, strict                                                                            | RV-001, RV-002, RV-003, RV-010, RV-013, RV-200                                         |
| **R9c**  | **Node**                                                                                          | RV-014, RV-181, RV-182                                                                 |
| **R9d**  | **NestJS**                                                                                        | RV-180, RV-182, RV-183, RV-184, RV-186, RV-187, RV-188, RV-215                         |
| **R9e**  | **Best practice, SOLID**                                                                          | RV-004, RV-007, RV-008, RV-009, RV-011, RV-012, RV-013, RV-020, RV-027, RV-030, RV-164 |
| **R9f**  | **Full tests**                                                                                    | RV-010, RV-027, RV-033, RV-144, RV-149, RV-169, RV-188, RV-216                         |
| **R10a** | UI is **bilingual fa/en**                                                                         | RV-201, RV-216                                                                         |
| **R10b** | **Default Persian**                                                                               | RV-014, RV-080, RV-201, RV-203                                                         |
| **R10c** | **RTL**                                                                                           | RV-202, RV-211, RV-216                                                                 |

**Unmapped requirements: none.**

---

## 8. Open decisions for the owner

These do not block M0 or M1, but they will need an answer before the milestone that consumes them.

| #   | Decision                                                                                                                                             | Needed by | PO recommendation                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1 | Is **audio** in scope for v1 (P-01)? The IR already carries `lipSync` and dialogue cues with nothing to drive them.                                  | M4        | Defer to v1.1; keep the IR fields, ship silent masters.                                                                                                                              |
| D-2 | What is the **acceptable per-episode budget** at final quality? `.env.example` says `$5.00` per run, `$25.00` per day.                               | M3        | Keep `$5`/run as the hard cap; it matches the 40–120-asset estimate for a 60-second short.                                                                                           |
| D-3 | Which **paid image model** is the default final lane — `gemini-3.1-flash-lite-image` at ~$0.034/image, or `openai/gpt-5-image-mini` at ~$0.002–0.01? | M3        | Default to `gpt-5-image-mini` for drafts-above-free and `gemini-3.1-flash-lite-image` for locked assets, because only the Gemini family gives native multi-reference editing (R-04). |
| D-4 | Do episodes need a **manual "air" step**, or does rendering imply airing?                                                                            | M2        | Manual. Canon freeze must be a deliberate act.                                                                                                                                       |
| D-5 | Should the studio ship **English-first for screenshots/documentation** while remaining Persian-default at runtime?                                   | M5        | Persian default everywhere; keep English references in the visual-regression suite only.                                                                                             |
