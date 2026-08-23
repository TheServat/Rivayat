# ComfyUI on Google Colab — the free lane with headroom

[`rivayat-comfyui.ipynb`](rivayat-comfyui.ipynb) runs the free image lane on a Colab **T4 (~15 GB)**
instead of the local **Quadro RTX 3000 (6 GB)**, and hands you one line to paste into
`COMFYUI_HOST`. The adapter cannot tell the difference between the two lanes — same ComfyUI HTTP
API, different host.

> **⚠️ Read this before you run it**
>
> **1. Google's Terms forbid this on the free tier.** Colab's FAQ lists, as disallowed _from
> free-tier runtimes without a positive compute balance_: **"bypassing the notebook UI to interact
> primarily via a web UI"** and _"remote control such as SSH shells, remote desktops"_. Driving
> ComfyUI's API through a tunnel is exactly that. **Run this on Colab Pro / Pro+ / pay-as-you-go**
> — the restriction is scoped to runtimes without a compute balance — or use Kaggle or a rented
> GPU. Details and alternatives in [§2](#2-the-tos-answer-honestly).
>
> **2. The tunnel is a public URL and ComfyUI has no authentication.** The notebook therefore never
> exposes ComfyUI; it puts a token gate in front and tunnels _that_. Details in
> [§5](#5-security-the-token-gate).

---

## 1. What this buys you over the local card

**It does not buy you speed. It buys you 9 GB.**

The T4 and the Quadro RTX 3000 are the _same GPU generation_ (Turing, compute capability 7.5). On
vendor-published figures the T4 is about **1.5× the arithmetic throughput** and has **slightly less
memory bandwidth**:

|                    | Quadro RTX 3000 Mobile (local) | Tesla T4 (Colab)                   |
| ------------------ | ------------------------------ | ---------------------------------- |
| VRAM               | **6 GB**                       | **16 GB** (~15 GB usable)          |
| FP32               | 5.3 TFLOPS                     | **8.1 TFLOPS**                     |
| FP16 tensor        | ~42 TFLOPS                     | **65 TFLOPS**                      |
| Memory bandwidth   | **336 GB/s**                   | 320 GB/s                           |
| Compute capability | 7.5                            | 7.5 — _no bf16, no fp8, on either_ |

So moving _identical SD 1.5 work_ to Colab wins you maybe 1.2–1.5×. That is not worth a tunnel.
What is worth a tunnel is that **9 extra gigabytes changes which models exist**.

### The local ceiling, measured

From [`tools/comfy-workflows/README.md`](../comfy-workflows/README.md) — real numbers on the real
card, 3 runs per cell, node cache evicted between runs:

| Resolution | Steps | s/image    | Peak VRAM | Verdict                                                |
| ---------- | ----- | ---------- | --------- | ------------------------------------------------------ |
| 512×512    | 4     | **1.42 s** | 3698 MiB  | the conversational draft loop                          |
| 768×768    | 4     | **3.25 s** | 4818 MiB  | **the practical ceiling**                              |
| 1024×1024  | 4     | 7.59 s     | 5839 MiB  | works, at **95 % of the card** — a browser will OOM it |
| 1280×1280  | 4     | 16.2 s     | 5871 MiB  | thrashing: 2.1× the time for 1.6× the pixels           |

And the limits that follow from it: **no SDXL, no FLUX**, and — the one that actually hurts —
**characters do not decompose into parts** (research §3, `txt2img-lcm-parts-sheet.md`). SD 1.5
returns six whole figures where six body parts were asked for.

### What the T4 adds

|                                      | local, 6 GB                        | Colab, ~15 GB               |
| ------------------------------------ | ---------------------------------- | --------------------------- |
| SD 1.5 + LCM                         | ✅ 768² comfortably, 1024² at 95 % | ✅ same, with room to spare |
| **SDXL**                             | ❌                                 | ✅ 1024², ~11 GB            |
| **FLUX.1-schnell** (GGUF Q4)         | ❌                                 | ✅ 1024², ~11 GB            |
| Concurrent browser / second CUDA app | ❌                                 | ✅                          |

The FLUX row is the real prize, and not because of image quality. It is the only option here whose
**text encoder** is different in kind: T5-XXL with a 512-token budget, versus CLIP-L's 77. The
parts-sheet failure is a prompt-adherence failure, so a bigger _encoder_ is a plausible fix where a
bigger _UNet_ is not. See [§4](#4-which-models-and-why).

---

## 2. The ToS answer, honestly

**Running this notebook on a free Colab account is against Google's Terms.** Not a grey area, not a
technicality — an explicitly enumerated prohibition.

Colab's FAQ lists activities _"disallowed from Colab runtimes"_, and a second, stricter list
_disallowed from free-tier runtimes **without a positive compute balance**_. That second list
includes:

> - _"remote control such as SSH shells, remote desktops"_
> - **"bypassing the notebook UI to interact primarily via a web UI"**
> - _"running distributed computing workers"_

Serving the ComfyUI API through a tunnel so an external adapter can drive it is the clearest
possible case of _interacting primarily via something other than the notebook UI_. This is the same
policy Google enforced in **2023 against `stable-diffusion-webui`**, which was blocked on free
Colab; Colab's product lead framed it then as a free-tier resource-consumption measure, explicitly
**not** applying to paid users. The [ComfyUI issue tracker recorded the same
conclusion](https://github.com/comfyanonymous/ComfyUI/issues/1460) ("⚠ No more free Colab for
ComfyUI", Sept 2023).

Two further clauses apply to **all** runtimes, paid included, and are worth keeping in view:
_"file hosting, media serving, or other web service offerings not related to interactive compute"_
and _"connecting to remote proxies"_. A tunnel used interactively while you work in the notebook
reads as interactive compute; leaving it up unattended as a rendering endpoint for days does not.
**Do not treat this as always-on infrastructure.** It is a session-scoped scratch lane.

### So what should you actually do?

| option                        | cost                              | verdict                                                                                                                                                                                                                           |
| ----------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Colab Pro / pay-as-you-go** | from ~$10                         | **Recommended.** A positive compute balance lifts the free-tier-only restrictions, and you get better GPUs (L4/A100) that also _do_ support bf16 and fp8.                                                                         |
| **Kaggle Notebooks**          | free                              | **Best free option.** 30 GPU-hours/week, T4×2 (32 GB total) or P100. Longer weekly budget than Colab and no equivalent "web UI" clause. Notebooks are public by default on the free tier — check that before you enable anything. |
| **RunPod / Vast.ai**          | ~$0.20–0.40/h for a T4-class card | No ToS friction at all; serving an API is the product. The honest choice if you want this running reliably.                                                                                                                       |
| **Lightning.ai**              | free monthly GPU hours            | Viable; smaller free allowance.                                                                                                                                                                                                   |
| **Stay local**                | free                              | SD 1.5 at 768², always available, [§7](#7-falling-back-to-local).                                                                                                                                                                 |

The notebook does not try to hide any of this — the ToS warning is the first thing in it.

---

## 3. The exact steps

1. Upload `rivayat-comfyui.ipynb` to [colab.research.google.com](https://colab.research.google.com).
2. **Runtime → Change runtime type → T4 GPU.** (Then read §2 again and decide about the compute
   balance.)
3. Run **cell 1**. It stops loudly if no GPU was attached, and prints the compute capability that
   decides the model set.
4. Set **cell 2** — `MODEL_SET`, `USE_DRIVE`, and optionally a fixed `AUTH_TOKEN`. Leave the token
   blank and a 43-character secret is generated.
5. Run cells **3 → 8** in order. Cell 8 waits for each process, refuses to open the tunnel if the
   gate is not closed, and finally prints:

   ```
   COMFYUI_HOST=https://<random-words>.trycloudflare.com
   COMFYUI_AUTH_TOKEN=<43 chars>
   RV_COMFYUI_REMOTE=true
   ```

6. Paste those three lines into **`.env`** in the repo root. **Never into `.env.example`** — that
   file is committed.
7. Run **cell 9** to self-test through the public URL, then leave **cell 10** (keep-alive) running.

### The one line

```dotenv
COMFYUI_HOST=https://<random-words>.trycloudflare.com
```

No port, no trailing slash, no `/api` suffix — a bare origin, exactly like the local
`http://127.0.0.1:8288`. The hostname is random and **different every session**, so this is a line
you will re-paste. The token is stable if you set it yourself in cell 2.

---

## 4. Which models, and why

`MODEL_SET` in cell 2. Sizes are exact bytes, and every file's SHA-256 is verified after download.

| set                    | contents                                                  | download    | notes                                                                      |
| ---------------------- | --------------------------------------------------------- | ----------- | -------------------------------------------------------------------------- |
| **`sdxl`** _(default)_ | SDXL base 1.0 + LCM-LoRA-SDXL                             | **7.3 GB**  | Genuinely uses the 15 GB. **Runs the three existing workflows unchanged.** |
| `flux-schnell`         | FLUX.1-schnell Q4_K_S + T5-XXL Q5_K_M + CLIP-L + FLUX VAE | **10.8 GB** | The parts-decomposition experiment. Needs `ComfyUI-GGUF`.                  |
| `both`                 | all of the above                                          | **18.1 GB** | Will not fit a free 15 GB Drive.                                           |
| `sd15`                 | dreamshaper_8 + LCM-LoRA-SD1.5                            | **2.3 GB**  | Identical to the local lane, for A/B.                                      |

### Why `sdxl` is the default

Because it costs nothing to adopt. SDXL uses **the same ComfyUI node graph as SD 1.5** —
`CheckpointLoaderSimple` → `LoraLoader` → `CLIPTextEncode` → `EmptyLatentImage` → `KSampler`. None
of those nodes has an SD-version-specific input. So the three existing workflows in
`tools/comfy-workflows/` run on SDXL with **no new files**, just different placeholder values:

```text
{{checkpoint}} = sd_xl_base_1.0.safetensors
{{lora}}       = lcm-lora-sdxl.safetensors
{{width}}      = 1024        {{height}} = 1024
{{steps}}      = 8           {{cfg}}    = 1.5
```

Pairing SDXL with **LCM-LoRA-SDXL** (rather than SDXL-Lightning or Turbo) is deliberate: it keeps
`ModelSamplingDiscrete(sampling: "lcm")` and the `lcm`/`sgm_uniform` pairing that the local lane
already depends on, so the adapter needs no new branch.

_Caveat, reasoned not measured:_ plain `CLIPTextEncode` feeds both of SDXL's text encoders but skips
the explicit size/crop conditioning that `CLIPTextEncodeSDXL` adds. That costs a little quality and
is a fair trade for zero new files. If it matters, add a dedicated workflow later.

### Why FLUX is worth the 10.8 GB

Research §3 records that **SD 1.5 cannot decompose characters into parts** — the parts sheet returns
a costume turnaround, not limbs. The question this notebook exists to answer is whether that is a
limit of SD 1.5 or of the parts-sheet idea.

There is a specific reason to expect a _bigger model_ not to help but a _different text encoder_ to:

- SD 1.5 conditions on **CLIP-L, 77 tokens**, effectively bag-of-words. "Six separate parts, not one
  figure" and "one figure with six parts" are nearly the same vector.
- **SDXL adds OpenCLIP-bigG — but it is still CLIP, still 77 tokens.** Bigger UNet, same handle.
  **SDXL is not expected to fix this.**
- **FLUX conditions on T5-XXL, 512 tokens** — a language encoder that carries syntax, negation and
  spatial relations. Multi-clause layout instructions are what it is for.

Against that: the training prior ("character reference sheet" = turnaround) is the same everywhere,
and a 4-step distilled model has less capacity to be argued out of a prior than its parent. FLUX.1-
**dev** at 20+ steps might succeed where schnell fails — but dev is non-commercial-licensed.

So [`txt2img-flux-schnell-parts-sheet.json`](../comfy-workflows/txt2img-flux-schnell-parts-sheet.md)
exists to run the test. **It has not been run.** Nothing above is a result.

### Why FLUX is GGUF here, and not fp8

**A T4 is compute capability 7.5. fp8 requires 8.9** (Ada/Hopper). The widely-shared
`flux1-schnell-fp8.safetensors` is the wrong file for this hardware. GGUF weights dequantise to
fp16, which Turing does natively — so `Q4_K_S` (6.78 GB) it is. `Q5_K_S` (8.26 GB) also fits if
quality disappoints.

The same fact rules out bf16, and is why cell 1 prints the compute capability.

### One sourcing wrinkle you should know about

`black-forest-labs/FLUX.1-schnell` is **gated**. Fetching `ae.safetensors` from it anonymously
returns **HTTP 401** (verified 2026-08-23) — it needs an accepted licence and an HF token, which
would break an unattended notebook. The notebook pulls the identical VAE from
`Comfy-Org/Lumina_Image_2.0_Repackaged`, which is ungated and ships the same
**335,304,388-byte** FLUX autoencoder
(sha256 `afc8e282…29e38`). _Byte-size equality with the gated original is verified; hash equality
is inferred, not proven — the original cannot be read anonymously to compare._

---

## 5. Security: the token gate

**ComfyUI has no authentication of any kind.** An exposed instance is an open image generator on
your quota, and `/view` will serve anything in the output directory. A `trycloudflare.com` URL is
public — random, but public, and randomness is not a security control.

So the notebook never tunnels ComfyUI. It tunnels a token gate:

```text
internet  ──►  cloudflared  ──►  rv_auth_proxy (:8189)  ──►  ComfyUI (127.0.0.1:8188)
                                  ▲ the only thing              ▲ loopback-bound,
                                    the tunnel can see            unreachable directly
```

The gate accepts the secret three ways and rejects everything else with a 401 whose body says
nothing about the runtime:

| how                             | who uses it                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer <token>` | **the Rivayat `ComfyUiAdapter`** — this is the contract                                                  |
| `X-Rivayat-Token: <token>`      | scripts, curl                                                                                            |
| `?rv_token=<token>`             | a human opening the ComfyUI web UI; it sets a cookie so sub-resources and the `/ws` channel inherit auth |

Comparison is `hmac.compare_digest`, so the token cannot be probed byte by byte. `/rv-health` is
deliberately unauthenticated and returns only `{"ok": true}`, so the keep-alive poll leaks nothing.
Auth headers and cookies are stripped before the request reaches ComfyUI.

**Cell 8 refuses to start the tunnel** if an unauthenticated request to the proxy returns anything
other than 401. The gate is checked before anything is exposed, not after.

### Why cloudflared

| option                       | account? | verdict                                                                                                                           |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **cloudflared quick tunnel** | **no**   | **Chosen.** One command, HTTPS, random `*.trycloudflare.com`, WebSockets supported (ComfyUI's `/ws` progress channel needs them). |
| `localtunnel`                | no       | Interstitial page demanding the tunnel's public IP before passing traffic — hostile to a machine client.                          |
| `ngrok`                      | **yes**  | Works, but needs a signup + authtoken, and the free plan injects a browser-warning interstitial.                                  |

Cloudflare documents quick tunnels as **for testing and demos, not production**, and caps them at
**200 concurrent requests**. Irrelevant for one adapter; do not build a service on it.

**Your responsibilities:** don't post the URL and token together; treat the token as a secret
(`.env`, never `.env.example`); shut the tunnel down (cell 12) when you finish.

---

## 6. Expected performance — and what kind of number each figure is

**Read the labels.** The repo's rule is that measured numbers and guesses do not get to look alike.

| lane                | model               | steps | s/image @1024² | **status of this figure**                                                  |
| ------------------- | ------------------- | ----- | -------------- | -------------------------------------------------------------------------- |
| **local**, RTX 3000 | SD 1.5 + LCM        | 4     | **7.59 s**     | ✅ **MEASURED** — 3 runs, cache evicted, `tools/comfy-workflows/README.md` |
| **local**, RTX 3000 | SD 1.5 + LCM @768²  | 4     | **3.25 s**     | ✅ **MEASURED**                                                            |
| Colab T4            | SD 1.5 + LCM        | 4     | ~5–6 s         | ⚠️ **ESTIMATE** — local measurement ÷ the 1.5× FP32 ratio                  |
| Colab T4            | **SDXL + LCM-LoRA** | 8     | **~15–25 s**   | ⚠️ **ESTIMATE** — scaled from third-party RTX 3060/4070 Ti SDXL timings    |
| Colab T4            | **FLUX-schnell Q4** | 4     | **~40–90 s**   | ⚠️ **ESTIMATE, wide error bars** — no T4-specific measurement found        |

Nothing in the T4 rows has been run. **Not one of them.** They are arithmetic on vendor TFLOPS
figures and other people's benchmarks on other cards, which is a weaker kind of claim than anything
in the local table, and they could be wrong by 2×. The FLUX row is the least trustworthy: GGUF
dequantisation overhead and 12 B-parameter memory traffic on a 70 W card do not scale cleanly from
FLOPs.

Add first-load costs on top: the T5-XXL text encoder is a one-off several-second hit, and the
7–11 GB download dominates the first minutes of any session.

**When someone runs it, replace these rows with measurements and delete this paragraph.**

### Determinism

The local lane is bit-exactly deterministic _within one machine profile_ — same graph, same bytes,
across process restarts. **That does not extend to Colab.** Different GPU, different CUDA, different
fp16 kernels: hashes will not match the local ones, and Colab may hand you a different GPU model
between sessions. Treat Colab renders as a **separate machine profile** in the content-addressed
store. Research §2 and `tools/comfy-workflows/README.md` §6 already say launch flags are part of the
determinism key; on Colab, so is the assigned GPU.

---

## 7. Falling back to local

Colab will drop you — free/burst runtimes cap at 12 hours and are frequently reclaimed sooner, and
some days there is no GPU at all. The fallback is one edit:

```dotenv
COMFYUI_HOST=http://127.0.0.1:8288
RV_COMFYUI_REMOTE=false
COMFYUI_AUTH_TOKEN=
```

then

```powershell
powershell -ExecutionPolicy Bypass -File tools\scripts\comfy-start.ps1
```

You lose SDXL and FLUX and go back to SD 1.5 at 768². It is always there, it is genuinely free, and
its numbers are measured.

Recovery paths for the various ways a session can die are in **cell 11** of the notebook. The short
version: the tunnel URL never survives, weights survive a kernel restart but not a disconnect
(unless `USE_DRIVE`), and every recovery produces a **new `COMFYUI_HOST`**.

### Google Drive weight caching

`USE_DRIVE = True` puts the weights in `MyDrive/rivayat-comfy-models/` and symlinks them into
ComfyUI, so a reconnect costs a mount instead of a 7–11 GB download. Three honest caveats:

1. **A free Drive is 15 GB, shared with Gmail and Photos.** `sdxl` fits, `flux-schnell` probably
   fits, `both` (18.1 GB) does not.
2. **Drive reads are slower than the Hugging Face CDN.** It reliably saves bandwidth; it does not
   reliably save time.
3. Mounting grants the notebook access to your whole Drive. It only writes under
   `rivayat-comfy-models/`, but the permission is broader — that is Colab's design.

---

## 8. What was verified, and what was not

Everything checkable without a Colab session **was** checked, on 2026-08-23, against a real local
ComfyUI **0.33.0** on the Quadro RTX 3000.

### ✅ Verified locally

- **The notebook is valid.** `json.load()` parses it; 24 cells (13 markdown, 11 code); **no cell
  carries stale output or a non-null `execution_count`**; every code cell `ast.parse`s; every code
  cell has a markdown cell above it.
- **The token gate works — 18 assertions against live ComfyUI 0.33.0.** No credential → 401. Wrong
  token → 401. Truncated token → 401. Raw token without the `Bearer` prefix → 401. Correct
  `Authorization: Bearer` → 200. `X-Rivayat-Token` → 200. `?rv_token=` → 200 **and** sets a cookie.
  `/rv-health` open. The 401 body leaks nothing about ComfyUI.
- **The gate is transparent.** Proxied `/system_stats` is identical to direct. `/object_info` came
  through at **1,631,370 bytes — byte-identical** to the direct response.
- **A full generation round trip through the proxy.** `POST /prompt` → `200`, `node_errors: {}` →
  polled `/history/{id}` → `GET /view` returned a **273,581-byte real PNG**. Unauthenticated
  `POST /prompt` → 401.
- **The exact proxy source in the notebook is the source that passed those tests** — asserted by
  byte comparison, not by eye.
- **Both new FLUX workflows validate against live ComfyUI.** With the GGUF loaders stubbed to a
  local checkpoint's MODEL/CLIP/VAE outputs, `POST /prompt` returned `node_errors: {}` — every link,
  socket index and input name is correct. With core-node equivalents, the _only_ errors were
  `value_not_in_list` on the four model filenames. This check **caught a real defect**: a stray
  `{{negative}}` inside a `_meta.title` that would have made an adapter treat `negative` as a
  required parameter.
- **All FLUX node names exist in core 0.33.0** with the input names used here: `UNETLoader`,
  `DualCLIPLoader` (with `type: "flux"`), `VAELoader`, `ConditioningZeroOut`,
  `EmptySD3LatentImage`, `FluxGuidance`, `ModelSamplingFlux`.
- **`--whitelist-custom-nodes` exists** in ComfyUI 0.33 and takes folder names, so `ComfyUI-GGUF`
  can be admitted while everything else stays disabled.
- **Every model URL: HTTP 200 anonymously, with exact size and SHA-256** read from the HF CDN. The
  gated `black-forest-labs/FLUX.1-schnell` **401** was confirmed by request, which is why the mirror
  is used.
- **Both pinned commits resolve:** ComfyUI `v0.33.1` = `72865f4f…` (2026-08-13); ComfyUI-GGUF
  `6ea2651e…` (2026-01-12).

### ❌ Not verified — no Colab session was available

- **The notebook has never been executed.** Not one cell. Colab-specific behaviour —
  `google.colab.drive.mount`, `@param` form rendering, the preinstalled torch surviving
  `pip install -r requirements.txt` — is unrun.
- **The `ComfyUI-GGUF` pin has never been run against ComfyUI v0.33.1.** Its last commit predates
  that release by **seven months**. `UnetLoaderGGUF` / `DualCLIPLoaderGGUF` may not register. Cell 9
  checks for exactly this and tells you; the fix is to bump `COMFYUI_GGUF_COMMIT`. **This is the
  most likely thing to break.**
- **cloudflared has not been run**, so the URL-parsing regex and the WebSocket path through
  Cloudflare's edge are untested. The proxy's WebSocket code was reviewed, not exercised.
- **No T4 timing, VRAM figure, or output.** Every T4 number in §6 is an estimate.
- **Whether FLUX-schnell decomposes characters into parts** — the entire reason FLUX is here — is
  the open question. Unanswered.
- **SDXL on the existing workflows** is reasoned from node signatures, not run. No SDXL model fits
  on 6 GB.

---

## 9. Files

| file                                                                                                                 | what                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`rivayat-comfyui.ipynb`](rivayat-comfyui.ipynb)                                                                     | The notebook. 24 cells, every code cell explained by the markdown above it.                  |
| [`../comfy-workflows/txt2img-flux-schnell-draft.json`](../comfy-workflows/txt2img-flux-schnell-draft.md)             | FLUX draft. New — FLUX needs a different graph.                                              |
| [`../comfy-workflows/txt2img-flux-schnell-parts-sheet.json`](../comfy-workflows/txt2img-flux-schnell-parts-sheet.md) | FLUX parts sheet. The research §3 experiment.                                                |
| `../comfy-workflows/txt2img-lcm-*.json`, `img2img-lcm-variant.json`                                                  | Unchanged. Run on SDXL as-is.                                                                |
| `.env.example`                                                                                                       | Documents `COMFYUI_HOST` as a tunnel URL, plus `COMFYUI_AUTH_TOKEN` and `RV_COMFYUI_REMOTE`. |

## Sources

- [Colab FAQ — prohibited activities and resource limits](https://research.google.com/colaboratory/faq.html)
- [ComfyUI #1460 — "⚠ No more free Colab for ComfyUI"](https://github.com/comfyanonymous/ComfyUI/issues/1460)
- [Google Colab has started banning Stable Diffusion WebUI users — Hacker News](https://news.ycombinator.com/item?id=35653698)
- [Did Google Ban AI Artists from Running Stable Diffusion on Its Cloud? — Decrypt](https://decrypt.co/197428/google-colab-stable-diffusion-web-ui-ban)
- [NVIDIA Tesla T4 datasheet](https://www.nvidia.com/en-us/data-center/tesla-t4/) — 8.1 FP32 TFLOPS, 65 FP16 TFLOPS, 16 GB GDDR6, 320+ GB/s, 70 W
- [NVIDIA Quadro RTX 3000 Mobile specifications](https://videocardz.net/nvidia-quadro-rtx-3000-mobile) — 1920 CUDA / 240 tensor, 5.3 FP32 TFLOPS, 336 GB/s
- [ComfyUI — which GPU should I buy (fp8 needs compute capability 8.9)](https://github.com/Comfy-Org/ComfyUI/wiki/Which-GPU-should-I-buy-for-ComfyUI)
- [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) · [FLUX.1-schnell-gguf](https://huggingface.co/city96/FLUX.1-schnell-gguf) · [t5-v1_1-xxl-encoder-gguf](https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf)
- [Cloudflare — TryCloudflare quick tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
- [Kaggle Notebooks GPU quota (30 h/week, T4×2 / P100)](https://www.kaggle.com/general/108481)
