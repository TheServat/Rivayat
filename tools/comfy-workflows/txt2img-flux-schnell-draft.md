# `txt2img-flux-schnell-draft.json`

The plain FLUX.1-schnell draft, for the **optional remote** lane only. FLUX does not fit on the 6 GB
Quadro RTX 3000; this workflow exists for the Colab GPUs described in
[`tools/colab/README.md`](../colab/README.md). **This is the GGUF-loader file — the T4 and A100
path.** On an L4 or H100 use [`txt2img-flux-schnell-fp8-draft.json`](txt2img-flux-schnell-fp8-draft.md)
instead.

> **Nothing in this file has been run.** ComfyUI-GGUF is not installed on the local machine
> (`--disable-all-custom-nodes`), and FLUX does not fit on 6 GB. What _has_ been verified is the
> graph itself — see [Verification status](#verification-status). Timings and image quality are
> unverified.

## Why this is a different graph, not a different `{{checkpoint}}`

SDXL runs on the _existing_ [`txt2img-lcm-draft.json`](txt2img-lcm-draft.json) unchanged — same
nodes, different filenames. FLUX cannot, because four things change at once:

|              | SD 1.5 / SDXL                                                | FLUX.1-schnell                                          |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------- |
| Weights      | one `CheckpointLoaderSimple` (UNet + CLIP + VAE in one file) | three loaders: transformer, text encoders, VAE          |
| Text encoder | CLIP-L (+ bigG on SDXL), **77 tokens**                       | **T5-XXL + CLIP-L, 512 tokens**                         |
| Latent       | 4-channel, `EmptyLatentImage`                                | **16-channel, `EmptySD3LatentImage`**                   |
| Guidance     | real CFG, so a negative prompt does work                     | guidance-distilled: **cfg 1.0, the negative is zeroed** |

The last row is the one that bites. `ConditioningZeroOut` is not an optimisation — at cfg 1.0 the
negative branch has no weight, so a negative prompt is _inert_. Anything you would have put in
`{{negative}}` has to be stated positively instead. That is why this workflow has no `{{negative}}`
placeholder at all: offering one would be a lie.

## Why GGUF and not fp8

A T4 is **compute capability 7.5** (Turing). fp8 needs **8.9** (Ada/Hopper). The widely-shared
`flux1-schnell-fp8.safetensors` is therefore the wrong file for this hardware. GGUF weights are
dequantised to fp16 on the fly, and fp16 is exactly what Turing does well.

`Q4_K_S` (6.78 GB) is what fits alongside T5 in a T4's ~15 GB. On a bigger card the notebook pulls
**`Q8_0` (12.69 GB)** into this same graph instead — near-fp16 quality, no workflow change.

**This still holds on an A100**, which surprises people: an A100 is **8.0** (Ampere), so it has
bf16 but _no fp8 path either_. Only **L4 (8.9)** and **H100 (9.0)** can load the fp8 file, and for
those there is a separate graph —
[`txt2img-flux-schnell-fp8-draft.json`](txt2img-flux-schnell-fp8-draft.md) — because fp8
safetensors need core `UNETLoader`/`DualCLIPLoader` rather than the GGUF loaders. The notebook's
`FLUX_VARIANT='auto'` reads `nvidia-smi` and picks for you.

## What is fixed and what the caller owns

Node `4` is a bare `{{prompt}}` — this is the general-purpose draft, so the caller owns the whole
positive prompt. For the layout-scaffolded variant see
[`txt2img-flux-schnell-parts-sheet.md`](txt2img-flux-schnell-parts-sheet.md).

Node `5` (`ConditioningZeroOut`) and node `2`'s `type: "flux"` are workflow-owned. Changing either
changes what this file means.

## Placeholders

| Placeholder           | Type      | Suggested value                   | What it does                                                                                                 |
| --------------------- | --------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `{{prompt}}`          | string    | _(caller)_                        | The full positive prompt. T5 gives you 512 tokens — use natural sentences, not comma-separated keyword soup. |
| `{{unet}}`            | string    | `flux1-schnell-Q4_K_S.gguf`       | Filename under `models/unet/`. Loaded by `UnetLoaderGGUF`.                                                   |
| `{{t5}}`              | string    | `t5-v1_1-xxl-encoder-Q5_K_M.gguf` | Filename under `models/text_encoders/`.                                                                      |
| `{{clip_l}}`          | string    | `clip_l.safetensors`              | Filename under `models/text_encoders/`. Mixing GGUF + safetensors in one `DualCLIPLoaderGGUF` is supported.  |
| `{{vae}}`             | string    | `ae.safetensors`                  | Filename under `models/vae/`. The FLUX 16-channel autoencoder, **not** `sdxl_vae`.                           |
| `{{seed}}`            | **int**   | `424242`                          | Noise seed.                                                                                                  |
| `{{steps}}`           | **int**   | `4`                               | schnell is distilled to 4. Above ~8 it returns nothing for the time.                                         |
| `{{cfg}}`             | **float** | `1.0`                             | **Keep at 1.0.** schnell is guidance-distilled; higher values burn the image out.                            |
| `{{width}}`           | **int**   | `1024`                            | Must be a multiple of 16 (`EmptySD3LatentImage` enforces `step: 16`).                                        |
| `{{height}}`          | **int**   | `1024`                            | Same.                                                                                                        |
| `{{sampler}}`         | string    | `euler`                           | Keep `euler`.                                                                                                |
| `{{scheduler}}`       | string    | `simple`                          | Keep `simple`. `sgm_uniform` is the LCM pairing and does not belong here.                                    |
| `{{batch_size}}`      | **int**   | `1`                               | Keep at 1 on a T4 at 1024².                                                                                  |
| `{{filename_prefix}}` | string    | `rivayat-flux`                    | `SaveImage` prefix.                                                                                          |

Numeric placeholders (`seed`, `steps`, `cfg`, `width`, `height`, `batch_size`) are substituted as
**JSON numbers**, per the contract in [`README.md`](README.md) §4. `denoise` is hard-coded to `1`.

## Verification status

Verified against the live local ComfyUI 0.33.0 on 2026-08-23:

- Parses as JSON; every link resolves to an existing node and socket.
- Substituting every placeholder leaves no `{{...}}` behind, and `_meta` strips cleanly.
- **The graph validates.** With the three loaders replaced by a local `CheckpointLoaderSimple`'s
  `MODEL`/`CLIP`/`VAE` outputs, `POST /prompt` returned `node_errors: {}` — so every link, socket
  index and input _name_ in the rest of the graph is correct.
- With `UnetLoaderGGUF`→`UNETLoader` and `DualCLIPLoaderGGUF`→`DualCLIPLoader` (their core
  equivalents), the only errors returned were `value_not_in_list` on `unet_name`, `clip_name1`,
  `clip_name2` and `vae_name` — i.e. the missing weight files, and nothing structural.

**Not verified, and cannot be from this machine:**

- That `UnetLoaderGGUF` / `DualCLIPLoaderGGUF` register and accept these input names. They are
  ComfyUI-GGUF nodes, pinned in the notebook at `6ea2651e`, whose last commit (2026-01-12) predates
  ComfyUI v0.33.1 (2026-08-13) by seven months. **This pin has never been run against this ComfyUI
  release.**
- Any timing, VRAM figure or output quality.
