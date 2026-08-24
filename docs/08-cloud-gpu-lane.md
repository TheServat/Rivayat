# The cloud GPU lane

Every number here was read off the vendor's own pricing page on **2026-08-24** and checked
against that vendor's own claims by arithmetic. Per `CLAUDE.md`, do not "correct" them from
memory — re-check them.

**Decision: Comfy Cloud Creator, with a RunPod A40 Pod as the fallback.**

Supersedes [Colab](07-colab-cli-lane.md) as the primary art lane. Colab stays as a free
fallback for experiments, because it is already built.

---

## The fact that decides it

**Our workload is bursty, and by a lot.** An episode needs roughly 20–40 images, then the
GPU is idle for hours while assets are matted, rigged, animated, rendered and iterated on.
Generation is maybe **15–25 minutes of actual GPU time per episode**.

Hourly billing charges for the hours you spend thinking. Per-second billing does not. Every
other consideration is downstream of that.

---

## 1. Comfy Cloud — official, `cloud.comfy.org`

| plan        | monthly  | yearly (−20 %) | credits/mo | GPU hours | $/GPU-hr (monthly) |
| ----------- | -------- | -------------- | ---------- | --------- | ------------------ |
| Standard    | **$20**  | $16            | 4,200      | 4.39      | $4.55              |
| **Creator** | **$35**  | $28            | 7,400      | 7.73      | **$4.53**          |
| Pro         | **$100** | $80            | 21,100     | 22.03     | $4.54              |

Rate **0.266 credits/second**, cut from 0.39 on 2026-01-23 after GPU costs fell 30 %. The
arithmetic reproduces every published "hours" figure exactly, and the price per GPU-hour is
flat across plans — the tiers buy volume, not a discount.

**Hardware: RTX 6000 Pro Blackwell — 96 GB VRAM**, 180 GB RAM, roughly **2× an A100**. So
$4.53/hr is about **$2.27/hr of A100-equivalent work**, against RunPod Serverless A100 at
$2.72 — and with 96 GB rather than 80.

**Free tier:** 5 runs on real GPUs, no card. **Concurrency** 1 / 3 / 5 by plan. Plan credits
reset monthly and do **not** roll over; top-ups persist a year.

### Creator, not Standard, and this is the whole reason

**"Import your own models" is a Creator feature.** Standard cannot. Our pipeline pins a
checkpoint and verifies it by sha256, so Standard is not a cheaper version of what we need —
it cannot do the job at all.

Also tiered: workflow runtime caps at **30 minutes** on Standard and Creator, 1 hour on Pro.
A parts-sheet generation is seconds, so 30 minutes is not a constraint for us.

### The evidence it will take our workflow

The documented free-tier restrictions name `/api/prompt`, `/api/view`, `/api/upload/*` and
`/api/object_info` as returning 403 — which are **exactly the paths our adapter already
speaks**. If that holds on a paid account, this is a base URL and an API key from
`platform.comfy.org`, **not a new adapter**.

**Still unverified**, and it is the one thing left: whether our _graph_ runs unchanged,
including the parts-sheet workflow with its separability scaffold. The custom-model question
is now answered — it needs Creator.

### Costed for us

35 images at ~10 s on that card = 350 s = **93 credits**. Creator's 7,400 credits is
therefore **≈ 79 episodes a month**, about **$0.44 an episode**, with no infrastructure and
nothing to remember to switch off.

---

## 2. RunPod — cheapest real silicon, and no code change

**Pods** are a persistent VM: a real ComfyUI on a real port, so **our adapter works
unchanged**.

| GPU       | VRAM      | community $/hr |
| --------- | --------- | -------------- |
| RTX A5000 | 24 GB     | 0.27           |
| **A40**   | **48 GB** | **0.44**       |
| L4        | 24 GB     | 0.49           |
| RTX 4090  | 24 GB     | 0.74           |
| L40S      | 48 GB     | 0.99           |
| A100 PCIe | 80 GB     | 1.39           |

The A40 is the value outlier: **48 GB for less than a 4090's 24 GB**. Slower per image, but
VRAM decides which models exist, and that is the ceiling we are lifting.

**Serverless**, per second of active execution, zero when idle: L4 $0.69, RTX 4090 $1.10,
L40S $1.75, A100 $2.72, H100 $4.79 per active hour. Storage $0.05–0.07/GB/month.

Serverless matches our cost model exactly — `quoteImage` returns a real number and the guard
runs before the call, whereas **an hourly pod cannot attribute an hour to an image**. But it
needs a new adapter: `worker-comfyui` takes `{"input":{"workflow":…}}` at `/run`, where ours
speaks `POST /prompt` and `GET /history`. The expensive artefact survives — that worker
consumes the **same native workflow JSON** we already have — so it is a transport change
behind an existing port, not a redesign.

**Cold starts, corrected against the marketing.** RunPod advertises sub-second FlashBoot;
measured reality for ComfyUI is **20–60 s cold**, 10–30 s warm with a network volume.
FlashBoot snapshots what is already in the worker process at scale-to-zero, and ComfyUI
loads models lazily on first request, so the headline does not apply to us.

---

## 3. RunComfy — managed, and it does the reproducibility thing well

Pay-as-you-go with no subscription. **Billed by the second**; rates displayed per hour.

| tier          | GPU          | VRAM   | RAM    | PAYG $/hr | Pro $/hr | actual discount |
| ------------- | ------------ | ------ | ------ | --------- | -------- | --------------- |
| Small         | CPU          | —      | —      | 0.50      | **free** | 100 %           |
| Medium        | T4 / A4000   | 16 GB  | 16 GB  | 0.99      | 0.79     | 20 %            |
| Large         | A10G / A5000 | 24 GB  | 32 GB  | 1.75      | **1.39** | 21 %            |
| X-Large       | A6000        | 48 GB  | 48 GB  | 2.50      | **1.99** | 20 %            |
| X-Large Plus  | L40S / L40   | 48 GB  | 64 GB  | 2.99      | **2.15** | **28 %**        |
| 2X-Large      | A100         | 80 GB  | 96 GB  | 4.99      | 3.99     | 20 %            |
| 2X-Large Plus | H100         | 80 GB  | 180 GB | 7.49      | 5.99     | 20 %            |
| 3X-Large      | H200         | 141 GB | 240 GB | 9.59      | **7.66** | 20 %            |

**Pro is $19.99/mo** (or $239.90/yr): the discounts above, a $10 monthly credit, 200 GB
permanent storage, and 20 CPU hours a month for uploads and setup — which is free on Pro
rather than $0.50/hr. Free tier gets 10 GB cleared after 90 days.

The marketing says "20 %+" and the table bears it out: mostly 20 %, but **the L40S tier is
28 % off** and is the value pick on Pro. Note it is marked **API only** — which for us is
not a restriction, since we drive everything over the API anyway. H200 pricing was updated
2026-06-01.

Two things it does that nobody else on this list does:

- **Native ComfyUI, synced with official releases**, on both tiers, in a 100 % private
  workspace. Not a fork.
- **"Cloud Save" packages a workflow with its full runtime** — drivers, libraries, custom
  nodes, models — **into a reproducible container image**, deployable as a serverless
  endpoint.

That second one is the closest thing on this list to what our pinning discipline is reaching
for, and it is the reason RunComfy stays on the shortlist rather than being dismissed on
price. But "synced with official releases" cuts the other way for us: we pin ComfyUI to a
commit precisely so upstream cannot move under a content-addressed store. Cloud Save may
resolve that tension; it is untested.

Roughly **2–3× RunPod** for the same silicon. Not chosen, and not unreasonable.

---

## 4. comfy.icu — read the asterisk

| plan     | $/mo | credits      | "hours" | headline GPU        |
| -------- | ---- | ------------ | ------- | ------------------- |
| Basic    | 10   | 100k         | ≈ 3     | L4 24 GB included   |
| Standard | 30   | 315k (+5 %)  | ≈ 10    | L40S 48 GB included |
| Pro      | 60   | 660k (+10 %) | ≈ 20    | H100 80 GB included |

Rates: L4 **9 credits/s**, L40S **32**, H100 **64**, at 10,000 credits = $1. So **L4
$3.24/hr, L40S $11.52/hr, H100 $23.04/hr.**

**The footnote reads: **"Hours estimated using the L4 GPU tier."**** Every plan's headline hours
are computed at the cheapest card, while the card beside them advertises the most expensive
one as included. On the Pro plan the honest numbers are:

- 20.4 hours if you use the L4
- **2.86 hours if you use the H100 it advertises** — a **7× gap** between the headline and
  the advertised card.

That is disclosed, in a footnote, and it is legal. It is also the reason to check arithmetic
against a vendor's own claims rather than reading the big number. Declined on price: 3–5×
RunPod for the same silicon, and an H100 at $23/hr is not a rate this workload can justify.

---

## The comparison that matters

Cheapest first, like for like:

|                        | 48 GB class |                        | 80 GB class |
| ---------------------- | ----------- | ---------------------- | ----------- |
| RunPod Pod A40         | **$0.44**   | RunPod Pod A100        | **$1.39**   |
| RunPod Pod L40S        | $0.99       | RunPod Serverless A100 | $2.72       |
| RunPod Serverless L40S | $1.75       | RunComfy Pro A100      | $3.99       |
| RunComfy Pro A6000     | $1.99       | RunPod Serverless H100 | $4.79       |
| RunComfy Pro L40S      | $2.15       | RunComfy Pro H100      | $5.99       |
| RunComfy A6000         | $2.50       | comfy.icu H100         | $23.04      |
| comfy.icu L40S         | $11.52      |                        |             |

**96 GB, ~2× A100: Comfy Cloud at $4.53/hr** — the only one on this list above 80 GB at a
sane rate.

### One episode, 35 images

|                         | s/image | active   | cost                                              |
| ----------------------- | ------- | -------- | ------------------------------------------------- |
| RunPod Pod A40          | 28      | 16.3 min | **$0.12** active — but a 2 h session is **$0.88** |
| RunPod Serverless 4090  | 22      | 12.8 min | **$0.24**                                         |
| RunPod Serverless L40S  | 18      | 10.5 min | $0.31                                             |
| **Comfy Cloud Creator** | 10      | 5.8 min  | **$0.44**, and nothing to switch off              |
| RunComfy Pro A6000      | 25      | 14.6 min | $0.49                                             |
| RunComfy Pro L40S       | 18      | 10.5 min | $0.38                                             |
| comfy.icu L4            | 40      | 23.3 min | $1.26                                             |

Seconds-per-image are estimates scaled by card class, not measurements — they will be
measured on the first real run. Everything else is arithmetic on published rates.

**All of these are affordable.** The spread across the sane options is about thirty cents an
episode, which is not a number worth optimising. So the decision should be made on the
things that are **not** the price.

---

## Recommendation

**Comfy Cloud Creator, $35/mo (or $28 billed yearly).**

Not because it is cheapest per hour — it is not. Because:

1. **96 GB removes the ceiling entirely**, and the ceiling is the actual problem. The local
   card scores `style-match 0.00` because SD 1.5 cannot draw what we ask for; 96 GB runs FLUX
   at full precision.
2. **"Import your own models" on Creator** answers the one question that would have blocked
   it.
3. **It likely needs no adapter** — the native ComfyUI paths appear to be what it serves.
4. **Nothing to switch off.** Every hourly option punishes inattention: a forgotten A40 pod
   overnight is $10, which is a month of Creator.
5. Roughly **79 episodes a month** included.

**Fall back to a RunPod A40 Pod at $0.44/hr** if Comfy Cloud refuses our graph. It needs no
code change either, and 48 GB is a large step up from 6. The discipline that comes with it:
stop the pod when you stop working.

**Serverless later**, once the graph is settled and we are producing batches rather than
experimenting. That is when per-second billing wins and when the adapter earns its cost.

### First step, and it is free

**Spend the 5 free Comfy Cloud runs on our parts-sheet workflow.** That answers the only
remaining unknown at no cost, and it answers it better than any amount of further reading.

---

## Corrections to the previous version of this document

Recorded rather than silently edited, because both were wrong in the same direction —
optimistic:

- **Comfy Cloud's plans are $20 / $35 / $100 monthly.** I previously quoted $16 / $28 / $80,
  which are the _yearly-billed_ equivalents at the 20 % discount.
- **Standard cannot import custom models.** I recommended Standard and flagged the
  custom-model question as unverified. It is verified now and the answer moves the plan to
  Creator.
