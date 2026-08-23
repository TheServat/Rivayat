# `txt2img-flux-schnell-fp8-parts-sheet.json`

The **fp8 / bf16 safetensors** twin of
[`txt2img-flux-schnell-parts-sheet.json`](txt2img-flux-schnell-parts-sheet.md). The layout
scaffold, the zeroed negative, the grid contract and every placeholder except three are identical —
read that file's doc for the experiment this workflow exists to run. The only difference is the
loader pair:

| node  | GGUF file (`…-parts-sheet.json`) | this file                                        |
| ----- | -------------------------------- | ------------------------------------------------ |
| **1** | `UnetLoaderGGUF`                 | **`UNETLoader`** (core) + a `weight_dtype` input |
| **2** | `DualCLIPLoaderGGUF`             | **`DualCLIPLoader`** (core)                      |

## Why a second copy instead of a switch

Because the parts-sheet experiment is the one thing this whole lane exists to answer, and it must
be runnable on whatever GPU Colab hands you. On a **T4 (compute capability 7.5)** fp8 does not
exist and GGUF is the only FLUX that runs; on an **L4 (8.9)** or **H100 (9.0)** fp8 runs on native
tensor cores and GGUF's dequantise-to-fp16 pass is pure overhead. Two loaders, two files — see
[`tools/colab/README.md`](../colab/README.md) §5 for the GPU→file table.

A useful side effect: this graph uses **only core nodes**, so it does not depend on
[`city96/ComfyUI-GGUF`](https://github.com/city96/ComfyUI-GGUF) — the pinned custom node that is
the notebook's most likely breakage.

## Placeholders

Identical to
[`txt2img-flux-schnell-parts-sheet.md`](txt2img-flux-schnell-parts-sheet.md#placeholders) except:

| Placeholder        | Type   | Suggested value                        | What it does                                                                                                               |
| ------------------ | ------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `{{unet}}`         | string | `flux1-schnell-fp8-e4m3fn.safetensors` | Filename under `models/unet/` (aliased to `diffusion_models`). Loaded by core `UNETLoader`.                                |
| `{{weight_dtype}}` | string | `fp8_e4m3fn`                           | One of `default`, `fp8_e4m3fn`, `fp8_e4m3fn_fast`, `fp8_e5m2` — the live enum, read from `/object_info` on ComfyUI 0.33.0. |
| `{{t5}}`           | string | `t5xxl_fp8_e4m3fn.safetensors`         | Filename under `models/text_encoders/`. Pair `t5xxl_fp16.safetensors` with `{{weight_dtype}} = default` for bf16.          |

There is still **no `{{negative}}`**, for the same reason as the GGUF sheet: node `5` is a
`ConditioningZeroOut` and schnell runs at cfg 1.0, so a negative prompt would be inert. Every
separability constraint is stated positively inside the scaffold.

## Verification status

Verified against the live local ComfyUI **0.33.0** on 2026-08-23:

- **The graph validates end to end.** With the three loaders stubbed by a local
  `CheckpointLoaderSimple`'s `MODEL`/`CLIP`/`VAE` outputs, `POST /prompt` returned **HTTP 200,
  `node_errors: {}`**.
- **Unstubbed, the only errors are the four missing weight files** (`value_not_in_list` on
  `unet_name`, `clip_name1`, `clip_name2`, `vae_name`). Nothing structural.
- The scaffold substitutes cleanly — no `{{…}}` survives, and no placeholder leaks into a `_meta`
  title (the defect that the equivalent check caught in the GGUF sheet).
- **No unverified custom-node pin.** Both loaders are core ComfyUI.

**Not verified:** the experiment itself. Whether FLUX.1-schnell decomposes a _character_ into parts
is still unanswered — no Colab session was available, and FLUX does not fit on the 6 GB local card
at any precision. And nothing fp8 has ever executed on hardware available to this project: the
local Quadro RTX 3000 is compute capability 7.5.
