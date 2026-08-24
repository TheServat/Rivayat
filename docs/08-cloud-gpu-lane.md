# The cloud GPU lane

Prices live-checked 2026-08-24. Per `CLAUDE.md`, do not "correct" these from memory —
re-check them.

**Decision: RunPod. A Pod now, Serverless once the workflow settles.**

This supersedes [Colab](07-colab-cli-lane.md) as the primary art lane. Colab stays as a
fallback for experiments, because it is already built and costs nothing extra.

---

## The fact that decides it

**Our workload is bursty, and by a lot.** An episode needs roughly 20–40 images, then the
GPU is idle for hours while assets are matted, rigged, animated, rendered and iterated on.
Generation is maybe **15–25 minutes of actual GPU time per episode**.

Every other consideration is secondary to that shape. Hourly billing charges for the
hours you spend thinking; per-second billing does not.

---

## What we would pay

**Pods** — a persistent VM. You get a real ComfyUI on a real port, so **our adapter works
unchanged**: it is the same HTTP API as the local card, at a different host.

| GPU       | VRAM  | community $/hr |
| --------- | ----- | -------------- |
| RTX A5000 | 24 GB | **0.27**       |
| A40       | 48 GB | **0.44**       |
| L4        | 24 GB | 0.49           |
| RTX 4090  | 24 GB | 0.74           |
| L40S      | 48 GB | 0.99           |
| A100 PCIe | 80 GB | 1.39           |

The A40 is the value outlier: **48 GB for less than a 4090's 24 GB.** Slower per image, but
VRAM is what decides which models exist, and that is the ceiling we are trying to lift.

**Serverless** — billed per second of active execution, zero when idle.

| GPU                 | VRAM  | $/hr active |
| ------------------- | ----- | ----------- |
| L4                  | 24 GB | 0.69        |
| RTX 4090            | 24 GB | 1.10        |
| L40S / RTX 6000 Ada | 48 GB | 1.75        |
| A100                | 80 GB | 2.72        |

Storage for either: **$0.05–0.07/GB/month** standard, $0.14 high-performance. A network
volume holding SDXL plus a LoRA is roughly 8 GB — call it **$0.50/month** to not
re-download 7 GB on every start.

### One episode, costed

At ~25 s per image on SDXL and ~35 images, that is ~15 minutes of GPU:

- **Serverless 4090:** 15 min × $1.10 ≈ **$0.28**, plus a cold start.
- **Pod A40:** the meter runs for the whole working session, not just generation. Two hours
  of iterating is **$0.88**. Forgetting to stop it overnight is $10.

Both are affordable. The difference is not the money — it is that one of them punishes
inattention and the other does not.

---

## Why serverless is the destination, and why not yet

**It matches our cost model exactly.** Cost is metered before it is spent, `quoteImage`
returns a real number, and the budget guard runs before the call. A per-second serverless
invocation has a knowable price per generation. **An hourly pod cannot attribute an hour to
an image** — the third non-negotiable becomes an estimate we cannot reconcile against an
invoice, which is precisely the "receipt, not a guard" failure we already fixed once.

**But it needs a new adapter.** RunPod's `worker-comfyui` takes
`{"input": {"workflow": …}}` against `/run` or `/runsync` and returns base64 or S3 URLs.
Ours speaks native ComfyUI: `POST /prompt`, `GET /history/{id}`, `GET /view`, WebSocket
progress. Different shape.

**The expensive artefact survives the move, though**, and that is what makes this a staged
plan rather than a fork: `worker-comfyui` consumes the **same native workflow JSON export**
we already have in `tools/comfy-workflows/`. The graphs — including the parts-sheet graph
with its separability scaffold — carry over untouched. Only the transport changes, which is
one adapter behind a port that exists for this.

**Cold starts are the honest caveat.** RunPod markets sub-second FlashBoot; measured
reality for ComfyUI is **20–60 seconds** cold, and 10–30 s on subsequent runs with a network
volume. FlashBoot only snapshots what is already in the worker process when it scales to
zero, and ComfyUI loads models lazily on first request — so the headline number does not
apply to us. For a batch of 35 images in one session that amortises to nothing. For one
image it doubles the wall time.

---

## What we are not choosing, and why

**Vast.ai** is genuinely cheaper — an L40 at $0.31/hr against RunPod's $0.69. We are not
taking it, and the reason is not convenience. It is a marketplace of individual hosts with
varying drivers and reliability, and this pipeline pins ComfyUI to a commit, launches with
`--disable-all-custom-nodes`, and verifies every model by sha256 — all so that identical
inputs produce identical outputs. Host-to-host variability undercuts the thing those pins
are for. At 15 minutes an episode the saving is a few cents; the reproducibility is the
product.

**fal.ai** bills per image ($0.01–0.08) which is attractive, and it is fast. But its ComfyUI
custom-node support is documented as incomplete, and it is shaped around model endpoints
rather than "run my graph". We would be handing over control of the graph, and the graph is
where the style-fidelity work lives — the parts-sheet scaffold, the separability negatives,
the encoder ordering. Losing that to save cents is the wrong trade.

**Modal** is a good platform with the right billing model, but we would write and maintain
the container. RunPod ships and maintains `worker-comfyui`. Less of our code to own, for the
same shape.

**Monthly commitments**: no. Monthly pricing wins at sustained utilisation. Ours is bursty
by construction — that is the whole economic argument of "generate once, reuse forever",
and buying a month of GPU would quietly undo it.

---

## The plan

**Now — a Pod.** `COMFYUI_HOST=<pod endpoint>` and the existing adapter runs, today, with
no code change. Start on an **A40 (48 GB, $0.44/hr)**: enough VRAM for SDXL at high
resolution and for quantised FLUX, at less than a 4090. Attach a network volume so the
weights survive a restart.

The rule that comes with it: **stop the pod when you stop working.** An idle pod bills.
This is the same discipline the Colab doc asks for and the same reason.

**Then — Serverless**, once the workflow is settled and we are generating batches rather
than experimenting. That is when per-second billing starts winning and when the adapter is
worth writing.

**Ordering matters here.** Building the serverless adapter first would mean iterating on
prompts and graphs through a cold-start on every attempt, and paying an adapter's
development cost before knowing which graph we are deploying. Pods are the right tool for
finding the answer; serverless is the right tool for running it.
