# `txt2img-flux-schnell-fp8-draft.json`

The **fp8 / bf16 safetensors** twin of
[`txt2img-flux-schnell-draft.json`](txt2img-flux-schnell-draft.md). Same nine nodes, same links,
same semantics — only the two loaders differ:

| node  | GGUF file (`…-draft.json`) | this file                                        |
| ----- | -------------------------- | ------------------------------------------------ |
| **1** | `UnetLoaderGGUF`           | **`UNETLoader`** (core) + a `weight_dtype` input |
| **2** | `DualCLIPLoaderGGUF`       | **`DualCLIPLoader`** (core)                      |

Everything downstream — `VAELoader`, `CLIPTextEncode`, `ConditioningZeroOut`,
`EmptySD3LatentImage`, `KSampler`, `VAEDecode`, `SaveImage` — is byte-identical to the GGUF
version, including `cfg 1.0` and the zeroed negative. Read that file's doc for _why_ the FLUX graph
is shaped this way; this page only covers the delta.

## Why this file exists

**fp8 needs compute capability 8.9.** A T4 is 7.5, which is the whole reason the GGUF variant is
the default — see [`tools/colab/README.md`](../colab/README.md) §5. But Colab Pro can hand you an
**L4 (8.9, Ada)** or an **H100 (9.0, Hopper)**, and on those cards fp8 runs on native tensor cores
with no dequantisation step in the way. GGUF's dequant-to-fp16 pass is pure overhead there.

Two consequences worth having in view:

1. **This graph needs no custom node at all.** The GGUF path depends on
   [`city96/ComfyUI-GGUF`](https://github.com/city96/ComfyUI-GGUF), pinned at a commit seven months
   older than the pinned ComfyUI — the notebook's single most likely breakage. Core `UNETLoader`
   and `DualCLIPLoader` ship with ComfyUI, so the L4/H100 path drops that dependency and can run
   with `--disable-all-custom-nodes` and no whitelist.
2. **`weight_dtype` is a parameter, so this file is also the bf16 path.** On an **A100 (8.0,
   Ampere)** fp8 is not available — Ampere does bf16 but not fp8 — so pass
   `{{weight_dtype}} = default` with bf16 weights. In practice the notebook prefers GGUF `Q8_0` on
   an A100 because the download is 46 % smaller for near-identical quality; this file is there if
   you would rather have the real bf16 tensors.

## Placeholders

Identical to [`txt2img-flux-schnell-draft.md`](txt2img-flux-schnell-draft.md#placeholders) except:

| Placeholder        | Type   | Suggested value                        | What it does                                                                                                               |
| ------------------ | ------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `{{unet}}`         | string | `flux1-schnell-fp8-e4m3fn.safetensors` | Filename under `models/unet/` (ComfyUI aliases that folder to `diffusion_models`). Loaded by core `UNETLoader`.            |
| `{{weight_dtype}}` | string | `fp8_e4m3fn`                           | One of `default`, `fp8_e4m3fn`, `fp8_e4m3fn_fast`, `fp8_e5m2` — the live enum, read from `/object_info` on ComfyUI 0.33.0. |
| `{{t5}}`           | string | `t5xxl_fp8_e4m3fn.safetensors`         | Filename under `models/text_encoders/`. Use `t5xxl_fp16.safetensors` with `{{weight_dtype}} = default`.                    |

`{{clip_l}}` and `{{vae}}` are unchanged: `clip_l.safetensors` and `ae.safetensors`.

> `fp8_e4m3fn_fast` enables ComfyUI's fp8 matmul optimisations. It is **faster and slightly less
> accurate**, and it has not been measured on any card available to this project. Start with
> `fp8_e4m3fn`.

## Verification status

Verified against the live local ComfyUI **0.33.0** on 2026-08-23, by the same method as the GGUF
file:

- **The graph validates end to end.** With the three loaders replaced by a local
  `CheckpointLoaderSimple`'s `MODEL`/`CLIP`/`VAE` outputs, `POST /prompt` returned **HTTP 200,
  `node_errors: {}`** — every link, socket index and input name is correct.
- **Unstubbed, the only errors are missing files.** `POST /prompt` with the real loaders returned
  exactly four `value_not_in_list` errors, on `unet_name`, `clip_name1`, `clip_name2` and
  `vae_name` — nothing structural.
- **`UNETLoader` really does take `weight_dtype`**, and its enum really is
  `['default', 'fp8_e4m3fn', 'fp8_e4m3fn_fast', 'fp8_e5m2']`; `DualCLIPLoader`'s `type` enum really
  does contain `flux`. Both read from live `/object_info`, not from memory.
- Unlike the GGUF file, **there is no unverified custom-node pin here.** Both loaders are core.

**Not verified, and cannot be from this machine:** anything requiring an Ada or Hopper GPU — no
timing, no VRAM figure, no output. fp8 cannot execute on the local Quadro RTX 3000 (7.5), and no
Colab session was available.
