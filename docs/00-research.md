# 00 — Research & Tool Selection

> Verified on 2026-08-23 against live APIs and vendor docs. Numbers marked **[live]** were
> pulled programmatically from the vendor API, not from a blog post.

## 0. Target machine (verified locally)

| Item   | Value                                                    |
| ------ | -------------------------------------------------------- |
| CPU    | Intel i7-10850H @ 2.70GHz                                |
| RAM    | 32 GB                                                    |
| GPU    | NVIDIA Quadro RTX 3000, **6 GB VRAM** (+ Intel UHD iGPU) |
| Node   | v24.19.0 / npm 11.17.0                                   |
| Python | 3.13.2                                                   |
| FFmpeg | 8.1.2-full (gyan build) — already on PATH                |
| Ollama | 0.32.15                                                  |

**Local Ollama models present [live]:** `qwen3.5:latest` (6.6 GB), `gemma4:26b` (17 GB),
`qwen2.5:7b`, `qwen3:1.7b`, `aya-expanse:8b`, `llama3.2:latest`.

**Implication:** 6 GB VRAM is enough for SDXL-Turbo / SD1.5 / SDXL-with-offload at 512–1024px
(draft quality, seconds per image). It is _not_ enough for comfortable FLUX-dev work.
So: **local = free draft lane, cloud = paid final lane.**

---

## 1. Text / story LLM

| Provider              | Verdict                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ollama (local)**    | Free, private, offline. Default for iteration. `qwen3.5` already installed.                                                                                                                                                    |
| **Google Gemini API** | Gemini 2.5 Flash and Gemini 3 Flash text are "Free of charge" on the free tier. Best free cloud option.                                                                                                                        |
| **OpenRouter**        | **18 models carry the `:free` suffix [live]**, incl. `z-ai/glm-5.2:free` (256k ctx), `nvidia/nemotron-3-ultra-550b-a55b:free` (1M ctx), `google/gemma-4-31b-it:free` (vision), `nvidia/nemotron-nano-12b-v2-vl:free` (vision). |

The story model is therefore **user-selectable per pipeline stage**, not global: cheap local model
for bulk extraction, strong cloud model for the creative beats.

### Known defect — structured output on Ollama

Ollama issue [#15540](https://github.com/ollama/ollama/issues/15540) (closed as dup of #14645):
the **OpenAI-compatible endpoint does not enforce JSON Schema** for `qwen 3.5` and `gemma 4`
(returns markdown-fenced JSON or schema-violating deltas). `gemma3` / `gpt-oss` behave.

**Mitigations we must build (non-negotiable):**

1. Use Ollama's **native `/api/chat` with `format: <jsonSchema>`** — never the OpenAI shim.
2. `temperature: 0`, `think: false` for extraction calls.
3. A **`StructuredCall` wrapper**: strip fences → `JSON.parse` → Zod validate → on failure feed
   the Zod error back for a bounded repair turn → then escalate to a stronger model. This wrapper
   is provider-agnostic and is the _only_ sanctioned way any part of the app asks an LLM for JSON.

### Verified defect — `z.toJSONSchema` silently drops every refinement

**Verified locally against zod 4.4.3 on 2026-08-23.** `z.toJSONSchema()` emits a schema for a
refined object that is **byte-identical** to the schema it emits for the same object with the
refinement deleted — no `allOf`, no `not`, no annotation, no warning. It is not a lossy
translation; it is a silent one.

```text
z.object({ a: z.number(), b: z.number() })
z.object({ a: z.number(), b: z.number() }).refine(v => v.b > v.a)
→ both emit {"type":"object","properties":{"a":{...},"b":{...}},"required":["a","b"]}
```

This is unavoidable rather than a bug to route around: a `.refine` is an arbitrary predicate and
JSON Schema has no way to express one. But the consequence is not obvious from the call site, and
it is load-bearing:

- **Every cross-field invariant in `@rv/contracts` is invisible to the model.** The bi-temporal
  ordering on `Relation` (`validUntil >= validFrom`, `retractedAt >= assertedAt`), the structural
  integrity of `AnimationIR` and `Rig`, the arithmetic on `CostEstimate`, and roughly thirty
  others. The model is constrained by the **shape** and by the field **descriptions**, and by
  nothing else.
- **Descriptions are therefore the only channel that reaches the model.** They survive emission
  in all four dialects, which is why the field descriptions in `@rv/contracts` are written as
  instructions rather than as labels. Writing an invariant only in a TSDoc block above the schema
  — where `describe()` never sees it — puts it where neither the model nor the validator can read
  it.
- **Every refinement therefore needs a runtime check downstream, and it has exactly one:**
  `StructuredCall`'s validate step calls `schema.safeParse` on the parsed JSON, which does run
  the refinements, and feeds the resulting issue paths back on the repair turn. That single call
  is what makes mitigation 3 above a non-negotiable rather than a convenience — bypass the
  wrapper and the invariants are enforced nowhere at all.
- **Prose alone is not a contract.** An invariant stated in a description but not backed by a
  `.refine`/`.superRefine` is enforced by nobody: not the emitted schema, not the parser.
  `packages/contracts/src/seams.spec.ts` keeps an inventory of every refinement in the package
  with the invariant it enforces, and fails when one is added without an entry.

**Verify:** `cd packages/contracts && npx vitest run src/seams.spec.ts`

---

## 2. Image generation — the real cost picture

### Correcting a common assumption

There is **no genuinely free image-generation API** left that is reliable for production:

- Google docs: image models are **not on the Gemini free tier** (only _text_ Flash models are).
  The "500 free images/day" figure circulating in blogs refers to the AI Studio **UI**, not the API.
- OpenRouter: **zero models with `:free` produce image output [live]** — all 18 free models are
  text/vision only.

### Cheapest credible options

[live pricing from OpenRouter `/api/v1/models` + Google pricing page]

| Model                                | $ / 1M image-output tokens | approx $ / 1024px image     |
| ------------------------------------ | -------------------------- | --------------------------- |
| `google/gemini-3.1-flash-lite-image` | $30                        | **$0.0336**                 |
| `google/gemini-2.5-flash-image`      | $30                        | $0.039                      |
| `openai/gpt-5-image-mini`            | $8                         | ~$0.002 (low) – $0.01 (med) |
| `google/gemini-3.1-flash-image`      | $60                        | $0.045 (0.5K) – $0.151 (4K) |
| `google/gemini-3-pro-image`          | $120                       | $0.134 (1–2K) / $0.24 (4K)  |

> `Imagen 4` is **deprecated, shutdown 2026-08-17** — do not build on it.

### Why this is still cheap: the architecture removes per-frame cost

Cost scales with **unique assets**, not with frames or seconds, because animation is procedural
(rig-driven) rather than frame-generated, and every asset is content-addressed and reused.

A 60-second short is roughly 40–120 unique assets, i.e. **$1.5 – $5 total**, once, reusable forever.
Re-rendering, re-timing, re-framing to another aspect ratio, and new episodes in the same style
cost **$0**.

### Free draft lane - measured, not estimated

`ComfyUI` 0.33 + SD 1.5 (`dreamshaper_8`) + `lcm-lora-sdv1-5` on the Quadro RTX 3000.
Benchmarked 3 runs per cell with a fixed seed and the node cache evicted between runs:

| Resolution | Steps | s / image  | Peak VRAM                        |
| ---------- | ----- | ---------- | -------------------------------- |
| 512x512    | 4     | **1.42 s** | 3698 MiB                         |
| 512x512    | 8     | 2.25 s     | 3666 MiB                         |
| 768x768    | 4     | 3.25 s     | 4818 MiB                         |
| 768x768    | 8     | 5.30 s     | 4818 MiB                         |
| 1024x1024  | 4     | 7.59 s     | 5839 MiB (95% of the card)       |
| 1280x1280  | 4     | 16.2 s     | 5871 MiB - DynamicVRAM thrashing |

**Determinism holds bit-exactly** across process restarts: the same graph returned an
identical PNG hash over four separate ComfyUI lifetimes. The launch flags are part of the
determinism key.

Three findings that contradict the usual advice, each measured:

- **Port 8188 is unusable on this machine.** It falls inside a Windows reserved TCP exclusion
  range (8163-8262, held by WinNAT/Hyper-V) and binding fails with `PermissionError`. Default
  is **8288**.
- **`--lowvram` is a no-op** under ComfyUI 0.33's DynamicVRAM, and
  **`--use-split-cross-attention` is 30-56% slower** and uses more VRAM than the default
  PyTorch SDPA on torch 2.13. Both were benchmarked and rejected.
- **ComfyUI caches node outputs.** Re-POSTing an identical graph returns the previous image in
  ~10 ms, which produces a fictitious benchmark and a determinism check that tests nothing.
  Any harness must queue a seed-shifted decoy between timed runs.

`ModelSamplingDiscrete(sampling: "lcm")` is load-bearing: removed, the same graph at 4 steps
produces pure RGB noise.

Promote to a paid model only when an asset is locked.

### Free draft lane, second location — Google Colab (verified 2026-08-23)

The 6 GB card is the binding constraint, not the GPU generation. A Colab **T4 gives ~15 GB of the
same Turing architecture**, which changes _which models exist_ rather than how fast they run.
Notebook and full write-up: `tools/colab/`.

**Tier facts.** T4, 16 GB GDDR6 (~15 GB usable), ~12.7 GB system RAM, ephemeral disk. Sessions cap
at **12 h**, idle timeout commonly ~90 min, weekly GPU hours roughly 15–30. Google **does not
publish** these limits and states they fluctuate; a GPU is **not guaranteed** at all. Vendor
figures: T4 = 8.1 FP32 / 65 FP16 TFLOPS, 320 GB/s, 70 W, versus the local Quadro RTX 3000's 5.3
FP32 TFLOPS and 336 GB/s — **~1.5× the arithmetic, slightly less bandwidth**. Both are compute
capability **7.5: no bf16, no fp8, on either card.**

**ToS position — this is against the rules on the free tier.** Colab's FAQ lists, as disallowed
_from free-tier runtimes without a positive compute balance_: **"bypassing the notebook UI to
interact primarily via a web UI"** and _"remote control such as SSH shells, remote desktops"_.
Driving ComfyUI's API over a tunnel is exactly that — the same clause Google used in 2023 to block
`stable-diffusion-webui` on free Colab (ComfyUI issue #1460 recorded the same outcome), and which
Colab's product lead said explicitly did **not** apply to paid users. Two clauses bind **all**
runtimes including paid: _"web service offerings not related to interactive compute"_ and
_"connecting to remote proxies"_ — so this is a session-scoped scratch lane, never always-on
infrastructure. **Recommendation: Colab Pro / pay-as-you-go** (a positive compute balance lifts the
free-tier-only list, and L4/A100 additionally give bf16 + fp8), or **Kaggle** (free, 30 GPU-h/week,
T4×2, no equivalent web-UI clause), or a rented GPU. Do not run it on a free account.

**Tunnelling: cloudflared quick tunnel.** No account, HTTPS, supports the WebSockets ComfyUI's
`/ws` channel needs. `localtunnel` needs no account but interposes an IP-entry interstitial that a
machine client cannot pass; `ngrok` needs a signup and injects a browser warning on the free plan.
Cloudflare documents quick tunnels as testing-only, capped at 200 concurrent requests.

**ComfyUI has no authentication**, so the tunnel points at a **token-gated reverse proxy**, never at
ComfyUI. Contract for the adapter: `COMFYUI_HOST` = the tunnel origin, `Authorization: Bearer
$COMFYUI_AUTH_TOKEN` on every request, `RV_COMFYUI_REMOTE=true`. The gate was built and
**verified against live ComfyUI 0.33.0 — 18 assertions**, including a full `POST /prompt` →
`/history` → `/view` PNG round trip and a byte-identical 1.6 MB `/object_info`.

**Model-set recommendation.**

- **SDXL + LCM-LoRA-SDXL (7.3 GB) as the default.** It needs **no new workflow files** — the
  existing SD 1.5 graphs have no version-specific node input, so only `{{checkpoint}}`,
  `{{lora}}` and the resolution change.
- **FLUX.1-schnell as GGUF Q4_K_S (10.8 GB) as the experiment**, _not_ fp8: **fp8 needs compute
  capability 8.9** and a T4 is 7.5. GGUF dequantises to fp16, which Turing does natively.
- **On §3's finding that SD 1.5 cannot decompose characters into parts:** that is a
  prompt-adherence failure, so the fix — if there is one — is a better _text encoder_, not a bigger
  UNet. SD 1.5 has CLIP-L (77 tokens, bag-of-words); **SDXL adds OpenCLIP-bigG but is still CLIP at
  77 tokens, so SDXL is not expected to fix it**; FLUX conditions on **T5-XXL at 512 tokens**, which
  can carry multi-clause layout instructions. Against it: the "reference sheet = turnaround" prior
  is universal, and a 4-step distilled model resists argument. `txt2img-flux-schnell-parts-sheet.json`
  exists to settle it. **Unrun — no result yet.**

Everything above is verified. **Nothing has been executed on Colab**: no notebook cell, no T4
timing, no FLUX output. All T4 s/image figures in `tools/colab/README.md` are labelled estimates.

### Editing

Gemini image models are **`text+image -> text+image` [live]** — they natively support image
_editing_ and multi-reference conditioning. That is what buys us character consistency without
training a LoRA.

---

## 3. Character & asset consistency (2026 state of the art)

| Technique                                                        | Use here                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Multi-reference image conditioning (Gemini "nano-banana" family) | Primary: pass style anchors + character turnaround as refs on every call |
| FLUX/SDXL + character LoRA                                       | Optional local path; heavy for 6 GB                                      |
| ControlNet OpenPose over a turnaround template                   | Structural consistency for pose sheets                                   |
| Fixed seed + locked prompt fragments                             | Determinism / reproducibility                                            |

**Layer decomposition (critical for riggability):**

- `LayerDiffuse` / latent transparency — native RGBA generation.
- **`See-through`** (SIGGRAPH 2026, shitagaki-lab) — decomposes one anime illustration into ~23
  inpainted, depth-ordered body-part layers (PSD), designed for Live2D-style rigging.
- `SAM`-family + `RMBG-2.0` / `BiRefNet` (the 2026-07 "Lucida" fine-tune specifically targets
  _illustrations_, glow/VFX and transparent objects) for cutout and part masks.

**Our approach:** ask the image model for parts _by design_ — prompt for a "parts sheet" with each
part isolated on a neutral field — rather than fighting to decompose a finished render.
Fallback chain: parts-sheet → SAM/BiRefNet decomposition → single-layer asset (still animatable
via mesh deform).

---

## 4. Cutout / matting libraries

| Lib                              | Version [live] | Notes                                                 |
| -------------------------------- | -------------- | ----------------------------------------------------- |
| `@imgly/background-removal-node` | 1.4.5          | Node, WASM+ONNX, zero cost, ships its models          |
| `@huggingface/transformers`      | 4.2.0          | RMBG-1.4 / BiRefNet, WebGPU in browser, ONNX in node  |
| `sharp`                          | 0.35.3         | Trim, alpha ops, atlas composition, format conversion |

**Chosen:** `@huggingface/transformers` + BiRefNet as primary (illustration-tuned),
`@imgly/background-removal-node` as fallback, `sharp` for all pixel plumbing.

---

## 5. Animation runtime & engine

| Option                                                                | Verdict                                                                                                                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spine**                                                             | Best in class, **proprietary and paid** → rejected                                                                                                                           |
| **DragonBones**                                                       | Open source (Tencent), editor effectively unmaintained, format still useful as an _export target_                                                                            |
| **Rive** (`@rive-app/canvas` 2.40.1)                                  | Great runtime and state machines, but authoring is a closed cloud editor — we cannot _generate_ `.riv` programmatically → rejected as source of truth, kept as export target |
| **Lottie** (`lottie-web` 5.13.0, `@lottiefiles/dotlottie-web` 0.79.2) | Open JSON format, programmatically generatable, universally playable → **kept as export target**                                                                             |
| **PixiJS v8** (8.20.0)                                                | WebGL2/WebGPU, fastest, much better TS types since the v8 rewrite, mesh deform + filters + particles → **chosen renderer**                                                   |
| `konva` 10.3.1 / `fabric` 7.4.0                                       | Better for a _design editor_ UI than a playback engine; `konva` used for the **rigging/editor overlay** layer only                                                           |
| `gsap` 3.15.0                                                         | Free including plugins; used as the easing/interpolation reference, not as source of truth                                                                                   |

### Decision: we author our own Animation IR (`.rvanim.json`)

It must be **LLM-generatable**, **diffable**, **deterministic**, **seek-safe** and **editable in
our own UI**. No existing format is all five. PixiJS plays it; Lottie, sprite sheets and
DragonBones are _exports_.

---

## 6. Video rendering

| Option                                                                | Verdict                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Remotion**                                                          | React-based headless Chromium; **commercial licence fee** → rejected as a dependency                                      |
| **Motion Canvas / Revideo**                                           | Generator-based imperative API — hard for an LLM to emit, hard to edit visually → rejected                                |
| **Playwright (1.62.1) + deterministic seek + `sharp` + FFmpeg 8.1.2** | Full control, no licence, deterministic (we seek the timeline frame by frame instead of trusting wall-clock) → **chosen** |

Frame pipeline: `IR → PixiJS scene → seek(t) → readPixels → raw/PNG → ffmpeg (h264 / hevc / prores)`.

Headless Chrome costs roughly 8–15 s per 150 frames at 1080p on a CI-class box, so we also support
an offscreen **`@napi-rs/canvas` (1.0.7)** backend for pure-2D compositions — no browser at all.

---

## 7. Delivery formats (verified 2026 platform specs)

| Target            | Size                  | Ratio | Codec          | Bitrate           | Max length       |
| ----------------- | --------------------- | ----- | -------------- | ----------------- | ---------------- |
| YouTube landscape | 1920×1080 / 3840×2160 | 16:9  | H.264          | 8–12 / 35–45 Mbps | —                |
| YouTube Shorts    | 1080×1920             | 9:16  | H.264          | 8–12 Mbps         | **3 min (2026)** |
| Instagram Reels   | 1080×1920             | 9:16  | **H.264 only** | 8–12 Mbps         | 90 s             |
| Instagram Feed    | 1080×1350             | 4:5   | H.264          | 8–12 Mbps         | 60 s             |
| Instagram Square  | 1080×1080             | 1:1   | H.264          | 8–12 Mbps         | 60 s             |
| TikTok            | 1080×1920             | 9:16  | H.264/H.265    | 8–12 Mbps         | 10 min           |

**Universal vertical safe zone: 900×1400 centred inside 1080×1920.** TikTok additionally: avoid
top 15 %, bottom 20 %, right 15 %.

**Implication for the engine:** compose once in a **format-agnostic scene space** with a declared
`focusTarget` and `safeArea` per shot, then re-frame per delivery format (subject-aware crop /
re-layout) — instead of maintaining three parallel projects.

---

## 8. Final stack

| Layer         | Choice                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| Monorepo      | pnpm workspaces + Turborepo                                                                                      |
| Language      | TypeScript 5.x strict, ESM                                                                                       |
| Backend       | NestJS 11.2.1 + BullMQ 6.2.0 (Redis) + SSE progress                                                              |
| Frontend      | Vue 3.5.41 + Vite + Pinia 4 + VueUse 14 + PixiJS 8 + Konva 10                                                    |
| Schemas       | Zod 4.4.3 as single source of truth (`@rv/contracts`) → DTOs + JSON Schema for LLMs + OpenAPI                    |
| Persistence   | SQLite (better-sqlite3) + Drizzle ORM 0.45, local-first; Postgres swappable behind the same repository interface |
| Asset store   | Content-addressed FS (`sha256`) + Drizzle index + Ollama embeddings for semantic lookup                          |
| Images        | `sharp` 0.35.3, `@huggingface/transformers` 4.2.0                                                                |
| Video         | Playwright 1.62.1, `@napi-rs/canvas` 1.0.7, FFmpeg 8.1.2                                                         |
| Sprite sheets | `maxrects-packer` 2.7.3 (MaxRects bin packing)                                                                   |
| Tests         | Vitest 4.1.11 (unit/integration), Supertest (API e2e), Playwright (web e2e + visual regression)                  |

## Sources

- https://github.com/ollama/ollama/issues/15540
- https://ollama.com/blog/structured-outputs
- https://ai.google.dev/gemini-api/docs/pricing
- https://openrouter.ai/api/v1/models (queried live 2026-08-23)
- https://openrouter.ai/collections/image-models
- https://github.com/shitagaki-lab/see-through
- https://arxiv.org/html/2402.17113v3 (LayerDiffuse / latent transparency)
- https://github.com/imgly/background-removal-js
- https://github.com/1038lab/ComfyUI-RMBG
- https://www.pkgpulse.com/guides/remotion-vs-motion-canvas-vs-revideo-programmatic-video-2026
- https://www.pkgpulse.com/guides/fabricjs-vs-konva-vs-pixijs-canvas-2d-graphics-2026
- https://www.pkgpulse.com/guides/lottie-vs-rive-vs-css-animations-web-animation-formats-2026
- https://sproutsocial.com/insights/social-media-video-specs-guide/

Colab lane (§2, verified 2026-08-23):

- https://research.google.com/colaboratory/faq.html (prohibited activities; free-tier-only list)
- https://github.com/comfyanonymous/ComfyUI/issues/1460 ("No more free Colab for ComfyUI", 2023-09)
- https://news.ycombinator.com/item?id=35653698 (Colab blocking stable-diffusion-webui)
- https://decrypt.co/197428/google-colab-stable-diffusion-web-ui-ban (Colab lead: free tier only)
- https://www.nvidia.com/en-us/data-center/tesla-t4/ (8.1 FP32 / 65 FP16 TFLOPS, 16 GB, 320+ GB/s, 70 W)
- https://videocardz.net/nvidia-quadro-rtx-3000-mobile (5.3 FP32 TFLOPS, 336 GB/s, 240 tensor cores)
- https://github.com/Comfy-Org/ComfyUI/wiki/Which-GPU-should-I-buy-for-ComfyUI (fp8 needs cc 8.9)
- https://github.com/city96/ComfyUI-GGUF (pinned 6ea2651e, last commit 2026-01-12)
- https://huggingface.co/city96/FLUX.1-schnell-gguf
- https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
- https://www.kaggle.com/general/108481 (Kaggle 30 GPU-h/week, T4x2 / P100)
