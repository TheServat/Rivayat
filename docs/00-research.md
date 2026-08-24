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

### Optional second free lane — Google Colab (verified 2026-08-23, corrected 2026-08-23)

**Colab is optional.** The pipeline runs complete on the local lane alone or the cloud API lane
alone; `docs/01-architecture.md` states it as an invariant and `.env.example` ships pointing at
`http://127.0.0.1:8288`. What Colab adds is VRAM headroom for models the 6 GB card cannot host, for
as long as a session lasts. Notebook and full write-up: `tools/colab/`.

The 6 GB card is the binding constraint, not the GPU generation. A Colab **T4 gives ~15 GB of the
same Turing architecture**, which changes _which models exist_ rather than how fast they run. A
paid plan can also allocate **L4** and **A100**, which are different architectures, not just bigger
ones — see the GPU table below.

**Tier facts.** T4, 16 GB GDDR6 (~15 GB usable), ~12.7 GB system RAM, ephemeral disk. Sessions cap
at **12 h**, idle timeout commonly ~90 min, weekly GPU hours roughly 15–30. Google **does not
publish** these limits and states they fluctuate; a GPU is **not guaranteed** on _any_ tier — paid
plans buy premium GPUs "subject to availability". Vendor figures: T4 = 8.1 FP32 / 65 FP16 TFLOPS,
320 GB/s, 70 W, versus the local Quadro RTX 3000's 5.3 FP32 TFLOPS and 336 GB/s — **~1.5× the
arithmetic, slightly less bandwidth**. Both are compute capability **7.5: no bf16, no fp8, on
either card.** L4 = 30.3 FP32 TFLOPS, 121 FP16/BF16 tensor TFLOPS dense, 24 GB, 300 GB/s.
A100 = 19.5 FP32, 312 FP16/BF16 tensor TFLOPS dense, 40 GB.

> **⚠️ CORRECTION to the previous finding.** An earlier revision of this section said flatly:
> _"ToS position — this is against the rules on the free tier … Do not run it on a free account."_
> The first half was right and the framing was wrong: it presented a **free-tier-only** prohibition
> as the headline position, and the surrounding docs read as though the whole lane were
> off-limits. **The project owner has Colab Pro**, which puts this squarely in the permitted
> column. The tier table below is the corrected position; nothing about the underlying quotations
> changed, only which list they were read off.

**ToS position, by tier.** Colab's FAQ keeps **two** lists of disallowed activities.

| runtime                                                | ComfyUI over a tunnel | the wording that decides it                                                                                                                                                                           |
| ------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **free tier**, no positive compute balance             | ❌ disallowed         | List two applies to _"managed Colab runtimes running free of charge, without a positive Colab compute unit balance"_ and includes **"bypassing the notebook UI to interact primarily via a web UI"**. |
| **Colab Pro / Pro+ / pay-as-you-go**, positive balance | ✅ **allowed**        | Same FAQ, closing that list: _"You can remove these types of restrictions by purchasing one of our paid plans and maintaining a positive compute unit balance."_                                      |
| **all tiers**                                          | ⚠️ bounded            | List one binds everyone: _"web service offerings not related to interactive compute"_, _"connecting to remote proxies"_. Session-scoped scratch lane, **never always-on infrastructure.**             |

The 2023 `stable-diffusion-webui` block (ComfyUI issue #1460) was the same scoping: Colab's product
lead described a free-tier resource measure that explicitly did **not** apply to paid users.
Corroboration from a second direction — in June 2026 Google shipped an **official Colab CLI** whose
commands include `colab ssh` and `colab console`, while the FAQ still lists _"remote control such as
SSH shells"_ on the free-tier-only list. Both are current, and they are only consistent under the
tier reading. **If you have no compute balance:** Kaggle (free, 30 GPU-h/week, T4×2, no equivalent
web-UI clause), a rented GPU, or stay local.

**Automation.** "Colab" is **two different products**, and only the Google Cloud one has a public
API. Four paths, one shipped:

| path                                       | scriptable                                                       | billing                           | shipped?                          |
| ------------------------------------------ | ---------------------------------------------------------------- | --------------------------------- | --------------------------------- |
| **Consumer Colab, notebook + cloudflared** | no — manual, 8 cells in a browser                                | Colab compute units               | ✅ **this is what we ship**       |
| **Consumer Colab, official `colab` CLI**   | yes, but **Linux/macOS only**; no public API, internal endpoints | same compute units                | ❌ evaluated, not adopted         |
| **Colab Enterprise, `gcloud colab`**       | **yes** — GA CLI + documented Google Cloud API                   | **GCP, per runtime** (VM + GPU h) | ❌ wrong product for a scratchpad |
| **Local ComfyUI**                          | yes                                                              | free                              | ✅ shipped, **and the default**   |

- **`gcloud colab` is real but drives a different product.** GA, four command groups —
  `runtimes`, `runtime-templates`, `executions`, `schedules` — over a documented Google Cloud API.
  Hardware lives in the template (`--machine-type` default `e2-standard-4`, `--accelerator-type` ∈
  `NVIDIA_TESLA_T4 | NVIDIA_TESLA_V100 | NVIDIA_L4 | NVIDIA_TESLA_A100 | NVIDIA_A100_80GB`,
  `--idle-shutdown-timeout` default `3h`). It makes _provisioning_ scriptable but not _ingress_ —
  you still need a way to reach ComfyUI's HTTP API — and it bills per runtime on GCP.
- **Consumer Colab gained an official CLI on 2026-06-05** — `google-colab-cli`
  (`colab new --gpu L4`, `colab exec`, `colab ssh --proxy-mode`, `colab stop`). This **contradicts
  the assumption that consumer Colab has no CLI**. It is Linux/macOS-only (the dev machine is
  Windows) and drives undocumented `colab.research.google.com/tun/m/*` endpoints, so it is not a
  contract to build on — but `colab ssh -L` would remove the public tunnel entirely and is the
  first thing to evaluate if this lane ever stops being a scratchpad.

**Tunnelling: cloudflared quick tunnel.** No account, HTTPS, supports the WebSockets ComfyUI's
`/ws` channel needs. `localtunnel` needs no account but interposes an IP-entry interstitial that a
machine client cannot pass; `ngrok` needs a signup and injects a browser warning on the free plan.
Cloudflare documents quick tunnels as testing-only, capped at 200 concurrent requests.

**ComfyUI has no authentication**, so the tunnel points at a **token-gated reverse proxy**, never at
ComfyUI. **This is independent of tier** — paying Google does not make a public URL private.
Contract for the adapter: `COMFYUI_HOST` = the tunnel origin, `Authorization: Bearer
$COMFYUI_AUTH_TOKEN` on every request, `RV_COMFYUI_REMOTE=true`. The gate was built and
**verified against live ComfyUI 0.33.0 — 18 assertions**, including a full `POST /prompt` →
`/history` → `/view` PNG round trip and a byte-identical 1.6 MB `/object_info`.

**Model-set recommendation.**

- **SDXL + LCM-LoRA-SDXL (7.3 GB) as the default, on every GPU.** It needs **no new workflow
  files** — the existing SD 1.5 graphs have no version-specific node input, so only
  `{{checkpoint}}`, `{{lora}}` and the resolution change.
- **FLUX.1-schnell is now GPU-dependent.** The previous finding — _"as GGUF Q4_K_S, not fp8: fp8
  needs compute capability 8.9 and a T4 is 7.5"_ — is **still exactly right for a T4**, and is
  **no longer the whole answer**, because Pro can hand you a card that is not a T4. Compute
  capabilities, from NVIDIA's table: T4 **7.5**, A100 **8.0**, L4 **8.9**, H100 **9.0**.

| GPU      | cc      | fp8?   | file the notebook pulls                         | download | workflow                          |
| -------- | ------- | ------ | ----------------------------------------------- | -------- | --------------------------------- |
| **T4**   | 7.5     | ❌     | `flux1-schnell-Q4_K_S.gguf` + T5-XXL Q5_K_M     | 10.8 GB  | `txt2img-flux-schnell-*.json`     |
| **A100** | **8.0** | **❌** | `flux1-schnell-Q8_0.gguf` + T5-XXL Q8_0         | 18.3 GB  | `txt2img-flux-schnell-*.json`     |
| **L4**   | **8.9** | ✅     | `flux1-schnell-fp8-e4m3fn.safetensors` + T5 fp8 | 17.4 GB  | `txt2img-flux-schnell-fp8-*.json` |
| **H100** | 9.0     | ✅     | as L4                                           | 17.4 GB  | `txt2img-flux-schnell-fp8-*.json` |

**The A100 is the trap:** it is the biggest card Colab allocates and it still cannot load an fp8
checkpoint — Ampere is 8.0, fp8 needs 8.9. ComfyUI's own GPU guide agrees: _"30 series (ampere):
fp16, bf16"_ versus _"40 series (ada): fp16, bf16, fp8"_. On an A100, GGUF **Q8_0** is the right
answer, not a fallback: it dequantises to bf16, which the A100 runs at full tensor-core rate.
The notebook's `FLUX_VARIANT='auto'` reads `nvidia-smi`'s compute capability and picks accordingly;
`fp8` on a card below 8.9 is **refused**, not silently downgraded. A side benefit of the fp8 path:
core `UNETLoader`/`DualCLIPLoader` replace the GGUF loaders, so it does not need the `ComfyUI-GGUF`
custom node — the notebook's most fragile pin.

- **On §3's finding that SD 1.5 cannot decompose characters into parts:** that is a
  prompt-adherence failure, so the fix — if there is one — is a better _text encoder_, not a bigger
  UNet. SD 1.5 has CLIP-L (77 tokens, bag-of-words); **SDXL adds OpenCLIP-bigG but is still CLIP at
  77 tokens, so SDXL is not expected to fix it**; FLUX conditions on **T5-XXL at 512 tokens**, which
  can carry multi-clause layout instructions. Against it: the "reference sheet = turnaround" prior
  is universal, and a 4-step distilled model resists argument. `txt2img-flux-schnell-parts-sheet.json`
  and its fp8 twin exist to settle it. **Unrun — no result yet.**

Everything above is verified against live sources or live local ComfyUI 0.33.0. **Nothing has been
executed on Colab**: no notebook cell, no T4/L4/A100 timing, no FLUX output, and **no fp8 has ever
run on hardware available to this project** (the local card is cc 7.5). All Colab s/image figures in
`tools/colab/README.md` are labelled estimates, and the L4/A100 ones are estimates derived from
estimates. What _was_ executed locally: all four FLUX workflows validate against ComfyUI 0.33.0
(`node_errors: {}` with the loaders stubbed), all twelve model URLs return the recorded byte size
and SHA-256 anonymously, and the notebook's GPU-detection cell was run against synthetic
`nvidia-smi` output for T4/L4/A100/H100 to confirm each resolves to the file above.

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

---

## 9. Voice / TTS

> Verified 2026-08-24. Two of the three engines were read from **primary sources on this
> machine** - the model card shipped inside the weights, and the installed Python package -
> rather than from documentation sites. ElevenLabs was read from its own API reference and
> pricing pages and **has not been called**: no key exists here.

### The finding that decides the architecture

**Chatterbox's stock multilingual weights do not speak Persian.** Read out of
`SUPPORTED_LANGUAGES` in `chatterbox/mtl_tts.py` (chatterbox-tts 0.1.7, installed and
inspected):

```text
ar da de el en es fi fr he hi it ja ko ms nl no pl pt ru sv sw tr zh   (23, no fa)
```

The series language is Persian. Sending Persian to these weights does not fail - it
produces fluent, confident sound in the wrong language, which passes every automated
check in this repository. So language is a **declared capability per checkpoint**, the
adapter refuses before it opens a socket, and the router fails over. Community Persian
fine-tunes of the same architecture exist (`Thomcles/Chatterbox-TTS-Persian-Farsi` is in
this machine's HuggingFace cache), which is exactly why the declaration is per checkpoint
and not per engine.

### Engine comparison

|                 | **Higgs TTS 3**                               | **Chatterbox**              | **ElevenLabs**                                                            |
| --------------- | --------------------------------------------- | --------------------------- | ------------------------------------------------------------------------- |
| Emotion channel | 21 named inline tags                          | one scalar (`exaggeration`) | `voice_settings` + v3 audio tags                                          |
| Persian         | **yes**, production tier                      | **no** (stock weights)      | listed for v3                                                             |
| Voice selection | zero-shot clone; presets on the hosted API    | clone or predefined         | voice id                                                                  |
| Timing returned | no                                            | no                          | **yes** (`/with-timestamps`)                                              |
| Seed            | not documented on `/v1/audio/speech`          | yes                         | yes (0..4294967295)                                                       |
| Output          | 24 kHz                                        | 24 kHz (`S3GEN_SR`)         | mp3/opus/pcm/wav                                                          |
| Watermark       | none documented                               | **always** (Resemble Perth) | none documented                                                           |
| Price           | free self-hosted; hosted price not published  | free                        | $0.10/1K chars (v3, multilingual v2); $0.05/1K (v3 conversational, Flash) |
| Licence         | research / non-commercial + Creator Use Grant | MIT                         | commercial                                                                |

### Higgs TTS 3 - the 43 control tags [verified from the shipped model card]

`bosonai/higgs-tts-3-4b`, from `PROMPTING.md` and `README.md` inside the weights. The
model card's own warning is why this is a closed table in code and not a template:
_"Only the tags below are recognized - anything else degrades output or gets read
literally."_

Every tag is `<|category:tag|>`. **Placement is load-bearing:** emotion, style and the
prosody `speed_* / pitch_* / expressive_*` tags are _sentence-level_ and go at the start;
`pause`, `long_pause` and every `sfx` are _inline_ and fire where they are placed.

- **Emotion (21)** — `elation` `amusement` `enthusiasm` `determination` `pride`
  `contentment` `affection` `relief` `contemplation` `confusion` `surprise` `awe`
  `longing` `arousal` `anger` `fear` `disgust` `bitterness` `sadness` `shame`
  `helplessness`
- **Style (3)** — `singing` `shouting` `whispering`
- **Prosody (10)** — `speed_very_slow` (~0.65x) `speed_slow` (~0.85x) `speed_fast`
  (~~1.2x) `speed_very_fast` (~~1.4x) `pitch_low` (~~-3 semitones) `pitch_high` (~~+2.5)
  `expressive_high` `expressive_low` `pause` (~400-700 ms) `long_pause` (~700-1500 ms)
- **Sound effects (9, inline, each paired with its onomatopoeia and no space)** —
  `cough` `laughter` `crying` `screaming` `burping` `humming` `sigh` `sniff` `sneeze`

Languages: 102 at single-digit WER/CER, split into 85 production-quality and 17 usable;
**Persian is in the production tier.** Serving is OpenAI-compatible `POST
/v1/audio/speech` under `sgl-omni` or `vllm-omni`, taking
`references: [{audio_path, text}]` for cloning; the hosted `api.boson.ai` endpoint spells
the same idea `ref_audio` / `ref_text` and adds `voice` for preset speakers. **The two
dialects are not interchangeable**, which is why the adapter has a `dialect` option.

**Not runnable on this machine.** ~4B parameters, benchmarked on 1x H100; §0 records
6 GB VRAM here. `vllm-omni` is also Linux-only. The weights' own `README` reserves
production and hosted use for a separate commercial licence - a decision the owner has to
make before this engine ships an episode.

### Chatterbox [verified from the installed package]

`chatterbox-tts` 0.1.7, MIT. Signatures read directly from the wheel:

```python
# chatterbox/tts.py
generate(text, repetition_penalty=1.2, min_p=0.05, top_p=1.0,
         audio_prompt_path=None, exaggeration=0.5, cfg_weight=0.5, temperature=0.8)
# chatterbox/mtl_tts.py adds a required `language_id` and defaults repetition_penalty=2.0
```

`S3GEN_SR = 24000` (`chatterbox/models/s3gen/const.py`). Every output carries a Resemble
AI Perth neural watermark; no documented way to disable it.

The vendor publishes two parameter anchors and the reason they move together: the neutral
pair `(exaggeration 0.5, cfg 0.5)`, the dramatic pair `(~0.7, ~0.3)`, and _"higher
exaggeration tends to speed up speech; reducing cfg helps compensate with slower, more
deliberate pacing."_ The adapter interpolates linearly between those two points and clamps
outside them - there is no third published point to fit a curve to.

**Generated locally and measured (2026-08-24, Quadro RTX 3000, CUDA, 24 kHz, English):**

| exaggeration / cfg   | audio length | generation |
| -------------------- | ------------ | ---------- |
| 0.5 / 0.5 (neutral)  | 3.16 s       | 6.8 s      |
| 0.7 / 0.3 (dramatic) | 3.00 s       | 4.6 s      |
| 0.3 / 0.5 (damped)   | 3.60 s       | 5.4 s      |

Same sentence, three deliveries: the documented relationship reproduces - pushing
`exaggeration` up shortens the line, pulling it down lengthens it. Model load took ~36 s
from a warm local checkpoint and ~2.5 GB of host RAM.

There is **no official HTTP server**. The adapter targets `POST /tts` on
`devnen/Chatterbox-TTS-Server`, the documented community server, because it is the surface
that exposes `exaggeration` and `cfg_weight`; the OpenAI-compatible `/v1/audio/speech` on
the same server accepts only `input`, `voice`, `response_format`, `speed` and `seed`, so
routing through it would discard the only expressive control this engine has.

### ElevenLabs [documentation only - never called]

`POST /v1/text-to-speech/{voice_id}` and `/v1/text-to-speech/{voice_id}/with-timestamps`,
header `xi-api-key`.

- `voice_settings`: `stability` 0-1 (default 0.5), `similarity_boost` (0.75), `style` (0),
  `use_speaker_boost` (true), `speed` **0.7-1.2** (1.0). Low stability is documented as
  "more emotional and expressive, but prone to hallucinations" and high as "highly stable,
  but less responsive to directional prompts" - so an expressive line wants _less_
  stability, which is easy to implement backwards.
- Models and limits: `eleven_v3` (70+ languages incl. Persian, 5,000 chars, $0.10/1K),
  `eleven_v3_conversational` ($0.05/1K), `eleven_multilingual_v2` (29 languages, 10,000
  chars, $0.10/1K), `eleven_flash_v2_5` (32 languages, 40,000 chars, $0.05/1K).
- **Audio tags are v3-only**, written inline in square brackets. The documented list is
  _examples, not a closed vocabulary_: `[laughs]` `[laughs harder]` `[starts laughing]`
  `[wheezing]` `[whispers]` `[sighs]` `[exhales]` `[sarcastic]` `[curious]` `[excited]`
  `[crying]` `[snorts]` `[mischievously]`, plus sound effects and experimental accents.
- `/with-timestamps` returns `audio_base64` plus `alignment` and `normalized_alignment`,
  each `{characters[], character_start_times_seconds[], character_end_times_seconds[]}`.

**Could not confirm:** the numeric values behind the v3 stability presets
(Creative / Natural / Robust). They are documented by name only on the pages checked, and
the 0.0 / 0.5 / 1.0 mapping that circulates elsewhere is not on them. The adapter
therefore maps continuously across the documented 0-1 range rather than snapping to three
numbers we would be guessing at. **Also unconfirmed:** whether audio tag characters are
billed. The adapter counts them, because they are characters sent, and under-counting is
the failure that costs money silently.

### Consequences for this codebase

1. **Emotion is declared once** (`@rv/contracts/audio`) with a valence and an arousal per
   member, because one engine cannot be told an emotion at all. Each adapter translates,
   and reports per call what it had to approximate or drop.
2. **An adapter emits only tags it has verified.** Higgs's catalogue is closed and checked
   in a test; ElevenLabs's is open, so only documented tags are emitted and every other
   emotion is reported as dropped rather than guessed at.
3. **Speech is priced per character in its own table** (`KNOWN_SPEECH_MODELS`), because
   nothing else in the system bills that way, and `quoteSpeech` counts the string the
   adapter is about to send rather than the raw line.
4. **No new npm dependency** was added for any of this. The adapters speak HTTP through
   the existing `JsonHttpClient`; the only new local code that touches bytes is a WAV
   header reader, because a cue whose length is guessed mistimes everything after it.

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

- https://research.google.com/colaboratory/faq.html (two lists; the free-tier-only list and the sentence that lifts it)
- https://github.com/comfyanonymous/ComfyUI/issues/1460 ("No more free Colab for ComfyUI", 2023-09)
- https://news.ycombinator.com/item?id=35653698 (Colab blocking stable-diffusion-webui)
- https://decrypt.co/197428/google-colab-stable-diffusion-web-ui-ban (Colab lead: free tier only)
- https://developers.googleblog.com/introducing-the-google-colab-cli/ (official consumer Colab CLI, 2026-06-05)
- https://github.com/googlecolab/google-colab-cli (command index; Linux/macOS only; T4/L4/A100/H100)
- https://cloud.google.com/sdk/gcloud/reference/colab (GA; runtimes / runtime-templates / executions / schedules — Colab **Enterprise**)
- https://cloud.google.com/sdk/gcloud/reference/colab/runtime-templates/create (flags, defaults, accelerator enum)
- https://cloud.google.com/colab/docs/create-runtime · https://cloud.google.com/colab/pricing
- https://developer.nvidia.com/cuda-gpus (compute capability: T4 7.5, A100 8.0, L4 8.9, H100 9.0, Quadro RTX 3000 7.5)
- https://www.nvidia.com/en-us/data-center/tesla-t4/ (8.1 FP32 / 65 FP16 TFLOPS, 16 GB, 320+ GB/s, 70 W)
- https://www.nvidia.com/en-us/data-center/l4/ (30.3 FP32; 242 FP16/BF16 and 485 FP8 TFLOPS _with sparsity_; 24 GB, 300 GB/s, 72 W)
- https://www.nvidia.com/en-us/data-center/a100/ (19.5 FP32; 312 FP16/BF16 tensor TFLOPS dense; **no FP8 row**)
- https://videocardz.net/nvidia-quadro-rtx-3000-mobile (5.3 FP32 TFLOPS, 336 GB/s, 240 tensor cores)
- https://github.com/Comfy-Org/ComfyUI/wiki/Which-GPU-should-I-buy-for-ComfyUI ("30 series (ampere): fp16, bf16" vs "40 series (ada): fp16, bf16, fp8")
- https://github.com/city96/ComfyUI-GGUF (pinned 6ea2651e, last commit 2026-01-12)
- https://huggingface.co/city96/FLUX.1-schnell-gguf (Q4_K_S 6,783,943,712 B; Q8_0 12,687,821,728 B)
- https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf (Q5_K_M 3,386,856,640 B; Q8_0 5,061,584,064 B)
- https://huggingface.co/Kijai/flux-fp8 (flux1-schnell-fp8-e4m3fn 11,891,329,784 B)
- https://huggingface.co/comfyanonymous/flux_text_encoders (t5xxl_fp8_e4m3fn 4,893,934,904 B; clip_l 246,144,152 B)
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
- https://www.kaggle.com/general/108481 (Kaggle 30 GPU-h/week, T4x2 / P100)

Voice / TTS (§9, verified 2026-08-24):

- `bosonai/higgs-tts-3-4b` model card, read from the local HuggingFace cache: `PROMPTING.md` (43-tag catalogue, placement rules), `README.md` (102 languages incl. Persian, control-token tables, `/v1/audio/speech` examples, licence)
- https://docs.boson.ai/models/higgs-tts/overview (hosted API: `ref_audio` / `ref_text` / `voice` / `response_format`)
- https://huggingface.co/bosonai/higgs-audio-v3-tts-4b · https://recipes.vllm.ai/bosonai/higgs-audio-v3-tts-4b (vLLM-Omni serving)
- `chatterbox-tts` 0.1.7 wheel, installed and read: `chatterbox/tts.py`, `chatterbox/mtl_tts.py` (`generate` signatures, `SUPPORTED_LANGUAGES`), `chatterbox/models/s3gen/const.py` (`S3GEN_SR = 24000`)
- https://github.com/resemble-ai/chatterbox · https://huggingface.co/ResembleAI/chatterbox (MIT, Perth watermark, the two published parameter anchors)
- https://github.com/devnen/Chatterbox-TTS-Server (documented `POST /tts` body; the OpenAI-compatible endpoint's narrower field set)
- https://elevenlabs.io/docs/api-reference/text-to-speech/convert · .../convert-with-timestamps (request fields, `voice_settings` ranges, alignment response)
- https://elevenlabs.io/docs/models (per-model language counts and character limits)
- https://elevenlabs.io/pricing/api (per-1K-character rates)
- https://elevenlabs.io/docs/best-practices/prompting/eleven-v3 (the documented audio-tag examples; the stability presets named but not numbered)
