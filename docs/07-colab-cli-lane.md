# The Colab lane, over Google's own CLI

How to give Rivayat a real GPU for art generation, using `google-colab-cli` rather than a
notebook and a public tunnel.

**Why this exists.** The local card is a Quadro RTX 3000 — 6 GB, compute capability 7.5,
one checkpoint installed (`dreamshaper_8`, SD 1.5). That is a hard ceiling on art quality,
not a tuning problem: the quality gate scored every take `style-match 0.00` against a 0.6
floor because SD 1.5 at 6–8 LCM steps genuinely cannot draw the locked style. Nine extra
gigabytes changes _which models exist_; an A100 changes it again.

---

## The honest constraints, first

**1. The CLI does not run on Windows.** `google-colab-cli` 0.6.0 (16 June 2026) requires
Python ≥ 3.12 and its own documentation says it supports **Linux and macOS only**, despite
a misleading `Operating System :: OS Independent` classifier on PyPI. This machine is
Windows 11, so the CLI runs **inside WSL**. That is a real path, not a workaround — WSL2 is
already enabled here.

I told you earlier in this project that the CLI was unusable on this machine. That was
correct about running it _directly_ and I should have said "directly" — WSL removes the
problem and is the better route than the notebook.

**2. WSL is enabled but has no general-purpose distribution.** `wsl -l -v` reports one
entry, `docker-desktop`, which is Docker's own utility distro and is not meant for this.
You need Ubuntu. That is one command and a reboot-free install.

**3. Your tier permits this; the free tier does not.** Colab's FAQ lists "bypassing the
notebook UI to interact primarily via a web UI" and "remote control such as SSH shells"
among activities disallowed on runtimes running _"free of charge, without a positive Colab
compute unit balance"_, and then says those restrictions are removed by a paid plan with a
positive balance. You have Pro. Google also ships `colab ssh` and `colab console` as
first-class commands in its own CLI, which settles the intent.

Two clauses still bind every tier, paid included: no _"file hosting, media serving, or
other web service offerings not related to interactive compute"_, and no _"connecting to
remote proxies"_. So this is a **session-scoped lane used while you are working**, never
always-on infrastructure. Stop it when you stop.

---

## Why the CLI beats the notebook we already have

`tools/colab/rivayat-comfyui.ipynb` works and stays as the fallback. But it reaches
ComfyUI through a **cloudflared tunnel**, which means a public URL — and ComfyUI has no
authentication of any kind, so that notebook had to build a token gate in front of it just
to be safe to run.

The CLI removes the problem instead of guarding it. `colab ssh --proxy-mode` acts as an
**OpenSSH `ProxyCommand` bridge**, so ordinary SSH port forwarding applies:

```
ComfyUI on the Colab VM :8188
        │
        │  ssh -L, over Google's authenticated WebSocket transport
        ▼
127.0.0.1:8188 on your machine
```

Nothing is published. No public URL exists to find. The adapter cannot tell the difference
between this and the local card — same ComfyUI HTTP API, different host — which is the
whole point of `ImageGenerationPort` being a port.

---

## Setup

### 1. Install a real WSL distribution

In PowerShell **as Administrator**:

```powershell
wsl --install -d Ubuntu
```

Then open Ubuntu, set a username and password. Everything below runs **inside Ubuntu**,
not in PowerShell.

### 2. Install the CLI

`uv` is the documented installer and it handles the Python 3.12 requirement itself, which
matters because Ubuntu's system Python may be older:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
exec $SHELL -l
uv tool install google-colab-cli
colab --help
```

### 3. Authenticate

```bash
colab auth
```

This opens a Google OAuth flow. WSL usually hands the URL to your Windows browser; if it
does not, copy the printed URL across manually. Sign in as the account holding your Pro
subscription — not another Google account, or you will silently get free-tier behaviour and
the restrictions in §1 above.

### 4. Allocate a GPU runtime

```bash
colab new --gpu a100 --high-mem
colab status
```

Check `colab new --help` for the accepted `--gpu` values on your plan — I have verified the
flag exists and its syntax, not the exact enum, and I would rather you read it from the tool
than take a guess from me. **Colab guarantees no GPU on any tier**; a paid plan buys
_priority and access_, "subject to availability". If an A100 is unavailable, an L4 (24 GB)
is still far past the local ceiling.

`colab sessions` lists what you have running. `colab status` shows what you actually got —
read it, because what you asked for and what you were allocated are different things.

### 5. Put ComfyUI on the runtime

```bash
colab run tools/colab/setup-comfy.sh
```

If that script does not exist yet, the notebook's cells are the reference for what it must
do: clone ComfyUI at a pinned commit, install requirements, download the model set, and
start it on `:8188` with `--disable-all-custom-nodes`.

**That flag is not optional.** It is part of the determinism key: a third-party custom node
changes what a graph computes, and the whole content-addressed store rests on identical
inputs producing identical outputs. The local lane runs with it and the Colab lane must
match, or the two lanes disagree about what a given `specHash` means.

### 6. Forward the port

```bash
ssh -L 8188:localhost:8188 \
    -o ProxyCommand="colab ssh --proxy-mode" \
    -N colab
```

Leave it running. `-N` means "forward only, no remote shell".

Verify from **Windows**, not from WSL — WSL2 forwards `localhost` to Windows automatically,
and checking from inside Ubuntu would prove only that Ubuntu can reach it:

```powershell
curl http://127.0.0.1:8188/system_stats
```

You should see the Colab GPU's name and VRAM, not the Quadro's.

### 7. Point Rivayat at it

In `.env`:

```
COMFYUI_HOST=http://127.0.0.1:8188
RV_COMFYUI_REMOTE=true
```

`RV_COMFYUI_REMOTE` exists so the adapter knows the lane is remote and can time out
accordingly — a model load over a WebSocket-bridged link is not a local model load.

Then confirm the studio agrees:

```bash
pnpm --filter @rv/api dev     # restart so the machine layer is re-read
node apps/cli/bin/rv.mjs doctor
```

`rv doctor` should report ComfyUI reachable. Every setting here is also editable from the
studio's Settings screen — that is what the settings registry is for, and the `.env` route
is the machine layer beneath it.

### 8. Stop it when you stop

```bash
colab stop
```

This is the clause from §1 that binds every tier. It is also your compute balance.

---

## Which models, and why it changes the answer

| card                    | VRAM  | what becomes possible                                                                                                    |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| Quadro RTX 3000 (local) | 6 GB  | SD 1.5 only. This is the current ceiling.                                                                                |
| T4                      | 16 GB | SDXL comfortably. Same Turing generation as the local card, so ~1.2–1.5× on identical work — the win is VRAM, not speed. |
| L4                      | 24 GB | SDXL at high resolution; FLUX quantised. **Compute capability 8.9, so fp8 works** — the local card and the T4 cannot.    |
| A100                    | 40 GB | FLUX.1-dev at full precision. Note cc 8.0: bf16 yes, **fp8 no**.                                                         |

A correction I owe you from earlier in this project: I implied Colab Pro's better GPUs
unlock fp8 generally. Only **L4 (8.9)** and H100 do. The A100 is 8.0 and has no fp8 — it is
the bigger card, not the newer one, and for fp8 specifically the L4 is the better
allocation despite having less memory.

---

## What this does not fix

The art ceiling is not the only ceiling. Getting a Pixar-grade _look_ in stills is a model
question and this lane answers it. Pixar-grade _animation_ — subsurface scattering,
volumetric light, full 3D character performance — is 3D rendering, which
[ADR-0008](adr/ADR-0008-motion-providers-and-representations.md) explicitly declined and
this architecture does not do.

What it does instead, and what the target should be: high-quality rendered stills, cut into
depth-separated 2.5D layers, moved by procedural animation on rigs under a cinematic camera.
A moving illustrated film with real depth. That is achievable and it is genuinely beautiful.
It is not the same thing as Pixar and I would rather say so now than show you something at
the end that is technically valid and misses what you asked for.
