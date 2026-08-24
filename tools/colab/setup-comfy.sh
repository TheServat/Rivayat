#!/usr/bin/env bash
# Put ComfyUI on a Colab runtime, for the CLI lane.
#
#   colab run tools/colab/setup-comfy.sh
#
# This is the notebook's install path with the tunnel removed. The notebook reaches
# ComfyUI through cloudflared, which publishes a URL - and ComfyUI has no authentication
# of any kind, so the notebook has to run a token-gated reverse proxy in front of it just
# to be safe. The CLI lane does not need that, because `colab ssh --proxy-mode` is an
# OpenSSH ProxyCommand bridge and ordinary `ssh -L` forwarding reaches the runtime over
# Google's own authenticated transport.
#
# So this script binds ComfyUI to 127.0.0.1 and stops. Nothing is published; there is no
# URL to find. That is a smaller attack surface than the notebook can offer, not merely a
# simpler one.
#
# See docs/07-colab-cli-lane.md for the whole setup.

set -euo pipefail

# ── pins ────────────────────────────────────────────────────────────────────
# Not `master`. Master drifts and takes the determinism claim with it: a content-addressed
# store is only meaningful if identical inputs produce identical outputs, and "identical
# inputs" includes the code that ran.
COMFYUI_COMMIT="72865f4f27eaf5396f8f36370e0a2be3a9a090ee"  # tag v0.33.1, 2026-08-13

COMFY_DIR="${COMFY_DIR:-/content/ComfyUI}"
COMFY_PORT="${COMFY_PORT:-8188}"
MODEL_SET="${MODEL_SET:-sdxl}"
# Colab's local disk is wiped on disconnect. With Drive mounted, weights survive a
# reconnect and cost a mount instead of a 7 GB download.
DRIVE_CACHE="${DRIVE_CACHE:-/content/drive/MyDrive/rivayat-comfy-models}"
LOG_DIR="/content/rv-logs"

# ── 1. what did we actually get? ────────────────────────────────────────────
# Read this rather than assuming. Colab guarantees no GPU on any tier - a paid plan buys
# priority and access "subject to availability" - and what you asked for and what you were
# allocated are different things.
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "*** NO GPU ATTACHED ***" >&2
  echo "Allocate one with: colab new --gpu <type>   (see colab new --help)" >&2
  exit 1
fi

read -r GPU_NAME VRAM_MIB CC <<<"$(nvidia-smi \
  --query-gpu=name,memory.total,compute_cap --format=csv,noheader \
  | head -1 | awk -F', *' '{gsub(/ MiB/,"",$2); print $1"\t"$2"\t"$3}' \
  | tr '\t' ' ')"

echo "GPU                : ${GPU_NAME}"
echo "VRAM               : ${VRAM_MIB} MiB"
echo "Compute capability : ${CC}"

# dtype support follows from the compute capability, never from the VRAM. This is the
# distinction that is easy to get backwards: an A100 is the bigger card and the *older*
# architecture. Turing 7.5 = fp16 only. Ampere 8.0 = + bf16. Ada 8.9 / Hopper 9.0 = + fp8.
awk -v cc="$CC" 'BEGIN {
  printf "bf16               : %s   (needs cc >= 8.0)\n", (cc >= 8.0 ? "yes" : "NO")
  printf "fp8                : %s   (needs cc >= 8.9 - an A100 is 8.0 and does NOT qualify)\n", (cc >= 8.9 ? "yes" : "NO")
}'

# ── 2. ComfyUI at the pin ───────────────────────────────────────────────────
if [ ! -d "$COMFY_DIR" ]; then
  git clone --filter=blob:none https://github.com/comfyanonymous/ComfyUI "$COMFY_DIR"
fi
git -C "$COMFY_DIR" fetch --depth 1 origin "$COMFYUI_COMMIT"
git -C "$COMFY_DIR" checkout --detach "$COMFYUI_COMMIT"

HEAD_SHA="$(git -C "$COMFY_DIR" rev-parse HEAD)"
if [ "$HEAD_SHA" != "$COMFYUI_COMMIT" ]; then
  echo "pin failed: HEAD is ${HEAD_SHA}, wanted ${COMFYUI_COMMIT}" >&2
  exit 1
fi
echo "ComfyUI pinned at ${HEAD_SHA}"

pip install -q -r "$COMFY_DIR/requirements.txt"

# ── 3. weights ──────────────────────────────────────────────────────────────
# name|subdir|url|bytes|sha256. Sizes and hashes are the HF CDN's X-Linked-Size and
# X-Linked-ETag, read 2026-08-23, and carried across from the notebook's catalogue.
#
# A size check alone is not verification - a truncated download and a redirected HTML
# error page both have a length. The hash is what makes "this is the model I meant" a
# fact rather than a hope, and it is also what lets a Drive-cached copy be trusted on a
# later session without re-downloading.
sdxl_catalog() {
  cat <<'CATALOG'
sd_xl_base_1.0.safetensors|checkpoints|https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors|6938078334|31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b
lcm-lora-sdxl.safetensors|loras|https://huggingface.co/latent-consistency/lcm-lora-sdxl/resolve/main/pytorch_lora_weights.safetensors|393855224|a764e6859b6e04047cd761c08ff0cee96413a8e004c9f07707530cd776b19141
CATALOG
}

# The parity set. Same model as the local card, so a Colab run and a local run of the same
# spec are comparable rather than merely both being "the free lane".
sd15_catalog() {
  cat <<'CATALOG'
dreamshaper_8.safetensors|checkpoints|https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors|2132625894|879db523c30d3b9017143d56705015e15a2cb5628762c11d086fed9538abd7fd
lcm-lora-sdv1-5.safetensors|loras|https://huggingface.co/latent-consistency/lcm-lora-sdv1-5/resolve/main/pytorch_lora_weights.safetensors|134621556|8f90d840e075ff588a58e22c6586e2ae9a6f7922996ee6649a7f01072333afe4
CATALOG
}

case "$MODEL_SET" in
  sdxl) CATALOG_FN=sdxl_catalog ;;
  sd15) CATALOG_FN=sd15_catalog ;;
  *)
    echo "MODEL_SET='${MODEL_SET}' is not handled here." >&2
    echo "FLUX needs a transformer chosen against this card's compute capability plus its" >&2
    echo "matching text encoders; that selection logic lives in the notebook and has not" >&2
    echo "been carried across. Use MODEL_SET=sdxl, or run rivayat-comfyui.ipynb for FLUX." >&2
    exit 1
    ;;
esac

fetch_one() {
  local name="$1" subdir="$2" url="$3" want_bytes="$4" want_sha="$5"
  local dest="$COMFY_DIR/models/$subdir/$name"
  mkdir -p "$COMFY_DIR/models/$subdir"

  # Drive first, if it is mounted and holds a verified copy.
  local cached="$DRIVE_CACHE/$subdir/$name"
  if [ -f "$cached" ]; then
    echo "  cached  $name  (from Drive)"
    ln -sf "$cached" "$dest"
    return 0
  fi

  if [ -f "$dest" ] && [ "$(stat -c%s "$dest")" = "$want_bytes" ]; then
    echo "  present $name"
  else
    echo "  fetch   $name  ($(awk -v b="$want_bytes" 'BEGIN{printf "%.1f", b/2^30}') GiB)"
    wget -q --show-progress -O "$dest" "$url"
  fi

  local got_sha
  got_sha="$(sha256sum "$dest" | cut -d' ' -f1)"
  if [ "$got_sha" != "$want_sha" ]; then
    echo "  *** $name failed verification ***" >&2
    echo "      wanted sha256 $want_sha" >&2
    echo "      got           $got_sha" >&2
    rm -f "$dest"
    exit 1
  fi
  echo "          sha256 ok"

  # Only cache what verified. Caching first would persist a bad download across sessions,
  # which is worse than not caching at all.
  if [ -d "$DRIVE_CACHE" ]; then
    mkdir -p "$DRIVE_CACHE/$subdir"
    cp "$dest" "$cached"
    ln -sf "$cached" "$dest"
    echo "          cached to Drive"
  fi
}

echo "models (${MODEL_SET}):"
while IFS='|' read -r name subdir url bytes sha; do
  [ -n "$name" ] && fetch_one "$name" "$subdir" "$url" "$bytes" "$sha"
done < <($CATALOG_FN)

# ── 4. launch, bound to loopback ────────────────────────────────────────────
# --listen 127.0.0.1 is the whole security model of this lane. The only route in is the
# SSH forward, which Google has already authenticated.
#
# --disable-all-custom-nodes is not optional and not a hardening flag: a third-party node
# changes what a graph computes, and the local lane runs with it. Two lanes that disagree
# about what a given specHash means would break the dedup key across machines.
mkdir -p "$LOG_DIR"
pkill -f "python main.py --listen 127.0.0.1 --port ${COMFY_PORT}" 2>/dev/null || true

cd "$COMFY_DIR"
nohup python main.py \
  --listen 127.0.0.1 --port "$COMFY_PORT" \
  --disable-auto-launch --preview-method none \
  --disable-all-custom-nodes \
  >"$LOG_DIR/comfy.log" 2>&1 &

echo "waiting for ComfyUI on 127.0.0.1:${COMFY_PORT} ..."
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${COMFY_PORT}/system_stats" >/dev/null 2>&1; then
    echo
    curl -fsS "http://127.0.0.1:${COMFY_PORT}/system_stats" \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(f"  {x[\"name\"]}  {x[\"vram_total\"]/2**30:.1f} GiB total, {x[\"vram_free\"]/2**30:.1f} GiB free") for x in d.get("devices",[])]'
    echo
    echo "ComfyUI is up, on loopback only."
    echo
    echo "From your WSL shell:"
    echo "  ssh -L ${COMFY_PORT}:localhost:${COMFY_PORT} -o ProxyCommand=\"colab ssh --proxy-mode\" -N colab"
    echo
    echo "Then in .env:  COMFYUI_HOST=http://127.0.0.1:${COMFY_PORT}"
    echo "               RV_COMFYUI_REMOTE=true"
    echo
    echo "And when you stop working:  colab stop"
    exit 0
  fi
  sleep 2
done

echo "ComfyUI did not become healthy within 180s. Last 40 lines:" >&2
tail -40 "$LOG_DIR/comfy.log" >&2
exit 1
