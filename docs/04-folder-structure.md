# 04 — Folder Structure

The file-level companion to [`01-architecture.md`](./01-architecture.md). That document says what
the layers are; this one says where every file goes and what it is called.

> **Status.** This is the **target** layout. At the time of writing only `packages/shared-kernel`
> and `packages/contracts` exist on disk. Everything else below is the shape new work must take,
> not a description of what is there.

---

## خلاصهٔ فارسی

ساختار پوشه‌ها مستقیماً از لایه‌بندی معماری می‌آید. هر بسته یک «زمینهٔ محدود» (bounded context)
است، هر use-case یک کلاس با یک متد `execute()`، هر قابلیت بیرونی یک **port** در لایهٔ application
و یک **adapter** در `packages/providers`. تست‌ها کنار کد خودشان (`*.spec.ts`) می‌نشینند، نه در
یک پوشهٔ جدا. جهت وابستگی‌ها فقط به سمت داخل است و `pnpm arch:check` آن را اجبار می‌کند.

---

## 1. Repository root

```text
rivayat/
├─ .github/
│  └─ workflows/
│     └─ ci.yml                    Verify (format/lint/typecheck/arch/test) + a separate build job
├─ .husky/
│  └─ pre-commit                   Runs lint-staged
├─ .vscode/
│  ├─ extensions.json              Recommended extensions (ESLint, Prettier, Vitest, Vue, SQLite)
│  ├─ settings.json                Format-on-save, flat config, workspace TypeScript SDK
│  └─ launch.json                  Debug the API; debug the current Vitest file
├─ apps/                           Delivery layer — see §4
│  └─ .gitkeep                     Keeps the directory in git: `pnpm arch:check` cruises
│                                  `packages apps` and errors if `apps/` is absent. Delete it
│                                  once the first app lands.
├─ packages/                       Domain, application and infrastructure — see §3
├─ docs/                           Design documents and ADRs — see §5
├─ tools/                          Dev-only scripts and vendored workflow JSON — see §6
├─ workspace/                      RUNTIME DATA. Gitignored. See §7
├─ .dependency-cruiser.cjs         The architecture fitness function; fails CI on a layering breach
├─ .editorconfig                   Cross-editor whitespace/charset baseline
├─ .env / .env.example             Secrets and machine defaults (`.env` is gitignored)
├─ .npmrc                          save-exact, engine-strict, workspace linking
├─ .nvmrc                          Node 24 — read by nvm / fnm / Volta / actions-setup-node
├─ .prettierrc.json / .prettierignore
├─ CLAUDE.md                       The working agreement. Read before touching code.
├─ README.md                       Bilingual overview and quick start
├─ docker-compose.yml              Optional Redis for BullMQ; commented-out Postgres for later
├─ eslint.config.js                ESLint 10 flat config, type-aware
├─ package.json                    Root scripts (`verify`, `arch:check`, …) and shared devDeps
├─ pnpm-workspace.yaml             Workspace globs, the version `catalog:`, build allowlist
├─ tsconfig.base.json              Compiler options + `paths` for every `@rv/*`
├─ turbo.json                      Task graph, inputs/outputs, cache keys
└─ vitest.config.ts                Root projects list + coverage thresholds
```

---

## 2. The shape every package shares

```text
packages/<name>/
├─ src/
│  ├─ index.ts            The ONLY public surface. Explicit re-exports; never `export *` from a barrel of barrels.
│  └─ …                   Feature folders, described per package below
├─ package.json           `@rv/<name>`, `private: true`, `type: module`, catalog deps
├─ tsconfig.json          Extends ../../tsconfig.base.json; sets rootDir/outDir
├─ tsup.config.ts         ESM + CJS + .d.ts build
└─ vitest.config.ts       Carries a `name:` so `pnpm test` output is attributable
```

**Tests live next to the code they test** (`result.ts` / `result.spec.ts`). A separate `test/`
tree is used only for fixtures, harnesses and cross-cutting suites that belong to no single file.

---

## 3. `packages/` — the target tree

### 3.1 `shared-kernel/` — `@rv/shared-kernel`

Bottom of the dependency graph. Zero runtime dependencies; Node core only. **This package exists.**

```text
src/
├─ brand.ts        Nominal typing helper (`Brand`, `defineBrand`) so `AssetId` ≠ `EpisodeId`
├─ result.ts       `Result<T,E>` and its combinators — expected failures never throw
├─ errors.ts       `AppError` taxonomy: Validation/NotFound/Conflict/Provider/RateLimit/Budget/…
├─ guard.ts        `invariant`, `assertDefined`, `assertNever`, `at`, `must` — the sanctioned
│                  replacements for `!` and `any`
├─ clock.ts        `Clock` port, `SystemClock`, `FixedClock` — the only way to read time
├─ id.ts           ULID generation and prefixed ids (`asset_01J…`)
├─ hash.ts         `sha256`, `stableStringify`, `contentHash`, `compositeHash`, `shardPath`
├─ rng.ts          `createRng(seed)` — the only sanctioned randomness
├─ money.ts        `NanoUsd` integer money; no floats in the cost ledger
├─ logger.ts       `Logger` port, `NoopLogger`, `MemoryLogger`
└─ index.ts
```

### 3.2 `contracts/` — `@rv/contracts`

Zod schemas as the single source of truth. Types are **inferred**, never hand-written beside a
schema. **This package exists** (owned by the contracts workstream).

```text
src/
├─ primitives/        ids, StoryTime, Instant, Percent, HexColor, Seed, Checksum
├─ style/             StyleBible and its sub-schemas (visual, motion, render, promptFragments)
├─ story/             Brief, StoryBible, Act/Sequence/Scene/Beat, CharacterSheet, Shot
├─ narrative/         Entity, Relation, StateDelta, ContinuityIssue, WorldState
├─ asset/             AssetSpec, Asset, AssetVersion, Part, Rig, Variant, Clip, DedupKey
├─ anim/              AnimationIR: Node, Track, Keyframe, Behaviour, Marker, CameraTrack
├─ render/            FormatProfile, RenderRequest, EncodeSettings, SafeArea
├─ provider/          Provider request/response envelopes, CapabilityMatrix, CostRecord
├─ pipeline/          StageId, StageInput/Output unions, checkpoint and progress events
├─ emit/
│  ├─ json-schema.ts  Zod → JSON Schema for LLM structured output
│  └─ openapi.ts      Zod → OpenAPI components for the API
└─ index.ts
```

### 3.3 `core-domain/` — `@rv/core-domain`

Entities, value objects, invariants, domain events. **Pure**: no IO, no SDK, no node builtins.
Held to 100 % coverage.

```text
src/
├─ series/            Series, Season, Episode aggregates; the episode state machine and its
│                     transition guards (`AIRED` freezes canon)
├─ style/             StyleBible entity, checksum computation, the lock invariant
├─ asset/             Asset / AssetVersion / Variant aggregate, dedup-key construction,
│                     RegenerateIntent rules (a new take never overwrites)
├─ narrative/         Entity and Relation value objects, bi-temporal interval algebra,
│                     epistemic-view derivation, contradiction predicates
├─ pipeline/          Stage graph, dependency and invalidation rules, checkpoint semantics
├─ cost/              Budget, CostLedger aggregation, the pre-flight budget guard
├─ events/            Domain events emitted by the aggregates above
└─ index.ts
```

### 3.4 `prompt-kit/` — `@rv/prompt-kit`

Typed prompt templates and the only sanctioned path to LLM JSON (non-negotiable #6).

```text
src/
├─ template.ts             Typed template compilation with declared variables
├─ structured-call.ts      StructuredCall: strip fences → parse → Zod validate → bounded repair
│                          → escalate to a stronger model
├─ repair.ts               Feeds a Zod error back as a correction turn
├─ roles/                  One file per agent role, each with its own system prompt and rubric:
│                          screenwriter · director · producer · actor · continuity-editor ·
│                          art-director · extractor · summariser
├─ fewshot/                Few-shot banks, versioned so a prompt change is a reviewable diff
└─ index.ts
```

### 3.5 `narrative-memory/` — `@rv/narrative-memory`

The bi-temporal narrative knowledge graph (ADR-0004). This is what makes a _series_ possible.

```text
src/
├─ graph/
│  ├─ episodic-node.ts       Raw source utterance / scene text
│  ├─ entity-node.ts         Resolved entity + embedding
│  ├─ entity-edge.ts         A fact, with both temporal intervals
│  ├─ community-node.ts      Auto-clustered group with a rolling summary
│  └─ bitemporal.ts          validFrom/validUntil × assertedAt/retractedAt algebra
├─ ingest/
│  ├─ extract-entities.use-case.ts    Scene text → candidate entities
│  ├─ extract-relations.use-case.ts   Scene text → candidate facts
│  ├─ resolve-entity.use-case.ts      Alias/coreference resolution against existing nodes
│  └─ fold-state-delta.use-case.ts    Scene delta → world-state mutation
├─ retrieval/
│  ├─ hybrid-retriever.ts    graphProximity + semanticSimilarity + recency + importance + openLoop
│  ├─ budget.ts              Token-budgeted assembly; deterministic given the same graph state
│  └─ epistemic-view.ts      The world *as a given character knows it*
├─ continuity/
│  ├─ rules/                 Free, exact checks: dead-character-acting, object-in-two-places,
│  │                         timeline-inversion, unknown-knowledge, wardrobe/prop mismatch, ages
│  └─ llm-pass.use-case.ts   Semantic pass over what the rules could not decide
├─ compaction/               scene → episode → season → series rolling summaries
├─ ports/                    NarrativeGraphRepository, EmbeddingPort (re-declared narrowly)
├─ __fixtures__/             A small canonical series graph used across the tests
└─ index.ts
```

### 3.6 `providers/` — `@rv/providers`

The **only** package allowed to import a vendor SDK.

```text
src/
├─ ports/
│  ├─ text-generation.port.ts
│  ├─ structured-generation.port.ts
│  ├─ image-generation.port.ts
│  ├─ image-edit.port.ts
│  ├─ vision-scoring.port.ts
│  └─ embedding.port.ts
├─ adapters/
│  ├─ ollama/          OllamaTextAdapter, OllamaStructuredAdapter, OllamaEmbeddingAdapter.
│  │                   Native `/api/chat` with `format: <jsonSchema>` — never the OpenAI shim.
│  ├─ gemini/          GeminiTextAdapter, GeminiImageAdapter, GeminiImageEditAdapter, …
│  ├─ openrouter/      OpenRouterTextAdapter, …, plus live `/models` catalogue sync
│  ├─ comfyui/         ComfyUiImageAdapter — local free draft lane
│  └─ pollinations/    PollinationsImageAdapter — keyless last-resort fallback
├─ router/
│  ├─ model-router.ts       route(task, tier, policy) → ProviderBinding
│  ├─ capability-matrix.ts  Declared capabilities; the router never asks for what an adapter lacks
│  └─ failover.ts           Typed errors → backoff → next provider
├─ cost/
│  ├─ cost-meter.ts         Records {provider, model, tokens, images, nanoUsd} on every call
│  └─ budget-guard.ts       Runs BEFORE the call (non-negotiable #3)
├─ cache/response-cache.ts  Keyed by sha256(model ‖ params ‖ prompt ‖ refHashes)
├─ __contract__/            ONE suite executed against EVERY adapter — the LSP guard
├─ __fixtures__/            Recorded HTTP interactions; CI never touches the network
└─ index.ts
```

### 3.7 `style-engine/` — `@rv/style-engine`

```text
src/
├─ presets/                     Curated StyleBible presets, one file per medium
├─ derive-style.use-case.ts     Reference images → vision analysis → filled StyleBible
├─ wizard-style.use-case.ts     Guided questions/sliders → composed StyleBible
├─ generate-probe-sheet.use-case.ts   Character + tree + prop + sky in the candidate style
├─ lock-style.use-case.ts       Freezes the checksum; every asset key depends on it
├─ prompt-fragments.ts          StyleBible → the positive/negative fragments generation uses
└─ index.ts
```

### 3.8 `story-engine/` — `@rv/story-engine`

```text
src/
├─ intake/                      Polymorphic S0: idea · logline · script · prose · series-bible
├─ generate-story-bible.use-case.ts     DOC-style single-level outline expansion
├─ generate-cast.use-case.ts            CHIRON-shaped CharacterSheets (psychology first)
├─ generate-world.use-case.ts           Locations, props, flora, fauna, sky → AssetSpec[]
├─ generate-shot-list.use-case.ts       StoryBible → Shot[]
├─ write-scene.use-case.ts              Actor calls per character, reconciled by a director pass
├─ critique/                    Rubric-based critique before a draft is accepted
├─ replan.use-case.ts           Re-outline unaired episodes as memory accumulates
└─ index.ts
```

### 3.9 `asset-registry/` — `@rv/asset-registry`

```text
src/
├─ dedup-key.ts                 sha256(semanticKey ‖ styleChecksum ‖ variantKey ‖ specHash)
├─ resolve-assets.use-case.ts   AssetSpec[] → hit/miss plan + exact cost estimate (stage S5)
├─ register-asset.use-case.ts   Store bytes in the CAS, index the metadata
├─ semantic-search.use-case.ts  Embedding lookup — "a gnarled old tree" before generating one
├─ versions.ts                  AssetVersion / Variant lifecycle; nothing is ever overwritten
├─ ports/
│  ├─ content-store.port.ts     Binary CAS (filesystem now, S3 later)
│  └─ asset-repository.port.ts  Metadata (SQLite now, Postgres later — ADR-0006)
└─ index.ts
```

### 3.10 `asset-engine/` — `@rv/asset-engine`

```text
src/
├─ generate-asset.use-case.ts       Spec → image, through the router and the quality gate
├─ matte/                           Background removal: BiRefNet primary, @imgly fallback
├─ parts/
│  ├─ parts-sheet-prompt.ts         Ask the model for isolated parts BY DESIGN
│  ├─ split-parts.use-case.ts       Parts sheet → named, z-ordered RGBA layers
│  └─ fallback-decompose.ts         SAM/BiRefNet path when the parts sheet fails
├─ rig/
│  ├─ archetypes/                   biped · quadruped · bird · tree · cloud · water · prop ·
│  │                                crowd · fx — bone graph + default clips per archetype
│  ├─ auto-rig.use-case.ts          Fit the archetype template to the actual parts
│  ├─ anchor-detect.ts              Alpha centroid + declared join hints
│  └─ mesh-grid.ts                  Deformation grids for bendable parts
├─ clips/generate-clips.use-case.ts Motion presets parameterised by StyleBible.motion
├─ quality/vision-gate.use-case.ts  Style match, alpha cleanliness, silhouette, identity, parts
└─ index.ts
```

### 3.11 `anim-engine/` — `@rv/anim-engine`

Pure, deterministic, 100 % coverage. The heart of ADR-0001.

```text
src/
├─ ir/
│  ├─ node.ts / track.ts / keyframe.ts / marker.ts
│  └─ validate.ts               Structural checks beyond what the Zod schema can express
├─ evaluate.ts                  evaluate(ir, t) → SceneSnapshot. Pure. No clock, no Math.random.
├─ interpolate/                 linear · bezier · step · spring — the easing set
├─ behaviours/                  wind · breathe · blink · sway · walkCycle · flap · orbit ·
│                               parallax · boil · lipSync · particles. Seeded, closed-form in t.
├─ camera/                      Camera track evaluation and focusTarget resolution
├─ choreograph/                 Shot[] + assets + StyleBible.motion → AnimationIR (stage S8)
├─ bake/sheet-baker.ts          Clip → trimmed frames → maxrects atlas + atlas.json
├─ __fixtures__/                Golden IRs; their frame hashes are the regression suite
└─ index.ts
```

### 3.12 `render-engine/` — `@rv/render-engine`

```text
src/
├─ backends/
│  ├─ playwright/               PixiJS scene in headless Chromium; seek-per-frame, never play
│  └─ napi-canvas/              Offscreen Skia for pure-2D compositions (ADR-0003)
├─ select-backend.ts            Reads the IR's declared feature set → browser | canvas
├─ frame-loop.ts                for f in 0..N — resumable and shardable by construction
├─ encode/
│  ├─ ffmpeg.ts                 Subprocess wrapper; h264 · hevc · prores profiles
│  └─ loudness.ts               EBU R128 normalisation per platform
├─ reframe/
│  ├─ format-profiles.ts        yt-16x9 · shorts-9x16 · reels-9x16 · ig-4x5 · ig-1x1 · tiktok
│  └─ solve-crop.ts             focusTarget + safeArea → per-format crop/pan
├─ render-video.use-case.ts     Stage S10
├─ deliver.use-case.ts          Stage S11 — reframe, captions, loudness
└─ index.ts
```

### 3.13 `export-kit/` — `@rv/export-kit`

```text
src/
├─ lottie/          IR → Lottie JSON (the primary interchange target)
├─ atlas/           Sprite sheet + atlas.json (+ webp/avif)
├─ dragonbones/     IR → DragonBones JSON
├─ psd/             Parts → layered PSD for external touch-up
└─ index.ts
```

---

## 4. `apps/`

### 4.1 `apps/api` — NestJS 11

```text
src/
├─ main.ts
├─ app.module.ts
├─ modules/                     One module per bounded context; each binds ports to adapters
│  ├─ style/ story/ asset/ anim/ render/ narrative/ project/
│  └─ <module>/
│     ├─ <name>.controller.ts   Thin: validate → call a use-case → map the Result
│     ├─ <name>.module.ts
│     └─ dto/                   DTOs GENERATED from @rv/contracts — never hand-written
├─ infrastructure/
│  ├─ persistence/
│  │  ├─ drizzle/schema/        Table definitions (sqlite-core; pg-core alongside, later)
│  │  ├─ drizzle/migrations/
│  │  └─ repositories/          <Aggregate>Repository implementations
│  ├─ fs-cas/                   ContentStore implementation over workspace/assets
│  └─ queue/                    BullMQ setup + the in-process fallback when REDIS_URL is empty
├─ workers/                     One processor per pipeline stage (S0…S11)
├─ sse/                         Progress event gateway
├─ common/                      Filters, interceptors, DI tokens, Result→HTTP mapping
└─ config/                      Typed env loading, validated with a Zod schema
test/                           Supertest e2e against an in-memory queue
```

### 4.2 `apps/web` — Vue 3 studio

```text
src/
├─ main.ts / App.vue / router/
├─ views/
│  ├─ style-lab/       Preset picker, derive-from-refs, wizard, probe sheet, lock
│  ├─ story-board/     Outline tree, scene editor, cast sheets
│  ├─ asset-library/   Registry browser, versions, variants, cost ledger
│  ├─ rig-editor/      Konva overlay: bones, weights, anchors, mesh grids
│  ├─ timeline/        Tracks, keyframes, behaviour parameters, markers
│  ├─ player/          PixiJS canvas, scrub, per-format safe-area overlays
│  └─ narrative-graph/ Entity graph, relationship matrix, timeline, continuity issues
├─ components/         Reusable, presentational
├─ composables/        use<Thing>.ts
├─ stores/             Pinia, one per bounded context
├─ api/                Typed client generated from the OpenAPI emitted by @rv/contracts
└─ styles/
e2e/                   Playwright flows + visual regression on the player canvas
```

### 4.3 `apps/cli` — headless driver

```text
src/
├─ main.ts
├─ commands/           new · style · story · resolve · produce · render · deliver ·
│                      resume · inspect · cost
└─ output/             Human and JSON reporters (JSON for CI)
```

---

## 5. `docs/`

```text
docs/
├─ 00-research.md          Live-verified tools, providers, pricing. Authoritative over memory.
├─ 00b-prior-art.md        What we copied from ViMax / Graphiti / DOC / CHIRON, and what we rejected
├─ 01-architecture.md      Layering, package map, core models, pipeline, providers
├─ 02-domain-model.md      Series, the bi-temporal graph, narrative memory
├─ 03-backlog.md           Stories with acceptance criteria
├─ 04-folder-structure.md  This document
├─ adr/
│  ├─ ADR-0001-own-animation-ir.md
│  ├─ ADR-0002-procedural-animation-not-generative-video.md
│  ├─ ADR-0003-playwright-ffmpeg-render-path.md
│  ├─ ADR-0004-bitemporal-narrative-graph.md
│  ├─ ADR-0005-typescript-6-not-7.md
│  └─ ADR-0006-sqlite-content-addressed-store.md
└─ generated/              Gitignored: dependency graphs, emitted OpenAPI, coverage summaries
```

---

## 6. `tools/`

Dev-only. Nothing here is imported by shipped code.

```text
tools/
├─ scripts/            One-off and maintenance scripts (.mjs, run with node/tsx)
└─ comfy-workflows/    ComfyUI workflow JSON for the free local draft lane
```

---

## 7. `workspace/` — runtime data, gitignored

Not source. Deleting it loses generated work, not code.

```text
workspace/
├─ rivayat.db                        SQLite: metadata + the narrative graph (ADR-0006)
├─ assets/<sha[0:2]>/<sha256>/…      Content-addressed binaries, shared across ALL projects
├─ projects/<projectId>/             Per-project checkpoints, drafts, render outputs
└─ cache/                            Provider response cache, HF model cache
```

---

## 8. Naming conventions

**Files** are `kebab-case.ts`. **Directories** are `kebab-case`. **Types, classes and Zod schema
constants** are `PascalCase`. **Functions and variables** are `camelCase`.

| Kind            | Pattern                                | Example                                                                       |
| --------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| Use-case class  | `<Verb><Noun>UseCase`, one `execute()` | `GenerateCharacterSheetUseCase`                                               |
| Use-case file   | `<verb>-<noun>.use-case.ts`            | `generate-character-sheet.use-case.ts`                                        |
| Port interface  | `<Capability>Port`                     | `ImageEditPort`, `EmbeddingPort`                                              |
| Port file       | `<capability>.port.ts`                 | `image-edit.port.ts`                                                          |
| Adapter class   | `<Vendor><Capability>Adapter`          | `GeminiImageEditAdapter`                                                      |
| Adapter file    | `<vendor>-<capability>.adapter.ts`     | `gemini-image-edit.adapter.ts`                                                |
| Repository port | `<Aggregate>Repository`                | `AssetRepository`                                                             |
| Repository impl | `<Tech><Aggregate>Repository`          | `DrizzleAssetRepository`, `PgAssetRepository`                                 |
| Domain entity   | `<Noun>` in `<noun>.ts`                | `StyleBible` in `style-bible.ts`                                              |
| Zod schema      | `<Noun>Schema` + inferred `<Noun>`     | `export const ShotSchema = …; export type Shot = z.infer<typeof ShotSchema>;` |
| Domain event    | `<Noun><PastTenseVerb>`                | `EpisodeAired`, `AssetRegistered`                                             |
| NestJS DI token | `SCREAMING_SNAKE`                      | `IMAGE_GENERATION_PORT`                                                       |
| Vue component   | `PascalCase.vue`                       | `TimelineTrack.vue`                                                           |
| Vue composable  | `use<Thing>.ts`                        | `useTimelineScrub.ts`                                                         |
| Pinia store     | `<context>.store.ts`                   | `asset-library.store.ts`                                                      |

### Tests and test data

| Kind                 | Location and name                                    | Rule                                                                   |
| -------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Unit spec            | `src/**/<file>.spec.ts`, beside the file             | One spec per source file. `.test.ts` is not used — pick one, this one. |
| Contract suite (LSP) | `src/__contract__/<port>.contract.spec.ts`           | One suite, executed against **every** adapter of that port.            |
| Golden frame test    | `src/__fixtures__/<name>.rvanim.json` + a hash table | `AnimationIR → frame hash`. A diff is a build failure.                 |
| Shared fixtures      | `src/__fixtures__/`                                  | Deterministic data only — fixed seeds, `FixedClock`, no `Date.now()`.  |
| Recorded network     | `src/__fixtures__/http/<provider>/*.json`            | CI never opens a socket.                                               |
| Test doubles         | `src/__mocks__/`                                     | Fakes preferred over mocks; assert on behaviour, not on call counts.   |
| API e2e              | `apps/api/test/*.e2e-spec.ts`                        | Supertest, in-memory queue.                                            |
| Web e2e              | `apps/web/e2e/*.spec.ts`                             | Playwright; visual regression on the player canvas.                    |

`__fixtures__` and `__mocks__` are excluded from coverage and from the dependency-cruiser graph.

### Rules the layout encodes

1. `src/index.ts` is the only public surface of a package. Deep imports across packages
   (`@rv/foo/src/bar`) are a layering breach and `arch:check` fails on them.
2. A file that exports a use-case exports **exactly one**.
3. Ports are declared in the layer that _needs_ them, and implemented in the layer that _can_.
   A port never moves outward to be near its adapter.
4. `packages/providers` is the only place a vendor SDK may be imported. If a new capability needs
   one somewhere else, the answer is a new port, not an exception.
5. Nothing in `core-domain`, `contracts` or `shared-kernel` may import from `apps/` or
   `providers/`. Enforced, not requested.
