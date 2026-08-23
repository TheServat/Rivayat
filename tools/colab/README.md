# ComfyUI on Google Colab — an optional second free lane

> **Colab is optional. Nothing in Rivayat requires it.**
> The image lane has three settings and Colab is one of them: **local ComfyUI** (free, always
> available, SD 1.5 at 768², all numbers measured) and the **cloud API lane** (Gemini / OpenRouter)
> each run the pipeline end to end on their own. `docs/01-architecture.md` states it as an
> invariant — _"Colab is one value of `image.lane`, never a requirement"_ — and `.env.example`
> ships with `RV_COMFYUI_REMOTE=false` and a loopback `COMFYUI_HOST`. If you never open this
> folder, nothing breaks. What Colab buys is **VRAM headroom for experiments the 6 GB local card
> cannot host**, for as long as a session lasts.

[`rivayat-comfyui.ipynb`](rivayat-comfyui.ipynb) runs the free image lane on a Colab GPU
(**T4 ~15 GB**, or **L4 24 GB** / **A100 40 GB** on a paid plan) instead of the local
**Quadro RTX 3000 (6 GB)**, and hands you one line to paste into `COMFYUI_HOST`. The adapter cannot
tell the difference between the two lanes — same ComfyUI HTTP API, different host.

> **⚠️ Read this before you run it**
>
> **1. Whether this is allowed depends on your Colab tier.** Colab's FAQ keeps _two_ lists of
> disallowed activities, and the clause that matters here is on the **free-tier-only** list.
>
> | your runtime                                                    | ComfyUI-over-a-tunnel | why                                                                                                                                                                                                                                                                                                                                                                                                            |
> | --------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **Free tier** — no positive compute balance                     | ❌ **disallowed**     | The FAQ's second list covers _"managed Colab runtimes running free of charge, without a positive Colab compute unit balance"_ and includes **"bypassing the notebook UI to interact primarily via a web UI"** and _"remote control such as SSH shells, remote desktops"_. Driving the ComfyUI API through a tunnel is exactly that.                                                                            |
> | **Colab Pro / Pro+ / pay-as-you-go** — positive compute balance | ✅ **allowed**        | Same FAQ, immediately after that list: _"You can remove these types of restrictions by purchasing one of our paid plans and maintaining a positive compute unit balance."_ The restriction is **scoped to the free tier by its own wording**, and Google now ships an official CLI whose commands include `colab ssh` and `colab console` — see [§3](#3-four-ways-to-run-a-gpu-and-which-one-this-repo-ships). |
> | **Any tier**                                                    | ⚠️ **still bounded**  | Two clauses bind _every_ runtime, paid included: _"file hosting, media serving, or other web service offerings not related to interactive compute"_ and _"connecting to remote proxies"_. So: session-scoped scratch lane, used while you are working. **Never always-on infrastructure.** Shut it down (cell 12) when you stop.                                                                               |
>
> Full reasoning and the alternatives if you have no compute balance: [§2](#2-the-tos-position-by-tier).
>
> **2. The tunnel is a public URL and ComfyUI has no authentication.** This is unrelated to your
> tier and applies to every one of them. The notebook therefore never exposes ComfyUI; it puts a
> token gate in front and tunnels _that_. Details in [§6](#6-security-the-token-gate).

---

## 1. What this buys you over the local card

**It is not primarily about speed. It is about VRAM.**

A **T4** and the Quadro RTX 3000 are the _same GPU generation_ (Turing, compute capability 7.5). On
vendor-published figures the T4 is about **1.5× the arithmetic throughput** and has **slightly less
memory bandwidth**:

|                    | Quadro RTX 3000 Mobile (local) | Tesla T4 (Colab, all tiers)        |
| ------------------ | ------------------------------ | ---------------------------------- |
| VRAM               | **6 GB**                       | **16 GB** (~15 GB usable)          |
| FP32               | 5.3 TFLOPS                     | **8.1 TFLOPS**                     |
| FP16 tensor        | ~42 TFLOPS                     | **65 TFLOPS**                      |
| Memory bandwidth   | **336 GB/s**                   | 320 GB/s                           |
| Compute capability | 7.5                            | 7.5 — _no bf16, no fp8, on either_ |

So moving _identical SD 1.5 work_ to a T4 wins you maybe 1.2–1.5×. That is not worth a tunnel.
What is worth a tunnel is that **9 extra gigabytes changes which models exist**.

On a paid plan the picture changes again, because Colab can allocate **L4** and **A100** (and,
per Google's own CLI, H100), which are not merely bigger but _architecturally different_ — see
[§5](#5-which-models-and-why).

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

### What a Colab GPU adds

|                                      | local, 6 GB                        | Colab T4, ~15 GB            | Colab L4 / A100 (paid)                    |
| ------------------------------------ | ---------------------------------- | --------------------------- | ----------------------------------------- |
| SD 1.5 + LCM                         | ✅ 768² comfortably, 1024² at 95 % | ✅ same, with room to spare | ✅ trivially                              |
| **SDXL**                             | ❌                                 | ✅ 1024², ~11 GB            | ✅ with headroom for batching             |
| **FLUX.1-schnell**                   | ❌                                 | ✅ GGUF Q4 only             | ✅ **fp8 (L4)** or **GGUF Q8 (A100)**     |
| bf16                                 | ❌ (cc 7.5)                        | ❌ (cc 7.5)                 | ✅ (cc 8.0+)                              |
| fp8                                  | ❌                                 | ❌                          | ✅ **L4 only** (8.9) — **not A100** (8.0) |
| Concurrent browser / second CUDA app | ❌                                 | ✅                          | ✅                                        |

The FLUX row is the real prize, and not because of image quality. It is the only option here whose
**text encoder** is different in kind: T5-XXL with a 512-token budget, versus CLIP-L's 77. The
parts-sheet failure is a prompt-adherence failure, so a bigger _encoder_ is a plausible fix where a
bigger _UNet_ is not. See [§5](#5-which-models-and-why).

---

## 2. The ToS position, by tier

An earlier version of this document said flatly that running the notebook was "against Google's
Terms — not a grey area". **That was too broad.** It read the prohibition off the wrong list. The
correction, with the wording that decides it:

Colab's FAQ enumerates disallowed activities in **two** separate lists.

**List one — disallowed from _all_ managed Colab runtimes**, whatever you pay:

> - _"file hosting, media serving, or other web service offerings not related to interactive compute"_
> - _"connecting to remote proxies"_
> - _"downloading torrents or engaging in peer-to-peer file-sharing"_, _"mining cryptocurrency"_,
>   _"running denial-of-service attacks"_, _"password cracking"_, _"using multiple accounts to work
>   around access or resource usage restrictions"_, _"creating deepfakes"_, _"employing techniques
>   such as containerization to circumvent anti-abuse policies"_

**List two — additionally disallowed from runtimes _"running free of charge, without a positive
Colab compute unit balance"_**, and terminable _"at any time without warning"_:

> - _"remote control such as SSH shells, remote desktops"_
> - **"bypassing the notebook UI to interact primarily via a web UI"**
> - _"chess training"_, _"running distributed computing workers"_

The clause this notebook trips is **on list two**, and the FAQ closes that list with:

> _"You can remove these types of restrictions by purchasing one of our paid plans and maintaining
> a positive compute unit balance."_

So the honest position is: **free tier, no. Positive compute balance, yes.** The 2023 episode
people remember — Google blocking `stable-diffusion-webui`, recorded on the
[ComfyUI issue tracker](https://github.com/comfyanonymous/ComfyUI/issues/1460) as _"⚠ No more free
Colab for ComfyUI"_ — was Colab's product lead describing a **free-tier resource-consumption
measure that explicitly did not apply to paid users**. That is the same scoping, three years on.

Corroboration from a second direction: in June 2026 Google shipped an
[official Colab CLI](https://developers.googleblog.com/introducing-the-google-colab-cli/) whose
command set includes **`colab ssh`** (an SSH shell over WebSocket) and **`colab console`** (a raw
TTY). Google does not ship a first-party SSH client for an activity it forbids outright — but the
FAQ still lists _"remote control such as SSH shells"_ on the free-tier list. Both statements are
current and they are only consistent under the tier reading.

### What still binds you, on every tier

List one does not go away when you pay. Two clauses on it are close enough to matter:

- _"web service offerings not related to interactive compute"_ — a tunnel you use **while you work
  in the notebook** is interactive compute. Leaving it up unattended for days as a render endpoint
  that something else calls is a web service offering.
- _"connecting to remote proxies"_ — read plainly this is about routing traffic _through_ third
  parties, not about exposing your own runtime; but it is not a clause to lean on.

**Do not treat this as always-on infrastructure.** It is a session-scoped scratch lane. Cell 12
exists to close it.

### If you do not have a positive compute balance

These are the alternatives — not the recommendation. With a compute balance, the notebook in this
folder is the shortest path.

| option               | cost                              | verdict                                                                                                                                                                                                                                |
| -------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kaggle Notebooks** | free                              | **Best free option.** 30 GPU-hours/week, T4×2 (32 GB total) or P100. Longer weekly budget than free Colab and no equivalent "web UI" clause. Notebooks are public by default on the free tier — check that before you enable anything. |
| **RunPod / Vast.ai** | ~$0.20–0.40/h for a T4-class card | No ToS friction at all; serving an API is the product. The honest choice if you want this running reliably rather than in sessions.                                                                                                    |
| **Lightning.ai**     | free monthly GPU hours            | Viable; smaller free allowance.                                                                                                                                                                                                        |
| **Colab Enterprise** | GCP per-runtime billing           | A different product with different terms, and fully scriptable — [§3](#3-four-ways-to-run-a-gpu-and-which-one-this-repo-ships).                                                                                                        |
| **Stay local**       | free                              | SD 1.5 at 768², always available, every number measured. [§8](#8-falling-back-to-local).                                                                                                                                               |

---

## 3. Four ways to run a GPU, and which one this repo ships

There is a real question hiding behind "can we just script this?", and the answer is
product-dependent. **"Colab" is two different products**, and only one of them has a Google Cloud
API.

|                 | **A. Consumer Colab, notebook + tunnel**                              | **B. Consumer Colab, official `colab` CLI**                                        | **C. Colab Enterprise, `gcloud colab`**                                                      | **D. Local ComfyUI**                               |
| --------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **What it is**  | `rivayat-comfyui.ipynb` in a browser tab, cloudflared to a token gate | `google-colab-cli` from PyPI, driving the _same_ consumer runtimes from a terminal | A Google Cloud product on Vertex/Agent Platform, driven by `gcloud` + REST                   | `tools/scripts/comfy-start.ps1` on the 6 GB Quadro |
| **Start-up**    | **manual** — open the tab, run 8 cells                                | `colab new --gpu L4`                                                               | `gcloud colab runtimes create …`                                                             | one PowerShell command                             |
| **Scriptable?** | no                                                                    | **yes** — but **Linux/macOS only; Windows is not supported**                       | **yes, fully** — CLI _and_ REST, IAM, service accounts                                       | yes                                                |
| **Public API**  | none                                                                  | none — the CLI talks to undocumented `colab.research.google.com/tun/m/*` endpoints | **yes**, a documented Google Cloud API                                                       | n/a                                                |
| **GPUs**        | T4 free; T4 / L4 / A100 / H100 with a balance                         | same (`--gpu T4\|L4\|A100\|H100`, plus TPU v5e1/v6e1)                              | `NVIDIA_TESLA_T4`, `NVIDIA_TESLA_V100`, `NVIDIA_L4`, `NVIDIA_TESLA_A100`, `NVIDIA_A100_80GB` | Quadro RTX 3000, 6 GB                              |
| **Billing**     | Colab compute units (subscription or pay-as-you-go)                   | same compute units                                                                 | **GCP, per runtime** — VM machine-hours + accelerator-hours, summed                          | **free**                                           |
| **Ceiling**     | 12 h session cap, reclaimable sooner, GPU not guaranteed              | same runtimes, same caps; has a built-in keep-alive daemon                         | runs until the idle-shutdown timeout (default **3 h**) or you delete it                      | your electricity                                   |
| **This repo**   | ✅ **what we ship**                                                   | ❌ not shipped                                                                     | ❌ not shipped                                                                               | ✅ shipped, **and the default**                    |

### A — what we ship, and why it is still manual

The notebook. You open it, pick a runtime, run cells 1→8, and paste three lines into `.env`. It is
manual on purpose: the session is short-lived and the URL changes every time, so there is nothing
durable to automate against. The whole lane is a scratchpad.

### B — the official consumer CLI (June 2026)

The premise that consumer Colab has "no CLI at all" **was true until 5 June 2026 and is now
wrong.** Google published [`googlecolab/google-colab-cli`](https://github.com/googlecolab/google-colab-cli):

```bash
uv tool install google-colab-cli      # or: pip install google-colab-cli

colab new -s rivayat --gpu L4         # provision; --high-mem needs Pro/Pro+
colab install -s rivayat -r requirements.txt
colab exec -s rivayat -f setup.py     # run local code on the remote kernel
colab ssh -s rivayat                  # SSH over WebSocket; --proxy-mode for OpenSSH
colab download -s rivayat out/x.png ./x.png
colab stop -s rivayat
```

Three things make it interesting here, and two make it a poor fit today:

- ✅ `colab ssh --proxy-mode` is an OpenSSH `ProxyCommand` bridge, so ordinary `ssh -L` port
  forwarding would reach ComfyUI **without cloudflared and without a public URL at all** — a
  strictly better security posture than a token gate on an open origin.
- ✅ A built-in keep-alive daemon replaces the notebook's cell 10.
- ✅ It targets the _same_ consumer runtimes and the _same_ compute units, so the tier analysis in
  [§2](#2-the-tos-position-by-tier) carries over unchanged.
- ❌ **Linux and macOS only.** The repo's dev machine is Windows 11; this would have to run under
  WSL, which is untested here.
- ❌ **There is still no documented public API.** The CLI's own design notes describe it driving
  `colab.research.google.com/tun/m/assign` and a Tunnel-Frontend keep-alive ping — internal
  endpoints it reverse-engineered, one of which it already had to migrate off once when Google
  changed an RPC. That is not a contract to build a pipeline on.

**Verdict: worth revisiting, not adopted.** If the Colab lane ever stops being a scratchpad, this —
not cloudflared — is the path to evaluate first. Nothing in the repo depends on it.

### C — Colab Enterprise, the one with a real API

`gcloud colab` is **GA** and has four command groups — `runtimes`, `runtime-templates`,
`executions`, `schedules` — over a documented Google Cloud API. It is a **different product**: it
runs on Google Cloud, bills to a GCP project, and is governed by the Cloud terms rather than the
consumer Colab FAQ.

Shape of the work, so you can judge the effort:

```bash
# 1. A template pins the hardware. This is where machine type and GPU live.
gcloud colab runtime-templates create \
    --region=us-central1 \
    --display-name=rivayat-comfy \
    --machine-type=g2-standard-8 \
    --accelerator-type=NVIDIA_L4 \
    --accelerator-count=1 \
    --disk-size-gb=200 \
    --idle-shutdown-timeout=1h

# 2. A runtime is an instance of a template.
gcloud colab runtimes create \
    --display-name=rivayat-comfy-run \
    --runtime-template=RUNTIME_TEMPLATE_ID \
    --region=us-central1 --project=PROJECT_ID

# 3. Headless notebook execution, in and out of GCS.
gcloud colab executions create \
    --display-name=parts-sheet-sweep \
    --notebook-runtime-template=RUNTIME_TEMPLATE_ID \
    --gcs-notebook-uri=gs://BUCKET/rivayat-comfyui.ipynb \
    --gcs-output-uri=gs://BUCKET/out \
    --user-email=YOU@example.com \
    --region=us-central1 --project=PROJECT_ID

# 4. Or on a cron.
gcloud colab schedules create …
```

Documented defaults worth knowing: `--machine-type` defaults to `e2-standard-4`,
`--idle-shutdown-timeout` to `3h`, `--disk-size-gb` to `100`. The published example pairs
`--machine-type=n1-standard-2` with `--accelerator-type=NVIDIA_TESLA_V100`.

> ⚠️ **Unverified:** the `g2-standard-8` + `NVIDIA_L4` pairing above is GCP's normal machine-family
> pairing for L4, not a shape read out of the Colab Enterprise allowlist. No Google Cloud project
> was available to run any of these commands. Treat the block as a _shape_, not a recipe.

**Why we do not use it:**

1. **It bills per runtime on GCP.** Compute Engine VM machine-hours plus accelerator-hours, summed
   for as long as the runtime exists — not a flat subscription. A forgotten runtime is a bill.
2. **It does not actually solve the hard part.** Enterprise makes _provisioning_ scriptable. Getting
   ComfyUI's HTTP API out of the runtime is the same problem: you still need an ingress, and the
   grown-up answer there is a VPC and private connectivity, which is real infrastructure and a real
   security review — for a lane whose entire job is drafting.
3. **A GCP project, IAM and a billing account** are a heavier prerequisite than "have a Colab
   subscription".

If Rivayat ever needs _unattended, repeatable, auditable_ GPU batches, this is the correct product
and `gcloud colab executions create` is the correct command. It is not what a scratch lane needs.

> **Not verified:** whether Colab Enterprise carries an equivalent enumerated prohibition on
> non-notebook access. The FAQ quoted in [§2](#2-the-tos-position-by-tier) is a _consumer Colab_
> document; Colab Enterprise is governed by the Google Cloud Platform Terms of Service. Nothing
> equivalent was found there — but "not found" is weaker than "checked and absent", and this was
> not reviewed by anyone qualified to say so.

### D — local

Free, always up, every number measured, zero terms to read. It is the default in `.env.example`
and it is why Colab is optional. [§8](#8-falling-back-to-local).

---

## 4. The exact steps

1. Upload `rivayat-comfyui.ipynb` to [colab.research.google.com](https://colab.research.google.com).
2. **Runtime → Change runtime type → GPU.** T4 on any tier; **L4** or **A100** if you have a
   compute balance and the option is offered. (Then read [§2](#2-the-tos-position-by-tier) and
   decide about the balance.)
3. Run **cell 1**. It stops loudly if no GPU was attached, and prints the GPU name, VRAM and
   **compute capability** — the three facts that decide the model files.
4. Set **cell 2** — `MODEL_SET`, `FLUX_VARIANT` (leave it on `auto`), `USE_DRIVE`, and optionally a
   fixed `AUTH_TOKEN`. Leave the token blank and a 43-character secret is generated. Cell 2 prints
   which FLUX file `auto` resolved to and why.
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

## 5. Which models, and why

`MODEL_SET` picks the family; `FLUX_VARIANT` picks the FLUX file, and defaults to `auto`, which
reads the compute capability and VRAM that cell 1 detected. Sizes are exact bytes and every file's
SHA-256 is verified after download.

| set                    | contents                                    | download           | notes                                                                     |
| ---------------------- | ------------------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| **`sdxl`** _(default)_ | SDXL base 1.0 + LCM-LoRA-SDXL               | **7.3 GB**         | Genuinely uses the VRAM. **Runs the three existing workflows unchanged.** |
| `flux-schnell`         | FLUX.1-schnell + T5-XXL + CLIP-L + FLUX VAE | **10.8 – 18.3 GB** | The parts-decomposition experiment. Size depends on `FLUX_VARIANT`.       |
| `both`                 | all of the above                            | **18.1 – 25.7 GB** | Will not fit a free 15 GB Drive at any variant.                           |
| `sd15`                 | dreamshaper_8 + LCM-LoRA-SD1.5              | **2.3 GB**         | Identical to the local lane, for A/B.                                     |

### The GPU → FLUX file table

This is the part Colab Pro changes. **fp8 requires compute capability 8.9**; bf16 requires 8.0.
ComfyUI's own GPU guide puts it as _"20 series (turing): fp16"_, _"30 series (ampere): fp16,
bf16"_, _"40 series (ada): fp16, bf16, fp8"_. The trap is that **an A100 is Ampere (8.0) and has no
fp8 path at all** — it is the fastest card on this list and still cannot run the fp8 file.

| GPU (`nvidia-smi` name) | cc      | VRAM     | `auto` picks         | transformer file                                  | text encoder                      | download | workflow                             |
| ----------------------- | ------- | -------- | -------------------- | ------------------------------------------------- | --------------------------------- | -------- | ------------------------------------ |
| **Tesla T4**            | **7.5** | 16 GB    | **`gguf-q4`**        | `flux1-schnell-Q4_K_S.gguf` (6.78 GB)             | `t5-v1_1-xxl-encoder-Q5_K_M.gguf` | 10.8 GB  | `txt2img-flux-schnell-*.json` (GGUF) |
| **NVIDIA L4**           | **8.9** | 24 GB    | **`fp8`**            | `flux1-schnell-fp8-e4m3fn.safetensors` (11.89 GB) | `t5xxl_fp8_e4m3fn.safetensors`    | 17.4 GB  | `txt2img-flux-schnell-fp8-*.json`    |
| **A100-SXM4-40GB**      | **8.0** | 40 GB    | **`gguf-q8`**        | `flux1-schnell-Q8_0.gguf` (12.69 GB)              | `t5-v1_1-xxl-encoder-Q8_0.gguf`   | 18.3 GB  | `txt2img-flux-schnell-*.json` (GGUF) |
| **H100**                | **9.0** | 80 GB    | **`fp8`**            | as L4                                             | as L4                             | 17.4 GB  | `txt2img-flux-schnell-fp8-*.json`    |
| anything under 14 GiB   | any     | < 14 GiB | falls back to `sd15` | —                                                 | —                                 | 2.3 GB   | `txt2img-lcm-*.json`                 |

`clip_l.safetensors` (246 MB) and `ae.safetensors` (335 MB) are shared by every FLUX variant.
`FLUX_VARIANT` can be forced to `gguf-q4`, `gguf-q8` or `fp8` if you disagree with `auto`.

**Why these choices:**

- **T4 → GGUF Q4_K_S.** cc 7.5 has no fp8 and no bf16. GGUF weights dequantise to fp16, which
  Turing does natively. Q4_K_S (6.78 GB) leaves room for T5 and the VAE inside 15 GB.
- **L4 → fp8.** cc 8.9 runs fp8 on native tensor cores with **no dequantisation pass at all**,
  which GGUF cannot avoid. This is the one row where Colab Pro changes the _file_, not just the
  headroom. Quality caveat below.
- **A100 → GGUF Q8_0, not fp8.** Ampere has no fp8. Q8_0 (12.69 GB) dequantises to bf16, which an
  A100 does natively at 312 dense TFLOPS, and is the closest-to-fp16 quantisation available. Full
  bf16 safetensors exist (`flux1-schnell.safetensors`, 23.78 GB) and fit 40 GB — the download is
  87 % larger for a difference nobody here has measured, so `auto` does not pick it. If you want
  it, use the fp8 workflow with `{{weight_dtype}} = default`.
- **H100 → fp8.** cc 9.0 (Hopper) has fp8 tensor cores. Untested here; Colab's own CLI lists H100
  as allocatable.

> **On "fp8 is better quality":** it is better than the **Q4_K_S** the T4 is stuck with — that is
> the comparison that matters when you move from a T4 to an L4. It is _not_ obviously better than
> **Q8_0**, which is the nearest-to-fp16 option and is what `auto` picks for the A100. fp8's win on
> an L4 is **speed** (native tensor cores, no dequant) plus the removal of the ComfyUI-GGUF
> dependency. ⚠️ **No fp8-vs-GGUF comparison has been run on any card available to this project** —
> the local Quadro is cc 7.5 and cannot execute fp8 at all.

### Why `sdxl` is the default set

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

### Why FLUX is worth the download

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
and its fp8 twin exist to run the test. **Neither has been run.** Nothing above is a result.

### A side benefit of the fp8 path

The GGUF path needs [`city96/ComfyUI-GGUF`](https://github.com/city96/ComfyUI-GGUF), pinned at a
commit **seven months older** than the pinned ComfyUI — [§9](#9-what-was-verified-and-what-was-not)
calls it the most likely thing to break. `UNETLoader` and `DualCLIPLoader` are **core ComfyUI**, so
on an L4 or H100 the notebook runs with `--disable-all-custom-nodes` and no whitelist at all. One
fewer moving part on exactly the tier that can afford the fp8 file.

### One sourcing wrinkle you should know about

`black-forest-labs/FLUX.1-schnell` is **gated**. Fetching `ae.safetensors` from it anonymously
returns **HTTP 401** (verified 2026-08-23) — it needs an accepted licence and an HF token, which
would break an unattended notebook. The notebook pulls the identical VAE from
`Comfy-Org/Lumina_Image_2.0_Repackaged`, which is ungated and ships the same
**335,304,388-byte** FLUX autoencoder
(sha256 `afc8e282…29e38`). _Byte-size equality with the gated original is verified; hash equality
is inferred, not proven — the original cannot be read anonymously to compare._

---

## 6. Security: the token gate

**This section is unchanged by your Colab tier.** Paying Google does not make a public URL private.

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
| `colab ssh -L` (the CLI)     | **yes**  | **Strictly better, if you can run it.** No public URL at all. Linux/macOS only — [§3B](#b--the-official-consumer-cli-june-2026).  |

Cloudflare documents quick tunnels as **for testing and demos, not production**, and caps them at
**200 concurrent requests**. Irrelevant for one adapter; do not build a service on it.

**Your responsibilities:** don't post the URL and token together; treat the token as a secret
(`.env`, never `.env.example`); shut the tunnel down (cell 12) when you finish.

---

## 7. Expected performance — and what kind of number each figure is

**Read the labels.** The repo's rule is that measured numbers and guesses do not get to look alike.

| lane                | model                    | steps | s/image @1024² | **status of this figure**                                                                                           |
| ------------------- | ------------------------ | ----- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| **local**, RTX 3000 | SD 1.5 + LCM             | 4     | **7.59 s**     | ✅ **MEASURED** — 3 runs, cache evicted, `tools/comfy-workflows/README.md`                                          |
| **local**, RTX 3000 | SD 1.5 + LCM @768²       | 4     | **3.25 s**     | ✅ **MEASURED**                                                                                                     |
| Colab T4            | SD 1.5 + LCM             | 4     | ~5–6 s         | ⚠️ **ESTIMATE** — local measurement ÷ the 1.5× FP32 ratio                                                           |
| Colab T4            | **SDXL + LCM-LoRA**      | 8     | **~15–25 s**   | ⚠️ **ESTIMATE** — scaled from third-party RTX 3060/4070 Ti SDXL timings                                             |
| Colab T4            | **FLUX-schnell GGUF Q4** | 4     | **~40–90 s**   | ⚠️ **ESTIMATE, wide error bars** — no T4-specific measurement found                                                 |
| Colab **L4**        | SDXL + LCM-LoRA          | 8     | ~8–14 s        | ⚠️⚠️ **ESTIMATE OF AN ESTIMATE** — the T4 row ÷ the 1.86× FP16-tensor ratio                                         |
| Colab **L4**        | **FLUX-schnell fp8**     | 4     | ~15–45 s       | ⚠️⚠️ **ESTIMATE OF AN ESTIMATE**, and fp8 changes the kernel, not just the clock — could be well outside this range |
| Colab **A100** 40GB | SDXL + LCM-LoRA          | 8     | ~4–7 s         | ⚠️⚠️ **ESTIMATE OF AN ESTIMATE** — the T4 row ÷ the 4.8× FP16-tensor ratio                                          |
| Colab **A100** 40GB | **FLUX-schnell GGUF Q8** | 4     | ~10–25 s       | ⚠️⚠️ **ESTIMATE OF AN ESTIMATE** — Q8 is ~1.9× the weights of Q4, on ~4.8× the throughput                           |

**Nothing in any Colab row has been run. Not one of them.** The T4 rows are arithmetic on vendor
TFLOPS figures and other people's benchmarks on other cards. The **L4 and A100 rows are worse than
that** — they are that arithmetic applied _again_ to a number that was already an estimate, so they
compound. They could be wrong by 2× or more, and the fp8 row could be wrong by more still, because
switching precision changes which kernels run rather than just how fast the same ones go.

Vendor figures the ratios come from: T4 = 65 FP16-tensor TFLOPS / 320 GB/s / 70 W;
L4 = 121 FP16-and-BF16-tensor TFLOPS dense (242 with sparsity) / 300 GB/s / 72 W, and 242 dense
FP8 TFLOPS (485 with sparsity); A100 = 312 FP16-and-BF16-tensor TFLOPS dense, **no FP8 row exists
on the datasheet**.

Add first-load costs on top: the T5-XXL text encoder is a one-off several-second hit, and the
7–18 GB download dominates the first minutes of any session.

**When someone runs it, replace these rows with measurements and delete this paragraph.**

### Determinism

The local lane is bit-exactly deterministic _within one machine profile_ — same graph, same bytes,
across process restarts. **That does not extend to Colab.** Different GPU, different CUDA, different
fp16 kernels: hashes will not match the local ones, and Colab may hand you a different GPU model
between sessions. On a paid plan this is **more** true, not less: T4, L4 and A100 are three
different architectures with three different numerics, and `auto` will hand each of them a
different weight file. Treat **each Colab GPU model as its own machine profile** in the
content-addressed store. Research §2 and `tools/comfy-workflows/README.md` §6 already say launch
flags are part of the determinism key; on Colab, so are the assigned GPU **and** the resolved
`FLUX_VARIANT`.

---

## 8. Falling back to local

Colab will drop you — sessions cap at 12 hours and are frequently reclaimed sooner, and some days
there is no GPU at all (paid plans buy _priority_, not a guarantee: the FAQ says premium GPUs are
_"subject to availability"_). The fallback is one edit:

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
its numbers are measured. **This is the state the repo ships in** — the Colab lane is something you
opt into for a session, not something you fall back _from_.

Recovery paths for the various ways a session can die are in **cell 11** of the notebook. The short
version: the tunnel URL never survives, weights survive a kernel restart but not a disconnect
(unless `USE_DRIVE`), and every recovery produces a **new `COMFYUI_HOST`**.

### Google Drive weight caching

`USE_DRIVE = True` puts the weights in `MyDrive/rivayat-comfy-models/` and symlinks them into
ComfyUI, so a reconnect costs a mount instead of a 7–18 GB download. Three honest caveats:

1. **A free Drive is 15 GB, shared with Gmail and Photos.** `sdxl` fits; `flux-schnell` fits at
   `gguf-q4` (10.8 GB) and **does not** at `fp8` (17.4 GB) or `gguf-q8` (18.3 GB); `both` never
   does. The bigger GPU you get, the more likely you need paid Drive storage too.
2. **Drive reads are slower than the Hugging Face CDN.** It reliably saves bandwidth; it does not
   reliably save time.
3. Mounting grants the notebook access to your whole Drive. It only writes under
   `rivayat-comfy-models/`, but the permission is broader — that is Colab's design.

---

## 9. What was verified, and what was not

Everything checkable without a Colab session **was** checked, on 2026-08-23, against a real local
ComfyUI **0.33.0** on the Quadro RTX 3000.

### ✅ Verified locally

- **The notebook is valid.** `json.load()` parses it; **no cell carries stale output or a non-null
  `execution_count`**; every code cell `ast.parse`s; every code cell has a markdown cell above it.
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
- **All four FLUX workflows validate against live ComfyUI** — the two GGUF ones and the two new
  fp8 ones. With the loaders stubbed to a local checkpoint's MODEL/CLIP/VAE outputs, `POST /prompt`
  returned **HTTP 200, `node_errors: {}`** for every one of them. Unstubbed, the fp8 pair returned
  **exactly four `value_not_in_list` errors** (`unet_name`, `clip_name1`, `clip_name2`, `vae_name`)
  — the missing weight files, nothing structural.
- **`UNETLoader` takes `weight_dtype`, and the enum is real.** Read from live `/object_info`:
  `['default', 'fp8_e4m3fn', 'fp8_e4m3fn_fast', 'fp8_e5m2']`. `DualCLIPLoader`'s `type` enum
  contains `flux`. `models/unet` is a live alias for `diffusion_models` in `folder_paths`, so the
  GGUF and safetensors transformers can share a directory.
- **All FLUX node names exist in core 0.33.0** with the input names used here: `UNETLoader`,
  `DualCLIPLoader`, `VAELoader`, `ConditioningZeroOut`, `EmptySD3LatentImage`, `FluxGuidance`,
  `ModelSamplingFlux`.
- **`--whitelist-custom-nodes` exists** in ComfyUI 0.33 and takes folder names, so `ComfyUI-GGUF`
  can be admitted while everything else stays disabled — and the fp8 path needs neither.
- **Every model URL: HTTP 200 anonymously, with exact size and SHA-256** read from the HF CDN,
  including the four files added for the L4/A100 paths. The gated
  `black-forest-labs/FLUX.1-schnell` **401** was confirmed by request, which is why the mirror is
  used.
- **Both pinned commits resolve:** ComfyUI `v0.33.1` = `72865f4f…` (2026-08-13); ComfyUI-GGUF
  `6ea2651e…` (2026-01-12).

### ✅ Verified against live documentation (2026-08-23)

- **The two-list structure of the Colab FAQ**, the exact membership of each list, and the sentence
  that lifts list two for a positive compute balance. Quoted verbatim in
  [§2](#2-the-tos-position-by-tier).
- **`gcloud colab` is GA**, with exactly four command groups, and manages **Colab Enterprise** —
  a Google Cloud product, not consumer Colab. Flag names, defaults (`e2-standard-4`, `3h`,
  `100` GB) and the accelerator enum were read from the `gcloud` reference.
- **The official consumer Colab CLI exists** (`google-colab-cli`, announced 5 June 2026), is
  Linux/macOS-only, and drives undocumented `colab.research.google.com` endpoints rather than a
  public API. This **contradicts the premise this rewrite started from** — see
  [§3](#3-four-ways-to-run-a-gpu-and-which-one-this-repo-ships).
- **Compute capabilities**, from NVIDIA's CUDA GPUs table: T4 **7.5**, L4 **8.9**, A100 **8.0**,
  H100 **9.0**, Quadro RTX 3000 **7.5**. This is what makes the A100 an fp8 exception.

### ❌ Not verified — no Colab session and no GCP project were available

- **The notebook has never been executed.** Not one cell. Colab-specific behaviour —
  `google.colab.drive.mount`, `@param` form rendering, the preinstalled torch surviving
  `pip install -r requirements.txt` — is unrun. **The new GPU-detection branch is unrun on every
  GPU**, including the T4.
- **No fp8 has ever executed on hardware available to this project.** The local card is cc 7.5.
  Every fp8 claim here is architecture-reading, not measurement.
- **The `ComfyUI-GGUF` pin has never been run against ComfyUI v0.33.1.** Its last commit predates
  that release by **seven months**. `UnetLoaderGGUF` / `DualCLIPLoaderGGUF` may not register. Cell 9
  checks for exactly this and tells you; the fix is to bump `COMFYUI_GGUF_COMMIT`. **This is still
  the most likely thing to break — on the T4 and A100 paths. The L4/H100 fp8 path does not use it.**
- **cloudflared has not been run**, so the URL-parsing regex and the WebSocket path through
  Cloudflare's edge are untested. The proxy's WebSocket code was reviewed, not exercised.
- **No T4, L4 or A100 timing, VRAM figure, or output.** Every Colab number in §7 is an estimate,
  and the L4/A100 ones are estimates derived from estimates.
- **Whether FLUX-schnell decomposes characters into parts** — the entire reason FLUX is here — is
  the open question. Unanswered.
- **SDXL on the existing workflows** is reasoned from node signatures, not run. No SDXL model fits
  on 6 GB.
- **No `gcloud colab` command in §3 has been executed.** The `g2-standard-8` + `NVIDIA_L4` pairing
  is GCP's normal machine-family pairing, not a shape read from the Colab Enterprise allowlist.
- **Colab Enterprise's terms were not reviewed by anyone qualified.** No enumerated equivalent of
  the consumer FAQ's list was found under the Google Cloud Platform Terms; "not found" is not
  "absent".

---

## 10. Files

| file                                                                                                                         | what                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [`rivayat-comfyui.ipynb`](rivayat-comfyui.ipynb)                                                                             | The notebook. Every code cell explained by the markdown above it.                                                         |
| [`../comfy-workflows/txt2img-flux-schnell-draft.json`](../comfy-workflows/txt2img-flux-schnell-draft.md)                     | FLUX draft, **GGUF loaders** — the T4 and A100 path.                                                                      |
| [`../comfy-workflows/txt2img-flux-schnell-parts-sheet.json`](../comfy-workflows/txt2img-flux-schnell-parts-sheet.md)         | FLUX parts sheet, GGUF. The research §3 experiment.                                                                       |
| [`../comfy-workflows/txt2img-flux-schnell-fp8-draft.json`](../comfy-workflows/txt2img-flux-schnell-fp8-draft.md)             | **New.** Same graph on **core `UNETLoader`/`DualCLIPLoader`** — the L4 / H100 fp8 path.                                   |
| [`../comfy-workflows/txt2img-flux-schnell-fp8-parts-sheet.json`](../comfy-workflows/txt2img-flux-schnell-fp8-parts-sheet.md) | **New.** The same experiment, fp8.                                                                                        |
| `../comfy-workflows/txt2img-lcm-*.json`, `img2img-lcm-variant.json`                                                          | Unchanged. Run on SDXL as-is.                                                                                             |
| `.env.example`                                                                                                               | Documents `COMFYUI_HOST` as a tunnel URL, plus `COMFYUI_AUTH_TOKEN` and `RV_COMFYUI_REMOTE`. Ships pointing at **local**. |

## Sources

**Colab terms and tiers**

- [Colab FAQ — prohibited activities, the free-tier-only list, and how to lift it](https://research.google.com/colaboratory/faq.html)
- [ComfyUI #1460 — "⚠ No more free Colab for ComfyUI"](https://github.com/comfyanonymous/ComfyUI/issues/1460)
- [Google Colab has started banning Stable Diffusion WebUI users — Hacker News](https://news.ycombinator.com/item?id=35653698)
- [Did Google Ban AI Artists from Running Stable Diffusion on Its Cloud? — Decrypt](https://decrypt.co/197428/google-colab-stable-diffusion-web-ui-ban) (Colab lead: free tier only)

**Automation paths**

- [Introducing the Google Colab CLI — Google Developers Blog, 5 June 2026](https://developers.googleblog.com/introducing-the-google-colab-cli/)
- [`googlecolab/google-colab-cli`](https://github.com/googlecolab/google-colab-cli) — command index, Linux/macOS-only note, accelerator list
- [`gcloud colab` reference](https://cloud.google.com/sdk/gcloud/reference/colab) · [`runtime-templates create`](https://cloud.google.com/sdk/gcloud/reference/colab/runtime-templates/create) · [Create a runtime in Colab Enterprise](https://cloud.google.com/colab/docs/create-runtime) · [Schedule a notebook run](https://cloud.google.com/colab/docs/schedule-notebook-run)
- [Colab Enterprise pricing](https://cloud.google.com/colab/pricing)

**Hardware**

- [NVIDIA CUDA GPUs — compute capability table](https://developer.nvidia.com/cuda-gpus) — T4 7.5, L4 8.9, A100 8.0, H100 9.0, Quadro RTX 3000 7.5
- [NVIDIA Tesla T4 datasheet](https://www.nvidia.com/en-us/data-center/tesla-t4/) — 8.1 FP32 TFLOPS, 65 FP16 TFLOPS, 16 GB GDDR6, 320 GB/s, 70 W
- [NVIDIA L4 datasheet](https://www.nvidia.com/en-us/data-center/l4/) — 30.3 FP32 TFLOPS, 242 FP16/BF16 and 485 FP8 tensor TFLOPS _with sparsity_ (halve for dense), 24 GB, 300 GB/s, 72 W
- [NVIDIA A100 datasheet](https://www.nvidia.com/en-us/data-center/a100/) — 19.5 FP32 TFLOPS, 312 FP16/BF16 tensor TFLOPS dense; **no FP8 row**
- [NVIDIA Quadro RTX 3000 Mobile specifications](https://videocardz.net/nvidia-quadro-rtx-3000-mobile) — 1920 CUDA / 240 tensor, 5.3 FP32 TFLOPS, 336 GB/s
- [ComfyUI — which GPU should I buy](https://github.com/Comfy-Org/ComfyUI/wiki/Which-GPU-should-I-buy-for-ComfyUI) — "20 series (turing): fp16", "30 series (ampere): fp16, bf16", "40 series (ada): fp16, bf16, fp8"

**Models and tunnelling**

- [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) · [FLUX.1-schnell-gguf](https://huggingface.co/city96/FLUX.1-schnell-gguf) · [t5-v1_1-xxl-encoder-gguf](https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf)
- [Kijai/flux-fp8](https://huggingface.co/Kijai/flux-fp8) · [comfyanonymous/flux_text_encoders](https://huggingface.co/comfyanonymous/flux_text_encoders)
- [Cloudflare — TryCloudflare quick tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
- [Kaggle Notebooks GPU quota (30 h/week, T4×2 / P100)](https://www.kaggle.com/general/108481)
