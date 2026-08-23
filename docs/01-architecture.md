# 01 — Architecture

**Project codename: `Rivayat` (`rv`)** — idea → art style → story → cast → assets → rig →
animation → multi-format video.

---

## خلاصهٔ فارسی (Persian summary)

سه ایدهٔ اصلی که کل معماری روی آن‌ها بنا شده:

1. **Style اول از همه.** قبل از هر تصویری، یک «کتاب سبک» (StyleBible) ساخته و _قفل_ می‌شود؛
   این کتاب هم ظاهر (رنگ، خط، سایه، بافت) و هم **نحوهٔ حرکت** (easing، اغراق، fps، سبک لوپ،
   قواعد دوربین) را تعریف می‌کند. هر تغییری در آن یک نسخهٔ جدید با checksum جدید می‌سازد.
2. **انیمیشن procedural است، نه frame-by-frame.** هوش مصنوعی فقط _قطعات_ (parts) را یک بار
   می‌سازد؛ حرکت از روی rig و منحنی‌ها محاسبه می‌شود. sprite sheet خروجی _پخت_ (bake) همان
   rig است. نتیجه: هزینه به تعداد asset یکتا وابسته است، نه به تعداد فریم یا ثانیه.
3. **هیچ asset ای دو بار ساخته نمی‌شود.** کلید محتوا-محور (content-addressed) از
   `semanticKey + styleChecksum + variantKey` ساخته می‌شود. تولید دوباره فقط با درخواست صریح
   («یک نسخهٔ دیگر می‌خواهم») اتفاق می‌افتد و آن هم به‌صورت `AssetVersion` جدید ذخیره می‌شود،
   نه جایگزینی.

---

## 1. Layering (Clean / Hexagonal)

```
            ┌──────────────────────────────────────────────┐
            │  apps/web (Vue 3)      apps/cli              │  Delivery
            └──────────────────────────────────────────────┘
                              │ HTTP / SSE
            ┌──────────────────────────────────────────────┐
            │  apps/api (NestJS): controllers, DTOs,        │  Delivery
            │  BullMQ workers, SSE gateway                  │
            └──────────────────────────────────────────────┘
                              │ depends on ↓ (interfaces only)
   ┌─────────────────────────────────────────────────────────────────┐
   │ story-engine · style-engine · asset-engine · anim-engine ·      │  Application
   │ render-engine · asset-registry            (use-cases)           │
   └─────────────────────────────────────────────────────────────────┘
                              │
   ┌─────────────────────────────────────────────────────────────────┐
   │ core-domain (entities, value objects, invariants — zero IO)     │  Domain
   │ contracts (Zod schemas — the single source of truth)            │
   └─────────────────────────────────────────────────────────────────┘
                              ↑ implemented by
   ┌─────────────────────────────────────────────────────────────────┐
   │ providers (Ollama/Gemini/OpenRouter/ComfyUI), persistence       │  Infrastructure
   │ (Drizzle), fs-cas, ffmpeg, playwright, sharp                    │
   └─────────────────────────────────────────────────────────────────┘
```

**Dependency rule:** arrows point inward only. Domain and application layers never `import`
an SDK. Every outward capability is a **port** (`interface`) declared in the application layer
and **adapted** in `packages/providers` or `apps/api/src/infrastructure`.

### How each SOLID letter is actually enforced

| Principle | Enforcement                                                                                                                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S**RP   | One package per bounded context; one class per use-case (`GenerateCharacterSheetUseCase.execute()`)                                                                                                                                            |
| **O**CP   | New provider / new art style / new motion behaviour / new export format = a new class registered in a registry map. No `switch` in core.                                                                                                       |
| **L**SP   | Every provider satisfies contract tests (`packages/providers/src/__contract__/*.spec.ts`) run against _all_ implementations                                                                                                                    |
| **I**SP   | Narrow ports: `TextGenerationPort`, `StructuredGenerationPort`, `ImageGenerationPort`, `ImageEditPort`, `VisionScoringPort`, `EmbeddingPort` are separate — an adapter implements only what it can do, and capability is declared, not assumed |
| **D**IP   | NestJS DI tokens for every port; `core-domain` has **zero** dependencies in its `package.json` (enforced by `dependency-cruiser` in CI)                                                                                                        |

---

## 2. Package map

```
packages/
  contracts/        @rv/contracts       Zod schemas + inferred types + JSON-Schema emitters
  shared-kernel/    @rv/shared-kernel   Result<T,E>, Id, Hash, Clock, Logger, Money — no deps
  core-domain/      @rv/core-domain     Entities, VOs, invariants, domain events. Pure.
  prompt-kit/       @rv/prompt-kit      Typed prompt templates, few-shot banks, StructuredCall + repair loop
  narrative-memory/ @rv/narrative-memory Bi-temporal narrative knowledge graph, world state, continuity, retrieval
  providers/        @rv/providers       LLM / Image / Vision / Embedding adapters, Router, CostMeter, Cache
  style-engine/     @rv/style-engine    StyleBible presets, derivation from refs, wizard, probe sheets
  story-engine/     @rv/story-engine    Brief → StoryBible → Cast → World → Shot list
  asset-registry/   @rv/asset-registry  CAS store, dedup keys, versions, variants, semantic search
  asset-engine/     @rv/asset-engine    AssetSpec → generate → matte → parts → rig → clips → register
  anim-engine/      @rv/anim-engine     Animation IR, evaluator, behaviours, motion presets, sheet baker
  render-engine/    @rv/render-engine   IR → frames → ffmpeg → delivery formats + reframing
  export-kit/       @rv/export-kit      Lottie / sprite-atlas / DragonBones / PSD exporters
  persistence/      @rv/persistence     Drizzle schema + repository implementations (SQLite now, Postgres later)
apps/
  api/              NestJS 11 — REST + SSE + BullMQ workers
  web/              Vue 3 studio (style lab, story board, asset library, rig editor, timeline, player)
  cli/              headless driver for CI and batch runs
```

Full tree with file-level detail lives in [`04-folder-structure.md`](./04-folder-structure.md).

---

## 3. The four core models

### 3.1 `StyleBible` — art direction, including motion

Locked before any pixel is generated. Its `checksum` participates in every asset dedup key,
so changing the style automatically forks the asset library instead of silently mismatching.

```ts
StyleBible {
  id, name, version, checksum
  origin: 'preset' | 'derived' | 'wizard'
  visual: {
    medium: 'flat-vector' | 'painterly' | 'paper-cutout' | 'pixel' | 'ink-comic'
          | 'watercolor' | 'claymation' | 'gouache' | 'woodblock' | custom
    palette: { primary[], secondary[], neutral[], accent[], harmonyRule, contrastFloor }
    line:    { weight, variability, colorMode: 'black'|'tinted'|'none', taper }
    shading: { model: 'cel'|'soft'|'flat'|'crosshatch', steps, lightDir, ambientTint }
    texture: { grain, paperFiber, halftone, edgeRoughness }
    shapeLanguage: { roundness, exaggeration, proportionRatio, silhouetteRule }
    detailDensity, backgroundTreatment
    negative: string[]          // what must never appear
  }
  motion: {                     // ← "نحوهٔ animate" is part of the style, not an afterthought
    fps, stepMode: 'smooth'|'on-2s'|'on-3s'
    easingSet: { in, out, inOut, bounce }        // named cubic-beziers
    principles: { squashStretch, anticipation, followThrough, overshoot, secondaryMotion, holdBias }
    boil: { enabled, amplitude, hz }             // hand-drawn line jitter
    ambient: { windHz, windAmp, breathHz, blinkEveryMs, idleAmp }
    camera: { panEase, parallaxCurve, shakeAmp, cutRhythm }
  }
  render: { colorGrade, vignette, filmGrain, bloom }
  promptFragments: {
    positive, negative,
    bySubject: { character, prop, foliage, architecture, sky, fx, ground }
  }
  anchors: AssetRef[]           // reference images that *are* the style
  seed: number
}
```

**Three ways to obtain one** (all converge on the same schema):

- **Preset** — a curated library, then tweak.
- **Derived** — user uploads reference images → a free vision model analyses them → proposes a
  filled `StyleBible` → user edits.
- **Wizard** — guided questions/sliders → LLM composes the bible.

Then always: **probe sheet** (a character, a tree, a prop, a sky rendered in the candidate style)
→ user approves → **style locked**, checksum frozen.

### 3.2 `Asset` — identity, versions, variants, clips

```
Asset                      semanticKey: "flora/oak-tree/mature"
 ├─ AssetVersion v1        styleChecksum, seed, provider, prompt, cost   ← "a different take"
 │   ├─ Parts[]            transparent RGBA layers, named + z-ordered
 │   │                     (trunk, branch_L, branch_R, canopy_1..n)
 │   ├─ Rig                bones, joints, IK chains, mesh grids, anchors, physics hints
 │   ├─ Variants[]         colorway / season / damaged / night-lit / age  (cheap edits, not regens)
 │   └─ Clips[]            idle, sway, wind-gust, fall  →  procedural + optional baked sheet
 └─ AssetVersion v2        only created on an explicit "give me another model" request
```

**Dedup key** = `sha256(semanticKey ‖ styleChecksum ‖ variantKey ‖ specHash)`.
A generation request that hashes to an existing key **returns the cached asset and spends $0**.
Regeneration requires an explicit `RegenerateIntent { reason: 'new-take' | 'style-changed' |
'quality-reject', keepPrevious: true }` — previous versions are never destroyed.

### 3.3 `AnimationIR` (`.rvanim.json`) — the animation source of truth

Deterministic, seek-safe, diffable, LLM-generatable, editable.

```ts
AnimationIR {
  meta: { fps, duration, sceneSpace: {w,h}, styleBibleRef }
  nodes: Node[]            // tree: Group | AssetInstance | Part | Bone | Camera | FxEmitter | TextLayer
  tracks: Track[]          // (nodeId, property, keyframes[], easing, interpolation)
  behaviours: Behaviour[]  // declarative, parameterised, seeded:
                           //   wind, breathe, blink, sway, walkCycle, flap, orbit,
                           //   parallax(depth), boil, lipSync(phonemes), particles
  markers: Marker[]        // beats, dialogue cues, cut points
  camera: CameraTrack      // pos/zoom/rotation + focusTarget for auto-reframing
}
```

Rules that make it renderable head-lessly and correctly:

- **Pure function of `t`.** `evaluate(ir, t) -> SceneSnapshot`. No accumulating state, no
  `Date.now()`, no `Math.random()` — behaviours take an explicit `seed`.
- Therefore: scrubbing, resuming a render, distributed frame rendering and golden-file tests
  all work for free.

Everything else is a **projection** of the IR:
`IR → PixiJS live playback` · `IR → PNG frames → ffmpeg` · `IR → baked sprite sheet + atlas JSON`
· `IR → Lottie` · `IR → DragonBones`.

### 3.4 `Shot` — the sequence unit

```ts
Shot {
  id, index, durationMs, beatRef
  camera: { framing: 'wide'|'medium'|'close'|'extreme-close', move, focusTarget }
  layout: Layer[]          // z-ordered AssetInstances with transform + depth (for parallax)
  blocking: Action[]       // (assetInstanceId, clipName, startMs, durationMs, loop)
  dialogue?: Line[]        // speaker, text, phonemes → lipSync behaviour
  audio: { sfx[], musicCue }
  safeArea, focusTarget    // → drives per-format reframing
}
```

---

## 4. The pipeline

Every stage is **idempotent, cached, resumable, cancellable, and streams progress over SSE**.
Stages are BullMQ jobs; the state machine lives in `core-domain`, not in the queue library.

| #   | Stage           | In → Out                                                                                                                                                                                       | Model tier     |
| --- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| S0  | **Intake**      | free-text idea/brief → `Brief`                                                                                                                                                                 | cheap          |
| S1  | **Style**       | `Brief` (+refs) → `StyleBible` → probe sheet → **locked**                                                                                                                                      | vision + image |
| S2  | **Story**       | `Brief`+`StyleBible` → `StoryBible` (logline, theme, acts, beats, arcs)                                                                                                                        | **strong**     |
| S3  | **Cast**        | `StoryBible` → `CharacterSheet[]` — bio, psychology, visual descriptor, wardrobe, **expression set, pose set, part-decomposition plan, motion signature, and the generation prompts for each** | strong         |
| S4  | **World**       | → locations, props, flora, fauna, sky/weather → `AssetSpec[]`                                                                                                                                  | cheap          |
| S5  | **Resolve**     | `AssetSpec[]` → registry lookup → hit/miss plan + **cost estimate shown to user before spending**                                                                                              | none           |
| S6  | **Produce**     | misses only → image gen → matte → part split → auto-rig → clips → register                                                                                                                     | image          |
| S7  | **Sequence**    | `StoryBible` → `Shot[]` (camera, duration, layout, blocking, dialogue)                                                                                                                         | strong         |
| S8  | **Choreograph** | `Shot[]` + assets + `StyleBible.motion` → `AnimationIR`                                                                                                                                        | cheap + rules  |
| S9  | **Preview**     | IR → in-browser PixiJS player, scrub + edit → IR′                                                                                                                                              | none           |
| S10 | **Render**      | IR → frames → ffmpeg → master (ProRes/H.264)                                                                                                                                                   | none           |
| S11 | **Deliver**     | master + `focusTarget` → per-format reframe, captions, loudness norm                                                                                                                           | none           |

S9 is a first-class stage, not a debug view: **every artefact of every earlier stage is
editable in the UI, and editing re-runs only the downstream stages that depend on it.**

---

## 5. Provider layer

### Ports (ISP — an adapter implements only what it supports)

```ts
interface TextGenerationPort      { generate(req): Promise<Result<TextOut>> }
interface StructuredGenerationPort{ generate<T>(req, schema: ZodType<T>): Promise<Result<T>> }
interface ImageGenerationPort     { generate(req): Promise<Result<ImageOut>> }
interface ImageEditPort           { edit(req: { base, mask?, refs[], instruction }): Promise<Result<ImageOut>> }
interface VisionScoringPort       { score(req: { image, rubric }): Promise<Result<Scores>> }
interface EmbeddingPort           { embed(texts): Promise<Result<number[][]>> }
```

### Adapters

| Adapter               | Ports                                      | Notes                                                                                  |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `OllamaAdapter`       | Text, Structured, Embedding, Vision*       | native `/api/chat` + `format` JSON Schema; **never** the OpenAI shim (see research §1) |
| `GeminiAdapter`       | Text, Structured, Image, ImageEdit, Vision | `@google/genai` 2.18; free text tier; image is paid                                    |
| `OpenRouterAdapter`   | Text, Structured, Image, ImageEdit, Vision | one key, many models; live `/models` catalogue sync                                    |
| `ComfyUiAdapter`      | Image, ImageEdit                           | local, free; SDXL-Turbo/LCM workflows in `tools/comfy-workflows/`                      |
| `PollinationsAdapter` | Image                                      | keyless fallback, lowest quality tier                                                  |

### `ModelRouter` — the cost/quality brain

```
route(task: TaskKind, tier: 'draft'|'preview'|'final', policy: 'cheapest'|'balanced'|'best')
  → ProviderBinding
```

- Per-stage overrides: the user can pin _any_ stage to _any_ model (this is the "story model is
  selectable" requirement — it applies to every LLM stage, not just story).
- Declared **capability matrix** so the router never asks an adapter for something it cannot do.
- **Failover chain** with typed errors (rate-limit → backoff → next provider).
- **`CostMeter`**: every call logs `{provider, model, inTokens, outTokens, images, usd}` into a
  per-project ledger. Hard **budget guard** aborts a run before it overspends.
- **`ResponseCache`** keyed by `sha256(model ‖ params ‖ prompt ‖ refHashes)` — never pay twice for
  a byte-identical request.

### Quality gate

Every generated image passes `VisionScoringPort` against a rubric derived from the StyleBible:
style match, alpha cleanliness, silhouette readability, character-identity match vs anchors,
part completeness. Below threshold → automated prompt repair and retry (bounded), then surface
to the user rather than silently accepting.

---

## 6. Rigging & animation

### Auto-rig

1. Classify the asset archetype (`biped`, `quadruped`, `bird`, `tree`, `cloud`, `water`, `prop`,
   `crowd`, `fx`) — from the `AssetSpec`, not guessed from pixels.
2. Load the matching **rig template** (bone graph + default clip set + behaviour bindings).
3. Fit the template to the actual parts: anchor detection (alpha centroid + declared join hints
   from the parts-sheet prompt), mesh grid generation for deformable parts.
4. Produce clips from the archetype's **motion preset library**, parameterised by
   `StyleBible.motion` — so a `bird/flap` in a paper-cutout style genuinely differs from the same
   clip in a painterly style.

### Sprite-sheet baking

`bakeSheet(assetVersion, clipName, {fps, frames, maxSize, padding, trim})` →
render the clip head-lessly → trim + `maxrects-packer` atlas → `atlas.png` + `atlas.json`
(+ optional `.webp`/`.avif`). Sheets are **derived artefacts** cached in the CAS and rebuildable
at any time — they are never the source of truth.

### Editability

Every level is editable in the UI and every edit is a diff against the IR:
parts (redraw / re-generate / swap) → rig (drag bones, weights) → clips (keyframe curves) →
behaviours (parameters) → shot blocking → camera → per-format reframing.

---

## 7. Rendering & delivery

```
AnimationIR ──► SceneSnapshot(t) ──► Backend ──► frames ──► FFmpeg ──► master.mov
                                      ├── PixiJS in Playwright (effects, shaders, 3D-ish)
                                      └── @napi-rs/canvas offscreen (pure 2D, no browser)
                                                                          │
                                     master + focusTarget/safeArea ───────┴──► FormatProfile[]
                                        yt-16x9 · shorts-9x16 · reels-9x16 · ig-4x5 · ig-1x1 · tiktok
```

- **Deterministic frame loop**: `for f in 0..N: evaluate(ir, f/fps) → draw → capture`. No
  real-time playback during render, so output is bit-reproducible and renders are resumable and
  shardable.
- **Reframing is computed, not re-authored**: each shot declares `focusTarget` + `safeArea`;
  the reframer solves a crop/pan per format honouring the verified safe zones (§7 of research).
- Audio: TTS/voice ports and music/SFX are separate ports on the same provider architecture,
  mixed by ffmpeg with EBU R128 loudness normalisation per platform.

---

## 7b. Settings: everything the user can change, declared once

Requirement: **every option is configurable from the UI.** The failure mode that
requirement invites is a hand-built settings form that drifts from the options the code
actually reads - a checkbox that no longer does anything, an option that exists in code
with no way to reach it. So settings are **declared, not hand-wired**, and the UI is
generated from the declaration.

### The registry

Each setting is declared once, in `@rv/contracts`, carrying everything its three
consumers need:

```ts
SettingDescriptor {
  key            // 'image.lane', 'provider.story.model', 'budget.perRunUsd'
  schema         // the Zod schema that validates it - the same one the API uses
  group          // which panel it appears in
  label          // LocalisedText - fa and en, because the UI is Persian-first
  help           // LocalisedText - why you would change it
  default        // the value when nothing overrides it
  scope          // 'machine' | 'global' | 'project' | 'run'
  secret         // never returned to the client, never logged, never exported
  requiresRestart
  dependsOn      // shown only when another setting has a given value
  options?       // for an enum: the choices, each with its own localised label
}
```

The UI renders a control per descriptor from `schema` and `options`; the API validates
with the same `schema`; the resolver reads the same `key`. A setting that exists is
reachable, and a setting that is removed disappears from all three at once.

### Layered resolution

```
built-in default  ->  machine (.env)  ->  global (DB)  ->  project  ->  run override
```

Later layers win. The UI shows **which layer a value came from**, because "why is this
model being used" is otherwise unanswerable once four layers exist. Secrets live only in
the machine layer; the UI can report that a key is _present_, never what it is.

### What this covers

Per-stage model selection (the owner's explicit requirement - Ollama, Gemini or
OpenRouter, chosen independently for each pipeline stage), quality tier and routing
policy, the image lane (local ComfyUI / Colab / cloud API) with its host and token,
budget ceilings and the confirm-above threshold, style presets and defaults, delivery
formats and which ones a project ships, render backend and concurrency, and UI locale
and direction.

**Colab is one value of `image.lane`, never a requirement.** The system runs complete on
the local lane alone, or on the cloud API lane alone.

---

## 8. Persistence

- **Metadata**: SQLite + Drizzle (local-first, zero-ops). All access via
  `interface XRepository` in the application layer → Postgres is a drop-in swap.
- **Binaries**: content-addressed store at `workspace/assets/<sha[0:2]>/<sha>/…` — immutable,
  deduplicated across _all_ projects. A project references assets, never owns them.
- **Semantic index**: Ollama embeddings over `semanticKey + description + tags` so
  "a gnarled old tree" finds `flora/oak-tree/mature` before deciding to generate anything.
- **Provenance**: every artefact records `{ prompt, model, seed, params, parentIds, cost, ts }` —
  full reproducibility and a cost audit trail.

---

## 9. Testing strategy

| Level        | Tool                 | Rule                                                                                                         |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Unit         | Vitest               | `core-domain` + `anim-engine` evaluator at **100 % branch coverage** — they are pure, so there is no excuse  |
| Contract     | Vitest               | One shared suite executed against **every** provider adapter (LSP guard); network calls recorded as fixtures |
| Golden       | Vitest + `sharp`     | `AnimationIR → frame hash` fixtures — catches any regression in the evaluator or renderer                    |
| Integration  | Vitest               | Full pipeline stages against **fake providers** — no network, no cost, runs in CI                            |
| API e2e      | Supertest            | NestJS app + in-memory queue                                                                                 |
| Web e2e      | Playwright           | Studio flows + visual regression on the player canvas                                                        |
| Architecture | `dependency-cruiser` | Fails CI if the dependency rule (§1) is violated                                                             |

Global thresholds: 90 % lines / 85 % branches; `core-domain`, `contracts`, `anim-engine`: 100 %.

---

## 10. Decisions recorded as ADRs

See [`adr/`](./adr/): each of the rejections above (Remotion, Rive-as-source, Spine, frame-by-frame
AI animation, OpenAI-compat endpoint for Ollama) is written up with context and consequences.
