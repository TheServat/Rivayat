# cfg-lane — the same three graphs with the LCM distillation switched off

`RV_COMFYUI_WORKFLOW_DIR` is a directory and `loadComfyWorkflows` reads three fixed filenames out
of it, so a deployment can swap the whole graph set without a code change. This directory is that
swap, and it exists for one measured reason:

**LCM buys speed with prompt adherence, and style _is_ prompt adherence.**

`tools/scripts/style-sweep.mjs` ran the eleven presets over two sampler regimes. On the LCM regime
(`lora_strength 1.0`, `ModelSamplingDiscrete(lcm)`, 8 steps, cfg 1.8) `dreamshaper_8` returns a
photoreal product render for most subjects and ignores most of the prompt past the noun. On the
full-CFG regime (`lora_strength 0`, `ModelSamplingDiscrete(eps)`, 24 steps, cfg 7.0,
`dpmpp_2m`/`karras`) the same prompts come back genuinely flat-vector and much closer to what was
asked for. The cost is 3–4× the seconds per image: 512² goes from ~2.5 s to ~8 s, which on a
five-asset episode is nothing.

The filenames still read `…-lcm-…` because `COMFY_WORKFLOW_FILES` in
`packages/providers/src/adapters/comfyui/load-workflows.ts` names them, and that package has an
owner. The **contents** are not LCM here. The only edit against the parent directory's files is:

```diff
   "3": {
     "class_type": "ModelSamplingDiscrete",
     "inputs": {
       "model": ["2", 0],
-      "sampling": "lcm",
+      "sampling": "eps",
       "zsnr": false
     }
   }
```

`lora_strength: 0` makes `LoraLoader` a pass-through, so the LCM LoRA is loaded and contributes
nothing. The node stays in the graph so the two regimes differ by four numbers and one enum rather
than by graph shape, which keeps them comparable.

## Use

```js
const workflows = await loadComfyWorkflows(join(root, 'tools', 'comfy-workflows', 'cfg-lane'));
new ComfyUiAdapter({
  workflows,
  defaults: { steps: 24, cfg: 7.0, sampler: 'dpmpp_2m', scheduler: 'karras', lora_strength: 0 },
  partsSheetDefaults: { steps: 24, cfg: 7.0 },
});
```

## ⚠ Switching regimes inside one ComfyUI session returns pure noise

ComfyUI 0.33.0 does **not** fully unpatch `lcm-lora-sdv1-5` when the next graph in the same session
asks for `strength 0.0` and `sampling: "eps"`. The sampler then runs a still-distilled UNet at
cfg 7 and the decode is RGB noise. Reproduced deterministically three times:

| order                                                         | result      |
| ------------------------------------------------------------- | ----------- |
| lcm `strength 1.0`, 8 steps, cfg 1.8                          | clean image |
| eps `strength 0.0`, 24 steps, cfg 7.0, straight after         | **noise**   |
| the same eps graph after `POST /free {"unload_models": true}` | clean image |

So any harness that mixes the two regimes must unload the model on the switch.
`tools/scripts/style-sweep.mjs` orders its cells regime-major and calls `/free` between groups for
exactly this reason; `tools/scripts/episode-produce.mjs` calls `/free` once before it starts.

## The parts-sheet graph here is a **single-subject** scaffold, not an exploded view

`txt2img-lcm-parts-sheet.json` in the parent directory opens with `exploded view item sheet,
disassembled parts of …` and closes with `game asset icon sheet, inventory icons`. That scaffold is
correct for its job and it is the wrong scaffold for a single cutout: asked for one kite it returns
a tray of thirty small icons, and asked for one skyline it returns a collage.

The copy here keeps the same five slots and replaces the scaffold with the shape that was measured
to work, an A/B over six subjects on the same seeds (`workspace/tmp/probe/ab`):

| prompt shape                                                                | what came back                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **A** — `composeGenerationRequest(..., 'clip-77')`, 484–683 chars           | a 3D house, an anime portrait, an ornament, an abstract clock face |
| **B** — `description, style×4, "one single subject alone …"`, 343–415 chars | a row of domed buildings, a diamond kite, a standing figure        |

Both went to the same graph with the same negative and the same seed, so the difference is the
prompt. The mechanism is research §2's: SD 1.5 conditions on CLIP-L at 77 tokens, and A spends its
first window on `layoutClause` + `description` + `SUBJECT_CLAUSES[subjectClass]` — the subject
clause alone is 232 characters for `character` and carries a hex ramp — so the style clause and the
end of the description land in windows 2 and 3 where they are diluted rather than truncated.

**A caller that uses this directory must therefore route every asset through the parts-sheet port**
(`decomposition: 'parts-sheet'`), because that port is the only one that hands the graph its slots
separately. `generateImage` receives one already-concatenated prose string and this scaffold cannot
reorder it. `tools/scripts/episode-produce.mjs` passes a `DecompositionPolicy` whose fallback route
is `parts-sheet` for exactly that reason, with `archetype: 'rigid-prop'` so the plan is one part and
`{{parts}}`/`{{grid_cols}}`/`{{grid_rows}}` go unused.

The real fix is upstream and belongs to `packages/asset-engine`: `request-composer.ts`'s `clip-77`
branch should put the compiled style ahead of `SUBJECT_CLAUSES`, or the lane should reach
`PromptFragments.byModel` — which already compiles a proper 215-character tag form for exactly this
encoder and is unreachable in production because it is keyed `comfyui:sd1.5-lcm` while
`ComfyUiAdapter.modelRef` reports `comfyui:dreamshaper_8.safetensors`.
