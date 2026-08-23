# `txt2img-lcm-draft.json`

The fast free draft path: SD 1.5 (DreamShaper 8) + LCM LoRA, 4–8 steps, `lcm` sampler,
`sgm_uniform` scheduler, CFG ~1.5. Roughly **1.4 s per 512×512 image** on the Quadro RTX 3000.

Use it for composition, blocking, style probing and anything that will be thrown away.
Promote a locked asset to the paid cloud lane; never ship a draft.

## Graph

```
CheckpointLoaderSimple ─┬─> LoraLoader ─┬─> ModelSamplingDiscrete("lcm") ─> KSampler ─> VAEDecode ─> SaveImage
                        │               ├─> CLIPTextEncode (positive) ────────┘  ▲
                        │               └─> CLIPTextEncode (negative) ───────────┤
                        └─ VAE ──────────────────────────────────────────────────┘
                                                EmptyLatentImage ────────────────┘
```

**Node `3` (`ModelSamplingDiscrete`, `sampling: "lcm"`) is load-bearing, not decoration.**
Removed, the same graph at 4 steps produces pure RGB noise — measured, not assumed. It swaps the
model's sigma schedule for the 50-timestep distilled one that LCM-LoRA was trained against.
Do not "simplify" it away.

## Placeholders

| Placeholder           | Type      | Default used by the smoke script                                                                        | What it does                                                                                                          |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `{{prompt}}`          | string    | _(a pocket-watch test prompt)_                                                                          | Positive conditioning. Caller owns it entirely.                                                                       |
| `{{negative}}`        | string    | `blurry, low quality, jpeg artifacts, watermark, signature, text, deformed, extra limbs, oversaturated` | Negative conditioning.                                                                                                |
| `{{seed}}`            | **int**   | `424242`                                                                                                | Noise seed. Fixed seed ⇒ byte-identical PNG (verified across process restarts).                                       |
| `{{steps}}`           | **int**   | `6`                                                                                                     | Denoising steps. 4 is usable, 6 is the sweet spot, 8 is the point of diminishing returns. Above ~8 LCM gains nothing. |
| `{{cfg}}`             | **float** | `1.5`                                                                                                   | Guidance. LCM needs **1.0–2.0**. At normal SD values (7–8) LCM output burns out.                                      |
| `{{width}}`           | **int**   | `512`                                                                                                   | Multiple of 8.                                                                                                        |
| `{{height}}`          | **int**   | `512`                                                                                                   | Multiple of 8.                                                                                                        |
| `{{checkpoint}}`      | string    | `dreamshaper_8.safetensors`                                                                             | Filename under `models/checkpoints/`.                                                                                 |
| `{{lora}}`            | string    | `lcm-lora-sdv1-5.safetensors`                                                                           | Filename under `models/loras/`. Must match the checkpoint's base architecture.                                        |
| `{{lora_strength}}`   | **float** | `1.0`                                                                                                   | Applied to both `strength_model` and `strength_clip`. Below ~0.8 the 4-step schedule falls apart.                     |
| `{{sampler}}`         | string    | `lcm`                                                                                                   | Anything in `KSampler.SAMPLERS`, but `lcm` is the only correct choice with this LoRA.                                 |
| `{{scheduler}}`       | string    | `sgm_uniform`                                                                                           | `sgm_uniform` is the LCM pairing. `karras` and `normal` degrade badly at 4 steps.                                     |
| `{{batch_size}}`      | **int**   | `1`                                                                                                     | Latents per run. Keep at 1 at 768 px and above — see the VRAM table in `README.md`.                                   |
| `{{filename_prefix}}` | string    | `rivayat-smoke`                                                                                         | `SaveImage` prefix; also selects the output subfolder if it contains `/`.                                             |

Types marked **int** / **float** must reach ComfyUI as JSON numbers, not strings — ComfyUI
type-checks node inputs and rejects `"steps": "4"`. See the substitution contract in `README.md`.

## Determinism key

Identical bytes require all of: `{{seed}}`, `{{steps}}`, `{{cfg}}`, `{{width}}`, `{{height}}`,
`{{sampler}}`, `{{scheduler}}`, `{{prompt}}`, `{{negative}}`, `{{checkpoint}}`, `{{lora}}`,
`{{lora_strength}}` — **plus the ComfyUI launch flags**, because the attention backend is part of
the numerics. Switching to `--use-split-cross-attention` changes every hash. Record the launch
command alongside the spec hash.
