# ComfyUI — the free local draft lane

API-format workflows for the local SD 1.5 + LCM draft lane, plus the measured settings for this
machine. Everything here is parameterised: the ComfyUI adapter substitutes `{{placeholders}}` and
POSTs the result to `/prompt`. No prompt is hard-coded in an adapter.

Per research §2: **local = free draft lane, cloud = paid final lane.** Draft here for free, promote
to a paid model only when an asset is locked.

| File                                                                                                | Purpose                                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`txt2img-lcm-draft.json`](txt2img-lcm-draft.json) · [docs](txt2img-lcm-draft.md)                   | Fast free draft. 4–8 steps, ~1.4 s at 512².                                    |
| [`txt2img-lcm-parts-sheet.json`](txt2img-lcm-parts-sheet.json) · [docs](txt2img-lcm-parts-sheet.md) | Subject decomposed into separated components on a neutral field (research §3). |
| [`img2img-lcm-variant.json`](img2img-lcm-variant.json) · [docs](img2img-lcm-variant.md)             | Colourway / season / damage variant at low denoise.                            |

**Optional remote lane (a Colab GPU — T4 / L4 / A100) — see
[`tools/colab/`](../colab/README.md).** Colab is never required: the local lane above and the cloud
API lane each run the pipeline end to end on their own. Those three files are **not**
SD-1.5-specific: their node graph
(`CheckpointLoaderSimple → LoraLoader → CLIPTextEncode → EmptyLatentImage → KSampler`) has no
version-dependent input, so **SDXL runs on them unchanged** — just pass
`{{checkpoint}} = sd_xl_base_1.0.safetensors`, `{{lora}} = lcm-lora-sdxl.safetensors` and 1024².
_(Reasoned from the node signatures; not run — no SDXL model fits on 6 GB.)_

FLUX cannot reuse them: it needs three separate loaders, a 16-channel `EmptySD3LatentImage`, and it
is guidance-distilled so the negative prompt is inert. Hence four new files, remote lane only — the
same graph twice, once per loader family, because **which one you want depends on the GPU Colab
gives you**:

| File                                                                                                                                       | Purpose                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| [`txt2img-flux-schnell-draft.json`](txt2img-flux-schnell-draft.json) · [docs](txt2img-flux-schnell-draft.md)                               | FLUX.1-schnell draft, **GGUF loaders**. The **T4** (cc 7.5, no fp8) and **A100** (cc 8.0, also no fp8) path. |
| [`txt2img-flux-schnell-parts-sheet.json`](txt2img-flux-schnell-parts-sheet.json) · [docs](txt2img-flux-schnell-parts-sheet.md)             | The §7.2 experiment, GGUF: does a **T5-XXL** encoder decompose characters where CLIP-L cannot?               |
| [`txt2img-flux-schnell-fp8-draft.json`](txt2img-flux-schnell-fp8-draft.json) · [docs](txt2img-flux-schnell-fp8-draft.md)                   | The same draft on **core `UNETLoader` + `DualCLIPLoader`**. The **L4 / H100** fp8 path (cc ≥ 8.9).           |
| [`txt2img-flux-schnell-fp8-parts-sheet.json`](txt2img-flux-schnell-fp8-parts-sheet.json) · [docs](txt2img-flux-schnell-fp8-parts-sheet.md) | The same experiment, fp8.                                                                                    |

**fp8 needs compute capability 8.9** (Ada/Hopper). A T4 is 7.5 and an **A100 is 8.0** — the biggest
card Colab hands out still cannot load an fp8 checkpoint, so it uses GGUF `Q8_0`. The fp8 pair has a
second advantage: both loaders are **core ComfyUI**, so it does not need the `ComfyUI-GGUF` custom
node at all.

All four were validated against the live local ComfyUI 0.33.0 — with the loaders stubbed to a local
checkpoint's MODEL/CLIP/VAE, `POST /prompt` returned `node_errors: {}`; unstubbed, the only errors
were `value_not_in_list` on the missing weight files. **None has ever been executed** — FLUX does not
fit on this card, and fp8 cannot run on it at all (cc 7.5). Details in each doc.

---

## 1. Starting ComfyUI

```powershell
powershell -ExecutionPolicy Bypass -File tools\scripts\comfy-start.ps1
```

```bash
bash tools/scripts/comfy-start.sh
```

Both wrap this exact command, which is the one that was benchmarked:

```
D:\me\tools\ComfyUI\.venv\Scripts\python.exe main.py ^
  --listen 127.0.0.1 ^
  --port 8288 ^
  --disable-auto-launch ^
  --disable-all-custom-nodes ^
  --preview-method none ^
  --output-directory D:\me\story\workspace\cache\comfy\output ^
  --temp-directory  D:\me\story\workspace\cache\comfy\temp ^
  --input-directory D:\me\story\workspace\cache\comfy\input
```

run with `cwd = D:\me\tools\ComfyUI`. Stop it with `comfy-start.ps1 -Stop` / `comfy-start.sh --stop`.

Health check: `GET /system_stats` and `GET /object_info` (892 node types, ~1.6 MB).
Server is ready ~1–6 s after launch; the first image additionally pays the 2.0 GB checkpoint load.

### Why port 8288 and not 8188

**8188 cannot be bound on this machine.** It falls inside a Windows reserved TCP exclusion range
held by WinNAT/Hyper-V, and binding fails with
`PermissionError: [Errno 13] ... an attempt was made to access a socket in a way forbidden by its access permissions`.

```
> netsh interface ipv4 show excludedportrange protocol=tcp
Start Port    End Port
      8163        8262      <-- 8188 is in here
      8463        8762
      8904        9003
      9130        9229
```

8288 is outside every excluded range. Freeing 8188 would need an elevated
`netsh int ipv4 add excludedportrange` reservation plus a reboot — not worth it. The port is a
parameter everywhere (`-Port`, `--port`, `COMFY_PORT`, `--host`), so change it in one place if the
exclusion ranges shift after a reboot.

### Flags we deliberately do _not_ pass

The received wisdom for 6 GB cards is `--lowvram --use-split-cross-attention`. Both are wrong here,
measured rather than assumed:

- **`--lowvram` is a no-op.** ComfyUI 0.33 enables **DynamicVRAM**, and `--lowvram` is documented in
  `cli_args.py` as _"Doesn't do anything if dynamic vram is enabled."_ The log confirms
  `Set vram state to: NORMAL_VRAM` / `DynamicVRAM support detected and enabled`. DynamicVRAM already
  does the offloading, better, based on live pressure.
- **`--use-split-cross-attention` is slower and uses _more_ VRAM.** With torch 2.13 the default
  PyTorch SDPA path wins on both axes. See the comparison table below. It also changes the numerics,
  so it changes every output hash.

---

## 2. Benchmarks — real numbers, this machine

Quadro RTX 3000 (6144 MiB), i7-10850H, 32 GB RAM, torch 2.13.0+cu126, ComfyUI 0.33.0,
`dreamshaper_8` + `lcm-lora-sdv1-5`, `lcm`/`sgm_uniform`, cfg 1.5, seed 424242, batch 1.

Each cell: 3 runs, fixed seed, with ComfyUI's node cache evicted between runs (see §4). Peak VRAM is
whole-GPU `nvidia-smi memory.used` sampled every 200 ms, so it includes ~430 MiB of desktop.

### Recommended configuration (default PyTorch attention)

| Resolution | Steps | s/image    | Peak VRAM | Headroom |
| ---------- | ----- | ---------- | --------- | -------- |
| 512×512    | 4     | **1.42 s** | 3698 MiB  | 2446 MiB |
| 512×512    | 8     | **2.25 s** | 3666 MiB  | 2478 MiB |
| 768×768    | 4     | **3.25 s** | 4818 MiB  | 1326 MiB |
| 768×768    | 8     | **5.30 s** | 4818 MiB  | 1326 MiB |

Reproducibility of the timings themselves: an independent earlier run of the same matrix, before a
process restart, gave 1.42 / 2.37 / 3.33 / 5.29 s — within 0.1 s except the 512²/8 cell.

### `--use-split-cross-attention` (rejected)

| Resolution | Steps | s/image | vs default | Peak VRAM | vs default |
| ---------- | ----- | ------- | ---------- | --------- | ---------- |
| 512×512    | 4     | 1.98 s  | **+39 %**  | 4357 MiB  | +659 MiB   |
| 512×512    | 8     | 2.92 s  | **+30 %**  | 4357 MiB  | +691 MiB   |
| 768×768    | 4     | 4.88 s  | **+50 %**  | 4837 MiB  | +19 MiB    |
| 768×768    | 8     | 8.25 s  | **+56 %**  | 4613 MiB  | −205 MiB   |

### Where 6 GB runs out

| Resolution | Steps | s/image | Peak VRAM | Verdict                                                                                                      |
| ---------- | ----- | ------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| 1024×1024  | 4     | 7.59 s  | 5839 MiB  | Works, at **95 % of the card**. ~300 MiB headroom — a browser or a second CUDA app will OOM it.              |
| 1280×1280  | 4     | 16.2 s  | 5871 MiB  | Completes, but **2.1× the time of 1024²** for 1.6× the pixels: DynamicVRAM is thrashing weights to host RAM. |

Reference VRAM levels: desktop only **430 MiB**; ComfyUI started, no model **~515 MiB**;
ComfyUI idle with the checkpoint resident **2821 MiB**.

---

## 3. Recommended defaults for this GPU

| Setting             | Value                                                    | Why                                                                             |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Resolution (draft)  | **512×512**                                              | 1.4 s/image. Fast enough to iterate conversationally.                           |
| Resolution (review) | **768×768**                                              | 3.3 s/image, still 1.3 GB headroom. **Treat this as the ceiling.**              |
| Resolution (sheets) | **768×512**                                              | 3×2 grid; match canvas aspect to grid aspect.                                   |
| Steps               | **4** blocking / **6** default / **8** sheets & variants | Beyond 8, LCM returns nothing for the time.                                     |
| CFG                 | **1.5** (1.8 for sheets)                                 | LCM territory is 1.0–2.0. Normal SD values (7–8) burn the image out.            |
| Sampler / scheduler | **`lcm` / `sgm_uniform`**                                | The LCM-LoRA pairing. `karras`/`normal` degrade badly at 4 steps.               |
| LoRA strength       | **1.0**                                                  | Below ~0.8 the 4-step schedule falls apart.                                     |
| Batch size          | **1**                                                    | Batching at 768² has no headroom to pay for itself.                             |
| Above 768²          | **go to the cloud lane**                                 | 1024² is possible but leaves no margin, and SD 1.5 composition degrades anyway. |

---

## 4. The placeholder substitution contract

`tools/scripts/comfy-smoke.mjs` is the reference implementation; the adapter must match it.

1. **Typed whole-value substitution.** A JSON string that is _exactly_ `"{{name}}"` and whose name is
   numeric (`seed`, `steps`, `cfg`, `width`, `height`, `lora_strength`, `batch_size`, `denoise`,
   `grid_cols`, `grid_rows`) becomes a **JSON number**. ComfyUI type-checks node inputs and rejects
   `"steps": "4"`.
2. **Textual interpolation elsewhere.** Any other `{{name}}` occurrence is replaced as text, so the
   parts-sheet scaffold can embed placeholders mid-sentence.
3. **No leftovers.** If any `{{...}}` survives substitution, fail loudly rather than sending it.
4. **Strip `_meta`.** The `_meta.title` keys here are documentation; ComfyUI ignores them.

### Beware the node cache

ComfyUI caches node outputs keyed by resolved inputs. **Re-POSTing an identical graph returns the
previous image in ~10 ms without running the sampler.** This silently invalidates both benchmarks
and determinism checks — the first version of the benchmark above reported a fictitious "0.01 s per
image" for exactly this reason.

`comfy-smoke.mjs` handles it by queueing a seed-shifted decoy between measured runs to evict the
sampler's cache entry, and by failing if a repeat run returns in under 25 % of the first run's time.

---

## 5. Smoke test

```bash
node tools/scripts/comfy-smoke.mjs --host http://127.0.0.1:8288
node tools/scripts/comfy-smoke.mjs --repeat 3            # determinism
node tools/scripts/comfy-smoke.mjs --help
```

Plain Node, builtins only — no repo dependency, nothing added to `package.json`. It includes a
~90-line PNG reader (`node:zlib` inflate + scanline unfiltering) so it can assert on pixels without
`sharp`. Output goes to `workspace/cache/smoke/` (gitignored).

Assertions, all fatal:

- ComfyUI reachable, and `{{checkpoint}}` / `{{lora}}` actually present in `/object_info`
- no unsubstituted placeholders; `/prompt` returned no `node_errors`
- the file is a real PNG (signature, IHDR, inflatable IDAT)
- dimensions match the requested `width`×`height`
- **not blank**: max per-channel stddev ≥ 3.0 and ≥ 64 distinct colours
- with `--repeat`: byte-identical `sha256`, and no cache-hit shortcut

**What it does not assert: semantic quality.** A 4-step run without the `ModelSamplingDiscrete`
node produces pure RGB noise, which sails past every check above (stddev 106). These are liveness
and plumbing assertions, not an aesthetic judgement.

---

## 6. Determinism — verified

**It holds, bit-exactly, across a full process restart.** All four benchmark cells produced
byte-identical PNGs (matching `sha256`) before and after ComfyUI was killed and relaunched with the
same flags:

| Cell        | sha256 (stable across restart)                                     |
| ----------- | ------------------------------------------------------------------ |
| 512×512 / 4 | `d116e546f394c340d8a5ee687c69602504ea9beaf96ba9f028334db969a29bbb` |
| 512×512 / 8 | `f7a0b208930c8363faa3769cbea640cfb99e22ec90aeaeada8938ffdb20d7855` |
| 768×768 / 4 | `c8299ec8598dfe9fd1252d29513bdbd3ac11a584ebdb47549529431cfb5bff74` |
| 768×768 / 8 | `3ef2dfea920152c9c3aff7d1d0370310fc931f7afc3c29cb87a681667eb9c525` |

Two caveats the content-addressed store must respect:

1. **Launch flags are part of the determinism key.** Running the identical graph under
   `--use-split-cross-attention` changed _every_ hash. Different attention kernel, different
   floating-point result. Record the launch command next to the spec hash, not just the model id.
2. **This is same-machine determinism.** Nothing here shows the hashes reproduce on a different GPU
   or CUDA version, and with fp16 kernels they very likely will not. Treat local draft hashes as
   valid within one machine profile.

---

## 7. Known limitations on 6 GB

1. **768² is the practical ceiling.** 1024² works at 95 % VRAM with no room for anything else;
   1280² thrashes.
2. **Characters do not decompose into parts.** The parts-sheet workflow produces a costume/turnaround
   sheet for characters, not limbs. Props and objects work well. Details and the fallback chain in
   [`txt2img-lcm-parts-sheet.md`](txt2img-lcm-parts-sheet.md).
3. **The grid in a parts sheet is advisory.** Segment by connected components; never slice by
   arithmetic.
4. **SD 1.5 cannot be talked out of gibberish captions** on sheet layouts, despite the negative.
5. **No SDXL, no FLUX.** As research §0 predicted, this card is the SD 1.5 draft lane and nothing
   heavier.
6. **`--disable-all-custom-nodes` is on.** ComfyUI-Manager is disabled for reproducibility. Any future
   workflow needing a custom node must whitelist it explicitly with `--whitelist-custom-nodes` and
   pin its version, or the determinism claim above lapses.
