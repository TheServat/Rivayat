# The cloud GPU lane

Prices live-checked 2026-08-24. Per `CLAUDE.md`, do not "correct" these from memory —
re-check them.

**Decision: try Comfy Cloud first, with a RunPod Pod as the proven fallback.**

This supersedes [Colab](07-colab-cli-lane.md) as the primary art lane. Colab stays as a
free fallback for experiments, because it is already built.

---

## The fact that decides it

**Our workload is bursty, and by a lot.** An episode needs roughly 20–40 images, then the
GPU is idle for hours while assets are matted, rigged, animated, rendered and iterated on.
Generation is maybe **15–25 minutes of actual GPU time per episode**.

Every other consideration is secondary to that shape. Hourly billing charges for the hours
you spend thinking; per-second billing does not.

---

## Comfy Cloud — the official one, and the best value found

`cloud.comfy.org`, from the ComfyUI team.

|             |                                                                                 |
| ----------- | ------------------------------------------------------------------------------- |
| Standard    | **$16/mo** → 4,200 credits → **4.4 GPU hours**                                  |
| Creator     | $28/mo → 7,400 credits → 7.7 hours                                              |
| Pro         | $80/mo → 21,100 credits → 22 hours                                              |
| Rate        | **0.266 credits/second**, cut from 0.39 on 2026-01-23 after GPU costs fell 30 % |
| Hardware    | **RTX 6000 Pro Blackwell — 96 GB VRAM**, 180 GB RAM, roughly **2× an A100**     |
| Free tier   | 5 runs on real GPUs, no card                                                    |
| API         | API key from `platform.comfy.org`, workflows run programmatically               |
| Concurrency | 1 / 3 / 5 on Standard / Creator / Pro                                           |
| Credits     | Plan credits reset monthly and do **not** roll over. Top-ups persist one year.  |

**Per GPU hour that is $3.64** — which looks expensive next to RunPod until you divide by
what the card does. At roughly 2× an A100, it is about **$1.82/hr of A100-equivalent work,
against RunPod Serverless A100 at $2.72/hr**, and it comes with 96 GB instead of 80.

**Costed for us:** 35 images at ~10 s each on that card is ~6 minutes, ~93 credits. Standard's
4,200 credits is therefore around **45 episodes a month for $16** — roughly **$0.36 an
episode**, with no infrastructure to run and nothing to remember to switch off.

**And it appears to serve the native ComfyUI API.** The documented free-tier restrictions
name `/api/prompt`, `/api/view`, `/api/upload/*` and `/api/object_info` as returning 403 —
which are precisely the paths our adapter already speaks. If that holds on a paid account,
this is a base URL and an auth header, **not a new adapter**.

### The one thing I could not verify, and it is the one that matters

**Whether Comfy Cloud will run our checkpoint and our graph.**

A managed service owns its ComfyUI version and its node set. Ours does not merely prefer to
own those — it pins ComfyUI to a commit, launches with `--disable-all-custom-nodes`, and
verifies every model by sha256, because `docs/00-research.md` records the launch flags as
part of the determinism key. Handing that to a service is a real trade against the second
non-negotiable, not a detail.

Two specific unknowns:

1. Can we use an arbitrary checkpoint? SDXL base 1.0 is standard enough to be near-certain,
   but a fine-tune we choose later is not.
2. Does the graph run unchanged, including the parts-sheet workflow with its separability
   scaffold?

**$16 answers both empirically, and the free tier's 5 runs may answer them for nothing.**
That is cheaper than any amount of further reading, so the recommendation is to spend it
rather than to keep researching.

---

## RunPod — the fallback, and the one that needs no permission

If Comfy Cloud refuses our graph or our checkpoint, RunPod is the answer, and a **Pod**
specifically: a persistent VM where you get a real ComfyUI on a real port, so **our adapter
works unchanged**.

| GPU       | VRAM  | community $/hr |
| --------- | ----- | -------------- |
| RTX A5000 | 24 GB | **0.27**       |
| A40       | 48 GB | **0.44**       |
| L4        | 24 GB | 0.49           |
| RTX 4090  | 24 GB | 0.74           |
| L40S      | 48 GB | 0.99           |
| A100 PCIe | 80 GB | 1.39           |

The A40 is the value outlier: **48 GB for less than a 4090's 24 GB.** Slower per image, but
VRAM is what decides which models exist, and that is the ceiling we are lifting.

**Serverless**, billed per second of active execution, zero when idle: L4 $0.69/hr,
RTX 4090 $1.10, L40S $1.75, A100 $2.72, H100 $4.79. Storage $0.05–0.07/GB/month.

Serverless matches our cost model exactly — `quoteImage` returns a real number and the
guard runs before the call, whereas **an hourly pod cannot attribute an hour to an image**.
But it needs a new adapter: `worker-comfyui` takes `{"input": {"workflow": …}}` at
`/run`, where ours speaks `POST /prompt` and `GET /history`. The expensive artefact
survives — that worker consumes the **same native workflow JSON** we already have — so it is
a transport change behind an existing port, not a redesign.

**Cold starts, corrected against the marketing.** RunPod advertises sub-second FlashBoot;
measured reality for ComfyUI is **20–60 s cold**, 10–30 s warm with a network volume.
FlashBoot snapshots what is already in the worker process at scale-to-zero, and ComfyUI
loads models lazily on first request, so the headline does not apply to us. Across a batch
of 35 that amortises to nothing; on a single image it doubles the wall time.

---

## Rejected, with reasons

**comfy.icu** — a fully managed serverless ComfyUI with 2,000 models preinstalled and a real
API. Priced at 10,000 credits per dollar: L4 9 credits/s (**$3.24/hr**), L40S 32 (**$11.52**),
H100 64 (**$23.04**). That is **3–5× RunPod** for the same silicon. The management is real
but it is not worth five times an H100.

**Vast.ai** is genuinely cheaper than RunPod — an L40 at $0.31/hr against $0.69 — and is
declined on reproducibility, not convenience. It is a marketplace of individual hosts with
varying drivers, and at fifteen minutes an episode the saving is a few cents while the
reproducibility is the product.

**fal.ai** bills per image ($0.01–0.08), which is the right shape, but its ComfyUI
custom-node support is documented as incomplete and it is built around model endpoints
rather than "run my graph". The graph is where the style-fidelity work lives.

**Modal** has the right billing model, but we would write and maintain the container.
RunPod ships `worker-comfyui` and maintains it.

**Monthly commitments in general**: Comfy Cloud's $16 is an exception worth making because
it buys 45 episodes, not a reserved machine. Reserved monthly GPU capacity is still wrong
for us — it wins at sustained utilisation, and "generate once, reuse forever" is an argument
for the opposite.

---

## The plan

1. **Spend the free 5 runs on Comfy Cloud** with our parts-sheet workflow and whichever
   checkpoint we settle on. That answers the only open question.
2. If it runs: **Standard at $16/mo**, point `COMFYUI_HOST` at it, add the API key to the
   machine layer. Roughly $0.36 an episode and nothing to switch off.
3. If it refuses: **a RunPod A40 Pod at $0.44/hr**, network volume attached, adapter
   unchanged — and **stop it when you stop working**, because an idle pod bills.
4. **Serverless later**, once the graph is settled and we are producing batches rather than
   experimenting. That is when per-second billing starts winning and when the adapter earns
   its cost.
