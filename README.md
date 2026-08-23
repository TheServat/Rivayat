# Rivayat · روایت

**ایده → سریال انیمیشنی چندقسمتی، در چند فرمت.**
_An idea becomes an animated, multi-episode series — rendered to every delivery format from one
composition._

> **وضعیت: موتورها کامل‌اند، استودیو نیمه‌کاره است، و هنوز هیچ سریالی سرتاسر تولید نشده.**
> **Status: the engines are done, the studio is half-built, and no series has been produced end
> to end yet.** The API and the web app both start and serve. See
> [Current status](#current-status) for what is measured and what is missing.

---

# فارسی

## این چیست

Rivayat یک خط تولید کامل است که از یک ایدهٔ متنی شروع می‌کند و به یک سریال انیمیشنی می‌رسد:
سبک هنری قفل می‌شود، داستان و مدل جهانِ آن ساخته می‌شود، دارایی‌های تصویری **یک بار** تولید و
برای همیشه بازاستفاده می‌شوند، انیمیشن روی rig به‌صورت **procedural** محاسبه می‌شود، و خروجی از
یک ترکیب واحد برای YouTube / Shorts / Reels / TikTok رندر می‌گیرد.

سه تصمیم، کل معماری را می‌سازند:

1. **اول سبک.** پیش از هر تصویری یک «کتاب سبک» (StyleBible) ساخته و _قفل_ می‌شود — هم ظاهر
   (رنگ، خط، سایه، بافت) و هم **نحوهٔ حرکت** (easing، اغراق، fps، قواعد دوربین). checksum آن
   جزئی از کلید هر asset است، پس تغییر سبک به‌جای ناهماهنگی خاموش، کتابخانه را fork می‌کند.
2. **انیمیشن procedural است، نه frame-by-frame.** مدل هوش مصنوعی فقط _قطعات_ را می‌سازد؛ حرکت از
   روی rig و منحنی‌ها محاسبه می‌شود. نتیجهٔ اقتصادی: هزینه به **تعداد asset یکتا** وابسته است،
   نه به تعداد فریم، ثانیه، بازنگری، نسبت تصویر، یا قسمت.
3. **هیچ asset ای دو بار ساخته نمی‌شود.** کلید محتوا-محور از
   `semanticKey + styleChecksum + variantKey + specHash` ساخته می‌شود. درخواستی که به کلیدی
   موجود hash شود، همان asset را برمی‌گرداند و **صفر دلار** خرج می‌کند.

### عدد ماجرا

یک ویدیوی ۶۰ ثانیه‌ای تقریباً **۴۰ تا ۱۲۰ asset یکتا** لازم دارد. با
`gemini-3.1-flash-lite-image` (قیمت زنده‌بررسی‌شده: **۰٫۰۳۳۶ دلار** برای هر تصویر ۱۰۲۴ پیکسلی):

```
 40 × $0.0336 = $1.34        120 × $0.0336 = $4.03
```

یعنی **حدود ۱٫۵ تا ۵ دلار، یک بار.** بعد از آن، رندر دوباره، تغییر زمان‌بندی، تغییر قاب برای
شش فرمت مختلف، و **قسمت‌های بعدی با همان بازیگران و همان سبک، صفر دلار** هزینه دارند. جزئیات و
استدلال کامل در [ADR-0002](docs/adr/ADR-0002-procedural-animation-not-generative-video.md).

## پیش‌نیازها

روی همین ماشین بررسی و تأیید شده (۱۴۰۵/۰۶/۰۱ — 2026-08-23):

| ابزار   | نسخهٔ تأییدشده                       | لازم؟                                              |
| ------- | ------------------------------------ | -------------------------------------------------- |
| Node.js | `v24.19.0`                           | بله                                                |
| pnpm    | `11.22.0` (از طریق corepack)         | بله                                                |
| Git     | `2.54.0`                             | بله                                                |
| FFmpeg  | `8.1.2-full` (gyan build) روی PATH   | بله — برای رندر                                    |
| Ollama  | `0.32.15`                            | بله — مدل رایگان محلی، پیش‌فرض همهٔ مرحله‌های متنی |
| Python  | `3.13.2` (و `3.11` هم نصب است)       | فقط برای ComfyUI                                   |
| ComfyUI | محلی در `D:\me\tools\ComfyUI`        | اختیاری — خط رایگان draft                          |
| Redis   | از طریق `docker compose up -d redis` | اختیاری — بدون آن صف in-process کار می‌کند         |

سخت‌افزار این ماشین: Intel i7-10850H، ۳۲ گیگابایت RAM، NVIDIA Quadro RTX 3000 با **۶ گیگابایت
VRAM**. شش گیگابایت برای SDXL-Turbo / SD1.5 کافی است (draft، چند ثانیه در هر تصویر) اما برای
FLUX-dev کافی نیست. به همین دلیل: **محلی = خط رایگانِ پیش‌نویس، ابری = خط پولیِ نهایی.**

## شروع سریع

```bash
git clone <repo> rivayat && cd rivayat

corepack enable                 # pnpm 11.22.0 را از package.json می‌خواند
pnpm install

cp .env.example .env            # کلیدها اختیاری‌اند؛ Ollama بدون کلید کار می‌کند
pnpm verify                     # دروازه: قالب + lint + typecheck + arch + determinism + test
```

هیچ سرویسی لازم نیست. پایگاه داده یک فایل SQLite در `workspace/` است و صف بدون Redis به‌صورت
in-process اجرا می‌شود ([ADR-0006](docs/adr/ADR-0006-sqlite-content-addressed-store.md)).

اگر مسیر واقعی BullMQ را می‌خواهید:

```bash
docker compose up -d redis
# سپس در .env:  REDIS_URL=redis://127.0.0.1:6379
```

## اجرا

سه فرمان، سه ورودی به سیستم. هر سه بدون هیچ کلید API کار می‌کنند.

```bash
pnpm --filter @rv/api dev      # NestJS روی http://127.0.0.1:3000
pnpm --filter @rv/web dev      # استودیوی Vue روی http://127.0.0.1:5173
pnpm --filter @rv/cli exec rv doctor
```

وب به `/api` روی پورت ۳۰۰۰ پروکسی می‌کند، پس API را اول بالا بیاورید. سلامت سیستم:

```bash
curl http://127.0.0.1:3000/api/health
```

پاسخ می‌گوید کدام provider ثبت شده و کدام رد شده و چرا — مثلاً `gemini` با دلیل
`GEMINI_API_KEY is not set`. این یک خطا نیست: خط رایگان محلی همین‌طور کار می‌کند.

## وضعیت فعلی

**لایهٔ موتور عملاً تمام است، لایهٔ برنامه نه.** پانزده بسته زیر `packages/` نوشته و تست
شده‌اند — ۵۰۷۳ تست در ۲۳۱ فایل — و `contracts`، `core-domain` و `anim-engine` روی ۱۰۰٪ پوشش
قفل شده‌اند. API بالا می‌آید و هر دوازده مرحلهٔ pipeline را ثبت می‌کند. اما شش صفحه از هشت
صفحهٔ استودیو هنوز placeholder هستند، CLI حدود هشت فرمان از بیست فرمان را دارد و هیچ تستی
ندارد، و **هیچ سریالی سرتاسر تولید نشده است.**

`pnpm verify` امروز سبز نیست. هیچ‌کدام از شکست‌ها مربوط به محیط نیست؛ همه کدِ در حال نوشته
شدن است. جدول دقیقِ اندازه‌گیری‌شده: [Current status](#current-status). فهرست کارهای
باقی‌مانده: [`docs/05-remaining-work.md`](docs/05-remaining-work.md).

---

# English

## What it is

Rivayat is an end-to-end pipeline: a text idea in, an animated multi-episode series out. The art
style is locked first; the story and its world model come next; visual assets are generated
**once** and reused forever; animation is **procedural** on rigs; and one composition renders to
YouTube, Shorts, Reels and TikTok formats.

Three decisions carry the architecture:

1. **Style first.** A `StyleBible` is authored and _locked_ before any pixel exists — appearance
   (palette, line, shading, texture) **and motion** (easing, exaggeration, fps, camera rules). Its
   checksum participates in every asset key, so changing the style forks the asset library instead
   of silently mismatching.
2. **Animation is procedural, not frame-by-frame.** The image models produce _parts_; motion is
   computed from a rig. The economic consequence: **cost scales with unique assets**, not with
   frames, seconds, revisions, aspect ratios or episodes.
3. **No asset is generated twice.** Every request is content-addressed on
   `semanticKey + styleChecksum + variantKey + specHash`. A request that hashes to an existing key
   returns the cached asset and spends **$0**.

### The number that justifies the design

A 60-second short needs roughly **40–120 unique assets**. At the live-verified price for
`google/gemini-3.1-flash-lite-image` — **$0.0336 per 1024px image**:

```
 40 × $0.0336 = $1.34          120 × $0.0336 = $4.03
```

**≈ $1.50 – $5.00, paid once.** After that, re-rendering, re-timing, re-framing to six delivery
formats, exporting to Lottie or a sprite atlas, and shipping episodes 2…N with the same cast in
the same style all cost **$0**. The full argument, including why we rejected generative video, is
[ADR-0002](docs/adr/ADR-0002-procedural-animation-not-generative-video.md).

## Prerequisites

Verified on this machine on 2026-08-23 — these are actual measured versions, not minimums copied
from a template:

| Tool    | Verified version                     | Required?                                                  |
| ------- | ------------------------------------ | ---------------------------------------------------------- |
| Node.js | `v24.19.0`                           | Yes (`engines: >=24.0.0`)                                  |
| pnpm    | `11.22.0`, via corepack              | Yes — the version is pinned in `packageManager`            |
| Git     | `2.54.0`                             | Yes                                                        |
| FFmpeg  | `8.1.2-full` (gyan build), on PATH   | Yes, for rendering. Invoked as a subprocess, not vendored. |
| Ollama  | `0.32.15`                            | Yes — the free local default for every text stage          |
| Python  | `3.13.2` (and `3.11` also installed) | Only for ComfyUI                                           |
| ComfyUI | local, at `D:\me\tools\ComfyUI`      | **Optional** — the free local draft lane                   |
| Redis   | via `docker compose up -d redis`     | **Optional** — without it the queue runs in-process        |
| Docker  | any recent version                   | **Optional** — only for Redis / future Postgres            |

Local Ollama models present on this machine: `qwen3.5:latest` (6.6 GB), `gemma4:26b` (17 GB),
`qwen2.5:7b`, `qwen3:1.7b`, `aya-expanse:8b`, `llama3.2:latest`.

Hardware: Intel i7-10850H, 32 GB RAM, NVIDIA Quadro RTX 3000 with **6 GB VRAM**. That is enough
for SDXL-Turbo / SD1.5 drafts at 512–1024px and not enough for comfortable FLUX-dev work — hence
**local = free draft lane, cloud = paid final lane**.

No API key is required to start. Ollama covers the text stages for free; `GEMINI_API_KEY` and
`OPENROUTER_API_KEY` are only needed for paid final-quality image generation.

## Quick start

```bash
git clone <repo> rivayat && cd rivayat

corepack enable                 # picks up pnpm 11.22.0 from package.json
pnpm install

cp .env.example .env            # keys are optional; Ollama needs none
pnpm verify                     # the gate — see Commands
```

Nothing else has to be running. Metadata is a SQLite file under `workspace/`, binaries go to a
content-addressed directory beside it, and with `REDIS_URL` empty the pipeline uses an in-process
queue ([ADR-0006](docs/adr/ADR-0006-sqlite-content-addressed-store.md)).

For the real BullMQ path:

```bash
docker compose up -d redis
# then set in .env:  REDIS_URL=redis://127.0.0.1:6379
```

## Running it

Three entry points. None of them needs an API key.

```bash
pnpm --filter @rv/api dev      # NestJS + SSE + workers   → http://127.0.0.1:3000
pnpm --filter @rv/web dev      # the Vue studio            → http://127.0.0.1:5173
pnpm --filter @rv/cli exec rv doctor
```

Start the API first: Vite proxies `/api` to `http://127.0.0.1:3000` (`RV_API_ORIGIN` overrides
the target, `RV_API_PORT` the port). `pnpm --filter @rv/web preview` serves a production build on
`4173`.

The health endpoint is the fastest way to see what the machine actually has:

```bash
curl http://127.0.0.1:3000/api/health
```

Measured response on this machine, 2026-08-23, with no keys in `.env`:

```json
{
  "status": "ok",
  "database": { "location": "…/workspace/rivayat.db", "reachable": true },
  "queue": { "driver": "in-process", "concurrency": 4 },
  "providers": {
    "registered": [
      "ollama:qwen3.5:latest",
      "ollama:nomic-embed-text",
      "comfyui:dreamshaper_8.safetensors"
    ],
    "skipped": [{ "provider": "gemini", "reason": "GEMINI_API_KEY is not set" }]
  }
}
```

A `skipped` provider is not an error. It is the free lane working as designed: the router routes
around adapters that cannot be built, and the paid ones only appear when you supply a key.

### Running the tests

```bash
pnpm test                              # every package, one Vitest process
pnpm test:cov                          # the same, plus the per-package coverage floors
pnpm exec vitest run --project contracts   # one package, from the repo root
cd packages/contracts && npx vitest run    # one package, from inside it
pnpm -r --no-bail test                 # each package's own test script, all of them
```

The last two are not redundant. `pnpm test` is one process over every project and is the fast
path; `pnpm -r --no-bail test` runs each package's own script in its own working directory, which
is the only way to catch a package whose `vitest.config.ts` is broken in isolation. `--no-bail`
matters: without it the first red package ends the run and the green ones never report.

Browser end-to-end tests are separate and are not part of `pnpm verify`:
`pnpm --filter @rv/web test:e2e` (Playwright, needs `npx playwright install`).

## Commands

| Command                             | What it does                                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                      | Install the workspace                                                                                                                                                                                                                             |
| **`pnpm verify`**                   | **The gate.** `format:check` → `lint` → `typecheck` → `arch:check` → `determinism:check` → `test:cov`. Must be green before anything is "done". CI runs these six steps, in this order, and a guard fails the build if the two lists ever differ. |
| `pnpm build`                        | `turbo run build` — tsup, ESM + CJS + `.d.ts` per package                                                                                                                                                                                         |
| `pnpm dev`                          | `turbo run dev` — watch mode across packages                                                                                                                                                                                                      |
| `pnpm test`                         | Every package's Vitest suite                                                                                                                                                                                                                      |
| `pnpm test:watch`                   | Vitest in watch mode                                                                                                                                                                                                                              |
| `pnpm test:cov`                     | Tests plus coverage. Floors are **per package**, not one workspace average: 100 % for `contracts` / `core-domain` / `anim-engine`, 90 % lines and 85 % branches for the rest                                                                      |
| `pnpm typecheck`                    | `tsc --noEmit` per package, via turbo. `--continue`, so one package's type error does not hide the others                                                                                                                                         |
| `pnpm lint` / `pnpm lint:fix`       | ESLint 10 flat config, type-aware                                                                                                                                                                                                                 |
| `pnpm format` / `pnpm format:check` | Prettier 3.9                                                                                                                                                                                                                                      |
| `pnpm arch:check`                   | dependency-cruiser — fails on any breach of the dependency rule                                                                                                                                                                                   |
| `pnpm determinism:check`            | Fails on `Date.now()`, `Math.random()`, bare `new Date()` and the `node:crypto` entropy calls anywhere in `packages/*/src` or `apps/*/src` (CLAUDE.md #1)                                                                                         |
| `pnpm ci:check`                     | Asserts CI and `pnpm verify` run the same steps, `.nvmrc` satisfies `engines`, and no paid credential is present under `CI=true`                                                                                                                  |
| `pnpm arch:graph`                   | Writes an architecture graph to `docs/generated/deps.dot`                                                                                                                                                                                         |
| `pnpm clean`                        | Removes `dist`, `.turbo`, `coverage`                                                                                                                                                                                                              |
| `pnpm --filter @rv/<pkg> <script>`  | Run a script in one package                                                                                                                                                                                                                       |

### Continuous integration

`.github/workflows/ci.yml` (the `verify` workflow) runs on every push to `main` and every pull
request, on **`ubuntu-latest` and `windows-latest`**, with `fail-fast: false` so a Windows-only
break does not cancel the Linux leg. Windows is in the matrix because it is the primary
development machine and two of the defects found so far were Windows-only: a command-line length
limit, and PowerShell mangling a quoted string. Steps run under each runner's native shell, so
the Windows leg really is PowerShell.

CI runs the six `pnpm verify` steps as six separate steps, then `pnpm build`, then a second job
running `pnpm -r --no-bail test`. It runs nothing else, and `pnpm ci:check` fails the build if
that stops being true. **CI spends $0**: no provider credential is set in any job, `ci:check`
fails if one appears, and the provider contract suite runs against recorded fixtures where an
unmatched request throws instead of reaching the network. Reasoning and rejected alternatives:
[ADR-0007](docs/adr/ADR-0007-ci-on-github-actions.md).

## Package map

`apps → engines → core-domain / contracts → shared-kernel`. Arrows point inward only; domain and
application layers never import a vendor SDK. `pnpm arch:check` enforces this and fails CI.

Fifteen packages and three apps. The "lines / branches" column is measured coverage from
`pnpm test:cov` on 2026-08-23, not an aspiration.

| Package                | Purpose                                                                                                                    | Lines / branches |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `@rv/shared-kernel`    | `Result<T,E>`, error taxonomy, branded ids, hashing, seeded RNG, `Clock`, money, logging. Zero dependencies.               | 98.50 / 94.08    |
| `@rv/contracts`        | Zod schemas as the single source of truth; JSON Schema and OpenAPI are emitted from them                                   | **100 / 100**    |
| `@rv/core-domain`      | Entities, value objects, invariants, domain events. Pure.                                                                  | **100 / 100**    |
| `@rv/settings`         | The settings registry and its layers: built-in default → `.env` → global → project → run                                   | 99.24 / 97.50    |
| `@rv/prompt-kit`       | Typed prompt templates, agent roles, `StructuredCall` + repair loop                                                        | 96.15 / 84.34 ⚠  |
| `@rv/narrative-memory` | Bi-temporal narrative knowledge graph, world state, continuity, retrieval                                                  | 98.50 / 86.41    |
| `@rv/providers`        | Ollama / Gemini / OpenRouter / ComfyUI adapters, router, cost meter, cache — the only package that may import a vendor SDK | 99.26 / 88.79    |
| `@rv/persistence`      | SQLite + Drizzle schema, repositories, the content-addressed blob store                                                    | 99.06 / 91.49    |
| `@rv/style-engine`     | StyleBible presets, derivation from references, wizard, probe sheets                                                       | 99.42 / 91.71    |
| `@rv/story-engine`     | Brief → StoryBible → cast → world → shot list                                                                              | 99.85 / 90.46    |
| `@rv/asset-registry`   | Content-addressed store, dedup keys, versions, variants, semantic search                                                   | 100 / 92.25      |
| `@rv/asset-engine`     | AssetSpec → generate → matte → parts → auto-rig → clips → register                                                         | 98.27 / 91.18    |
| `@rv/anim-engine`      | Animation IR, pure evaluator, behaviours, motion presets, sheet baker                                                      | **100 / 100**    |
| `@rv/render-engine`    | IR → frames → FFmpeg → delivery formats and re-framing                                                                     | 98.01 / 87.61    |
| `@rv/export-kit`       | Lottie / sprite-atlas / DragonBones / PSD exporters                                                                        | 99.29 / 91.37    |
| `apps/api`             | NestJS — REST + SSE + workers, all twelve pipeline stages registered                                                       | 94.65 / 78.32 ⚠  |
| `apps/web`             | Vue 3 studio: style lab, story board, asset library, rig editor, timeline, player                                          | 96.20 / 88.36    |
| `apps/cli`             | Headless driver for CI and batch runs                                                                                      | **no tests yet** |

⚠ marks a package below the 85 % branch floor. Both are pinned by a ratchet in
`vitest.config.ts` at the number they actually reach, so they can only go up; see
[ADR-0007](docs/adr/ADR-0007-ci-on-github-actions.md).

File-level layout and naming conventions: [`docs/04-folder-structure.md`](docs/04-folder-structure.md).

## Current status

Read this before assuming anything works.

| Area                                                                                    | State                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Design documents and ADRs                                                               | **Complete**                                                                                |
| Repo plumbing — pnpm workspace, turbo, ESLint, Prettier, Vitest, dependency-cruiser, CI | **Working**                                                                                 |
| The fifteen packages under `packages/`                                                  | **Written and tested.** 5,073 tests in 231 files                                            |
| `apps/api`                                                                              | **Runs.** REST + SSE, all twelve pipeline stages registered, in-process queue               |
| `apps/web`                                                                              | **Runs.** Shell, navigation, i18n and RTL work; six of eight screens are still placeholders |
| `apps/cli`                                                                              | **Runs, untested.** Roughly eight of twenty commands; zero tests                            |
| A series produced end to end                                                            | **Not done.** The single most important gap                                                 |

`pnpm verify` does **not** pass end to end today. Measured on 2026-08-23 by running the CI step
sequence locally:

| Step                     | Result                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm ci:check`          | passes                                                                                                                                 |
| `pnpm format:check`      | **fails** — 24 files. `pnpm format` fixes every one                                                                                    |
| `pnpm lint`              | **fails** — 18 errors, 1 warning, in `apps/cli` (9 files), `apps/api` and `persistence` specs                                          |
| `pnpm typecheck`         | **fails** in `@rv/api` only — the pipeline-checkpoint row gained fields that the callers have not caught up with                       |
| `pnpm arch:check`        | passes — 810 modules, 3,240 dependencies, 0 errors, 1 orphan warning                                                                   |
| `pnpm determinism:check` | passes — 497 files, 3 allowlisted boundary files                                                                                       |
| `pnpm test:cov`          | **fails** on 1 test of 5,073: `export-kit/src/registry.spec.ts` walks `'src'` relative to `process.cwd()`, which is the repo root here |
| `pnpm build`             | passes                                                                                                                                 |

Coverage itself is green: **zero threshold breaches** across all seventeen per-package floors,
with `contracts`, `core-domain` and `anim-engine` at exactly 100 %.

And the second CI job, `pnpm -r --no-bail test`, ends in `Summary: 1 fails, 17 passes` — the one
failure being `apps/cli`, which has no tests yet and whose `test` script is red on purpose.

These are real failures in code being written right now, not environment problems. Do not treat a
red `verify` as normal — it is the thing that has to go green. Each one is tracked in
[`docs/05-remaining-work.md`](docs/05-remaining-work.md) §W7.

## Documentation

Read in this order.

| Document                                                     | Contents                                                                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [`CLAUDE.md`](CLAUDE.md)                                     | The working agreement: non-negotiables, code standards, testing, definition of done. Read before touching code.                   |
| [`docs/00-research.md`](docs/00-research.md)                 | Live-verified tools, providers and pricing. **These numbers were checked against live APIs — do not "correct" them from memory.** |
| [`docs/00b-prior-art.md`](docs/00b-prior-art.md)             | What we took from ViMax, Graphiti, DOC and CHIRON — and what we deliberately rejected                                             |
| [`docs/01-architecture.md`](docs/01-architecture.md)         | Layering, package map, the four core models, the 12-stage pipeline, the provider layer                                            |
| [`docs/02-domain-model.md`](docs/02-domain-model.md)         | Series and episodes, the bi-temporal narrative graph, narrative memory, continuity                                                |
| [`docs/03-backlog.md`](docs/03-backlog.md)                   | Stories with acceptance criteria                                                                                                  |
| [`docs/04-folder-structure.md`](docs/04-folder-structure.md) | The full file-level tree and every naming convention                                                                              |
| [`docs/05-remaining-work.md`](docs/05-remaining-work.md)     | Everything between here and a runnable studio, measured rather than guessed. **Start here if you want something to do.**          |

### Decision records

| ADR                                                                        | Decision                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [ADR-0001](docs/adr/ADR-0001-own-animation-ir.md)                          | Author our own animation IR (`.rvanim.json`) rather than adopt Spine, DragonBones, Rive or Lottie            |
| [ADR-0002](docs/adr/ADR-0002-procedural-animation-not-generative-video.md) | Procedural animation over generated assets, **not** generative video — the central economic decision         |
| [ADR-0003](docs/adr/ADR-0003-playwright-ffmpeg-render-path.md)             | Render with Playwright + FFmpeg, plus a `@napi-rs/canvas` offscreen backend; not Remotion, not Motion Canvas |
| [ADR-0004](docs/adr/ADR-0004-bitemporal-narrative-graph.md)                | A Graphiti-shaped bi-temporal narrative graph on SQLite; not Zep/Neo4j as a service, not Mem0                |
| [ADR-0005](docs/adr/ADR-0005-typescript-6-not-7.md)                        | Pin TypeScript 6.0.3 — TS 7 ships no compiler API                                                            |
| [ADR-0006](docs/adr/ADR-0006-sqlite-content-addressed-store.md)            | SQLite + Drizzle for metadata, a content-addressed filesystem for binaries                                   |
| [ADR-0007](docs/adr/ADR-0007-ci-on-github-actions.md)                      | CI on GitHub Actions, matrixed on Windows, with per-package coverage floors                                  |

## Contributing

1. `pnpm verify` must be green. Not "green except for".
2. New public API carries TSDoc explaining _why_ it exists.
3. Tests cover the happy path, the failure path, and the boundary the code actually guards.
4. No new dependency without a line in an ADR or in `docs/00-research.md` saying why.
5. A pre-commit hook runs `lint-staged` over staged files. It is the fast half; `pnpm verify` is
   the real gate.

The non-negotiables in [`CLAUDE.md`](CLAUDE.md) §1 — determinism, no asset generated twice, cost
metered before it is spent, the dependency rule, Zod as the single source of truth, LLM JSON only
via `StructuredCall`, aired canon is immutable — are invariants. Breaking one is a bug even if the
tests pass.

## Licence

Not yet chosen.
