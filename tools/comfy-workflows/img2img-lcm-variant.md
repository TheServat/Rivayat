# `img2img-lcm-variant.json`

Takes a locked base image and produces a **variant** — colourway, season, damage state, wear pass —
at low denoise, so the composition survives and only the delta changes.

This is the "variants are cheap edits, not regenerations" path. A variant must not re-roll the
asset: if the silhouette moves, downstream rigs, atlases and masks all invalidate.

## Graph

```
LoadImage ─> ImageScale ─> VAEEncode ─┐
CheckpointLoaderSimple ─> LoraLoader ─┴─> ModelSamplingDiscrete("lcm") ─> KSampler ─> VAEDecode ─> SaveImage
                                       └─> CLIPTextEncode ×2 ─────────────┘
```

`ImageScale` (lanczos, `crop: disabled`) normalises the base to the target latent size, so the
caller does not have to pre-resize and the workflow cannot be fed a non-multiple-of-8 image.

## Uploading the base image

`LoadImage` reads by filename from ComfyUI's **input** directory. The adapter must upload first:

```bash
curl -X POST http://127.0.0.1:8288/upload/image \
  -F "image=@/path/to/base.png;filename=base-satchel.png" \
  -F "overwrite=true" -F "type=input"
# -> {"name": "base-satchel.png", "subfolder": "", "type": "input"}
```

Pass the returned `name` as `{{image}}`. With `comfy-start.*` the input directory is
`workspace/cache/comfy/input/`, so dropping a file there works too.

## The denoise / steps interaction — the one thing to get right

LCM's _effective_ step count is `steps × denoise`. At `denoise 0.35` with `steps 4` you get
**1.4 effective steps** and mush. Keep `steps × denoise >= 4`:

| Intent                     | `denoise` | `steps` | Effective |
| -------------------------- | --------- | ------- | --------- |
| Wear / grime / damage pass | 0.30      | 14      | 4.2       |
| Colourway, palette shift   | 0.45      | 12      | 5.4       |
| Season / material change   | 0.55      | 12      | 6.6       |
| Loose reinterpretation     | 0.70      | 10      | 7.0       |

Above ~0.6 the composition starts to drift and the variant stops being a cheap edit.

## Placeholders

| Placeholder           | Type      | Default used by the smoke script                | What it does                                                                                                  |
| --------------------- | --------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `{{image}}`           | string    | `""` — **must be supplied**                     | Filename in ComfyUI's input directory.                                                                        |
| `{{prompt}}`          | string    | _(test prompt)_                                 | The **base** description. Should match what generated the base image.                                         |
| `{{variant}}`         | string    | `autumn colourway, warm rust and ochre palette` | The delta, appended to `{{prompt}}`. This is the only thing that should change between variants of one asset. |
| `{{negative}}`        | string    | _(the shared quality negative)_                 | Negative conditioning.                                                                                        |
| `{{denoise}}`         | **float** | `0.4`                                           | How much of the base to discard. See the table above.                                                         |
| `{{seed}}`            | **int**   | `424242`                                        | Hold this constant across a variant family so the only difference is `{{variant}}`.                           |
| `{{steps}}`           | **int**   | `6`                                             | Use **12** here, not the draft default — see the effective-steps table.                                       |
| `{{cfg}}`             | **float** | `1.5`                                           | 1.5–2.0.                                                                                                      |
| `{{width}}`           | **int**   | `512`                                           | Target size; the base is rescaled to it.                                                                      |
| `{{height}}`          | **int**   | `512`                                           | Target size.                                                                                                  |
| `{{checkpoint}}`      | string    | `dreamshaper_8.safetensors`                     | **Must match the checkpoint that produced the base image**, or the variant fights the base's style.           |
| `{{lora}}`            | string    | `lcm-lora-sdv1-5.safetensors`                   | Filename under `models/loras/`.                                                                               |
| `{{lora_strength}}`   | **float** | `1.0`                                           | Both model and CLIP strength.                                                                                 |
| `{{sampler}}`         | string    | `lcm`                                           | Keep `lcm`.                                                                                                   |
| `{{scheduler}}`       | string    | `sgm_uniform`                                   | Keep `sgm_uniform`.                                                                                           |
| `{{filename_prefix}}` | string    | `rivayat-smoke`                                 | `SaveImage` prefix.                                                                                           |

No `{{batch_size}}`: the latent comes from the base image, not `EmptyLatentImage`.

## Verified invocation

```bash
curl -X POST http://127.0.0.1:8288/upload/image \
  -F "image=@workspace/cache/smoke/base.png;filename=base-satchel.png" \
  -F "overwrite=true" -F "type=input"

node tools/scripts/comfy-smoke.mjs \
  --workflow tools/comfy-workflows/img2img-lcm-variant.json \
  --image base-satchel.png \
  --prompt "exploded view item sheet, disassembled leather explorer satchel parts, flat vector illustration, muted palette, isolated pieces on neutral background" \
  --variant "frost-bitten winter colourway, pale blue-grey leather, rime frost on the brass, cold desaturated palette" \
  --denoise 0.45 --steps 12 --cfg 1.8 --width 768 --height 512 --seed 7
```

5.0 s, 768×512. Layout and piece positions preserved; palette shifted cool. Note that at
`denoise 0.45` SD 1.5 shifts palette **conservatively** — a full colourway swap wants 0.55–0.6,
traded against composition drift.
