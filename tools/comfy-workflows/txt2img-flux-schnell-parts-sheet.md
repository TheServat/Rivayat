# `txt2img-flux-schnell-parts-sheet.json`

The same FLUX.1-schnell base as [`txt2img-flux-schnell-draft.json`](txt2img-flux-schnell-draft.md),
with a fixed **layout scaffold** in the positive prompt. Remote lane only (Colab T4) — FLUX does
not fit on the 6 GB local card.

**This file exists to test one specific claim.** The SD 1.5 parts sheet
([`txt2img-lcm-parts-sheet.md`](txt2img-lcm-parts-sheet.md)) decomposes props well but
**cannot decompose characters** — it returns six whole figures instead of six body parts. This
workflow is the experiment that asks whether that is a limit of _SD 1.5_ or a limit of the
_parts-sheet idea_.

> **The experiment has not been run.** Everything below marked as reasoning is reasoning. Nothing
> here is a measurement. See [Verification status](#verification-status).

## Why FLUX might succeed where SD 1.5 failed

The SD 1.5 finding was diagnosed as "SD 1.5 has no compositional handle strong enough to override
its prior that _character + reference sheet_ means a turnaround." There is a concrete architectural
reason to think a bigger model changes that, and a concrete reason to doubt it.

**The case for:** the failure is a _prompt-adherence_ failure, and prompt adherence is exactly what
the text encoder buys.

- SD 1.5 conditions on **CLIP-L, 77 tokens**, which behaves close to a bag of words. "six separate
  body parts, not one figure" and "one figure of a character with six parts" are nearly the same
  vector. The negative prompt is doing most of the work, and losing.
- FLUX conditions on **T5-XXL, 512 tokens** — a sequence-to-sequence language encoder that carries
  syntax, negation and spatial relations. Explicit multi-clause layout instructions ("each
  component floats entirely on its own", "no component touches any other") are the kind of
  instruction T5 represents and CLIP-L cannot.
- This is also why **SDXL is not expected to fix it**: SDXL adds OpenCLIP-bigG, but it is still
  CLIP, still 77 tokens, still bag-of-words-ish. Bigger UNet, same handle. If SDXL decomposes
  characters, that would be a surprise; if FLUX does, it would not.

**The case against:** the training prior is the same on every model. "Character reference sheet"
means turnaround in every illustration corpus, and a distilled 4-step model has less capacity to be
argued out of a strong prior than its undistilled parent. FLUX.1-**dev** at 20+ steps may well do
this when schnell at 4 steps will not — but dev is non-commercial-licensed and slower.

Run it and find out. That is what this file is for.

## What is fixed and what the caller owns

The scaffold text in node `4` is **workflow-owned** — it is the layout contract, not a prompt, and
changing it changes what this file means. The caller owns `{{prompt}}`, `{{style}}`, `{{parts}}`,
`{{background}}` and the grid dimensions.

### There is no `{{negative}}`, and that is deliberate

The SD 1.5 sheet leans hard on a fixed negative tail (`single assembled figure, connected limbs,
overlapping components, touching edges, …`). **That tool is not available here.** FLUX.1-schnell is
guidance-distilled and runs at cfg 1.0, so the negative branch carries no weight; node `5` is a
`ConditioningZeroOut` and any negative prompt would be silently inert.

Every separability constraint therefore had to be restated **positively** inside the scaffold —
"floats entirely on its own with a wide empty margin", "No component touches, overlaps, or connects
to any other component", "The subject is never shown assembled". This is the single biggest
authoring difference between the two sheets, and it is only affordable because T5 has 512 tokens to
spend where CLIP-L had 77.

Offering a `{{negative}}` placeholder that did nothing would be worse than not offering one, so
callers extending this workflow must extend the scaffold, not a negative.

## Placeholders

| Placeholder           | Type      | Suggested value                                                 | What it does                                                                                        |
| --------------------- | --------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `{{prompt}}`          | string    | `a worn leather explorer satchel`                               | The subject to decompose. A noun phrase, not a scene.                                               |
| `{{parts}}`           | string    | `main body, shoulder strap, brass buckle, front flap, …`        | Comma-separated component names, in intended reading order (left→right, top→bottom).                |
| `{{style}}`           | string    | `flat vector illustration, clean line art, muted earth palette` | The locked style anchor. Identical across every asset in a series.                                  |
| `{{background}}`      | string    | `flat neutral light grey`                                       | The field the parts sit on. Pick for your matting stage — flat, unsaturated, absent in the subject. |
| `{{grid_cols}}`       | **int**   | `3`                                                             | Advisory column count. Set `width:height` to roughly `grid_cols:grid_rows`.                         |
| `{{grid_rows}}`       | **int**   | `2`                                                             | Advisory row count.                                                                                 |
| `{{seed}}`            | **int**   | `424242`                                                        | Noise seed.                                                                                         |
| `{{steps}}`           | **int**   | `4`                                                             | schnell is distilled to 4. Try 8 for sheets before concluding it cannot do this.                    |
| `{{cfg}}`             | **float** | `1.0`                                                           | **Keep at 1.0.** Unlike the SD 1.5 sheet, you cannot raise this to buy adherence.                   |
| `{{width}}`           | **int**   | `1536`                                                          | Multiple of 16. A 3×2 sheet wants a 3:2 canvas — 1536×1024.                                         |
| `{{height}}`          | **int**   | `1024`                                                          | Multiple of 16.                                                                                     |
| `{{unet}}`            | string    | `flux1-schnell-Q4_K_S.gguf`                                     | Under `models/unet/`.                                                                               |
| `{{t5}}`              | string    | `t5-v1_1-xxl-encoder-Q5_K_M.gguf`                               | Under `models/text_encoders/`.                                                                      |
| `{{clip_l}}`          | string    | `clip_l.safetensors`                                            | Under `models/text_encoders/`.                                                                      |
| `{{vae}}`             | string    | `ae.safetensors`                                                | Under `models/vae/`. FLUX's 16-channel autoencoder.                                                 |
| `{{sampler}}`         | string    | `euler`                                                         | Keep `euler`.                                                                                       |
| `{{scheduler}}`       | string    | `simple`                                                        | Keep `simple`.                                                                                      |
| `{{batch_size}}`      | **int**   | `1`                                                             | Keep at 1.                                                                                          |
| `{{filename_prefix}}` | string    | `rivayat-flux-sheet`                                            | `SaveImage` prefix.                                                                                 |

## Still true regardless of which model wins

Two findings from the SD 1.5 sheet are properties of the _approach_, not of SD 1.5, and carry over:

- **The grid is advisory.** No diffusion model honours an exact `grid_cols × grid_rows` cell count.
  Expect roughly the right density and reading order, never a guaranteed cell map.
  **Do not slice the sheet by arithmetic** — segment by connected components on the neutral field.
- **The fallback chain from research §3 still stands.** If characters still refuse to decompose:
  parts sheet → SAM/BiRefNet decomposition of a rendered figure → single-layer asset animated by
  mesh deform. FLUX is an attempt to widen step 1, not a replacement for steps 2 and 3.

FLUX _is_ expected to beat SD 1.5 on one sub-problem regardless: **gibberish captions**. SD 1.5
"cannot be talked out of" glyphs under sheet cells. FLUX renders real text competently, which
usually also means it can be told not to. Unverified.

## Verification status

Verified against the live local ComfyUI 0.33.0 on 2026-08-23, by the same two-pass method as the
draft workflow:

- Parses as JSON; every link resolves; no placeholder survives substitution; `_meta` strips cleanly;
  numeric placeholders become JSON numbers.
- **Pass A (stubbed loaders):** `POST /prompt` returned `node_errors: {}` — every link, socket index
  and input name in the graph is correct.
- **Pass B (core-node equivalents):** the only errors were `value_not_in_list` on the four model
  filename inputs. Nothing structural.
- A first draft of this file was **rejected** by that check: the string `{{negative}}` appeared
  inside a `_meta.title`, which would have made an adapter scanning the raw file treat `negative`
  as a required parameter. `_meta` is stripped before sending, so it would never have failed at
  runtime — it would just have produced a wrong parameter list. Fixed.

**Not verified:** that the ComfyUI-GGUF loader nodes work under ComfyUI v0.33.1 (see the draft
doc), any timing, and — the entire point of the file — **whether FLUX-schnell actually decomposes
a character into parts.** When someone runs it, replace the reasoning above with the result.
