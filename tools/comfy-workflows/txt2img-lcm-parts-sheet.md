# `txt2img-lcm-parts-sheet.json`

Same SD 1.5 + LCM base as the draft workflow, but the positive prompt carries a fixed **layout
scaffold** that asks for a subject decomposed into named, separated components on a flat neutral
field, laid out in a grid.

This implements research §3: _ask the image model for parts by design, rather than fighting to
decompose a finished render._ Pieces that were never joined do not need to be cut apart.

## What is fixed and what the caller owns

The scaffold text in node `4` is **workflow-owned** — it is the layout contract, not a prompt, and
changing it changes what this file means. The caller owns `{{prompt}}`, `{{style}}`, `{{parts}}`,
`{{background}}` and the grid dimensions.

The negative in node `5` is `{{negative}}` **plus** a fixed separability tail
(`single assembled figure, connected limbs, overlapping components, touching edges, cast shadow,
text, label, …`). Callers extend it through `{{negative}}`; they cannot remove it.

## Measured behaviour — read before relying on this

Tested on the real graph, not assumed:

- **Props, objects, equipment and garments decompose well.** A "worn leather explorer satchel" with
  `parts = main satchel body, shoulder strap, brass buckle, front flap, side pocket, compass charm`
  produced genuinely detached pieces — body, straps, buckles, tags — isolated on a flat cream field
  with wide gaps. Directly usable as a matting/atlas source.
- **Characters do not decompose.** The same scaffold on a "desert nomad courier" with
  `parts = hooded head, torso tunic, left arm, …` produced a **costume variant sheet** — six whole
  figures — not six body parts. SD 1.5 has no compositional handle strong enough to override its
  prior that "character + reference sheet" means a turnaround.
- **The grid is advisory.** SD 1.5 will not honour an exact `grid_cols × grid_rows` cell count.
  Expect roughly the right density and reading order, never a guaranteed cell map. **Do not slice
  the sheet by arithmetic** — segment by connected components on the neutral field.
- **Gibberish glyphs appear** under cells despite `text, label, caption, letters` in the negative.
  SD 1.5 cannot be fully talked out of captions on a sheet layout. Crop or mask them.

So the fallback chain from research §3 stands, and for characters you skip straight to step 2 or 3:

1. parts sheet (this workflow) — good for props/objects
2. SAM / BiRefNet decomposition of a rendered figure
3. single-layer asset, animated by mesh deform

For character parts specifically, the cloud lane (multi-reference conditioning) is the honest
answer; this workflow is not it.

## Placeholders

| Placeholder           | Type      | Default used by the smoke script                                | What it does                                                                                                            |
| --------------------- | --------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `{{prompt}}`          | string    | _(test subject)_                                                | The subject to decompose. A noun phrase — "a worn leather explorer satchel" — not a scene.                              |
| `{{parts}}`           | string    | `head, torso, left arm, right arm, left leg, right leg`         | Comma-separated component names, in intended reading order (left→right, top→bottom).                                    |
| `{{style}}`           | string    | `flat vector illustration, clean line art, muted earth palette` | The locked style anchor. Should be identical across every asset in a series.                                            |
| `{{background}}`      | string    | `flat neutral light grey`                                       | The field the parts sit on. Pick for your matting stage — a flat, unsaturated field that does not occur in the subject. |
| `{{grid_cols}}`       | **int**   | `3`                                                             | Advisory column count. Set `width:height` to roughly `grid_cols:grid_rows`.                                             |
| `{{grid_rows}}`       | **int**   | `2`                                                             | Advisory row count.                                                                                                     |
| `{{negative}}`        | string    | _(the shared quality negative)_                                 | Prepended to the fixed separability tail.                                                                               |
| `{{seed}}`            | **int**   | `424242`                                                        | Noise seed.                                                                                                             |
| `{{steps}}`           | **int**   | `6`                                                             | Use **8** here — sheets have more independent structure to resolve than a single subject.                               |
| `{{cfg}}`             | **float** | `1.5`                                                           | Use **1.8** here: the layout scaffold needs slightly more adherence than a plain draft.                                 |
| `{{width}}`           | **int**   | `512`                                                           | Use **768** for a 3×2 sheet.                                                                                            |
| `{{height}}`          | **int**   | `512`                                                           | Use **512** for a 3×2 sheet.                                                                                            |
| `{{checkpoint}}`      | string    | `dreamshaper_8.safetensors`                                     | Filename under `models/checkpoints/`.                                                                                   |
| `{{lora}}`            | string    | `lcm-lora-sdv1-5.safetensors`                                   | Filename under `models/loras/`.                                                                                         |
| `{{lora_strength}}`   | **float** | `1.0`                                                           | Both model and CLIP strength.                                                                                           |
| `{{sampler}}`         | string    | `lcm`                                                           | Keep `lcm`.                                                                                                             |
| `{{scheduler}}`       | string    | `sgm_uniform`                                                   | Keep `sgm_uniform`.                                                                                                     |
| `{{batch_size}}`      | **int**   | `1`                                                             | Keep at 1 at sheet resolutions.                                                                                         |
| `{{filename_prefix}}` | string    | `rivayat-smoke`                                                 | `SaveImage` prefix.                                                                                                     |

## Verified invocation

```bash
node tools/scripts/comfy-smoke.mjs \
  --workflow tools/comfy-workflows/txt2img-lcm-parts-sheet.json \
  --prompt "a worn leather explorer satchel" \
  --style "flat vector illustration, clean line art, muted earth palette, 2d game asset" \
  --parts "main satchel body, shoulder strap, brass buckle, front flap, side pocket, small compass charm" \
  --grid-cols 3 --grid-rows 2 --width 768 --height 512 --steps 8 --cfg 1.8 --seed 7
```

3.4 s, 768×512, passed all assertions.
